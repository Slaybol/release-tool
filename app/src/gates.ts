import type { Config } from './config.ts';
import { coverage, latestResults } from './matrix.ts';
import type { DisplayStatus, MatrixPlan, Release } from './model.ts';
import { openBugs } from './notes.ts';

export type GateState = 'pass' | 'fail' | 'pending';
export interface Gate { id: string; label: string; state: GateState; detail: string }

export interface Readiness {
  status: DisplayStatus;
  gates: Gate[];
  reason: string; // one line: why the release has this status
}

// Readiness is derived, never typed in. A candidate in test is:
//   Blocked  when a blocker bug is open or a dependency has not shipped,
//   At risk  when tests fail or errors exceed the threshold,
//   Ready    when every gate passes,
//   Testing  otherwise (gates still filling in).
export function readiness(r: Release, plan: MatrixPlan | undefined, cfg: Pick<Config, 'gates' | 'soakEnvironment'>, now: string, publishedTags: Set<string>): Readiness {
  const candidate = r.builds.find((b) => b.id === r.candidateId);
  const gates = candidate ? evaluate(r, candidate.id, plan, cfg, now, publishedTags) : [];
  if (r.status === 'shipped') return { status: 'shipped', gates, reason: `Shipped by ${r.shippedBy}` };
  if (r.status === 'building') return { status: 'building', gates, reason: candidate ? `${candidate.id} is not in a test environment yet` : 'Waiting for the first build' };
  const failing = gates.filter((g) => g.state === 'fail');
  const blockers = failing.filter((g) => g.id === 'bugs' || g.id === 'dependencies');
  if (blockers.length) return { status: 'blocked', gates, reason: blockers.map((g) => g.detail).join('; ') };
  if (failing.length) return { status: 'at-risk', gates, reason: failing.map((g) => g.detail).join('; ') };
  const pending = gates.filter((g) => g.state === 'pending');
  if (pending.length) return { status: 'testing', gates, reason: pending.map((g) => g.detail).join('; ') };
  return { status: 'ready', gates, reason: 'Every readiness gate passes' };
}

function evaluate(r: Release, buildId: string, plan: MatrixPlan | undefined, cfg: Pick<Config, 'gates' | 'soakEnvironment'>, now: string, publishedTags: Set<string>): Gate[] {
  const g = cfg.gates;
  const runs = r.testRuns.filter((t) => t.buildId === buildId);
  const gates: Gate[] = [];

  const auto = [...latestResults(runs.filter((t) => t.source === 'actions')).values()];
  const autoFail = auto.filter((t) => t.outcome === 'fail').length;
  gates.push(auto.length === 0
    ? { id: 'automated', label: 'Automated tests', state: 'pending', detail: 'No GitHub Actions test results yet' }
    : { id: 'automated', label: 'Automated tests', state: autoFail ? 'fail' : 'pass', detail: autoFail ? `${autoFail} of ${auto.length} automated tests failed` : `${auto.length} of ${auto.length} automated tests passed` });

  const cov = coverage(plan, runs.filter((t) => t.source === 'zephyr'));
  if (cov) {
    const pct = cov.planned ? Math.round((cov.executed / cov.planned) * 100) : 0;
    const state: GateState = cov.fail ? 'fail' : pct >= g.testTargetPct ? 'pass' : 'pending';
    gates.push({ id: 'tests', label: 'Matrix tests', state, detail: cov.fail ? `${cov.fail} matrix tests failed` : `${pct}% of ${cov.planned} planned matrix tests executed (target ${g.testTargetPct}%)` });
    const required = plan!.cells.filter((c) => c.level === 'Required').length;
    const reqPassed = required - countRequiredNotPassed(plan!, runs.filter((t) => t.source === 'zephyr'));
    gates.push({ id: 'matrix', label: 'Matrix coverage', state: reqPassed === required ? 'pass' : cov.requiredFailed ? 'fail' : 'pending', detail: `${cov.completeConfigs} of ${cov.configs.length} configurations complete · ${reqPassed} of ${required} required cells passed` });
  }

  const blockers = openBugs(r.jira).filter((i) => i.blocker);
  gates.push(r.jiraAt === undefined
    ? { id: 'bugs', label: 'Blocker bugs', state: 'pending', detail: 'Waiting for Jira' }
    : { id: 'bugs', label: 'Blocker bugs', state: blockers.length ? 'fail' : 'pass', detail: blockers.length ? `${blockers.length} blocker${blockers.length > 1 ? 's' : ''} open: ${blockers.map((b) => b.key).join(', ')}` : 'No open blockers' });

  const t = r.telemetry[buildId];
  gates.push(!t
    ? { id: 'errors', label: 'Error rate', state: 'pending', detail: 'No error data for this build yet' }
    : { id: 'errors', label: 'Error rate', state: t.errorsPerHour > g.errorThreshold ? 'fail' : 'pass', detail: `${t.errorsPerHour} errors per hour (threshold ${g.errorThreshold})` });

  const soak = r.deployments.find((d) => d.buildId === buildId && d.environment === cfg.soakEnvironment && !d.endedAt);
  const soakHours = soak ? (Date.parse(now) - Date.parse(soak.startedAt)) / 36e5 : 0;
  gates.push({ id: 'soak', label: `Soak in ${cfg.soakEnvironment}`, state: soak && soakHours >= g.soakHours ? 'pass' : 'pending', detail: soak ? `${fmtHours(soakHours)} of ${fmtHours(g.soakHours)} in ${cfg.soakEnvironment}` : `Not in ${cfg.soakEnvironment} yet` });

  const missing = g.dependencies.filter((d) => !publishedTags.has(`${d.repo}@${d.tag}`));
  gates.push({ id: 'dependencies', label: 'Dependencies', state: missing.length ? 'fail' : 'pass', detail: g.dependencies.length === 0 ? 'No dependencies configured' : missing.length ? `Waiting on ${missing.map((d) => d.name).join(', ')}` : 'All dependencies shipped' });
  return gates;
}

function countRequiredNotPassed(plan: MatrixPlan, runs: Release['testRuns']) {
  const latest = latestResults(runs);
  return plan.cells.filter((c) => c.level === 'Required' && latest.get(`${c.testId}@${c.configId}`)?.outcome !== 'pass').length;
}

export function fmtHours(h: number) {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  return `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h`;
}
