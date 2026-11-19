// Import a test matrix workbook into the tool's event log, once:
//   npm run import-matrix -- ../path/to/test-matrix.xlsx
// The server can also do this on start with MATRIX_FILE, or take an upload on POST /api/matrix.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { planFromWorkbook } from '../src/matrix.ts';
import { FileStore } from '../src/store.ts';

const file = process.argv[2];
if (!file) { console.error('Usage: npm run import-matrix -- <workbook.xlsx>'); process.exit(1); }
const plan = planFromWorkbook(new Uint8Array(readFileSync(file)), basename(file), new Date().toISOString());
new FileStore(process.env.DATA_DIR ?? 'data').append({ type: 'matrix.imported', at: plan.importedAt, plan });
const required = plan.cells.filter((c) => c.level === 'Required').length;
console.log(`Imported ${plan.tests.length} tests across ${plan.configs.length} configurations: ${plan.cells.length} planned cells (${required} required, ${plan.cells.length - required} smoke).`);
