import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { Config } from './config.ts';

export interface CreatedRelease { id: number; url: string; tag: string }

// The small slice of GitHub the flow needs. Tests use a fake.
export interface GitHubClient {
  createRelease(o: { tag: string; sha: string; name: string; body: string; draft: boolean; prerelease: boolean }): Promise<CreatedRelease>;
  updateRelease(id: number, o: { tag?: string; sha?: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; makeLatest?: boolean }): Promise<CreatedRelease>;
  deleteRelease(id: number): Promise<void>;
  getReleaseBody(id: number): Promise<string>;
  latestPublishedTag(): Promise<string | undefined>;
  generateNotes(o: { tag: string; sha: string; previousTag?: string }): Promise<string>;
  listReleaseBranches(): Promise<string[]>;
  latestSuccessfulRun(branch: string, workflowName: string): Promise<RunInfo | undefined>;
  listArtifacts(runId: number): Promise<{ id: number; name: string }[]>;
  downloadArtifact(id: number): Promise<Uint8Array>;
  isPublished(repo: string, tag: string): Promise<boolean>;
}

export interface RunInfo { id: number; runNumber: number; url: string; sha: string; branch: string; actor: string; createdAt: string; workflowName: string }

export function octokitFor(cfg: Config): Octokit {
  if (cfg.appId && cfg.privateKey && cfg.installationId) {
    return new Octokit({ authStrategy: createAppAuth, auth: { appId: cfg.appId, privateKey: cfg.privateKey, installationId: cfg.installationId } });
  }
  if (cfg.token) return new Octokit({ auth: cfg.token });
  throw new Error('Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_INSTALLATION_ID, or GITHUB_TOKEN.');
}

export class OctokitGitHub implements GitHubClient {
  constructor(private gh: Octokit, private owner: string, private repo: string) {}

  private get r() { return { owner: this.owner, repo: this.repo }; }

  async createRelease(o: { tag: string; sha: string; name: string; body: string; draft: boolean; prerelease: boolean }) {
    const { data } = await this.gh.repos.createRelease({ ...this.r, tag_name: o.tag, target_commitish: o.sha, name: o.name, body: o.body, draft: o.draft, prerelease: o.prerelease, make_latest: 'false' });
    return { id: data.id, url: data.html_url, tag: data.tag_name };
  }

  async updateRelease(id: number, o: { tag?: string; sha?: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; makeLatest?: boolean }) {
    const { data } = await this.gh.repos.updateRelease({
      ...this.r, release_id: id, tag_name: o.tag, target_commitish: o.sha, name: o.name, body: o.body, draft: o.draft, prerelease: o.prerelease,
      make_latest: o.makeLatest === undefined ? undefined : o.makeLatest ? 'true' : 'false'
    });
    return { id: data.id, url: data.html_url, tag: data.tag_name };
  }

  async deleteRelease(id: number) {
    await this.gh.repos.deleteRelease({ ...this.r, release_id: id });
  }

  async getReleaseBody(id: number) {
    const { data } = await this.gh.repos.getRelease({ ...this.r, release_id: id });
    return data.body ?? '';
  }

  async latestPublishedTag() {
    try {
      const { data } = await this.gh.repos.getLatestRelease(this.r);
      return data.tag_name;
    } catch (err: any) {
      if (err?.status === 404) return undefined;
      throw err;
    }
  }

  async generateNotes(o: { tag: string; sha: string; previousTag?: string }) {
    const { data } = await this.gh.repos.generateReleaseNotes({ ...this.r, tag_name: o.tag, target_commitish: o.sha, previous_tag_name: o.previousTag });
    return data.body;
  }

  async listReleaseBranches() {
    const branches = await this.gh.paginate(this.gh.repos.listBranches, { ...this.r, per_page: 100 });
    return branches.map((b) => b.name).filter((n) => /^release\//i.test(n));
  }

  async latestSuccessfulRun(branch: string, workflowName: string) {
    const { data } = await this.gh.actions.listWorkflowRunsForRepo({ ...this.r, branch, status: 'success', per_page: 20 });
    const run = data.workflow_runs.find((w) => w.name === workflowName);
    if (!run) return undefined;
    return { id: run.id, runNumber: run.run_number, url: run.html_url, sha: run.head_sha, branch, actor: run.triggering_actor?.login ?? run.actor?.login ?? 'unknown', createdAt: run.updated_at, workflowName: run.name ?? workflowName };
  }

  async listArtifacts(runId: number) {
    const { data } = await this.gh.actions.listWorkflowRunArtifacts({ ...this.r, run_id: runId, per_page: 100 });
    return data.artifacts.filter((a) => !a.expired).map((a) => ({ id: a.id, name: a.name }));
  }

  async downloadArtifact(id: number) {
    const { data } = await this.gh.actions.downloadArtifact({ ...this.r, artifact_id: id, archive_format: 'zip' });
    return new Uint8Array(data as ArrayBuffer);
  }

  // A dependency counts as shipped when that repository has a published, non-draft release with the tag.
  async isPublished(repo: string, tag: string) {
    const [owner, name] = repo.split('/');
    try {
      const { data } = await this.gh.repos.getReleaseByTag({ owner, repo: name, tag });
      return !data.draft && !data.prerelease;
    } catch (err: any) {
      if (err?.status === 404) return false;
      throw err;
    }
  }
}
