// release/4.12 → 4.12. Two-part lines only, as agreed (release/x.xx).
const BRANCH = /^release\/(\d+\.\d+)$/;

export function releaseLine(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const m = BRANCH.exec(ref.replace(/^refs\/heads\//, ''));
  return m ? m[1] : undefined;
}

// The Nth build on a release line is release candidate N: 4.12.0-rc.3.
export function candidateVersion(line: string, buildNumber: number): string {
  return `${line}.0-rc.${buildNumber}`;
}

// What a candidate becomes when a release owner ships it: 4.12.0-rc.3 → 4.12.0.
export function shippedVersion(version: string): string {
  return version.replace(/-rc\.\d+$/, '');
}

export const tagFor = (version: string) => `v${version}`;
