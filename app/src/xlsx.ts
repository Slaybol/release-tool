import { strFromU8, unzipSync } from 'fflate';

// Minimal .xlsx reader: enough to read cell values (shared strings, inline strings, numbers)
// from each sheet by name. Formulas are read as their cached value.
export type Sheet = (string | undefined)[][];

export function readWorkbook(data: Uint8Array): Record<string, Sheet> {
  const files = unzipSync(data);
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : '');
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => joinRuns(m[1]));

  const rels = new Map<string, string>();
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const out: Record<string, Sheet> = {};
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(attr(m[0], 'name') ?? '');
    const path = rels.get(attr(m[0], 'r:id') ?? '');
    if (!path) continue;
    out[name] = readSheet(text(path), shared);
  }
  return out;
}

function readSheet(xml: string, shared: string[]): Sheet {
  const rows: Sheet = [];
  for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(c[1], 'r');
    if (!ref) continue;
    const { row, col } = position(ref);
    const type = attr(c[1], 't');
    const inner = c[2] ?? '';
    let value: string | undefined;
    if (type === 's') value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])];
    else if (type === 'inlineStr') value = joinRuns(inner);
    else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      value = v === undefined ? undefined : decode(v);
    }
    (rows[row] ??= [])[col] = value;
  }
  return rows;
}

function joinRuns(xml: string) {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
}

function position(ref: string) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

function attr(tag: string, name: string) {
  const m = new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return m?.[1];
}

function decode(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
