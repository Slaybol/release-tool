import type { Config } from './config.ts';
import type { ReleaseFlow } from './flow.ts';
import type { GitHubClient } from './github.ts';
import type { Sources } from './integrations/types.ts';

// Pulls Jira, Zephyr and telemetry for every release in flight, and checks dependencies on GitHub.
// Unchanged snapshots are dropped by the flow, so polling often costs nothing in the event log.
export async function pollOnce(flow: ReleaseFlow, sources: Sources, gh: GitHubClient, cfg: Pick<Config, 'gates'>): Promise<void> {
  for (const release of [...flow.state.releases.values()]) {
    if (release.status === 'shipped') continue;
    await guard('jira', async () => flow.recordJira(release.line, await sources.jira.issues(release)));
    const build = release.builds.find((b) => b.id === release.candidateId);
    if (!build) continue;
    await guard('zephyr', async () => {
      const r = await sources.zephyr.results(release, build, flow.state.matrix);
      if (r) await flow.recordTests(release.line, { source: 'zephyr', buildId: build.id, label: r.label, results: r.results });
    });
    await guard('telemetry', async () => {
      const t = await sources.telemetry.read(release, build);
      if (t) await flow.recordTelemetry(release.line, build.id, t);
    });
  }
  for (const d of cfg.gates.dependencies) {
    await guard('dependencies', async () => flow.setDependencyPublished(`${d.repo}@${d.tag}`, await gh.isPublished(d.repo, d.tag)));
  }
}

async function guard(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (err: any) { console.error(`[poll:${name}]`, err?.message ?? err); }
}
