import type { ReleaseFlow } from './flow.ts';
import type { GitHubClient } from './github.ts';

// Catch anything the webhooks missed (the service was down, a delivery failed):
// every release/x.xx branch gets a release, and its latest successful build is recorded if it is new.
export async function reconcile(flow: ReleaseFlow, gh: GitHubClient, buildWorkflow: string): Promise<void> {
  for (const branch of await gh.listReleaseBranches()) {
    await flow.ensureBranch(branch);
    const run = await gh.latestSuccessfulRun(branch, buildWorkflow);
    if (run) await flow.recordBuild(run);
  }
}
