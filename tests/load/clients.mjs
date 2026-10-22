// Clients for the load simulation (tests/load/README.md), shared by sim.mjs, probe.mjs and the budgets suite.
//
//   Browser   a scripted browser tab: the same requests a real one sends (recorded with patterns.mjs on Next 16.2):
//             page loads, client navigations (RSC), link prefetches (a route-tree and a metadata-only request per
//             visible link), the preloader's full prefetches, server actions with the page they re-render, the Claude
//             page's push stream and its refresh on a hint.
//   Worker    the real worker loop and core (worker/) with stub sessions, on the simulation's clock, and its real push
//             stream.
//   Claude    MCP tool calls with a person's Claude chat key.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { B, login } from '../e2e/lib.mjs';
import { createCore } from '../../worker/core.mjs';
import { createLoop } from '../../worker/loop.mjs';
import { makeApi } from '../../worker/api.mjs';
import { connectPush } from '../../worker/push.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { computeCacheBustingSearchParam } = require(path.join(ROOT, 'node_modules/next/dist/shared/lib/router/utils/cache-busting-search-param.js'));

/** Signs a Playwright page in (the real form). */
export async function signInPage(page, email, password) {
  await login(page, { email, password, next: '/today' });
}

/** Session cookies for email (Better Auth sign-in over HTTP), as one Cookie header. */
export async function cookieFor(email, password) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  const set = r.headers.getSetCookie?.() ?? [];
  await r.text();
  if (!set.length) throw new Error(`sign-in failed for ${email}: ${r.status}`);
  return set.map(c => c.split(';')[0]).join('; ');
}

// ── server actions: ids from the build ───────────────────────────────────────
let actions = null;
/** The id of a server action, by exported name and file (from .next/server/server-reference-manifest.json). */
export function actionId(name, file = 'app/actions.ts') {
  if (!actions) {
    actions = {};
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8'));
    for (const [id, e] of Object.entries(m.node)) for (const w of Object.values(e.workers)) actions[`${w.filename}#${w.exportedName}`] = id;
  }
  const id = actions[`${file}#${name}`];
  if (!id) throw new Error(`no server action ${file}#${name} in the build`);
  return id;
}

// ── the router's request shapes ─────────────────────────────────────────────
const DYNAMIC = { tasks: 'id', projects: 'id', notes: 'id', modes: 'mode' };
/** Router state tree for a page path; mark: 'page' (a navigation: refetch from the page's segment), 'root' (refresh), null (action). */
export function treeFor(p, mark) {
  const parts = p.split('?')[0].split('/').filter(Boolean);
  let node = ['__PAGE__', {}];
  if (parts[1] && DYNAMIC[parts[0]]) node = [[DYNAMIC[parts[0]], parts[1], 'd', null], { children: node }];
  if (parts[0]) node = [parts[0], { children: node }];
  if (mark === 'page') node = [...node, null, 'refetch'];
  let t = ['', { children: ['(app)', { children: node }] }];
  if (mark === 'root') t = [...t, null, 'refetch'];
  return encodeURIComponent(JSON.stringify(t));
}
const META_TREE = encodeURIComponent(JSON.stringify(['', {}, null, 'metadata-only']));

// The topics the Claude page refreshes on: read from the app's AutoRefresh, so the scripted tab follows the code.
// How links prefetch: 'viewport' (Next's default: every visible link) or 'intent' (components/intent-link.tsx: only the
// link under the pointer, i.e. the one about to be clicked). Follows the code; LOAD_PREFETCH overrides it.
export const PREFETCH = process.env.LOAD_PREFETCH || (fs.existsSync(path.join(ROOT, 'components/intent-link.tsx')) ? 'intent' : 'viewport');

// LOAD_CLAUDE_TOPICS=claude,tasks overrides it (to measure a build made from older code).
const CLAUDE_TOPICS = (() => {
  if (process.env.LOAD_CLAUDE_TOPICS) return process.env.LOAD_CLAUDE_TOPICS.split(',');
  const src = fs.readFileSync(path.join(ROOT, 'app/(app)/claude/auto-refresh.tsx'), 'utf8');
  const m = /topics = \[([^\]]*)\]/.exec(src);
  return m ? [...m[1].matchAll(/'([a-z*]+)'/g)].map(x => x[1]) : ['claude', 'tasks'];
})();

/** Every request goes through here: counted per kind for the client's report. */
async function send(rec, tag, kind, url, init) {
  const t0 = Date.now();
  let status = 0;
  let bytes = 0;
  try {
    const r = await fetch(B + url, { redirect: 'manual', ...init, headers: { 'accept-encoding': 'gzip, deflate, br', 'x-load-client': tag, ...init.headers } });
    status = r.status;
    // A browser keeps the refreshed session cookies (the cookie cache is renewed every 2 minutes).
    if (init.jar) { const sc = r.headers.getSetCookie?.() ?? []; if (sc.length) init.jar(sc); }
    if (init.stream) return r;
    bytes = (await r.arrayBuffer()).byteLength;
    return r;
  } catch {
    status = -1;
    return null;
  } finally {
    if (rec) rec(kind, url, status, bytes, Date.now() - t0);
  }
}

function rscHeaders({ prefetch, segment, tree, nextUrl }) {
  const h = { rsc: '1' };
  if (prefetch) h['next-router-prefetch'] = '1';
  if (segment) h['next-router-segment-prefetch'] = segment;
  if (tree) h['next-router-state-tree'] = tree;
  if (nextUrl) h['next-url'] = nextUrl;
  return { h, q: computeCacheBustingSearchParam(prefetch ? '1' : undefined, segment, tree, nextUrl) };
}
const withQ = (p, q) => p + (p.includes('?') ? '&' : '?') + '_rsc=' + q;

/**
 * Visible links a page prefetches (counts from patterns.mjs on Next 16.2.4, desktop 1366x860; the sidebar's nine
 * routes are visible on every page). makeLinks(page, ids) gives the hrefs.
 */
export const SIDEBAR = ['/today', '/tasks', '/projects', '/notes', '/claude', '/notifications', '/review', '/timetable', '/settings'];
export const PAGE_LINKS = {
  today: { tasks: 9, projects: 4 },
  tasks: { tasks: 30 },
  projects: { projects: 15 },
  project: { tasks: 8, notes: 4, projects: 1 },
  task: {},
  claude: { claudeTabs: 3 },
  notes: { notes: 12 },
};

/** Which page type a path is. */
export const pageOf = p => {
  const [a, b] = p.split('?')[0].split('/').filter(Boolean);
  if (a === 'tasks') return b ? 'task' : 'tasks';
  if (a === 'projects') return b ? 'project' : 'projects';
  if (a === 'notes') return 'notes';
  return a;
};

/**
 * A scripted browser tab of one person. clock(): the simulation's time (ms). ids: { tasks, projects, notes } to pick
 * visible links from (the person's own view). rec(kind, url, status, bytes, ms): request log.
 */
export class Browser {
  constructor({ cookie, clock = () => Date.now(), ids, rec, tag = 'scripted', rng = Math.random }) {
    Object.assign(this, { cookie, clock, ids, tag, rng, base: B });
    this.lastBytes = 0;
    this.jar = list => {
      const m = new Map(this.cookie.split('; ').map(c => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
      for (const c of list) {
        const kv = c.split(';')[0];
        const k = kv.slice(0, kv.indexOf('='));
        const v = kv.slice(kv.indexOf('=') + 1);
        if (v) m.set(k, v); else m.delete(k);
      }
      this.cookie = [...m].map(([k, v]) => k + '=' + v).join('; ');
    };
    this.rec = (kind, url, status, bytes, ms) => { this.lastBytes += bytes; if (rec) rec(kind, url, status, bytes, ms); };
    this.path = null;
    this.prefetched = new Map(); // href -> sim time of its metadata prefetch
    this.trees = new Set(); // hrefs whose route tree is cached
    this.warmedAt = -Infinity;
    this.visible = [];
    this.writing = 0;
    this.quietUntil = 0;
    this.stream = null;
    this.hints = 0;
    this.refreshes = 0;
  }
  get(kind, url, headers = {}) {
    return send(this.rec, this.tag, kind, url, { headers: { cookie: this.cookie, ...headers }, jar: this.jar });
  }
  pick(list, n) {
    const out = [];
    for (let i = 0; i < n && list?.length; i++) out.push(list[Math.floor(this.rng() * list.length)]);
    return out;
  }
  linksOf(page) {
    const L = PAGE_LINKS[page] ?? {};
    return [
      ...SIDEBAR,
      ...this.pick(this.ids.tasks, L.tasks ?? 0).map(t => `/tasks/${t}`),
      ...this.pick(this.ids.projects, L.projects ?? 0).map(p => `/projects/${p}`),
      ...this.pick(this.ids.notes, L.notes ?? 0).map(n => `/notes/${n}`),
      ...(L.claudeTabs ? ['/claude?tab=now', '/claude?tab=queue', '/claude?tab=setup'] : []),
    ];
  }
  /** Prefetch the visible links that are not cached (staleTimes.static: 5 minutes), the way the router does. */
  async prefetchVisible({ trees = true } = {}) {
    if (PREFETCH === 'intent') return;
    const now = this.clock();
    const todo = this.visible.filter(h => !(now - (this.prefetched.get(h) ?? -Infinity) < 300_000));
    const jobs = [];
    for (const href of todo) {
      if (trees && !this.trees.has(href)) {
        const { h, q } = rscHeaders({ prefetch: true, segment: '/_tree', nextUrl: this.path });
        jobs.push(this.get('prefetch-tree', withQ(href, q), h));
        this.trees.add(href);
      }
      const { h, q } = rscHeaders({ prefetch: true, tree: META_TREE, nextUrl: this.path });
      jobs.push(this.get('prefetch', withQ(href, q), h));
      this.prefetched.set(href, now);
    }
    // The router runs a few at a time.
    for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6));
  }
  /** The preloader (components/preloader.tsx): Today, Tasks and Projects fully prefetched every 5 minutes in use. */
  async warm() {
    if (this.clock() - this.warmedAt < 300_000) return;
    this.warmedAt = this.clock();
    for (const r of ['/today', '/tasks', '/projects']) {
      if (r === this.path) continue;
      const { h, q } = rscHeaders({ tree: treeFor(r, 'page'), nextUrl: this.path });
      await this.get('preload', withQ(r, q), h);
    }
  }
  /** First load: the HTML document. */
  async load(p) {
    await this.get('page', p, { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' });
    this.path = p;
    this.visible = this.linksOf(pageOf(p));
    await this.prefetchVisible();
    await this.warm();
  }
  /** One navigation request (no prefetches). */
  async navOnly(p) {
    const { h, q } = rscHeaders({ tree: treeFor(p, 'page'), nextUrl: this.path });
    await this.get('rsc', withQ(p, q), h);
    this.path = p;
  }
  /** One router.refresh() request (no prefetches). */
  refreshOnly() {
    const { h, q } = rscHeaders({ tree: treeFor(this.path, 'root') });
    return this.get('refresh', withQ(this.path, q), h);
  }
  /** One link prefetch: its route tree (tree) or its metadata-only request. */
  prefetchOne(href, tree) {
    const { h, q } = tree ? rscHeaders({ prefetch: true, segment: '/_tree', nextUrl: this.path }) : rscHeaders({ prefetch: true, tree: META_TREE, nextUrl: this.path });
    return this.get(tree ? 'prefetch-tree' : 'prefetch', withQ(href, q), h);
  }
  /** One server action request on the current page (no prefetches after it). */
  actionOnly(name, args, file) {
    return send(this.rec, this.tag, 'action', this.path, { method: 'POST', headers: { cookie: this.cookie, 'next-action': actionId(name, file), 'next-router-state-tree': treeFor(this.path, null), accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(args), jar: this.jar });
  }
  /** A client navigation. */
  async nav(p) {
    if (PREFETCH === 'intent') {
      // The pointer is on the link before the click: its tree (once) and metadata (when stale) are fetched first.
      if (!this.trees.has(p)) { this.trees.add(p); await this.prefetchOne(p, true); }
      if (!(this.clock() - (this.prefetched.get(p) ?? -Infinity) < 300_000)) { this.prefetched.set(p, this.clock()); await this.prefetchOne(p, false); }
    }
    await this.navOnly(p);
    this.visible = this.linksOf(pageOf(p));
    await this.prefetchVisible();
    if (pageOf(p) === 'claude') this.openStream();
    else this.closeStream();
  }
  /** router.refresh(): the whole page from the root, then the visible links' metadata again. */
  async refresh() {
    this.refreshes++;
    await this.refreshOnly();
    this.prefetched.clear();
    await this.prefetchVisible({ trees: false });
  }
  /**
   * A server action on the current page. revalidates: the action calls revalidatePath (every action in app/actions.ts
   * does), so the router drops its whole prefetch cache and prefetches the visible links again (trees too).
   * thenRefresh: the component also calls router.refresh() after it (comment entry, the phone's task sheets, ...).
   */
  async action(name, args, { file, revalidates = true, thenRefresh = false } = {}) {
    this.writing++;
    try {
      const r = await this.actionOnly(name, args, file);
      if (revalidates) {
        this.prefetched.clear();
        this.trees.clear();
        await this.prefetchVisible();
      }
      if (thenRefresh) await this.refresh();
      return r?.status ?? -1;
    } finally {
      this.writing--;
      this.quietUntil = this.clock() + 2_000;
    }
  }
  /** The Claude page's push stream (components/live.ts); a hint for claude or tasks refreshes the page (AutoRefresh). */
  openStream() {
    if (this.stream) return;
    const ac = new AbortController();
    this.stream = ac;
    (async () => {
      const r = await send(null, this.tag, 'stream', '/api/stream', { headers: { cookie: this.cookie, accept: 'text/event-stream' }, signal: ac.signal, stream: true });
      if (this.rec) this.rec('stream', '/api/stream', r?.status ?? -1, 0, 0);
      if (!r?.body) return;
      const dec = new TextDecoder();
      let buf = '';
      let later = null;
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!/^event: ?hint/m.test(block)) continue;
            const data = /^data: ?(.*)$/m.exec(block)?.[1] ?? '{}';
            let hnt = {};
            try { hnt = JSON.parse(data); } catch { /* not ours */ }
            if (hnt.t !== '*' && !CLAUDE_TOPICS.includes(hnt.t)) continue;
            this.hints++;
            if (hnt.s && (this.writing > 0 || this.clock() < this.quietUntil)) continue;
            // AutoRefresh: hints within 400 ms are one refresh, at most one refresh per 2 s.
            later ??= setTimeout(() => {
              later = null;
              const since = Date.now() - (this.lastRefreshReal ?? 0);
              const run = () => { this.lastRefreshReal = Date.now(); if (this.path === '/claude') this.refresh().catch(() => {}); };
              if (since >= 2000) run(); else setTimeout(run, 2000 - since);
            }, 400);
          }
        }
      } catch { /* closed */ }
    })();
  }
  closeStream() {
    if (!this.stream) return;
    this.stream.abort();
    this.stream = null;
  }
}

// ── the worker ─────────────────────────────────────────────────────────────
/**
 * One computer's worker: the real core and loop with stub sessions, on the simulation clock (clock(), speed: sim ms
 * per real ms), and its real push stream. Sessions it starts "run" for a while and then end.
 */
export function startWorker({ person, clock, speed = 1, allowPrompts = false, log = () => {}, activityEvery = 3600_000 }) {
  const cfg = { baseUrl: B, roots: [], scanEveryMinutes: 24 * 60, enabled: true, allowPrompts };
  const state = { ids: {}, folders: {}, sessions: {}, markers: {}, lastScan: clock() };
  const api = makeApi(() => cfg, () => person.deviceKey);
  const counts = { started: 0 };
  let sessions = 1;
  let lastChange = clock();
  const activity = async () => {
    // A person's Claude sessions on their PC change now and then (counts only).
    if (clock() - lastChange > activityEvery) { lastChange = clock(); sessions = 1 + Math.floor(Math.random() * 3); }
    return { counts: { sessions, sessionsWorkOs: 0, sessionsOther: sessions, sessionsActive: 0, subagents: 0 }, list: [] };
  };
  const core = createCore({ getConfig: () => cfg, state, save: () => {}, api, now: clock, log, launcher: async () => { counts.started++; }, listProcesses: async () => [], killPid: async () => {}, activity });
  let wakeUp = null;
  let woke = false;
  const wake = () => { woke = true; if (wakeUp) wakeUp(); };
  const push = connectPush({ getCfg: () => cfg, getToken: () => person.deviceKey, onWake: wake, onUp: wake, log });
  const loop = createLoop({ core, getConfig: () => cfg, state, log, pushUp: () => push.up, now: clock });
  let stopped = false;
  (async () => {
    while (!stopped) {
      const ms = await loop.step();
      if (stopped) break;
      if (woke) { woke = false; loop.wake(); continue; }
      await new Promise(r => {
        const t = setTimeout(() => { wakeUp = null; r(); }, Math.max(5, ms / speed));
        wakeUp = () => { clearTimeout(t); wakeUp = null; r(); };
      });
      if (woke) { woke = false; loop.wake(); }
    }
  })();
  return { counts, get up() { return push.up; }, stop() { stopped = true; push.stop(); if (wakeUp) wakeUp(); } };
}

// ── Claude (MCP) ───────────────────────────────────────────────────────────
let rpc = 0;
/** One MCP tool call with a person's key. Returns { ok, json }. */
export async function mcpCall(key, name, args, rec) {
  const r = await send(rec, 'mcp', 'mcp', '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
  return { ok: !!r && r.status === 200 };
}
