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
    const candidate = release.builds.find((b) => b.id === release.candidateId);
    if (!candidate) return []; // nothing to file bugs against before the first build
    const onFirst = isFirstCandidate(candidate);
    const m = minutesSince(release.createdAt, this.now());
    const step = this.demoMinutes / 3;
    // Keys line up with the stories in each release's notes, so the pages tell one story.
    const known = LINES[release.line];
    const base = 2000 + (hash(release.line) % 800);
    const k = known ?? { blocker: [base, 'Checkout error rate rising in staging'], bugs: [[base + 1, 'Date picker ignores the browser locale'], [base + 2, 'Invoice history empty for accounts migrated last month'], [base + 3, 'Saved cart badge count off by one after sign-in']], stories: [] } as LineIssues;
    const issue = (key: number, summary: string, type: string, priority: string, done: boolean, blocker = false): JiraIssue => ({
      key: `${this.project}-${key}`, summary, type, priority, status: done ? 'Done' : key % 2 ? 'In Progress' : 'To Do', blocker: blocker && !done,
      url: `${this.baseUrl}/browse/${this.project}-${key}`
    });
    const [b1, b2, b3] = k.bugs;
    return [
      issue(k.blocker[0], k.blocker[1], 'Bug', 'Highest', !onFirst, true),
      issue(b1[0], b1[1], 'Bug', 'High', m > step),
      issue(b2[0], b2[1], 'Bug', 'Medium', m > 2 * step),
      issue(b3[0], b3[1], 'Bug', 'Low', false),
      ...k.stories.map(([key, summary]) => issue(key, summary, 'Story', 'Medium', true))
    ];
  }
}

interface LineIssues { blocker: [number, string]; bugs: [number, string][]; stories: [number, string][] }
// Demo Jira per release line. The stories match the simulated GitHub notes in demo/engine.ts, and the
// 4.13 blocker is the payments timeout the Integrations page shows.
const LINES: Record<string, LineIssues> = {
  '4.11': { blocker: [2108, 'Refund totals off by a cent in some currencies'], bugs: [[2109, 'Orders search ignores the date filter'], [2111, 'Order export missing the tax column'], [2112, 'Search results flicker while typing']], stories: [[2105, 'Faster search on the orders page']] },
  '4.12': { blocker: [2276, 'Invoice history fails for accounts on Billing API v1'], bugs: [[2277, 'Date picker ignores the browser locale'], [2279, 'Invoice history empty for accounts migrated last month'], [2281, 'Saved cart badge count off by one after sign-in']], stories: [[2270, 'Invoice history uses Billing API v2'], [2274, 'Saved carts sync across devices']] },
  '4.13': { blocker: [2318, 'Checkout times out against Payments partner API v3 under load'], bugs: [[2319, 'Card retry shows the error banner twice'], [2321, 'One-page checkout loses the coupon on refresh'], [2323, 'Order summary wraps badly on small screens']], stories: [[2311, 'One-page checkout'], [2316, 'Retry card payments on network errors']] }
};

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
