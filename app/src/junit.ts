import type { TestResult } from './model.ts';

// Reads JUnit XML (what vitest, jest, pytest, go-junit-report and most runners write).
export function parseJUnit(xml: string, at: string): TestResult[] {
  const out: TestResult[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1];
    const body = m[2] ?? '';
    const name = decode(attr(attrs, 'name') ?? 'unnamed');
    const suite = decode(attr(attrs, 'classname') ?? '');
    const seconds = Number(attr(attrs, 'time') ?? 0);
    const outcome = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skipped' : 'pass';
    out.push({ testId: suite ? `${suite} › ${name}` : name, name, outcome, durationMs: Math.round(seconds * 1000), at });
  }
  return out;
}

function attr(tag: string, name: string) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function decode(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
