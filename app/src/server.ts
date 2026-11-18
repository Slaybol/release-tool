import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { ForbiddenError, NotFoundError, ReleaseFlow } from './flow.ts';
import { OctokitGitHub, octokitFor } from './github.ts';
import { reconcile } from './reconcile.ts';
import { FileStore } from './store.ts';
import { releasesView } from './view.ts';
import { verifySignature } from './webhook.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const repoRoot = join(here, '..', '..'); // shared renderer files from the mockup site

const cfg = loadConfig();
const gh = new OctokitGitHub(octokitFor(cfg), cfg.owner, cfg.repo);
const streams = new Set<ServerResponse>();
const flow = new ReleaseFlow(cfg, gh, new FileStore(cfg.dataDir), undefined, () => {
  for (const res of streams) res.write(`event: change\ndata: ${Date.now()}\n\n`);
});

const STATIC: Record<string, [string, string]> = {
  '/': [join(webDir, 'index.html'), 'text/html; charset=utf-8'],
  '/dc-lite.js': [join(repoRoot, 'dc-lite.js'), 'text/javascript'],
  '/morphdom.min.js': [join(repoRoot, 'morphdom.min.js'), 'text/javascript']
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/webhooks/github') return await webhook(req, res);
    if (req.method === 'GET' && url.pathname === '/api/releases') return json(res, 200, releasesView(flow.state, new Date().toISOString()));
    if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res);
    const ship = /^\/api\/releases\/(\d+\.\d+)\/ship$/.exec(url.pathname);
    if (req.method === 'POST' && ship) return await doShip(req, res, ship[1]);
    const file = STATIC[url.pathname];
    if (req.method === 'GET' && file) {
      res.writeHead(200, { 'content-type': file[1] });
      return res.end(await readFile(file[0]));
    }
    json(res, 404, { error: 'Not found' });
  } catch (err: any) {
    console.error(err);
    json(res, 500, { error: err?.message ?? 'Server error' });
  }
});

async function webhook(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  if (!verifySignature(cfg.webhookSecret, body, header(req, 'x-hub-signature-256'))) return json(res, 401, { error: 'Bad signature' });
  const name = header(req, 'x-github-event') ?? 'unknown';
  const delivery = header(req, 'x-github-delivery') ?? `${Date.now()}`;
  // Acknowledge right away; GitHub expects a reply within 10 seconds. Work continues on the queue.
  json(res, 202, { accepted: true });
  flow.handleWebhook(name, delivery, JSON.parse(body.toString('utf8'))).catch(() => {});
}

async function doShip(req: IncomingMessage, res: ServerResponse, line: string) {
  // Demo stand-in for SSO: the caller names their GitHub login, and it must be a release owner.
  const { actor } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (!actor) return json(res, 400, { error: 'Send {"actor": "<GitHub login>"}' });
  try {
    const r = await flow.ship(line, String(actor));
    json(res, 200, { shipped: r.name, githubRelease: r.gh });
  } catch (err) {
    if (err instanceof ForbiddenError) return json(res, 403, { error: err.message });
    if (err instanceof NotFoundError) return json(res, 404, { error: err.message });
    throw err;
  }
}

function stream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
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

server.listen(cfg.port, () => {
  console.log(`Release Tool listening on http://localhost:${cfg.port} for ${cfg.owner}/${cfg.repo}`);
  const run = () => reconcile(flow, gh, cfg.buildWorkflow).catch((err) => console.error('[reconcile]', err?.message ?? err));
  run();
  setInterval(run, 6 * 60 * 60 * 1000);
});
