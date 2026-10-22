/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload (node --require), loaded before the app */
// Server-side meter for the load simulation (tests/load/README.md). Loaded into the app's `next start` process with
// NODE_OPTIONS=--require, never into the app itself. It measures, for the one process that serves HTTP:
//   - CPU seconds (process.cpuUsage), memory (rss / heap sampled every second: peak and average), event-loop delay
//     (monitorEventLoopDelay), garbage-collection time;
//   - per request "route" (kind + path pattern, see routeOf): count, bytes sent, wall time, database calls;
//   - open Server-Sent Events streams (now and peak), per stream path;
//   - every MongoDB call made while serving a request carries `comment: 'wos|<route>'`, so the mongod profiler can
//     report documents examined per route even when requests overlap.
// Stats are served on METER_PORT (GET /stats, POST /reset), bound to 127.0.0.1 only.
'use strict';
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { monitorEventLoopDelay, PerformanceObserver } = require('node:perf_hooks');

const PORT = Number(process.env.METER_PORT || 0);
const als = new AsyncLocalStorage();

/** One request's route: '<kind> <pattern>'. kind: page, rsc, prefetch, action, api, stream. */
function routeOf(req) {
  const h = req.headers;
  const url = String(req.url || '/');
  const path = url.split('?')[0];
  if (path.startsWith('/_next/') || path === '/favicon.ico' || path.startsWith('/icons/') || /\.(js|css|png|svg|webmanifest|json|txt|html|ico)$/.test(path)) return 'static';
  let p = path
    .replace(/^\/tasks\/[^/]+/, '/tasks/[id]')
    .replace(/^\/projects\/[^/]+/, '/projects/[id]')
    .replace(/^\/notes\/[^/]+/, '/notes/[id]')
    .replace(/^\/modes\/[^/]+/, '/modes/[mode]')
    .replace(/^\/api\/auth\/.*/, '/api/auth/*')
    .replace(/^\/api\/mcp\/.+/, '/api/mcp/[key]');
  if (p === '/api/stream' || p === '/api/worker/stream') return 'stream ' + p;
  if (p.startsWith('/api/')) return 'api ' + p;
  if (h['next-action']) return 'action ' + p;
  if (h['next-router-prefetch']) {
    const seg = h['next-router-segment-prefetch'];
    return 'prefetch ' + p + (seg ? ' seg' : '');
  }
  if (h.rsc) return 'rsc ' + p;
  return 'page ' + p;
}

const zero = () => ({ n: 0, bytes: 0, ms: 0, msMax: 0, dbCalls: 0, status: {} });
let S;
function reset() {
  S = {
    since: Date.now(),
    cpu: process.cpuUsage(),
    mem: { samples: 0, rssSum: 0, heapSum: 0, rssPeak: 0, heapPeak: 0 },
    gcMs: 0,
    gcCount: 0,
    routes: {},
    clients: {},
    streams: { open: S ? S.streams.open : {}, peak: {} },
  };
  for (const [k, v] of Object.entries(S.streams.open)) S.streams.peak[k] = v;
  eld.reset();
}
const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
reset();

setInterval(() => {
  const m = process.memoryUsage();
  S.mem.samples++;
  S.mem.rssSum += m.rss;
  S.mem.heapSum += m.heapUsed;
  if (m.rss > S.mem.rssPeak) S.mem.rssPeak = m.rss;
  if (m.heapUsed > S.mem.heapPeak) S.mem.heapPeak = m.heapUsed;
}, 1000).unref();

try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      S.gcMs += e.duration;
      S.gcCount++;
    }
  }).observe({ entryTypes: ['gc'] });
} catch {
  /* no gc entries on this Node */
}

function snapshot() {
  const cpu = process.cpuUsage(S.cpu);
  const ms = Date.now() - S.since;
  const MB = 1024 * 1024;
  return {
    pid: process.pid,
    wallSec: ms / 1000,
    cpuSec: (cpu.user + cpu.system) / 1e6,
    cpuUserSec: cpu.user / 1e6,
    cpuSystemSec: cpu.system / 1e6,
    memMB: {
      rssPeak: Math.round(S.mem.rssPeak / MB),
      rssAvg: S.mem.samples ? Math.round(S.mem.rssSum / S.mem.samples / MB) : 0,
      heapPeak: Math.round(S.mem.heapPeak / MB),
      heapAvg: S.mem.samples ? Math.round(S.mem.heapSum / S.mem.samples / MB) : 0,
      rssNow: Math.round(process.memoryUsage().rss / MB),
    },
    eventLoopMs: { mean: +(eld.mean / 1e6).toFixed(2), p50: +(eld.percentile(50) / 1e6).toFixed(2), p99: +(eld.percentile(99) / 1e6).toFixed(2), max: +(eld.max / 1e6).toFixed(2) },
    gc: { ms: Math.round(S.gcMs), count: S.gcCount },
    routes: S.routes,
    clients: S.clients,
    streams: S.streams,
  };
}

// ── HTTP: every request of the app's server ───────────────────────────────────
let meterServer = null;
let started = false;
function startMeter() {
  if (started || !PORT) return;
  started = true;
  meterServer = http.createServer((req, res) => {
    if (req.url === '/reset' && req.method === 'POST') {
      reset();
      res.end('ok');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(snapshot()));
  });
  meterServer.on('error', e => console.error('[meter] ' + e.message));
  meterServer.listen(PORT, '127.0.0.1');
  meterServer.unref();
}

const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res) {
  if (event !== 'request' || this === meterServer) return origEmit.apply(this, arguments);
  startMeter();
  const route = routeOf(req);
  const t0 = process.hrtime.bigint();
  const r = (S.routes[route] ??= zero());
  r.n++;
  const tag = req.headers['x-load-client'] || (route.includes('/api/worker') ? 'worker' : route.includes('/api/mcp') ? 'mcp' : 'other');
  const c = (S.clients[tag] ??= {});
  c[route] = (c[route] || 0) + 1;
  const store = { route, r };
  let bytes = 0;
  const w = res.write;
  const e = res.end;
  let stream = null;
  res.write = function (chunk, enc) {
    if (chunk) bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk.length;
    if (!stream && route.startsWith('stream ') && String(res.getHeader('content-type') || '').includes('event-stream')) {
      stream = route.slice(7);
      S.streams.open[stream] = (S.streams.open[stream] || 0) + 1;
      S.streams.peak[stream] = Math.max(S.streams.peak[stream] || 0, S.streams.open[stream]);
    }
    return w.apply(this, arguments);
  };
  res.end = function (chunk, enc) {
    if (chunk && typeof chunk !== 'function') bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8') : chunk.length;
    return e.apply(this, arguments);
  };
  res.on('close', () => {
    const cur = S.routes[route] ?? (S.routes[route] = zero());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (cur === r) {
      r.bytes += bytes;
      r.ms += ms;
      if (ms > r.msMax) r.msMax = ms;
    } else {
      // counted across a reset: put the bytes in the new window
      cur.bytes += bytes;
    }
    r.status[res.statusCode] = (r.status[res.statusCode] || 0) + 1;
    if (stream) S.streams.open[stream] = Math.max(0, (S.streams.open[stream] || 1) - 1);
  });
  return als.run(store, () => origEmit.apply(this, arguments));
};

// ── MongoDB: tag every call with its route ──────────────────────────────────
try {
  const { Collection } = require('mongodb');
  const OPTS = { find: 1, findOne: 1, countDocuments: 1, aggregate: 1, distinct: 2, insertOne: 1, insertMany: 1, updateOne: 2, updateMany: 2, replaceOne: 2, deleteOne: 1, deleteMany: 1, bulkWrite: 1, findOneAndUpdate: 2, findOneAndDelete: 1, findOneAndReplace: 2, estimatedDocumentCount: 0 };
  for (const [name, i] of Object.entries(OPTS)) {
    const orig = Collection.prototype[name];
    if (typeof orig !== 'function') continue;
    Collection.prototype[name] = function (...a) {
      const st = als.getStore();
      if (st) {
        st.r.dbCalls++;
        while (a.length < i) a.push(undefined);
        const o = a[i] && typeof a[i] === 'object' ? a[i] : {};
        if (o.comment === undefined) a[i] = { ...o, comment: 'wos|' + st.route };
      } else {
        const bg = (S.routes['(background)'] ??= zero());
        bg.dbCalls++;
      }
      return orig.apply(this, a);
    };
  }
} catch (e) {
  console.error('[meter] mongodb not patched: ' + e.message);
}
