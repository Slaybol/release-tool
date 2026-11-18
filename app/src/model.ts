// Records the tool keeps. Everything here is rebuilt from the event log on start.

export type Lifecycle = 'building' | 'testing' | 'shipped';
// What people see: the lifecycle, refined by the readiness gates while a candidate is in test.
export type DisplayStatus = 'building' | 'testing' | 'at-risk' | 'blocked' | 'ready' | 'shipped';

export interface GhRelease {
  id: number;
  tag: string;
  url: string;
  state: 'draft' | 'prerelease' | 'released';
  buildId: string;
}

export interface Build {
  id: string; // b<run number>, for example b1842
  runId: number;
  runUrl: string;
  sha: string;
  version: string; // 4.12.0-rc.3
  createdAt: string;
  actor: string;
}

export interface Deployment {
  buildId: string;
  environment: string;
  startedAt: string;
  endedAt?: string; // set when another build replaces it in the environment
}

export type TestOutcome = 'pass' | 'fail' | 'blocked' | 'skipped';

export interface TestResult {
  testId: string; // matrix test ID (Zephyr) or suite and test name (GitHub Actions)
  name: string;
  configId?: string; // matrix configuration, for hardware and software matrix tests
  outcome: TestOutcome;
  durationMs: number;
  at: string;
  issue?: string; // Jira key linked to a failure
}

export type TestSource = 'actions' | 'zephyr';

export interface TestRun {
  source: TestSource;
  buildId: string;
  results: TestResult[];
  at: string;
  label: string; // workflow name or Zephyr cycle
}

export interface JiraIssue {
  key: string;
  summary: string;
  type: string;
  priority: string;
  status: string;
  blocker: boolean;
  url: string;
}

export interface Telemetry {
  buildId: string;
  users: number;
  sessions: number;
  sessionHours: number;
  errorsPerHour: number;
  at: string;
}

export interface MatrixPlan {
  source: string;
  importedAt: string;
  configs: { id: string; product: string; description: string; os: string }[];
  tests: { id: string; category: string; name: string }[];
  // Planned cells: Required and Smoke tests for each configuration. Optional cells are not planned.
  cells: { testId: string; configId: string; level: 'Required' | 'Smoke' }[];
}

export interface NotesState {
  generated: Record<string, string>; // what the tool last wrote for each section
  locked: Record<string, { text: string; by: string; at: string }>; // sections someone edited
}

export interface Release {
  line: string; // 4.12
  branch: string; // release/4.12
  name: string; // Web app 4.12
  status: Lifecycle;
  createdAt: string;
  builds: Build[];
  candidateId?: string;
  deployments: Deployment[];
  gh?: GhRelease;
  history: GhRelease[]; // superseded GitHub releases, newest first
  firstTestAt?: string; // when the current candidate first reached a test environment
  shippedAt?: string;
  shippedBy?: string;
  testRuns: TestRun[];
  jira: JiraIssue[];
  jiraAt?: string;
  telemetry: Record<string, Telemetry>; // by build id
  notes: NotesState;
}

// Domain events. Raw webhooks are logged separately, these are what the state is built from.
export type DomainEvent =
  | { type: 'release.created'; at: string; line: string; branch: string; name: string }
  | { type: 'build.created'; at: string; line: string; build: Build }
  | { type: 'deployment.recorded'; at: string; line: string; buildId: string; environment: string }
  | { type: 'status.changed'; at: string; line: string; status: Lifecycle }
  | { type: 'ghrelease.set'; at: string; line: string; gh: GhRelease }
  | { type: 'ghrelease.superseded'; at: string; line: string; gh: GhRelease; deleted: boolean }
  | { type: 'release.shipped'; at: string; line: string; by: string; gh: GhRelease }
  | { type: 'tests.recorded'; at: string; line: string; run: TestRun }
  | { type: 'jira.snapshot'; at: string; line: string; issues: JiraIssue[] }
  | { type: 'telemetry.snapshot'; at: string; line: string; telemetry: Telemetry }
  | { type: 'notes.generated'; at: string; line: string; sections: Record<string, string> }
  | { type: 'notes.edited'; at: string; line: string; section: string; text: string | null; by: string }
  | { type: 'matrix.imported'; at: string; plan: MatrixPlan };
