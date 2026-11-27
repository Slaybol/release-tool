import type { DomainEvent, MatrixPlan, Release } from './model.ts';

// In-memory projection of the event log. apply() must stay pure and deterministic,
// because the same events are replayed on every start.
export class State {
  releases = new Map<string, Release>();
  matrix?: MatrixPlan;
  // Deployments that arrived before the build they belong to (keyed by commit SHA).
  pendingDeploys = new Map<string, { environment: string; at: string }[]>();

  apply(e: DomainEvent): void {
    if (e.type === 'matrix.imported') { this.matrix = e.plan; return; }
    if (e.type === 'release.created') {
      if (!this.releases.has(e.line)) {
        this.releases.set(e.line, {
          line: e.line, branch: e.branch, name: e.name, status: 'building', createdAt: e.at,
          builds: [], deployments: [], history: [], testRuns: [], jira: [], telemetry: {},
          notes: { generated: {}, locked: {} }
        });
      }
      return;
    }
    const r = this.releases.get(e.line);
    if (!r) return;
    switch (e.type) {
      case 'build.created':
        r.builds.push(e.build);
        r.candidateId = e.build.id;
        r.firstTestAt = undefined;
        break;
      case 'deployment.recorded':
        for (const d of r.deployments) {
          if (d.environment === e.environment && !d.endedAt && d.buildId !== e.buildId) d.endedAt = e.at;
        }
        if (!r.deployments.some((d) => d.environment === e.environment && d.buildId === e.buildId && !d.endedAt)) {
          r.deployments.push({ buildId: e.buildId, environment: e.environment, startedAt: e.at });
        }
        break;
      case 'status.changed':
        if (e.status === 'testing' && r.status !== 'testing') r.firstTestAt = e.at;
        r.status = e.status;
        break;
      case 'ghrelease.set':
        r.gh = e.gh;
        break;
      case 'ghrelease.superseded':
        r.history.unshift(e.gh);
        if (r.gh && r.gh.id === e.gh.id) r.gh = undefined;
        break;
      case 'release.shipped':
        r.status = 'shipped';
        r.gh = e.gh;
        r.shippedAt = e.at;
        r.shippedBy = e.by;
        break;
      case 'tests.recorded':
        r.testRuns.push(e.run);
        break;
      case 'jira.snapshot':
        r.jira = e.issues;
        r.jiraAt = e.at;
        break;
      case 'telemetry.snapshot':
        r.telemetry[e.telemetry.buildId] = e.telemetry;
        break;
      case 'notes.generated':
        r.notes.generated = { ...r.notes.generated, ...e.sections };
        break;
      case 'notes.edited':
        if (e.text === null) delete r.notes.locked[e.section];
        else r.notes.locked[e.section] = { text: e.text, by: e.by, at: e.at };
        break;
    }
  }

  findBuildBySha(sha: string): { release: Release; buildId: string } | undefined {
    for (const r of this.releases.values()) {
      for (let i = r.builds.length - 1; i >= 0; i--) {
        if (r.builds[i].sha === sha) return { release: r, buildId: r.builds[i].id };
      }
    }
    return undefined;
  }
}
