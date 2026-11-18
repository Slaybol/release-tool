import type { Config } from '../config.ts';
import type { JiraIssue, TestOutcome, TestResult } from '../model.ts';
import type { IssueSource, ManualTestSource, TelemetrySource } from './types.ts';

// Jira Cloud: open and recently changed issues on the release's fix version.
export class JiraSource implements IssueSource {
  readonly live = true;
  constructor(private cfg: Config['jira']) {}

  async issues(release: { line: string }): Promise<JiraIssue[]> {
    const fix = this.cfg.fixVersion.replace('{line}', release.line);
    const jql = `project = "${this.cfg.project}" AND fixVersion = "${fix}" ORDER BY priority DESC, key ASC`;
    const url = `${this.cfg.baseUrl!.replace(/\/$/, '')}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,issuetype,priority,status,labels&maxResults=100`;
    const res = await fetch(url, { headers: { authorization: 'Basic ' + Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64'), accept: 'application/json' } });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    return (data.issues ?? []).map((i: any) => ({
      key: i.key,
      summary: i.fields.summary,
      type: i.fields.issuetype?.name ?? 'Issue',
      priority: i.fields.priority?.name ?? 'Medium',
      status: i.fields.status?.statusCategory?.key === 'done' ? 'Done' : i.fields.status?.name ?? 'Open',
      blocker: /highest|blocker/i.test(i.fields.priority?.name ?? '') || (i.fields.labels ?? []).includes('blocker'),
      url: `${this.cfg.baseUrl!.replace(/\/$/, '')}/browse/${i.key}`
    }));
  }
}

// Zephyr Scale Cloud: executions in test cycles named for the build (its version or build id).
// Test cases are matched to matrix tests by the test ID at the start of their name ("PRV-01 Zero-touch…")
// and executions to configurations by their environment name ("PN1-A").
export class ZephyrSource implements ManualTestSource {
  readonly live = true;
  private cache = new Map<string, string>();
  constructor(private cfg: Config['zephyr']) {}

  private async get(path: string): Promise<any> {
    const url = path.startsWith('http') ? path : `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.cfg.apiToken}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Zephyr ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async name(self: string | undefined, field: 'name' | 'key'): Promise<string> {
    if (!self) return '';
    if (!this.cache.has(self)) {
      const v = await this.get(self);
      this.cache.set(self, field === 'key' ? `${v.key} ${v.name ?? ''}` : v.name ?? '');
    }
    return this.cache.get(self)!;
  }

  async results(_release: unknown, build: { id: string; version: string }) {
    const cycles = await this.get(`/testcycles?projectKey=${encodeURIComponent(this.cfg.project)}&maxResults=200`);
    const mine = (cycles.values ?? []).filter((c: any) => c.name?.includes(build.version) || new RegExp(`\\b${build.id}\\b`).test(c.name ?? ''));
    if (!mine.length) return null;
    const results: TestResult[] = [];
    for (const cycle of mine) {
      const ex = await this.get(`/testexecutions?projectKey=${encodeURIComponent(this.cfg.project)}&testCycle=${encodeURIComponent(cycle.key)}&maxResults=1000`);
      for (const e of ex.values ?? []) {
        const status = (await this.name(e.testExecutionStatus?.self, 'name')).toLowerCase();
        const outcome: TestOutcome | undefined = status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : status === 'blocked' ? 'blocked' : undefined;
        if (!outcome) continue; // not executed or in progress
        const tc = await this.name(e.testCase?.self, 'key');
        const testId = /\b([A-Z]{2,}-\d{2,})\b/.exec(tc.split(' ').slice(1).join(' '))?.[1] ?? tc.split(' ')[0];
        results.push({
          testId, name: tc.split(' ').slice(1).join(' ') || testId,
          configId: (await this.name(e.environment?.self, 'name')) || undefined,
          outcome, durationMs: e.executionTime ?? 0, at: e.actualEndDate ?? new Date().toISOString(),
          issue: undefined
        });
      }
    }
    return { label: mine.map((c: any) => c.name).join(', '), results };
  }
}

// Elastic APM: real user sessions (RUM) and errors for the build's service.version.
export class ElasticSource implements TelemetrySource {
  readonly live = true;
  constructor(private cfg: Config['elastic']) {}

  private async search(index: string, body: unknown) {
    const res = await fetch(`${this.cfg.url!.replace(/\/$/, '')}/${index}/_search`, {
      method: 'POST', headers: { authorization: `ApiKey ${this.cfg.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Elastic ${res.status}: ${await res.text()}`);
    return res.json() as Promise<any>;
  }

  async read(_release: unknown, build: { version: string }) {
    const filter = [{ term: { 'service.name': this.cfg.service } }, { term: { 'service.version': build.version } }];
    const rum = await this.search(this.cfg.rumIndex, {
      size: 0, query: { bool: { filter } },
      aggs: {
        users: { cardinality: { field: 'user.id' } },
        sessions: { terms: { field: 'session.id', size: 10000 }, aggs: { first: { min: { field: '@timestamp' } }, last: { max: { field: '@timestamp' } } } }
      }
    });
    const buckets = rum.aggregations?.sessions?.buckets ?? [];
    const ms = buckets.reduce((a: number, b: any) => a + Math.max(0, (b.last?.value ?? 0) - (b.first?.value ?? 0)), 0);
    const errors = await this.search(this.cfg.errorIndex, { size: 0, track_total_hits: true, query: { bool: { filter: [...filter, { range: { '@timestamp': { gte: 'now-1h' } } }] } } });
    return { users: rum.aggregations?.users?.value ?? 0, sessions: buckets.length, sessionHours: Math.round(ms / 36e5 * 10) / 10, errorsPerHour: errors.hits?.total?.value ?? 0 };
  }
}
