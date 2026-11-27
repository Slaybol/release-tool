// Release Tool, running entirely in the browser for the static demo site.
// The real flow, gates, notes and views run here against a simulated GitHub, Jira, Zephyr and Elastic.
// The page's calls to /api/* and its EventSource('/api/stream') are answered locally, so the
// pages are the same ones the service serves.
//
// The story is rebuilt from a fixed script each time a page loads, anchored to when the visitor
// first opened the demo (kept in localStorage with anything they did: ships and note edits), so
// it carries on across pages and reloads, and starts over from "Restart demo".
import { ForbiddenError, NotFoundError, ReleaseFlow } from '../src/flow.ts';
import type { GitHubClient } from '../src/github.ts';
import { DemoIssues, DemoManualTests, DemoTelemetry } from '../src/integrations/demo.ts';
import type { DomainEvent, MatrixPlan } from '../src/model.ts';
import { pollOnce } from '../src/poller.ts';
import type { EventStore } from '../src/store.ts';
import { releaseDetail, releasesView, type SourceInfo } from '../src/view.ts';

declare const MATRIX_PLAN: MatrixPlan;

const REPO = 'Slaybol/release-tool';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const KEY = 'release-tool-demo';
const MIN = 60_000;
const POLL_MS = 30_000;
const DEMO_MINUTES = 8;
const OWNER = 'Slaybol';

type Action = { at: number; kind: 'ship'; line: string; actor: string } | { at: number; kind: 'notes'; line: string; section: string; text: string | null; actor: string };
interface Saved { epoch: number; actions: Action[] }

function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    // Start over after a day, so a returning visitor sees the story rather than a stale end state.
    if (s && Date.now() - s.epoch < 24 * 3600e3) return s;
  } catch { /* storage blocked: run without it */ }
  return { epoch: Date.now(), actions: [] };
}
function save(s: Saved) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

class MemoryStore implements EventStore {
  private events: DomainEvent[] = [];
  private seen = new Set<string>();
  load() { return []; }
  append(e: DomainEvent) { this.events.push(e); }
  logRaw(_n: string, delivery: string) { this.seen.add(delivery); }
  seenDelivery(d: string) { return this.seen.has(d); }
}

class SimGitHub implements GitHubClient {
  private bodies = new Map<number, string>();
  private next = 101;
  private notes: Record<string, string> = {
    '4.11': "## What's Changed\n* WEB-2105 Faster search on the orders page by @maya in #6\n* Fix currency rounding on refunds by @sam in #8",
    '4.12': "## What's Changed\n* WEB-2270 Invoice history uses Billing API v2 by @maya in #14\n* Fix date picker locale by @sam in #15\n* WEB-2274 Saved carts sync across devices by @lee in #17",
    '4.13': "## What's Changed\n* WEB-2311 One-page checkout by @maya in #21\n* WEB-2316 Retry card payments on network errors by @lee in #23\n* Upgrade the RUM agent by @sam in #24"
  };
  async createRelease(o: { tag: string; body: string }) { const id = this.next++; this.bodies.set(id, o.body); return { id, url: RELEASES_URL, tag: o.tag }; }
  async updateRelease(id: number, o: { tag?: string; body?: string }) { if (o.body !== undefined) this.bodies.set(id, o.body); return { id, url: RELEASES_URL, tag: o.tag ?? '' }; }
  async deleteRelease(id: number) { this.bodies.delete(id); }
  async getReleaseBody(id: number) { return this.bodies.get(id) ?? ''; }
  async latestPublishedTag() { return undefined; }
  async generateNotes(o: { tag: string }) { return this.notes[/^v(\d+\.\d+)/.exec(o.tag)?.[1] ?? ''] ?? "## What's Changed\n* Maintenance updates"; }
  async listReleaseBranches() { return []; }
  async latestSuccessfulRun() { return undefined; }
  async listArtifacts() { return []; }
  async downloadArtifact(): Promise<Uint8Array> { throw new Error('No artifacts in the demo'); }
  async isPublished() { return true; }
}

// What happens, in minutes from when the visitor arrived. Before 0 is history; after 0 plays live.
const build = (line: string, n: number, actor = 'maya') => (f: ReleaseFlow) => f.handleWebhook('workflow_run', `run-${n}`, {
  action: 'completed',
  workflow_run: { id: n, run_number: n, name: 'Build', conclusion: 'success', head_branch: `release/${line}`, head_sha: `${(n * 2654435761 >>> 0).toString(16)}e1c9a0`, html_url: `https://github.com/${REPO}/actions`, actor: { login: actor } }
});
const deploy = (n: number, env: string) => (f: ReleaseFlow) => f.handleWebhook('deployment_status', `dep-${n}-${env}`, {
  deployment_status: { state: 'success' }, deployment: { sha: `${(n * 2654435761 >>> 0).toString(16)}e1c9a0`, environment: env }
});
const branch = (line: string) => (f: ReleaseFlow) => f.handleWebhook('create', `branch-${line}`, { ref_type: 'branch', ref: `release/${line}` });
const automated = (line: string, n: number, count: number) => (f: ReleaseFlow, at: string) => f.recordTests(line, {
  source: 'actions', buildId: `b${n}`, label: `Build run ${n}`,
  results: Array.from({ length: count }, (_, i) => ({ testId: `unit-${i}`, name: `unit ${i}`, outcome: 'pass' as const, durationMs: 400, at }))
});

function script(): { at: number; run: (f: ReleaseFlow, at: string) => Promise<unknown> }[] {
  return [
    // 4.11: shipped this morning.
    { at: -330, run: build('4.11', 29) }, { at: -300, run: build('4.11', 30) },
    { at: -298, run: deploy(30, 'qa') }, { at: -290, run: deploy(30, 'staging') }, { at: -289, run: automated('4.11', 30, 22) },
    { at: -255, run: (f) => f.ship('4.11', OWNER) },
    // 4.12: second candidate has soaked in staging and passes every gate. Ready to ship.
    { at: -200, run: build('4.12', 41, 'sam') }, { at: -197, run: deploy(41, 'qa') }, { at: -185, run: deploy(41, 'staging') },
    { at: -150, run: build('4.12', 42, 'sam') }, { at: -147, run: deploy(42, 'qa') }, { at: -132, run: deploy(42, 'staging') },
    { at: -131, run: automated('4.12', 42, 22) },
    { at: -120, run: (f) => f.editNotes('4.12', 'highlights', '## Highlights\n\nInvoice history now comes from Billing API v2, saved carts follow you across devices, and dates follow your locale.', OWNER) },
    // 4.13: first candidate in QA, about to go wrong.
    { at: -14, run: build('4.13', 50, 'lee') }, { at: -11, run: deploy(50, 'qa') }, { at: -10, run: automated('4.13', 50, 22) },
    // Live: a new release branch is cut, and 4.13 gets a fixed build that works its way to Ready.
    { at: 1, run: branch('4.14') },
    { at: 3, run: build('4.13', 51, 'lee') }, { at: 4, run: deploy(51, 'qa') }, { at: 4.5, run: automated('4.13', 51, 23) },
    { at: 6, run: deploy(51, 'staging') }
  ];
}

class Demo {
  saved = loadSaved();
  private clock = 0;
  private flow!: ReleaseFlow;
  private queue: { at: number; run: (f: ReleaseFlow, at: string) => Promise<unknown> }[] = [];
  private nextPoll = 0;
  private listeners = new Set<() => void>();
  private sources!: { jira: DemoIssues; zephyr: DemoManualTests; telemetry: DemoTelemetry };
  private gh = new SimGitHub();
  ready: Promise<void>;
  readonly sourceInfo: SourceInfo = { jira: false, zephyr: false, telemetry: false, jiraProject: 'WEB' };
  readonly gates = { testTargetPct: 90, errorThreshold: 8, soakHours: 0.1, dependencies: [] };

  constructor() { this.ready = this.start(); }

  private now = () => new Date(this.clock).toISOString();

  private async start() {
    const e = this.saved.epoch;
    this.clock = e + script()[0].at * MIN - MIN;
    this.flow = new ReleaseFlow(
      { productName: 'Web app', buildWorkflow: 'Build', testEnvironments: ['qa', 'staging'], releaseOwners: [OWNER.toLowerCase()], gates: this.gates, soakEnvironment: 'staging', jiraBaseUrl: 'https://jira.example.com', jiraProject: 'WEB' },
      this.gh, new MemoryStore(), this.now, () => {}
    );
    this.sources = { jira: new DemoIssues('WEB', 'https://jira.example.com', DEMO_MINUTES, this.now), zephyr: new DemoManualTests(DEMO_MINUTES, this.now), telemetry: new DemoTelemetry(this.now) };
    await this.flow.importMatrix({ ...MATRIX_PLAN, importedAt: this.now() });
    this.queue = [
      ...script().map((s) => ({ at: e + s.at * MIN, run: s.run })),
      ...this.saved.actions.map((a) => ({ at: a.at, run: (f: ReleaseFlow) => this.perform(f, a) }))
    ].sort((a, b) => a.at - b.at);
    this.nextPoll = this.clock;
    await this.advance(Date.now());
    setInterval(() => this.advance(Date.now()).then(() => this.changed()), 5000);
  }

  private perform(f: ReleaseFlow, a: Action) {
    return a.kind === 'ship' ? f.ship(a.line, a.actor) : f.editNotes(a.line, a.section, a.text, a.actor);
  }

  private async advance(to: number) {
    for (;;) {
      const next = this.queue[0];
      const t = Math.min(next ? next.at : Infinity, this.nextPoll);
      if (t > to) break;
      this.clock = t;
      try {
        if (next && next.at === t) { this.queue.shift(); await next.run(this.flow, this.now()); }
        else { this.nextPoll += POLL_MS; await pollOnce(this.flow, this.sources, this.gh, { gates: this.gates }); }
      } catch (err) { console.warn('[demo]', err); }
    }
    this.clock = to;
  }

  private changed() { for (const l of this.listeners) l(); }
  subscribe(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); }

  async act(a: Action extends infer A ? A extends Action ? Omit<A, "at"> : never : never) {
    await this.ready;
    await this.advance(Date.now());
    const action = { ...a, at: this.clock } as Action;
    await this.perform(this.flow, action);
    this.saved.actions.push(action);
    save(this.saved);
    this.changed();
  }

  restart() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } location.reload(); }

  async handle(method: string, path: string, body: any): Promise<[number, unknown]> {
    await this.ready;
    await this.advance(Date.now());
    const iso = this.now();
    if (method === 'GET' && path === '/api/releases') return [200, { ...releasesView(this.flow, iso, this.sourceInfo), demo: true }];
    if (method === 'GET' && path === '/api/settings') return [200, { owners: [OWNER], tokenRequired: false, repo: REPO, gates: this.gates }];
    let m = /^\/api\/releases\/(\d+\.\d+)$/.exec(path);
    if (method === 'GET' && m) { const d = releaseDetail(this.flow, m[1], iso, this.sourceInfo); return d ? [200, d] : [404, { error: `No release ${m[1]}` }]; }
    m = /^\/api\/releases\/(\d+\.\d+)\/ship$/.exec(path);
    if (method === 'POST' && m) { await this.act({ kind: 'ship', line: m[1], actor: String(body?.actor ?? OWNER) }); return [200, { shipped: m[1] }]; }
    m = /^\/api\/releases\/(\d+\.\d+)\/notes\/([a-z-]+)$/.exec(path);
    if (method === 'PUT' && m) { await this.act({ kind: 'notes', line: m[1], section: m[2], text: body?.text ?? null, actor: String(body?.actor ?? OWNER) }); return [200, { ok: true }]; }
    return [404, { error: 'Not found' }];
  }
}

const demo = new Demo();
save(demo.saved);

// Answer the page's API calls locally.
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith('/api/') && !url.pathname.includes('/api/')) return realFetch(input, init);
  const path = url.pathname.slice(url.pathname.indexOf('/api/'));
  try {
    const [status, json] = await demo.handle((init?.method ?? 'GET').toUpperCase(), path, init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  } catch (err: any) {
    const status = err instanceof NotFoundError ? 404 : err instanceof ForbiddenError ? 403 : 409;
    return new Response(JSON.stringify({ error: err?.message ?? String(err) }), { status, headers: { 'content-type': 'application/json' } });
  }
};

// Live updates: the page listens for "change" on EventSource('/api/stream').
class DemoEventSource {
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private handlers: (() => void)[] = [];
  constructor(_url: string) { demo.ready.then(() => this.onopen?.(new Event('open'))); demo.subscribe(() => this.handlers.forEach((h) => h())); }
  addEventListener(type: string, h: () => void) { if (type === 'change') this.handlers.push(h); }
  close() {}
}
(window as any).EventSource = DemoEventSource;

// A small banner so nobody mistakes the demo for a live system, with a way to replay the story.
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.setAttribute('role', 'note');
  bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:12px;max-width:calc(100% - 32px);box-sizing:border-box;padding:8px 8px 8px 16px;border-radius:999px;background:#16181D;color:#FFFFFF;font:500 13px/1.3 "IBM Plex Sans",system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18)';
  const text = document.createElement('span');
  text.textContent = 'Demo with simulated data';
  text.style.whiteSpace = 'nowrap';
  bar.title = 'Watch 4.13 get a fixed build and reach Ready over about 15 minutes.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Restart demo';
  btn.style.cssText = 'flex:none;min-height:32px;padding:0 14px;border:0;border-radius:999px;background:#FFFFFF;color:#16181D;font:inherit;cursor:pointer';
  btn.onclick = () => demo.restart();
  bar.append(text, btn);
  document.body.append(bar);
});
