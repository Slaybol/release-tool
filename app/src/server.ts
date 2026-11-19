import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.ts';
import { ForbiddenError, NotFoundError, ReleaseFlow } from './flow.ts';
import { OctokitGitHub, octokitFor } from './github.ts';
import { DemoIssues, DemoManualTests, DemoTelemetry } from './integrations/demo.ts';
import { ElasticSource, JiraSource, ZephyrSource } from './integrations/live.ts';
import type { Sources } from './integrations/types.ts';
import { planFromWorkbook } from './matrix.ts';
import { pollOnce } from './poller.ts';
import { reconcile } from './reconcile.ts';
import { FileStore } from './store.ts';
import { releaseDetail, releasesView, type SourceInfo } from './view.ts';
import { verifySignature } from './webhook.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const repoRoot = join(here, '..', '..'); // shared renderer files from the mockup site

const cfg = loadConfig();
const now = () => new Date().toISOString();
const gh = new OctokitGitHub(octokitFor(cfg), cfg.owner, cfg.repo);
const streams = new Set<ServerResponse>();
const jiraBaseUrl = cfg.jira.baseUrl ?? 'https://jira.example.com';
const flow = new ReleaseFlow({ ...cfg, jiraBaseUrl, jiraProject: cfg.jira.project }, gh, new FileStore(cfg.dataDir), now, () => {
  for (const res of streams) res.write(`event: change\ndata: ${Date.now()}\n\n`);
});

const sources: Sources = {
  jira: cfg.jira.baseUrl && cfg.jira.apiToken ? new JiraSource(cfg.jira) : new DemoIssues(cfg.jira.project, jiraBaseUrl, cfg.demoMinutes, now),
  zephyr: cfg.zephyr.apiToken ? new ZephyrSource(cfg.zephyr) : new DemoManualTests(cfg.demoMinutes, now),
  telemetry: cfg.elastic.url && cfg.elastic.apiKey ? new ElasticSource(cfg.elastic) : new DemoTelemetry(now)
};
const sourceInfo: SourceInfo = { jira: sources.jira.live, zephyr: sources.zephyr.live, telemetry: sources.telemetry.live, jiraProject: cfg.jira.project };

const STATIC: Record<string, [string, string]> = {
  '/': [join(webDir, 'index.html'), 'text/html; charset=utf-8'],
  '/integrations.html': [join(webDir, 'integrations.html'), 'text/html; charset=utf-8'],
  '/connections.html': [join(webDir, 'connections.html'), 'text/html; charset=utf-8'],
  '/dc-lite.js': [join(repoRoot, 'dc-lite.js'), 'text/javascript'],
  '/morphdom.min.js': [join(repoRoot, 'morphdom.min.js'), 'text/javascript']
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'POST' && path === '/webhooks/github') return await webhook(req, res);
    if (req.method === 'GET' && path === '/api/releases') return json(res, 200, releasesView(flow, now(), sourceInfo));
    if (req.method === 'GET' && path === '/api/stream') return stream(req, res);
    if (req.method === 'GET' && path === '/api/settings') return json(res, 200, { owners: cfg.releaseOwners, tokenRequired: !!cfg.adminToken, repo: `${cfg.owner}/${cfg.repo}`, gates: cfg.gates });
    if (req.method === 'POST' && path === '/api/matrix') return await uploadMatrix(req, res);

    let m = /^\/api\/releases\/(\d+\.\d+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const d = releaseDetail(flow, m[1], now(), sourceInfo);
      return d ? json(res, 200, d) : json(res, 404, { error: `No release ${m[1]}` });
    }
    m = /^\/api\/releases\/(\d+\.\d+)\/ship$/.exec(path);
    if (req.method === 'POST' && m) return await doShip(req, res, m[1]);
    m = /^\/api\/releases\/(\d+\.\d+)\/notes\/([a-z-]+)$/.exec(path);
    if (req.method === 'PUT' && m) return await editNotes(req, res, m[1], m[2]);
    if (req.method === 'GET' && /^\/releases\/\d+\.\d+$/.test(path)) return sendFile(res, join(webDir, 'release.html'), 'text/html; charset=utf-8');

    const file = STATIC[path];
    if (req.method === 'GET' && file) return sendFile(res, file[0], file[1]);
    json(res, 404, { error: 'Not found' });
  } catch (err: any) {
    if (err instanceof ForbiddenError) return json(res, 403, { error: err.message });
    if (err instanceof NotFoundError) return json(res, 404, { error: err.message });
    console.error(err);
    json(res, 500, { error: err?.message ?? 'Server error' });
  }
});

async function webhook(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  if (!verifySignature(cfg.webhookSecret, body, header(req, 'x-hub-signature-256'))) return json(res, 401, { error: 'Bad signature' });
  const name = header(req, 'x-github-event') ?? 'unknown';
  const delivery = header(req, 'x-github-delivery') ?? `${Date.now()}`;
  const payload = JSON.parse(body.toString('utf8'));
  // Acknowledge right away; GitHub expects a reply within 10 seconds. Work continues on the queue.
  json(res, 202, { accepted: true });
  flow.handleWebhook(name, delivery, payload).catch(() => {});
}

// Demo stand-in for SSO: the caller names their GitHub login, which must be a release owner,
// and proves they may act with the shared ADMIN_TOKEN when one is set.
function authorize(req: IncomingMessage) {
  if (!cfg.adminToken) return;
  const given = Buffer.from((header(req, 'authorization') ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(cfg.adminToken);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new ForbiddenError('A valid admin token is required.');
}

async function doShip(req: IncomingMessage, res: ServerResponse, line: string) {
  authorize(req);
  const { actor } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (!actor) return json(res, 400, { error: 'Send {"actor": "<GitHub login>"}' });
  const r = await flow.ship(line, String(actor));
  json(res, 200, { shipped: r.name, githubRelease: r.gh });
}

async function editNotes(req: IncomingMessage, res: ServerResponse, line: string, section: string) {
  authorize(req);
  const { text, actor } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (!actor) return json(res, 400, { error: 'Send {"actor": "<name>", "text": "<markdown>"} or text null to unlock' });
  await flow.editNotes(line, section, text === null ? null : String(text), String(actor));
  json(res, 200, { ok: true });
}

async function uploadMatrix(req: IncomingMessage, res: ServerResponse) {
  authorize(req);
  const plan = planFromWorkbook(await readBody(req), header(req, 'x-filename') ?? 'upload.xlsx', now());
  await flow.importMatrix(plan);
  json(res, 200, { configs: plan.configs.length, tests: plan.tests.length, planned: plan.cells.length });
}

function stream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
}

async function sendFile(res: ServerResponse, path: string, type: string) {
  res.writeHead(200, { 'content-type': type });
  res.end(await readFile(path));
}

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

server.listen(cfg.port, async () => {
  console.log(`Release Tool listening on http://localhost:${cfg.port} for ${cfg.owner}/${cfg.repo}`);
  console.log(`Sources: Jira ${sourceInfo.jira ? 'live' : 'demo'}, Zephyr ${sourceInfo.zephyr ? 'live' : 'demo'}, telemetry ${sourceInfo.telemetry ? 'live' : 'demo'}`);
  // Import the test matrix once; after that the plan lives in the tool.
  if (cfg.matrixFile && !flow.state.matrix) {
    try {
      await flow.importMatrix(planFromWorkbook(new Uint8Array(await readFile(cfg.matrixFile)), basename(cfg.matrixFile), now()));
      console.log(`Imported test matrix from ${cfg.matrixFile}`);
    } catch (err: any) { console.error('[matrix]', err?.message ?? err); }
  }
  const rec = () => reconcile(flow, gh, cfg.buildWorkflow).catch((err) => console.error('[reconcile]', err?.message ?? err));
  rec();
  setInterval(rec, 6 * 60 * 60 * 1000);
  const poll = () => pollOnce(flow, sources, gh, cfg).catch((err) => console.error('[poll]', err?.message ?? err));
  poll();
  setInterval(poll, cfg.pollSeconds * 1000);
  // Gates that depend on the clock (soak time) change without an event: nudge pages every minute.
  setInterval(() => { for (const s of streams) s.write(`event: change\ndata: ${Date.now()}\n\n`); }, 60000);
});
