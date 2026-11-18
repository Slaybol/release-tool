import type { Build, JiraIssue, MatrixPlan, Release, TestResult } from '../model.ts';
import type { IssueSource, ManualTestSource, TelemetrySource } from './types.ts';

// Simulated Jira, Zephyr and Elastic for demos. Everything is a pure function of the release,
// the build and the clock, so the story plays out the same way every time:
//   rc.1 reaches test → tests start passing, two fail and one is blocked, errors climb past the threshold,
//   and a blocker bug is open → the release shows Blocked.
//   A new build (rc.2) fixes the blocker → its tests all pass over DEMO_MINUTES and errors stay low → Ready.

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const minutesSince = (iso: string | undefined, now: string) => (iso ? Math.max(0, (Date.parse(now) - Date.parse(iso)) / 60000) : 0);
const isFirstCandidate = (b: Build) => /-rc\.1$/.test(b.version);

export class DemoIssues implements IssueSource {
  readonly live = false;
  constructor(private project: string, private baseUrl: string, private demoMinutes: number, private now: () => string) {}

  async issues(release: Release): Promise<JiraIssue[]> {
    const base = 2000 + (hash(release.line) % 800);
    const m = minutesSince(release.createdAt, this.now());
    const candidate = release.builds.find((b) => b.id === release.candidateId);
    const onFirst = !candidate || isFirstCandidate(candidate);
    const issue = (n: number, summary: string, type: string, priority: string, done: boolean, blocker = false): JiraIssue => ({
      key: `${this.project}-${base + n}`, summary, type, priority, status: done ? 'Done' : n % 2 ? 'In Progress' : 'To Do', blocker: blocker && !done,
      url: `${this.baseUrl}/browse/${this.project}-${base + n}`
    });
    const step = this.demoMinutes / 3;
    return [
      issue(0, 'Checkout error rate rising in staging', 'Bug', 'Highest', !onFirst, true),
      issue(1, 'Date picker ignores the browser locale', 'Bug', 'High', m > step),
      issue(2, 'Invoice history empty for accounts migrated last month', 'Bug', 'Medium', m > 2 * step),
      issue(3, 'Saved cart badge count off by one after sign-in', 'Bug', 'Low', false),
      issue(4, 'Invoice history uses Billing API v2', 'Story', 'Medium', true),
      issue(5, 'Saved carts sync across devices', 'Story', 'Medium', true)
    ];
  }
}

export class DemoManualTests implements ManualTestSource {
  readonly live = false;
  constructor(private demoMinutes: number, private now: () => string) {}

  async results(release: Release, build: Build, plan: MatrixPlan | undefined) {
    if (!plan || build.id !== release.candidateId || !release.firstTestAt) return null;
    const frac = Math.min(1, minutesSince(release.firstTestAt, this.now()) / this.demoMinutes);
    const cells = [...plan.cells].sort((a, b) => hash(build.version + a.testId + a.configId) - hash(build.version + b.testId + b.configId));
    const done = Math.floor(frac * cells.length);
    const names = new Map(plan.tests.map((t) => [t.id, t.name]));
    const start = Date.parse(release.firstTestAt);
    const results: TestResult[] = cells.slice(0, done).map((c, i) => {
      let outcome: TestResult['outcome'] = 'pass';
      if (isFirstCandidate(build) && (i === 3 || i === 11)) outcome = 'fail';
      if (isFirstCandidate(build) && i === 7) outcome = 'blocked';
      return {
        testId: c.testId, name: names.get(c.testId) ?? c.testId, configId: c.configId, outcome,
        durationMs: (5 + (hash(c.testId + c.configId) % 35)) * 60000,
        at: new Date(start + ((i + 1) / cells.length) * this.demoMinutes * 60000).toISOString()
      };
    });
    return { label: `Demo cycle ${build.version}`, results };
  }
}

export class DemoTelemetry implements TelemetrySource {
  readonly live = false;
  constructor(private now: () => string) {}

  async read(release: Release, build: Build) {
    if (build.id !== release.candidateId || !release.firstTestAt) return null;
    const m = minutesSince(release.firstTestAt, this.now());
    const users = Math.min(64, Math.round(4 + m * 2));
    const sessions = Math.round(users * 2.6);
    const errorsPerHour = isFirstCandidate(build) ? Math.min(14, Math.round(5 + m * 0.5)) : 2 + (hash(build.version) % 3);
    return { users, sessions, sessionHours: Math.round(sessions * 0.35 * 10) / 10, errorsPerHour };
  }
}
