import { describe, expect, it } from 'vitest';
import { releaseLine } from '../src/versioning.ts';
import { ForbiddenError, ReleaseFlow } from '../src/flow.ts';
import type { GitHubClient } from '../src/github.ts';
import { MemoryStore } from '../src/store.ts';
import { releasesView } from '../src/view.ts';
import { verifySignature } from '../src/webhook.ts';
import { createHmac } from 'node:crypto';

type Rel = { id: number; tag: string; name: string; body: string; draft: boolean; prerelease: boolean; latest: boolean; sha: string };

class FakeGitHub implements GitHubClient {
  releases = new Map<number, Rel>();
  calls: string[] = [];
  private next = 1;
  async createRelease(o: { tag: string; sha: string; name: string; body: string; draft: boolean; prerelease: boolean }) {
    const id = this.next++;
    this.releases.set(id, { id, tag: o.tag, name: o.name, body: o.body, draft: o.draft, prerelease: o.prerelease, latest: false, sha: o.sha });
    this.calls.push(`create ${o.tag}`);
    return { id, url: `https://github.test/releases/${id}`, tag: o.tag };
  }
  async updateRelease(id: number, o: any) {
    const r = this.releases.get(id)!;
    if (o.tag !== undefined) r.tag = o.tag;
    if (o.sha !== undefined) r.sha = o.sha;
    if (o.name !== undefined) r.name = o.name;
    if (o.body !== undefined) r.body = o.body;
    if (o.draft !== undefined) r.draft = o.draft;
    if (o.prerelease !== undefined) r.prerelease = o.prerelease;
    if (o.makeLatest !== undefined) r.latest = o.makeLatest;
    this.calls.push(`update ${id}`);
    return { id, url: `https://github.test/releases/${id}`, tag: r.tag };
  }
  async deleteRelease(id: number) { this.releases.delete(id); this.calls.push(`delete ${id}`); }
  async getReleaseBody(id: number) { return this.releases.get(id)!.body; }
  async latestPublishedTag() { return 'v4.11.2'; }
  async generateNotes(o: { tag: string; previousTag?: string }) { return `## What's Changed\n* ${o.previousTag}...${o.tag}`; }
  async listReleaseBranches() { return ['release/4.12', 'release/4.13']; }
  artifacts = new Map<number, { id: number; name: string; zip: Uint8Array }[]>();
  published = new Set<string>();
  async listArtifacts(runId: number) { return (this.artifacts.get(runId) ?? []).map(({ id, name }) => ({ id, name })); }
  async downloadArtifact(id: number) { return [...this.artifacts.values()].flat().find((a) => a.id === id)!.zip; }
  async isPublished(repo: string, tag: string) { return this.published.has(`${repo}@${tag}`); }
  async latestSuccessfulRun(branch: string) {
    return branch === 'release/4.13' ? { id: 900, runNumber: 1900, url: 'https://github.test/runs/900', sha: 'sha4130', branch, actor: 'dev', createdAt: '2026-11-18T10:00:00Z', workflowName: 'Build' } : undefined;
  }
}

export const cfg = {
  productName: 'Web app', buildWorkflow: 'Build', testEnvironments: ['qa', 'staging'], releaseOwners: ['slaybol'],
  soakEnvironment: 'staging', jiraProject: 'WEB', jiraBaseUrl: 'https://jira.test',
  gates: { testTargetPct: 90, errorThreshold: 8, soakHours: 0, dependencies: [] as { name: string; repo: string; tag: string }[] }
};
let delivery = 0;
export const clock = { now: '2026-11-18T12:00:00.000Z' };

function setup() {
  const gh = new FakeGitHub();
  const store = new MemoryStore();
  const flow = new ReleaseFlow(cfg, gh, store, () => clock.now);
  const send = (name: string, payload: any) => flow.handleWebhook(name, `d${++delivery}`, payload);
  const build = (runNumber: number, sha: string, branch = 'release/4.12', extra: any = {}) => send('workflow_run', {
    action: 'completed',
    workflow_run: { id: runNumber * 10, run_number: runNumber, name: 'Build', conclusion: 'success', head_branch: branch, head_sha: sha, html_url: `https://github.test/runs/${runNumber}`, actor: { login: 'dev' }, updated_at: '2026-11-18T11:00:00Z', ...extra }
  });
  const deploy = (sha: string, environment: string) => send('deployment_status', { deployment_status: { state: 'success' }, deployment: { sha, environment } });
  clock.now = '2026-11-18T12:00:00.000Z';
  return { gh, store, flow, send, build, deploy };
}

describe('build pickup', () => {
  it('reads the release line from release/x.xx and Release/x.xx branches only', () => {
    expect(releaseLine('release/4.12')).toBe('4.12');
    expect(releaseLine('refs/heads/Release/4.13')).toBe('4.13');
    expect(releaseLine('release/4.12-hotfix')).toBeUndefined();
    expect(releaseLine('feature/release/4.12')).toBeUndefined();
  });

  it('creates a release when a release/x.xx branch is created, and ignores other branches', async () => {
    const { flow, send } = setup();
    await send('create', { ref_type: 'branch', ref: 'release/4.12' });
    await send('create', { ref_type: 'branch', ref: 'feature/login' });
    await send('create', { ref_type: 'tag', ref: 'release/9.9' });
    expect([...flow.state.releases.keys()]).toEqual(['4.12']);
    expect(flow.state.releases.get('4.12')!.status).toBe('building');
  });

  it('records a successful Build run as candidate rc.1 and opens a draft GitHub release with notes', async () => {
    const { flow, gh, build } = setup();
    await build(1838, 'sha1838');
    const r = flow.state.releases.get('4.12')!;
    expect(r.candidateId).toBe('b1838');
    expect(r.builds[0].version).toBe('4.12.0-rc.1');
    const rel = [...gh.releases.values()][0];
    expect(rel).toMatchObject({ tag: 'v4.12.0-rc.1', draft: true, prerelease: false, sha: 'sha1838' });
    expect(rel.body).toContain('v4.11.2...v4.12.0-rc.1');
    expect(rel.body).toContain('<!-- release-tool:changes -->');
    expect(rel.body).toContain('[b1838](https://github.test/runs/1838)');
  });

  it('ignores failed runs, other workflows, non-release branches and repeat deliveries of the same run', async () => {
    const { flow, gh, build, send } = setup();
    await build(1, 'a', 'release/4.12', { conclusion: 'failure' });
    await build(2, 'b', 'release/4.12', { name: 'Lint' });
    await build(3, 'c', 'main');
    expect(flow.state.releases.size).toBe(0);
    await build(4, 'd');
    await build(4, 'd');
    expect(flow.state.releases.get('4.12')!.builds).toHaveLength(1);
    expect(gh.releases.size).toBe(1);
    // the exact same delivery id is dropped before it is processed
    await flow.handleWebhook('workflow_run', 'same', { action: 'completed', workflow_run: { id: 50, run_number: 5, name: 'Build', conclusion: 'success', head_branch: 'release/4.12', head_sha: 'e' } });
    await flow.handleWebhook('workflow_run', 'same', { action: 'completed', workflow_run: { id: 60, run_number: 6, name: 'Build', conclusion: 'success', head_branch: 'release/4.12', head_sha: 'f' } });
    expect(flow.state.releases.get('4.12')!.builds.map((b) => b.id)).toEqual(['b4', 'b5']);
  });
});

describe('GitHub release lifecycle', () => {
  it('turns the draft into a pre-release when the candidate reaches a test environment', async () => {
    const { flow, gh, build, deploy } = setup();
    await build(1838, 'sha1838');
    await deploy('sha1838', 'dev'); // not a test environment
    expect([...gh.releases.values()][0].draft).toBe(true);
    await deploy('sha1838', 'QA');
    const rel = [...gh.releases.values()][0];
    expect(rel).toMatchObject({ draft: false, prerelease: true, latest: false });
    const r = flow.state.releases.get('4.12')!;
    expect(r.status).toBe('testing');
    expect(r.gh!.state).toBe('prerelease');
    expect(r.firstTestAt).toBe('2026-11-18T12:00:00.000Z');
  });

  it('deletes a replaced draft, and creates a new draft for the new version', async () => {
    const { flow, gh, build } = setup();
    await build(1838, 'sha1838');
    await build(1840, 'sha1840');
    const left = [...gh.releases.values()];
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ tag: 'v4.12.0-rc.2', draft: true });
    const r = flow.state.releases.get('4.12')!;
    expect(r.history[0]).toMatchObject({ tag: 'v4.12.0-rc.1', state: 'draft' });
    expect(r.status).toBe('building');
  });

  it('marks a replaced pre-release as superseded and links it to the new release', async () => {
    const { flow, gh, build, deploy } = setup();
    await build(1838, 'sha1838');
    await deploy('sha1838', 'qa');
    await build(1840, 'sha1840');
    const [old, current] = [...gh.releases.values()];
    expect(old.name).toBe('Superseded: Web app 4.12.0-rc.1');
    expect(old.body).toMatch(/^> \*\*Superseded\*\* by \[v4\.12\.0-rc\.2\]\(https:\/\/github\.test\/releases\/2\)/);
    expect(old.prerelease).toBe(true);
    expect(current).toMatchObject({ tag: 'v4.12.0-rc.2', draft: true });
    const r = flow.state.releases.get('4.12')!;
    expect(r.status).toBe('building'); // the new candidate has not been tested yet
    expect(r.firstTestAt).toBeUndefined();
    await deploy('sha1840', 'staging');
    expect(current.prerelease).toBe(true);
    expect(flow.state.releases.get('4.12')!.status).toBe('testing');
  });

  it('does not promote the GitHub release when an older build is deployed', async () => {
    const { gh, build, deploy } = setup();
    await build(1838, 'sha1838');
    await build(1840, 'sha1840');
    await deploy('sha1838', 'qa');
    expect([...gh.releases.values()][0]).toMatchObject({ tag: 'v4.12.0-rc.2', draft: true });
  });

  it('applies a deployment that arrives before its build', async () => {
    const { flow, gh, build, deploy } = setup();
    await deploy('sha1838', 'qa');
    await build(1838, 'sha1838');
    expect([...gh.releases.values()][0].prerelease).toBe(true);
    expect(flow.state.releases.get('4.12')!.deployments).toHaveLength(1);
  });

  it('lets a release owner ship a ready release: final version tag, not a pre-release, marked latest', async () => {
    const { flow, gh, build, deploy } = setup();
    await build(1838, 'sha1838');
    await deploy('sha1838', 'qa');
    await expect(flow.ship('4.12', 'Slaybol')).rejects.toThrow(/not ready to ship/);
    await deploy('sha1838', 'staging');
    await flow.recordTests('4.12', { source: 'actions', buildId: 'b1838', label: 'Build run 1838', results: [{ testId: 'a', name: 'a', outcome: 'pass', durationMs: 5, at: 'x' }] });
    await flow.recordJira('4.12', []);
    await flow.recordTelemetry('4.12', 'b1838', { users: 3, sessions: 4, sessionHours: 1, errorsPerHour: 1 });
    expect(flow.readinessOf(flow.state.releases.get('4.12')!).status).toBe('ready');
    await expect(flow.ship('4.12', 'someone')).rejects.toBeInstanceOf(ForbiddenError);
    await flow.ship('4.12', 'Slaybol');
    const rel = [...gh.releases.values()][0];
    expect(rel).toMatchObject({ tag: 'v4.12.0', name: 'Web app 4.12.0', draft: false, prerelease: false, latest: true, sha: 'sha1838' });
    const r = flow.state.releases.get('4.12')!;
    expect(r.status).toBe('shipped');
    expect(r.shippedBy).toBe('Slaybol');
    await build(1850, 'sha1850'); // a shipped line takes no new candidates
    expect(r.builds).toHaveLength(1);
  });
});

describe('environments, replay and reconcile', () => {
  it('moves an environment to the newest build and lists what is deployed where', async () => {
    const { flow, build, deploy } = setup();
    await build(1838, 'sha1838');
    await deploy('sha1838', 'qa');
    await build(1840, 'sha1840');
    await deploy('sha1840', 'qa');
    await deploy('sha1838', 'staging');
    const v = releasesView(flow, '2026-11-18T14:00:00.000Z', { jira: false, zephyr: false, telemetry: false, jiraProject: 'WEB' });
    expect(v.inFlight[0].environments).toEqual([
      { name: 'qa', build: 'b1840', since: '2026-11-18T12:00:00.000Z' },
      { name: 'staging', build: 'b1838', since: '2026-11-18T12:00:00.000Z' }
    ]);
    expect(v.environments.map((e) => e.name).sort()).toEqual(['qa', 'staging']);
    expect(v.inFlight[0].timeInTestMs).toBe(2 * 60 * 60 * 1000);
  });

  it('rebuilds the same state from the event log', async () => {
    const { flow, gh, store, build, deploy } = setup();
    await build(1838, 'sha1838');
    await deploy('sha1838', 'qa');
    await build(1840, 'sha1840');
    const again = new ReleaseFlow(cfg, gh, store, () => clock.now);
    expect(again.state.releases.get('4.12')).toEqual(flow.state.releases.get('4.12'));
  });

  it('reconcile picks up release branches and builds the webhooks missed', async () => {
    const { flow, gh } = setup();
    const { reconcile } = await import('../src/reconcile.ts');
    await reconcile(flow, gh, 'Build');
    expect([...flow.state.releases.keys()].sort()).toEqual(['4.12', '4.13']);
    expect(flow.state.releases.get('4.13')!.candidateId).toBe('b1900');
    await reconcile(flow, gh, 'Build');
    expect(flow.state.releases.get('4.13')!.builds).toHaveLength(1);
  });
});

describe('webhook signature', () => {
  it('accepts GitHub signatures and rejects anything else', () => {
    const body = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifySignature('s3cret', body, sig)).toBe(true);
    expect(verifySignature('other', body, sig)).toBe(false);
    expect(verifySignature('s3cret', body, undefined)).toBe(false);
  });
});

// ---------------- phases 2 to 5 ----------------
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { planFromWorkbook, coverage } from '../src/matrix.ts';
import { parse, editedOnGitHub } from '../src/notes.ts';
import { parseJUnit } from '../src/junit.ts';
import { DemoIssues, DemoManualTests, DemoTelemetry } from '../src/integrations/demo.ts';
import { pollOnce } from '../src/poller.ts';
import { releaseDetail } from '../src/view.ts';

const workbook = new Uint8Array(readFileSync(new URL('./fixtures/edge-hardware-test-matrix.xlsx', import.meta.url)));
const plan = planFromWorkbook(workbook, 'edge-hardware-test-matrix.xlsx', '2026-11-18T00:00:00Z');
const latestBody = (gh: FakeGitHub) => [...gh.releases.values()].at(-1)!.body;

describe('test matrix import', () => {
  it('reads configurations, tests and planned cells from the workbook', () => {
    expect(plan.configs.map((c) => c.id)).toEqual(['PN1-A', 'PN1-B', 'PN1-C', 'FC6-A', 'FC6-B', 'FC6-C', 'RBK-A', 'RBK-B', 'MTS-A', 'MTS-B', 'GK-A']);
    expect(plan.configs[0]).toMatchObject({ os: 'EdgeOS 3.2 LTS', product: 'PN-1', description: 'Pocket Node, base' });
    expect(plan.tests).toHaveLength(31);
    expect(plan.tests[0]).toEqual({ id: 'PRV-01', category: 'Provisioning', name: 'Zero-touch enrollment with management server' });
    // R and S cells are planned, O and — are not. Matches the workbook's own Execution Tracker (209 rows).
    expect(plan.cells).toHaveLength(209);
    expect(plan.cells.find((c) => c.testId === 'PRV-03' && c.configId === 'PN1-A')).toBeUndefined(); // optional
    expect(plan.cells.find((c) => c.testId === 'NET-01' && c.configId === 'PN1-A')?.level).toBe('Smoke');
  });

  it('computes coverage from the latest result of each cell', () => {
    const at = (m: number) => `2026-11-18T12:0${m}:00Z`;
    const cov = coverage(plan, [
      { source: 'zephyr', buildId: 'b1', label: 'c', at: at(0), results: [
        { testId: 'PRV-01', name: '', configId: 'PN1-A', outcome: 'fail', durationMs: 1, at: at(1) },
        { testId: 'PRV-02', name: '', configId: 'PN1-A', outcome: 'blocked', durationMs: 1, at: at(1) }
      ] },
      { source: 'zephyr', buildId: 'b1', label: 'c', at: at(2), results: [{ testId: 'PRV-01', name: '', configId: 'PN1-A', outcome: 'pass', durationMs: 1, at: at(2) }] }
    ])!;
    expect(cov).toMatchObject({ planned: 209, pass: 1, fail: 0, blocked: 1, executed: 1, notRun: 207 });
    expect(cov.problems).toEqual([{ testId: 'PRV-02', name: 'Clean OS install / image flash', configId: 'PN1-A', outcome: 'blocked', issue: undefined }]);
  });
});

describe('GitHub Actions test results', () => {
  it('parses JUnit and attaches test-results artifacts from any workflow to the build by commit', async () => {
    const xml = '<testsuites><testsuite><testcase classname="checkout" name="pays" time="0.25"/><testcase classname="checkout" name="refunds" time="1"><failure message="x"/></testcase><testcase name="later"><skipped/></testcase></testsuite></testsuites>';
    expect(parseJUnit(xml, 't').map((r) => [r.testId, r.outcome, r.durationMs])).toEqual([['checkout › pays', 'pass', 250], ['checkout › refunds', 'fail', 1000], ['later', 'skipped', 0]]);
    const { flow, gh, build, send } = setup();
    await build(1838, 'sha1838');
    gh.artifacts.set(77, [{ id: 5, name: 'test-results-e2e', zip: zipSync({ 'junit.xml': strToU8(xml) }) }, { id: 6, name: 'site', zip: zipSync({}) }]);
    const e2e = { action: 'completed', workflow_run: { id: 77, run_number: 9, name: 'E2E', conclusion: 'failure', head_branch: 'release/4.12', head_sha: 'sha1838', updated_at: 't' } };
    await send('workflow_run', e2e);
    await send('workflow_run', e2e); // a second delivery of the same run adds nothing
    const r = flow.state.releases.get('4.12')!;
    expect(r.testRuns).toHaveLength(1);
    expect(r.testRuns[0]).toMatchObject({ source: 'actions', buildId: 'b1838', label: 'E2E run 9' });
    expect(flow.readinessOf(r).gates.find((g) => g.id === 'automated')).toMatchObject({ state: 'fail', detail: '1 of 3 automated tests failed' });
  });
});

describe('release notes', () => {
  it('writes marked sections and refreshes known issues when Jira changes', async () => {
    const { flow, gh, build } = setup();
    await build(1838, 'sha1838');
    await flow.recordJira('4.12', [{ key: 'WEB-1', summary: 'Checkout fails', type: 'Bug', priority: 'Highest', status: 'To Do', blocker: true, url: 'https://jira.test/browse/WEB-1' }]);
    const s = parse(latestBody(gh));
    expect(Object.keys(s)).toEqual(['header', 'highlights', 'changes', 'known-issues', 'facts']);
    expect(s['known-issues']).toContain('[WEB-1](https://jira.test/browse/WEB-1) Checkout fails **(blocker)**');
    expect(s.facts).toContain('1 build on `release/4.12`');
  });

  it('retries the notes refresh on the next Jira poll if GitHub was down', async () => {
    const { flow, gh, build } = setup();
    await build(1838, 'sha1838');
    const bug = { key: 'WEB-1', summary: 'Checkout fails', type: 'Bug', priority: 'Highest', status: 'To Do', blocker: true, url: 'https://jira.test/browse/WEB-1' };
    const real = gh.getReleaseBody.bind(gh);
    gh.getReleaseBody = async () => { throw new Error('GitHub down'); };
    await expect(flow.recordJira('4.12', [bug])).rejects.toThrow('GitHub down');
    gh.getReleaseBody = real;
    await flow.recordJira('4.12', [bug]);
    expect(parse(latestBody(gh))['known-issues']).toContain('WEB-1');
  });

  it('keeps a section edited on GitHub, and carries it to the next build', async () => {
    const { flow, gh, build } = setup();
    await build(1838, 'sha1838');
    const rel = [...gh.releases.values()][0];
    rel.body = rel.body.replace(/_No highlights yet[^_]*_/, 'Faster checkout for everyone.');
    expect(editedOnGitHub(rel.body, flow.state.releases.get('4.12')!.notes.generated)).toHaveProperty('highlights');
    await build(1840, 'sha1840');
    expect(parse(latestBody(gh)).highlights).toBe('## Highlights\n\nFaster checkout for everyone.');
    expect(flow.state.releases.get('4.12')!.notes.locked.highlights.by).toBe('GitHub');
  });

  it('takes edits from the tool, can unlock them, and refuses tool-owned sections', async () => {
    const { flow, gh, build } = setup();
    await build(1838, 'sha1838');
    await flow.editNotes('4.12', 'highlights', '## Highlights\n\nNew invoices.', 'Toby');
    expect(parse(latestBody(gh)).highlights).toBe('## Highlights\n\nNew invoices.');
    await flow.editNotes('4.12', 'highlights', null, 'Toby');
    expect(parse(latestBody(gh)).highlights).toContain('No highlights yet');
    await expect(flow.editNotes('4.12', 'facts', 'x', 'Toby')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('links Jira keys of the configured project in the changes, and nothing else', async () => {
    const { gh, build } = setup();
    gh.generateNotes = async () => "## What's Changed\n* WEB-12 fix checkout by @dev in #4\n* Use UTF-8 everywhere";
    await build(1838, 'sha1838');
    const changes = parse(latestBody(gh)).changes;
    expect(changes).toContain('[WEB-12](https://jira.test/browse/WEB-12) fix checkout');
    expect(changes).toContain('Use UTF-8 everywhere');
  });
});

describe('readiness gates and the demo story', () => {
  it('goes Blocked on rc.1, then Ready on rc.2, and ships with release facts', async () => {
    const { flow, gh, build, deploy } = setup();
    const now = () => clock.now;
    const sources = { jira: new DemoIssues('WEB', 'https://jira.test', 20, now), zephyr: new DemoManualTests(20, now), telemetry: new DemoTelemetry(now) };
    await flow.importMatrix(plan);
    await build(1838, 'sha1838');
    await deploy('sha1838', 'qa');
    await deploy('sha1838', 'staging');
    clock.now = '2026-11-18T12:30:00.000Z'; // 30 minutes into testing: every planned test has run
    await pollOnce(flow, sources, gh, cfg);
    let r = flow.state.releases.get('4.12')!;
    let ready = flow.readinessOf(r);
    expect(ready.status).toBe('blocked');
    expect(ready.reason).toMatch(/1 blocker open: WEB-\d+/);
    expect(ready.gates.find((g) => g.id === 'tests')).toMatchObject({ state: 'fail', detail: '2 matrix tests failed' });
    expect(ready.gates.find((g) => g.id === 'errors')!.state).toBe('fail');
    await expect(flow.ship('4.12', 'Slaybol')).rejects.toThrow(/not ready to ship: 1 blocker/);

    await build(1840, 'sha1840');
    await deploy('sha1840', 'qa');
    await deploy('sha1840', 'staging');
    await pollOnce(flow, sources, gh, cfg);
    r = flow.state.releases.get('4.12')!;
    expect(flow.readinessOf(r).status).toBe('testing'); // rc.2's matrix pass has just started
    clock.now = '2026-11-18T13:00:00.000Z';
    await pollOnce(flow, sources, gh, cfg);
    expect(flow.readinessOf(r).gates.find((g) => g.id === 'automated')!.state).toBe('pending');
    await flow.recordTests('4.12', { source: 'actions', buildId: 'b1840', label: 'Build run 1840', results: [{ testId: 't', name: 't', outcome: 'pass', durationMs: 1, at: 'x' }] });
    ready = flow.readinessOf(r);
    expect(ready).toMatchObject({ status: 'ready', reason: 'Every readiness gate passes' });

    const detail = releaseDetail(flow, '4.12', clock.now, { jira: false, zephyr: false, telemetry: false, jiraProject: 'WEB' })!;
    expect(detail.matrix!.configs).toHaveLength(11);
    expect(detail.lanes.lanes.map((l) => l.name)).toEqual(['qa', 'staging']);
    expect(detail.lanes.lanes[0].bars.map((b) => [b.build, b.current])).toEqual([['b1838', false], ['b1840', true]]);

    await flow.ship('4.12', 'Slaybol');
    const shipped = [...gh.releases.values()].find((x) => x.tag === 'v4.12.0')!;
    expect(shipped.latest).toBe(true);
    expect(parse(shipped.body).facts).toMatch(/209 of 209 planned matrix tests passed; 11 of 11 configurations complete[\s\S]*Shipped by Slaybol/);
  });

  it('blocks on a dependency until it is published on GitHub', async () => {
    const { flow, gh, build, deploy } = setup();
    const deps = { ...cfg, gates: { ...cfg.gates, dependencies: [{ name: 'Billing API 2.8', repo: 'acme/billing', tag: 'v2.8.0' }] } };
    const f = new ReleaseFlow(deps, gh, new MemoryStore(), () => clock.now);
    await f.handleWebhook('workflow_run', 'dep1', { action: 'completed', workflow_run: { id: 1, run_number: 1, name: 'Build', conclusion: 'success', head_branch: 'release/4.12', head_sha: 's1' } });
    await f.handleWebhook('deployment_status', 'dep2', { deployment_status: { state: 'success' }, deployment: { sha: 's1', environment: 'qa' } });
    await pollOnce(f, { jira: { live: false, issues: async () => [] }, zephyr: { live: false, results: async () => null }, telemetry: { live: false, read: async () => null } }, gh, deps);
    expect(f.readinessOf(f.state.releases.get('4.12')!)).toMatchObject({ status: 'blocked', reason: 'Waiting on Billing API 2.8' });
    gh.published.add('acme/billing@v2.8.0');
    await pollOnce(f, { jira: { live: false, issues: async () => [] }, zephyr: { live: false, results: async () => null }, telemetry: { live: false, read: async () => null } }, gh, deps);
    expect(f.readinessOf(f.state.releases.get('4.12')!).status).toBe('testing');
    void flow; void build; void deploy;
  });
});
