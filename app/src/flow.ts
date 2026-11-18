import type { GitHubClient } from './github.ts';
import type { Build, DomainEvent, GhRelease, Release } from './model.ts';
import { State } from './state.ts';
import type { EventStore } from './store.ts';
import { candidateVersion, releaseLine, shippedVersion, tagFor } from './versioning.ts';

export interface FlowConfig {
  productName: string;
  buildWorkflow: string;
  testEnvironments: string[];
  releaseOwners: string[];
}

export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

// The automated flow:
//   new release/x.xx branch     → release created (Building)
//   Build workflow succeeds      → build recorded as the new candidate, draft GitHub release created,
//                                  the previous GitHub release closed (draft deleted, pre-release marked superseded)
//   candidate deployed to a test environment → GitHub release becomes a pre-release (Testing)
//   release owner ships          → GitHub release published as latest with the final version tag
export class ReleaseFlow {
  readonly state = new State();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private cfg: FlowConfig,
    private gh: GitHubClient,
    private store: EventStore,
    private now: () => string = () => new Date().toISOString(),
    private onChange: () => void = () => {}
  ) {
    for (const e of store.load()) this.state.apply(e);
  }

  // Webhooks are handled one at a time, in arrival order, so GitHub calls never race each other.
  handleWebhook(name: string, delivery: string, payload: any): Promise<void> {
    if (this.store.seenDelivery(delivery)) return Promise.resolve();
    this.store.logRaw(name, delivery, payload);
    return this.enqueue(() => this.dispatch(name, payload));
  }

  ship(line: string, actor: string): Promise<Release> {
    let result!: Release;
    return this.enqueue(async () => { result = await this.doShip(line, actor); }).then(() => result);
  }

  // Feed a build found by the reconcile job through the same path as a webhook.
  recordBuild(run: { id: number; runNumber: number; url: string; sha: string; branch: string; actor: string; createdAt: string }): Promise<void> {
    return this.enqueue(() => this.onBuild(run));
  }

  ensureBranch(branch: string): Promise<void> {
    return this.enqueue(async () => { const line = releaseLine(branch); if (line) this.ensureRelease(line); });
  }

  idle(): Promise<void> { return this.queue; }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch((err) => { console.error('[flow]', err?.message ?? err); });
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
      if (run.conclusion !== 'success' || run.name !== this.cfg.buildWorkflow) return;
      await this.onBuild({
        id: run.id, runNumber: run.run_number, url: run.html_url, sha: run.head_sha, branch: run.head_branch,
        actor: run.triggering_actor?.login ?? run.actor?.login ?? 'unknown', createdAt: run.updated_at ?? this.now()
      });
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

  private async onBuild(run: { id: number; runNumber: number; url: string; sha: string; branch: string; actor: string; createdAt: string }) {
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

  private async replaceGitHubRelease(release: Release, build: Build) {
    const old = release.gh;
    const tag = tagFor(build.version);
    const body = await this.notes(release, build, tag);
    const created = await this.gh.createRelease({ tag, sha: build.sha, name: `${this.cfg.productName} ${build.version}`, body, draft: true, prerelease: false });
    const gh: GhRelease = { id: created.id, tag, url: created.url, state: 'draft', buildId: build.id };
    this.emit({ type: 'ghrelease.set', at: this.now(), line: release.line, gh });
    if (old) await this.closeGitHubRelease(release, old, gh);
  }

  // GitHub has no "closed" release: a draft is deleted, a published pre-release is retitled and linked to its replacement.
  private async closeGitHubRelease(release: Release, old: GhRelease, replacement: GhRelease) {
    if (old.state === 'draft') {
      await this.gh.deleteRelease(old.id);
      this.emit({ type: 'ghrelease.superseded', at: this.now(), line: release.line, gh: old, deleted: true });
      return;
    }
    const body = await this.gh.getReleaseBody(old.id);
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

    const version = shippedVersion(candidate.version);
    const tag = tagFor(version);
    const updated = await this.gh.updateRelease(release.gh.id, {
      tag, sha: candidate.sha, name: `${this.cfg.productName} ${version}`, draft: false, prerelease: false, makeLatest: true
    });
    this.emit({ type: 'release.shipped', at: this.now(), line, by: actor, gh: { ...release.gh, tag, url: updated.url, state: 'released' } });
    return release;
  }

  private async notes(release: Release, build: Build, tag: string): Promise<string> {
    let previous: string | undefined;
    let generated: string;
    try {
      previous = await this.gh.latestPublishedTag();
      generated = await this.gh.generateNotes({ tag, sha: build.sha, previousTag: previous });
    } catch (err: any) {
      generated = `_GitHub could not generate notes for this build (${err?.message ?? 'unknown error'})._`;
    }
    const range = previous ? `\`${previous}...${tag}\`` : 'the start of the repository';
    return [
      `Release candidate **${build.version}** for ${release.name}, from build [${build.id}](${build.runUrl}) on \`${release.branch}\` (commit \`${build.sha.slice(0, 7)}\`).`,
      '',
      `_Managed by Release Tool. Notes compare ${range} and are rebuilt for each new build; this release moves from draft to pre-release when the build reaches a test environment, and is published when a release owner ships it._`,
      '',
      generated
    ].join('\n');
  }
}
