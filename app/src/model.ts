// Records the tool keeps. Everything here is rebuilt from the event log on start.

export type ReleaseStatus = 'building' | 'testing' | 'shipped';

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

export interface Release {
  line: string; // 4.12
  branch: string; // release/4.12
  name: string; // Web app 4.12
  status: ReleaseStatus;
  createdAt: string;
  builds: Build[];
  candidateId?: string;
  deployments: Deployment[];
  gh?: GhRelease;
  history: GhRelease[]; // superseded GitHub releases, newest first
  firstTestAt?: string; // when the current candidate first reached a test environment
  shippedAt?: string;
  shippedBy?: string;
}

// Domain events. Raw webhooks are logged separately, these are what the state is built from.
export type DomainEvent =
  | { type: 'release.created'; at: string; line: string; branch: string; name: string }
  | { type: 'build.created'; at: string; line: string; build: Build }
  | { type: 'deployment.recorded'; at: string; line: string; buildId: string; environment: string }
  | { type: 'status.changed'; at: string; line: string; status: ReleaseStatus }
  | { type: 'ghrelease.set'; at: string; line: string; gh: GhRelease }
  | { type: 'ghrelease.superseded'; at: string; line: string; gh: GhRelease; deleted: boolean }
  | { type: 'release.shipped'; at: string; line: string; by: string; gh: GhRelease };
