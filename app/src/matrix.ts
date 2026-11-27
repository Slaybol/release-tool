import type { MatrixPlan, TestOutcome, TestResult, TestRun } from './model.ts';
import { readWorkbook, type Sheet } from './xlsx.ts';

// Reads the test matrix workbook: the "Configurations" sheet (one row per config) and the
// "Test Matrix" sheet (a row per test, a column per config; R = required, S = smoke,
// O = optional, — = not applicable). Required and smoke cells become the plan.
export function planFromWorkbook(data: Uint8Array, source: string, at: string): MatrixPlan {
  const book = readWorkbook(data);
  const matrix = book['Test Matrix'];
  if (!matrix) throw new Error('The workbook has no "Test Matrix" sheet.');
  const header = matrix[0] ?? [];
  const idCol = header.findIndex((h) => h?.trim() === 'Test ID');
  const catCol = header.findIndex((h) => h?.trim() === 'Category');
  const nameCol = header.findIndex((h) => h?.trim() === 'Test');
  if (idCol < 0 || nameCol < 0) throw new Error('"Test Matrix" needs "Test ID" and "Test" columns.');

  const configCols: { col: number; id: string; os: string }[] = [];
  const osRow = matrix[1] ?? [];
  header.forEach((h, col) => {
    if (h && col > nameCol && /^[A-Z0-9]+-[A-Z0-9]+$/.test(h.trim())) configCols.push({ col, id: h.trim(), os: osRow[col]?.trim() ?? '' });
  });

  const info = configInfo(book['Configurations']);
  const tests: MatrixPlan['tests'] = [];
  const cells: MatrixPlan['cells'] = [];
  for (const row of matrix.slice(1)) {
    const id = row?.[idCol]?.trim();
    if (!id || !/^[A-Z]+-\d+$/.test(id)) continue;
    tests.push({ id, category: row[catCol]?.trim() ?? '', name: row[nameCol]?.trim() ?? id });
    for (const c of configCols) {
      const v = row[c.col]?.trim().toUpperCase();
      if (v === 'R') cells.push({ testId: id, configId: c.id, level: 'Required' });
      else if (v === 'S') cells.push({ testId: id, configId: c.id, level: 'Smoke' });
    }
  }
  return {
    source, importedAt: at, tests, cells,
    configs: configCols.map((c) => ({ id: c.id, os: c.os, product: info.get(c.id)?.product ?? '', description: info.get(c.id)?.description ?? '' }))
  };
}

function configInfo(sheet: Sheet | undefined) {
  const map = new Map<string, { product: string; description: string }>();
  if (!sheet) return map;
  const h = sheet[0] ?? [];
  const id = h.indexOf('Config ID'), product = h.indexOf('Product'), desc = h.indexOf('Description');
  for (const row of sheet.slice(1)) {
    if (row?.[id]) map.set(row[id]!.trim(), { product: row[product] ?? '', description: row[desc] ?? '' });
  }
  return map;
}

// Latest result per test (and config) wins for coverage; every run still counts as effort.
export function latestResults(runs: TestRun[]): Map<string, TestResult> {
  const latest = new Map<string, TestResult>();
  for (const run of runs) {
    for (const r of run.results) {
      const key = `${r.testId}@${r.configId ?? ''}`;
      const prev = latest.get(key);
      if (!prev || prev.at <= r.at) latest.set(key, r);
    }
  }
  return latest;
}

export interface Coverage {
  planned: number; pass: number; fail: number; blocked: number; notRun: number; executed: number;
  requiredFailed: number;
  completeConfigs: number;
  configs: { id: string; os: string; product: string; planned: number; pass: number; fail: number; blocked: number }[];
  problems: { testId: string; name: string; configId: string; outcome: TestOutcome; issue?: string }[];
}

export function coverage(plan: MatrixPlan | undefined, runs: TestRun[]): Coverage | null {
  if (!plan) return null;
  const latest = latestResults(runs);
  const names = new Map(plan.tests.map((t) => [t.id, t.name]));
  const byConfig = new Map(plan.configs.map((c) => [c.id, { id: c.id, os: c.os, product: c.product, planned: 0, pass: 0, fail: 0, blocked: 0 }]));
  const cov: Coverage = { planned: 0, pass: 0, fail: 0, blocked: 0, notRun: 0, executed: 0, requiredFailed: 0, completeConfigs: 0, configs: [], problems: [] };
  for (const cell of plan.cells) {
    const c = byConfig.get(cell.configId)!;
    cov.planned++; c.planned++;
    const r = latest.get(`${cell.testId}@${cell.configId}`);
    const outcome = r?.outcome;
    if (outcome === 'pass') { cov.pass++; c.pass++; }
    else if (outcome === 'fail') { cov.fail++; c.fail++; if (cell.level === 'Required') cov.requiredFailed++; }
    else if (outcome === 'blocked') { cov.blocked++; c.blocked++; }
    else cov.notRun++;
    if (outcome === 'fail' || outcome === 'blocked') cov.problems.push({ testId: cell.testId, name: names.get(cell.testId) ?? cell.testId, configId: cell.configId, outcome, issue: r?.issue });
  }
  cov.executed = cov.pass + cov.fail;
  cov.configs = [...byConfig.values()];
  cov.completeConfigs = cov.configs.filter((c) => c.planned > 0 && c.pass === c.planned).length;
  return cov;
}
