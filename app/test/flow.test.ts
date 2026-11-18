import { describe, expect, it } from 'vitest';
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
  async latestSuccessfulRun(branch: string) {
    return branch === 'release/4.13' ? { id: 900, runNumber: 1900, url: 'https://github.test/runs/900', sha: 'sha4130', branch, actor: 'dev', createdAt: '2026-11-18T10:00:00Z', workflowName: 'Build' } : undefined;
  }
}

const cfg = { productName: 'Web app', buildWorkflow: 'Build', testEnvironments: ['qa', 'staging'], releaseOwners: ['slaybol'] };
let delivery = 0;

function setup() {
  const gh = new FakeGitHub();
  const store = new MemoryStore();
  const flow = new ReleaseFlow(cfg, gh, store, () => '2026-11-18T12:00:00.000Z');
  const send = (name: string, payload: any) => flow.handleWebhook(name, `d${++delivery}`, payload);
  const build = (runNumber: number, sha: string, branch = 'release/4.12', extra: any = {}) => send('workflow_run', {
    action: 'completed',
    workflow_run: { id: runNumber * 10, run_number: runNumber, name: 'Build', conclusion: 'success', head_branch: branch, head_sha: sha, html_url: `https://github.test/runs/${runNumber}`, actor: { login: 'dev' }, updated_at: '2026-11-18T11:00:00Z', ...extra }
  });
  const deploy = (sha: string, environment: string) => send('deployment_status', { deployment_status: { state: 'success' }, deployment: { sha, environment } });
  return { gh, store, flow, send, build, deploy };
}

describe('build pickup', () => {
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

  it('lets a release owner ship: final version tag, not a pre-release, marked latest', async () => {
    const { flow, gh, build, deploy } = setup();
    await build(1838, 'sha1838');
    await deploy('sha1838', 'qa');
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
    const v = releasesView(flow.state, '2026-11-18T14:00:00.000Z');
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
    const again = new ReleaseFlow(cfg, gh, store);
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
