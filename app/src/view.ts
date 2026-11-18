import type { ReleaseFlow } from './flow.ts';
import { coverage, latestResults } from './matrix.ts';
import type { Release } from './model.ts';
import { EDITABLE, merge, SECTION_TITLES, SECTIONS, openBugs } from './notes.ts';

export interface SourceInfo { jira: boolean; zephyr: boolean; telemetry: boolean; jiraProject: string }

// The shape the home page reads from /api/releases.
export function releasesView(flow: ReleaseFlow, nowIso: string, sources: SourceInfo) {
  const all = [...flow.state.releases.values()].sort((a, b) => compareLines(b.line, a.line));
  const inFlight = all.filter((r) => r.status !== 'shipped');
  const shipped = all.filter((r) => r.status === 'shipped');

  const environments = new Map<string, { release: string; line: string; build: string; status: string }[]>();
  for (const r of inFlight) {
    const status = flow.readinessOf(r).status;
    for (const d of r.deployments) {
      if (d.endedAt) continue;
      const list = environments.get(d.environment) ?? [];
      list.push({ release: r.name, line: r.line, build: d.buildId, status });
      environments.set(d.environment, list);
    }
  }

  return {
    generatedAt: nowIso,
    sources,
    matrix: flow.state.matrix ? { source: flow.state.matrix.source, configs: flow.state.matrix.configs.length, planned: flow.state.matrix.cells.length } : null,
    inFlight: inFlight.map((r) => summary(flow, r, nowIso)),
    shipped: shipped.map((r) => summary(flow, r, nowIso)),
    environments: [...environments.entries()].map(([name, items]) => ({ name, items }))
  };
}

function summary(flow: ReleaseFlow, r: Release, nowIso: string) {
  const now = Date.parse(nowIso);
  const candidate = r.builds.find((b) => b.id === r.candidateId);
  const runs = candidate ? r.testRuns.filter((t) => t.buildId === candidate.id) : [];
  const auto = [...latestResults(runs.filter((t) => t.source === 'actions')).values()];
  const cov = coverage(flow.state.matrix, runs.filter((t) => t.source === 'zephyr'));
  const bugs = openBugs(r.jira).filter((i) => /bug/i.test(i.type));
  const ready = flow.readinessOf(r);
  const tel = candidate ? r.telemetry[candidate.id] : undefined;
  return {
    line: r.line,
    name: r.name,
    branch: r.branch,
    lifecycle: r.status,
    status: ready.status,
    reason: ready.reason,
    candidate: candidate ? { id: candidate.id, version: candidate.version, sha: candidate.sha, runUrl: candidate.runUrl, createdAt: candidate.createdAt } : null,
    buildCount: r.builds.length,
    environments: r.deployments.filter((d) => !d.endedAt).map((d) => ({ name: d.environment, build: d.buildId, since: d.startedAt })),
    timeInTestMs: r.firstTestAt ? now - Date.parse(r.firstTestAt) : null,
    tests: {
      automated: { total: auto.length, pass: auto.filter((t) => t.outcome === 'pass').length, fail: auto.filter((t) => t.outcome === 'fail').length },
      matrix: cov ? { planned: cov.planned, pass: cov.pass, fail: cov.fail, blocked: cov.blocked, notRun: cov.notRun, completeConfigs: cov.completeConfigs, configs: cov.configs.length } : null
    },
    jira: { open: bugs.length, blockers: bugs.filter((i) => i.blocker).length, synced: r.jiraAt ?? null },
    telemetry: tel ?? null,
    githubRelease: r.gh ?? null,
    supersededReleases: r.history,
    shippedAt: r.shippedAt ?? null,
    shippedBy: r.shippedBy ?? null
  };
}

// Everything the release page shows.
export function releaseDetail(flow: ReleaseFlow, line: string, nowIso: string, sources: SourceInfo) {
  const r = flow.state.releases.get(line);
  if (!r) return null;
  const base = summary(flow, r, nowIso);
  const ready = flow.readinessOf(r);
  const candidate = r.builds.find((b) => b.id === r.candidateId);
  const runs = candidate ? r.testRuns.filter((t) => t.buildId === candidate.id) : [];
  const auto = [...latestResults(runs.filter((t) => t.source === 'actions')).values()];
  const cov = coverage(flow.state.matrix, runs.filter((t) => t.source === 'zephyr'));
  const categories = flow.state.matrix ? [...new Set(flow.state.matrix.tests.map((t) => t.category))] : [];
  const latest = latestResults(runs.filter((t) => t.source === 'zephyr'));

  // Environment lanes: one bar per deployment, from when it arrived to when it was replaced (or now).
  const start = Math.min(Date.parse(r.createdAt), ...r.deployments.map((d) => Date.parse(d.startedAt)));
  const end = Date.parse(nowIso);
  const span = Math.max(1, end - start);
  const envNames = [...new Set(r.deployments.map((d) => d.environment))];
  const lanes = envNames.map((env) => ({
    name: env,
    bars: r.deployments.filter((d) => d.environment === env).map((d) => {
      const s = Date.parse(d.startedAt), e = d.endedAt ? Date.parse(d.endedAt) : end;
      return { build: d.buildId, left: ((s - start) / span) * 100, width: Math.max(0.8, ((e - s) / span) * 100), current: !d.endedAt, hours: (e - s) / 36e5, candidate: d.buildId === r.candidateId };
    })
  }));

  const fresh = r.notes.generated;
  const merged = merge(fresh as never, r.notes.locked);
  return {
    ...base,
    sources,
    gates: ready.gates,
    builds: [...r.builds].reverse().map((b) => ({ ...b, envs: [...new Set(r.deployments.filter((d) => d.buildId === b.id && !d.endedAt).map((d) => d.environment))], candidate: b.id === r.candidateId })),
    lanes: { start: new Date(start).toISOString(), end: nowIso, lanes },
    automatedFailures: auto.filter((t) => t.outcome === 'fail').map((t) => ({ testId: t.testId, name: t.name })),
    testRuns: runs.map((t) => ({ source: t.source, label: t.label, at: t.at, count: t.results.length, effortHours: Math.round(t.results.reduce((a, x) => a + x.durationMs, 0) / 36e5 * 10) / 10 })),
    matrix: cov && flow.state.matrix ? {
      source: flow.state.matrix.source,
      categories,
      configs: cov.configs.map((c) => ({
        ...c,
        cells: categories.map((cat) => {
          const cells = flow.state.matrix!.cells.filter((x) => x.configId === c.id && flow.state.matrix!.tests.find((t) => t.id === x.testId)?.category === cat);
          const res = cells.map((x) => latest.get(`${x.testId}@${x.configId}`)?.outcome);
          return { planned: cells.length, pass: res.filter((o) => o === 'pass').length, bad: res.filter((o) => o === 'fail' || o === 'blocked').length };
        })
      })),
      problems: cov.problems
    } : null,
    jiraIssues: r.jira,
    telemetryAll: Object.values(r.telemetry),
    notes: SECTIONS.filter((id) => merged[id]).map((id) => ({
      id, title: SECTION_TITLES[id], editable: EDITABLE.includes(id), text: merged[id],
      locked: r.notes.locked[id] ? { by: r.notes.locked[id].by, at: r.notes.locked[id].at } : null
    }))
  };
}

function compareLines(a: string, b: string) {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}
