import type { Build, JiraIssue, MatrixPlan, Release, TestResult } from '../model.ts';

// Each integration answers for one release (and its candidate build). A source is either the
// real service or a deterministic demo stand-in, so the same pages work before anything is connected.
export interface IssueSource {
  readonly live: boolean;
  issues(release: Release): Promise<JiraIssue[]>;
}

export interface ManualTestSource {
  readonly live: boolean;
  // Results of manual and hardware runs against this build, keyed to matrix test IDs and configs.
  results(release: Release, build: Build, plan: MatrixPlan | undefined): Promise<{ label: string; results: TestResult[] } | null>;
}

export interface TelemetrySource {
  readonly live: boolean;
  read(release: Release, build: Build): Promise<{ users: number; sessions: number; sessionHours: number; errorsPerHour: number } | null>;
}

export interface Sources {
  jira: IssueSource;
  zephyr: ManualTestSource;
  telemetry: TelemetrySource;
}
