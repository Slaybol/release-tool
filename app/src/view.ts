import type { Release } from './model.ts';
import type { State } from './state.ts';

// The shape the home page reads from /api/releases.
export function releasesView(state: State, nowIso: string) {
  const now = Date.parse(nowIso);
  const all = [...state.releases.values()].sort((a, b) => compareLines(b.line, a.line));
  const inFlight = all.filter((r) => r.status !== 'shipped');
  const shipped = all.filter((r) => r.status === 'shipped');

  const environments = new Map<string, { release: string; build: string; status: string }[]>();
  for (const r of inFlight) {
    for (const d of r.deployments) {
      if (d.endedAt) continue;
      const list = environments.get(d.environment) ?? [];
      list.push({ release: r.name, build: d.buildId, status: r.status });
      environments.set(d.environment, list);
    }
  }

  return {
    generatedAt: nowIso,
    inFlight: inFlight.map((r) => one(r, now)),
    shipped: shipped.map((r) => one(r, now)),
    environments: [...environments.entries()].map(([name, items]) => ({ name, items }))
  };
}

function one(r: Release, now: number) {
  const candidate = r.builds.find((b) => b.id === r.candidateId);
  return {
    line: r.line,
    name: r.name,
    branch: r.branch,
    status: r.status,
    candidate: candidate ? { id: candidate.id, version: candidate.version, sha: candidate.sha, runUrl: candidate.runUrl, createdAt: candidate.createdAt } : null,
    buildCount: r.builds.length,
    builds: [...r.builds].reverse().map((b) => ({ id: b.id, version: b.version, createdAt: b.createdAt, runUrl: b.runUrl })),
    environments: r.deployments.filter((d) => !d.endedAt).map((d) => ({ name: d.environment, build: d.buildId, since: d.startedAt })),
    timeInTestMs: r.firstTestAt ? now - Date.parse(r.firstTestAt) : null,
    githubRelease: r.gh ?? null,
    supersededReleases: r.history,
    shippedAt: r.shippedAt ?? null,
    shippedBy: r.shippedBy ?? null
  };
}

function compareLines(a: string, b: string) {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}
