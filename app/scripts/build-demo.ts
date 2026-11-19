// Builds the static demo site into ../demo: the service's own pages, with the flow running in the
// browser on simulated data (demo/engine.ts). No server or tokens; host the folder anywhere.
//   npm run build:demo
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFromWorkbook } from '../src/matrix.ts';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..');
const out = join(root, 'demo');
mkdirSync(out, { recursive: true });

const plan = planFromWorkbook(new Uint8Array(readFileSync(join(app, 'test/fixtures/edge-hardware-test-matrix.xlsx'))), 'edge-hardware-test-matrix.xlsx', '2026-01-01T00:00:00.000Z');
await build({
  entryPoints: [join(app, 'demo/engine.ts')], bundle: true, minify: true, format: 'iife', target: 'es2020',
  outfile: join(out, 'demo-api.js'), define: { MATRIX_PLAN: JSON.stringify(plan) }, legalComments: 'none'
});

const patch = (s: string, pairs: [string | RegExp, string][]) => pairs.reduce((acc, [a, b]) => {
  if (typeof a === 'string' ? !acc.includes(a) : !a.test(acc)) throw new Error(`Pattern not found: ${a}`);
  return typeof a === 'string' ? acc.split(a).join(b) : acc.replace(a, b);
}, s);
const common: [string | RegExp, string][] = [
  ['<script src="/morphdom.min.js"></script>', '<script src="demo-api.js"></script>\n<script src="morphdom.min.js"></script>'],
  ['<script src="/dc-lite.js"></script>', '<script src="dc-lite.js"></script>'],
  ['href="/"', 'href="index.html"'],
  ['href="/integrations.html"', 'href="integrations.html"'],
  ['href="/connections.html"', 'href="connections.html"'],
  ['href="/hardware.html"', 'href="hardware.html"'],
  ['</style>', 'body{padding-bottom:72px}\n</style>'],
  ['<title>', '<meta name="description" content="Release Tool demo: releases in flight, readiness, release notes and test coverage, on simulated data.">\n<title>']
];
writeFileSync(join(out, 'index.html'), patch(readFileSync(join(app, 'web/index.html'), 'utf8'), [...common,
  ["href: '/releases/' + r.line", "href: 'release.html?line=' + r.line"]]));
writeFileSync(join(out, 'release.html'), patch(readFileSync(join(app, 'web/release.html'), 'utf8'), [...common,
  ["this.line = location.pathname.split('/').pop();", "this.line = new URLSearchParams(location.search).get('line') || '4.12';"]]));
const plain: [string | RegExp, string][] = [
  ['<title>', '<script src="demo-api.js"></script>\n<title>'],
  ...common.filter(([a]) => typeof a === 'string' && a.startsWith('href=')),
  ['</style>', 'body{padding-bottom:72px}\n</style>']
];
for (const f of ['hardware.html', 'integrations.html', 'connections.html']) writeFileSync(join(out, f), patch(readFileSync(join(app, 'web', f), 'utf8'), plain));
for (const f of ['morphdom.min.js', 'morphdom-LICENSE.txt', 'dc-lite.js']) copyFileSync(join(root, f), join(out, f));
console.log(`Built the demo site in ${out}`);
