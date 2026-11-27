import { strFromU8, unzipSync } from 'fflate';
import type { Config } from './config.ts';
import { fmtHours, readiness, type Readiness } from './gates.ts';
import type { GitHubClient } from './github.ts';
import { parseJUnit } from './junit.ts';
import { coverage, latestResults } from './matrix.ts';
import type { Build, DomainEvent, GhRelease, JiraIssue, MatrixPlan, Release, TestRun } from './model.ts';
import { EDITABLE, editedOnGitHub, generate, merge, render, type SectionId } from './notes.ts';
import { State } from './state.ts';
import type { EventStore } from './store.ts';
import { candidateVersion, releaseLine, shippedVersion, tagFor } from './versioning.ts';

export type FlowConfig = Pick<Config, 'productName' | 'buildWorkflow' | 'testEnvironments' | 'releaseOwners' | 'gates' | 'soakEnvironment'> & {
  jiraBaseUrl?: string;
  jiraProject: string;
};

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

type Run = { id: number; runNumber: number; url: string; sha: string; branch: string; actor: string; createdAt: string };

// The automated flow:
//   new release/x.xx branch     → release created (Building)
//   Build workflow succeeds      → build recorded as the new candidate, draft GitHub release created with notes,
//                                  the previous GitHub release closed (draft deleted, pre-release marked superseded)
//   any workflow uploads test-results → JUnit results counted against the build
//   candidate deployed to a test environment → GitHub release becomes a pre-release (Testing)
//   Jira, Zephyr and telemetry snapshots (from the poller) → readiness gates; notes refreshed on Jira changes
//   release owner ships a Ready release → GitHub release published as latest with the final version tag
export class ReleaseFlow {
  readonly state = new State();
  readonly publishedTags = new Set<string>(); // dependency releases seen published: "owner/repo@tag"
  private queue: Promise<void> = Promise.resolve();
  /** Lines whose GitHub notes refresh failed; retried on the next Jira poll. */
  private staleNotes = new Set<string>();

  constructor(
    private cfg: FlowConfig,
    private gh: GitHubClient,
    private store: EventStore,
    private now: () => string = () => new Date().toISOString(),
    private onChange: () => void = () => {}
  ) {
    for (const e of store.load()) this.state.apply(e);
  }

  // ---- entry points (each runs on one queue, in order, so GitHub calls never race) ----

  handleWebhook(name: string, delivery: string, payload: any): Promise<void> {
    if (this.store.seenDelivery(delivery)) return Promise.resolve();
    this.store.logRaw(name, delivery, payload);
    return this.enqueue(() => this.dispatch(name, payload));
  }

  ship(line: string, actor: string): Promise<Release> {
    let result!: Release;
    return this.enqueue(async () => { result = await this.doShip(line, actor); }).then(() => result);
  }

  recordBuild(run: Run): Promise<void> { return this.enqueue(() => this.onBuild(run)); }

  ensureBranch(branch: string): Promise<void> {
    return this.enqueue(async () => { const line = releaseLine(branch); if (line) this.ensureRelease(line); });
  }

  importMatrix(plan: MatrixPlan): Promise<void> {
    return this.enqueue(async () => this.emit({ type: 'matrix.imported', at: this.now(), plan }));
  }

  recordJira(line: string, issues: JiraIssue[]): Promise<void> {
    return this.enqueue(async () => {
      const r = this.state.releases.get(line);
      if (!r || r.status === 'shipped') return;
      const same = r.jiraAt && JSON.stringify(r.jira) === JSON.stringify(issues);
      if (same && !this.staleNotes.has(line)) return;
      if (!same) this.emit({ type: 'jira.snapshot', at: this.now(), line, issues });
      await this.refreshNotes(r);
    });
  }

  recordTests(line: string, run: Omit<TestRun, 'at'>): Promise<void> {
    return this.enqueue(async () => {
      const r = this.state.releases.get(line);
      if (!r || r.status === 'shipped') return;
      const prev = [...r.testRuns].reverse().find((t) => t.buildId === run.buildId && t.source === run.source && t.label === run.label);
      if (prev && JSON.stringify(prev.results) === JSON.stringify(run.results)) return;
      this.emit({ type: 'tests.recorded', at: this.now(), line, run: { ...run, at: this.now() } });
    });
  }

  recordTelemetry(line: string, buildId: string, t: { users: number; sessions: number; sessionHours: number; errorsPerHour: number }): Promise<void> {
    return this.enqueue(async () => {
      const r = this.state.releases.get(line);
      if (!r || r.status === 'shipped') return;
      const prev = r.telemetry[buildId];
      if (prev && prev.users === t.users && prev.sessions === t.sessions && prev.sessionHours === t.sessionHours && prev.errorsPerHour === t.errorsPerHour) return;
      this.emit({ type: 'telemetry.snapshot', at: this.now(), line, telemetry: { ...t, buildId, at: this.now() } });
    });
  }

  editNotes(line: string, section: string, text: string | null, by: string): Promise<void> {
    return this.enqueue(async () => {
      if (!EDITABLE.includes(section as SectionId)) throw new ForbiddenError(`Section "${section}" is written by the tool and cannot be edited.`);
      const r = this.state.releases.get(line);
      if (!r) throw new NotFoundError(`No release ${line}.`);
      this.emit({ type: 'notes.edited', at: this.now(), line, section, text, by });
      await this.refreshNotes(r);
    });
  }

  setDependencyPublished(key: string, published: boolean) {
    const had = this.publishedTags.has(key);
    if (published) this.publishedTags.add(key); else this.publishedTags.delete(key);
    if (had !== published) this.onChange();
  }

  readinessOf(r: Release): Readiness {
    return readiness(r, this.state.matrix, this.cfg, this.now(), this.publishedTags);
  }

  idle(): Promise<void> { return this.queue; }

  // ---- internals ----

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch((err) => { if (!(err instanceof ForbiddenError || err instanceof NotFoundError)) console.error('[flow]', err?.message ?? err); });
    return run;
  }

  private emit(e: DomainEvent) {
    this.store.append(e);
    this.state.apply(e);
    this.onChange();
  }

  private async dispatch(name: string, p: any) {
    if (name === 'create' && p.ref_type === 'branch') {
      const line = releaseLine(p.ref);
      if (line) this.ensureRelease(line);
      return;
    }
    if (name === 'workflow_run' && p.action === 'completed') {
      const run = p.workflow_run;
      if (!releaseLine(run.head_branch)) return;
      if (run.conclusion === 'success' && run.name === this.cfg.buildWorkflow) {
        await this.onBuild({
          id: run.id, runNumber: run.run_number, url: run.html_url, sha: run.head_sha, branch: run.head_branch,
          actor: run.triggering_actor?.login ?? run.actor?.login ?? 'unknown', createdAt: run.updated_at ?? this.now()
        });
      }
      await this.collectTestResults(run);
      return;
    }
    if (name === 'deployment_status' && p.deployment_status?.state === 'success') {
      await this.onDeploy(p.deployment.sha, String(p.deployment.environment ?? p.deployment_status.environment));
    }
  }

  private ensureRelease(line: string): Release {
    const existing = this.state.releases.get(line);
    if (existing) return existing;
    this.emit({ type: 'release.created', at: this.now(), line, branch: `release/${line}`, name: `${this.cfg.productName} ${line}` });
    return this.state.releases.get(line)!;
  }

  private async onBuild(run: Run) {
    const line = releaseLine(run.branch);
    if (!line) return;
    const release = this.ensureRelease(line);
    if (release.status === 'shipped') return; // a shipped line takes no new candidates
    if (release.builds.some((b) => b.runId === run.id)) return; // already recorded

    const build: Build = {
      id: `b${run.runNumber}`, runId: run.id, runUrl: run.url, sha: run.sha,
      version: candidateVersion(line, release.builds.length + 1), createdAt: run.createdAt, actor: run.actor
    };
    const at = this.now();
    this.emit({ type: 'build.created', at, line, build });
    if (release.status !== 'building') this.emit({ type: 'status.changed', at, line, status: 'building' });

    await this.replaceGitHubRelease(release, build);

    // A deployment can beat the workflow_run webhook; apply any that were waiting for this commit.
    const waiting = this.state.pendingDeploys.get(build.sha) ?? [];
    this.state.pendingDeploys.delete(build.sha);
    for (const d of waiting) await this.onDeploy(build.sha, d.environment);
  }

  // Test results from any workflow on a release branch: artifacts named test-results* holding JUnit XML.
  private async collectTestResults(run: any) {
    const found = this.state.findBuildBySha(run.head_sha);
    if (!found || found.release.status === 'shipped') return;
    const label = `${run.name} run ${run.run_number}`;
    if (found.release.testRuns.some((t) => t.label === label)) return;
    const artifacts = (await this.gh.listArtifacts(run.id)).filter((a) => /^test-results/i.test(a.name));
    const results = [];
    for (const a of artifacts) {
      const files = unzipSync(await this.gh.downloadArtifact(a.id));
      for (const [path, data] of Object.entries(files)) if (path.endsWith('.xml')) results.push(...parseJUnit(strFromU8(data), run.updated_at ?? this.now()));
    }
    if (!results.length) return;
    this.emit({ type: 'tests.recorded', at: this.now(), line: found.release.line, run: { source: 'actions', buildId: found.buildId, label, results, at: this.now() } });
  }

  private async replaceGitHubRelease(release: Release, build: Build) {
    const old = release.gh;
    let oldBody: string | undefined;
    if (old) {
      oldBody = await this.gh.getReleaseBody(old.id);
      this.lockGitHubEdits(release, oldBody);
    }
    const tag = tagFor(build.version);
    const { written, body } = await this.composeNotes(release, build, tag);
    const created = await this.gh.createRelease({ tag, sha: build.sha, name: `${this.cfg.productName} ${build.version}`, body, draft: true, prerelease: false });
    const gh: GhRelease = { id: created.id, tag, url: created.url, state: 'draft', buildId: build.id };
    this.emit({ type: 'ghrelease.set', at: this.now(), line: release.line, gh });
    this.emit({ type: 'notes.generated', at: this.now(), line: release.line, sections: written });
    if (old) await this.closeGitHubRelease(release, old, gh, oldBody ?? '');
  }

  // GitHub has no "closed" release: a draft is deleted, a published pre-release is retitled and linked to its replacement.
  private async closeGitHubRelease(release: Release, old: GhRelease, replacement: GhRelease, body: string) {
    if (old.state === 'draft') {
      await this.gh.deleteRelease(old.id);
      this.emit({ type: 'ghrelease.superseded', at: this.now(), line: release.line, gh: old, deleted: true });
      return;
    }
    await this.gh.updateRelease(old.id, {
      name: `Superseded: ${this.cfg.productName} ${old.tag.replace(/^v/, '')}`,
      body: `> **Superseded** by [${replacement.tag}](${replacement.url}). Kept for history; not for release.\n\n${body}`,
      makeLatest: false
    });
    this.emit({ type: 'ghrelease.superseded', at: this.now(), line: release.line, gh: old, deleted: false });
  }

  private async onDeploy(sha: string, environment: string) {
    const env = environment.toLowerCase();
    const found = this.state.findBuildBySha(sha);
    if (!found) {
      const list = this.state.pendingDeploys.get(sha) ?? [];
      list.push({ environment: env, at: this.now() });
      this.state.pendingDeploys.set(sha, list);
      return;
    }
    const { release, buildId } = found;
    this.emit({ type: 'deployment.recorded', at: this.now(), line: release.line, buildId, environment: env });

    const isCandidate = buildId === release.candidateId;
    if (!isCandidate || release.status === 'shipped' || !this.cfg.testEnvironments.includes(env)) return;
    if (release.status !== 'testing') this.emit({ type: 'status.changed', at: this.now(), line: release.line, status: 'testing' });
    const gh = release.gh;
    if (gh && gh.buildId === buildId && gh.state === 'draft') {
      const updated = await this.gh.updateRelease(gh.id, { draft: false, prerelease: true, makeLatest: false });
      this.emit({ type: 'ghrelease.set', at: this.now(), line: release.line, gh: { ...gh, url: updated.url, state: 'prerelease' } });
    }
  }

  private async doShip(line: string, actor: string): Promise<Release> {
    if (!this.cfg.releaseOwners.includes(actor.toLowerCase())) throw new ForbiddenError(`${actor} is not a release owner.`);
    const release = this.state.releases.get(line);
    if (!release) throw new NotFoundError(`No release ${line}.`);
    if (release.status === 'shipped') throw new ForbiddenError(`${release.name} has already shipped.`);
    const candidate = release.builds.find((b) => b.id === release.candidateId);
    if (!candidate || !release.gh) throw new ForbiddenError(`${release.name} has no candidate build yet.`);
    const ready = this.readinessOf(release);
    if (ready.status !== 'ready') throw new ForbiddenError(`${release.name} is not ready to ship: ${ready.reason}.`);

    const version = shippedVersion(candidate.version);
    const tag = tagFor(version);
    this.lockGitHubEdits(release, await this.gh.getReleaseBody(release.gh.id));
    const { written, body } = await this.composeNotes(release, candidate, tag, `Shipped by ${actor}`);
    const updated = await this.gh.updateRelease(release.gh.id, {
      tag, sha: candidate.sha, name: `${this.cfg.productName} ${version}`, body, draft: false, prerelease: false, makeLatest: true
    });
    this.emit({ type: 'notes.generated', at: this.now(), line, sections: written });
    this.emit({ type: 'release.shipped', at: this.now(), line, by: actor, gh: { ...release.gh, tag, url: updated.url, state: 'released' } });
    return release;
  }

  // Rebuild the current GitHub release's notes, keeping edited sections.
  private async refreshNotes(release: Release) {
    const gh = release.gh;
    const build = release.builds.find((b) => b.id === release.candidateId);
    if (!gh || !build || release.status === 'shipped') return;
    this.staleNotes.add(release.line);
    const current = await this.gh.getReleaseBody(gh.id);
    this.lockGitHubEdits(release, current);
    const { written, body } = await this.composeNotes(release, build, gh.tag);
    if (body.trim() !== current.trim()) await this.gh.updateRelease(gh.id, { body });
    this.emit({ type: 'notes.generated', at: this.now(), line: release.line, sections: written });
    this.staleNotes.delete(release.line);
  }

  private lockGitHubEdits(release: Release, body: string) {
    for (const [section, text] of Object.entries(editedOnGitHub(body, release.notes.generated))) {
      if (release.notes.locked[section]?.text === text) continue;
      this.emit({ type: 'notes.edited', at: this.now(), line: release.line, section, text, by: 'GitHub' });
    }
  }

  private async composeNotes(release: Release, build: Build, tag: string, extraFact?: string) {
    let previousTag: string | undefined;
    let githubNotes: string;
    try {
      previousTag = await this.gh.latestPublishedTag();
      githubNotes = await this.gh.generateNotes({ tag, sha: build.sha, previousTag });
    } catch (err: any) {
      githubNotes = `_GitHub could not generate notes for this build (${err?.message ?? 'unknown error'})._`;
    }
    const facts = this.facts(release, build);
    if (extraFact) facts.push(extraFact);
    const fresh = generate({ release, build, tag, previousTag, githubNotes, jiraBaseUrl: this.cfg.jiraBaseUrl, jiraProject: this.cfg.jiraProject, facts });
    // "written" is what goes to GitHub: fresh sections, with edited ones kept. Edits are later detected against it.
    const written = merge(fresh, release.notes.locked);
    return { written, body: render(written) };
  }

  private facts(release: Release, build: Build): string[] {
    const runs = release.testRuns.filter((t) => t.buildId === build.id);
    const auto = [...latestResults(runs.filter((t) => t.source === 'actions')).values()];
    const cov = coverage(this.state.matrix, runs.filter((t) => t.source === 'zephyr'));
    const envs = [...new Set(release.deployments.filter((d) => d.buildId === build.id).map((d) => d.environment))];
    const tel = release.telemetry[build.id];
    const facts = [`${release.builds.length} build${release.builds.length === 1 ? '' : 's'} on \`${release.branch}\`; this is ${build.id}`];
    facts.push(envs.length ? `Deployed to ${envs.join(', ')}` : 'Not deployed yet');
    if (release.firstTestAt) facts.push(`In test for ${fmtHours((Date.parse(this.now()) - Date.parse(release.firstTestAt)) / 36e5)}`);
    if (auto.length) facts.push(`${auto.filter((t) => t.outcome === 'pass').length} of ${auto.length} automated tests passed`);
    if (cov && cov.executed) facts.push(`${cov.pass} of ${cov.planned} planned matrix tests passed; ${cov.completeConfigs} of ${cov.configs.length} configurations complete`);
    if (tel) facts.push(`${tel.users} users, ${tel.sessions} sessions, ${tel.sessionHours} session hours on this build`);
    return facts;
  }
}
