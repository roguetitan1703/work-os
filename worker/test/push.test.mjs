import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connectPush } from '../push.mjs';
import { createCore, STATUS_EVERY_MS, STATUS_IDLE_MS } from '../core.mjs';

const TOKEN = 'wkr_' + 'B'.repeat(43);
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

// A tiny SSE server: /api/worker/stream with the key, events sent with s.send(event).
async function sseServer() {
  const s = { clients: [], connects: 0, refused: 0 };
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/worker/stream') { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { s.refused++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    s.connects++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('retry: 5000\nevent: hello\ndata: {"ttl":1800000}\n\n');
    s.clients.push(res);
    req.on('close', () => { s.clients = s.clients.filter((c) => c !== res); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}`;
  s.send = (event, data = '{}') => { for (const c of s.clients) c.write(`event: ${event}\ndata: ${data}\n\n`); };
  s.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return s;
}

test('push: connects with the device key, a jobs event wakes, ttl reconnects at once', async () => {
  const srv = await sseServer();
  let wakes = 0;
  const ups = [];
  const p = connectPush({ getCfg: () => ({ baseUrl: srv.url }), getToken: () => TOKEN, onWake: () => wakes++, onUp: (u) => ups.push(u) });
  try {
    assert.ok(await until(() => p.up), 'up after hello');
    srv.send('jobs');
    assert.ok(await until(() => wakes === 1), 'jobs event wakes the worker');
    srv.send('other'); // unknown events are ignored
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(wakes, 1);
    srv.send('bye', '{"r":"ttl"}');
    assert.ok(await until(() => srv.connects === 2 && p.up), 'reconnects right after a ttl bye');
    assert.deepEqual(ups.slice(0, 2), [true, false]);
  } finally {
    p.stop();
    await srv.close();
  }
});

test('push: a refused key is not up and does not retry quickly', async () => {
  const srv = await sseServer();
  const p = connectPush({ getCfg: () => ({ baseUrl: srv.url }), getToken: () => 'wkr_' + 'C'.repeat(43), onWake: () => {} });
  try {
    assert.ok(await until(() => srv.refused === 1));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(p.up, false);
    assert.equal(srv.refused, 1, 'waits minutes before trying again');
  } finally {
    p.stop();
    await srv.close();
  }
});

test('push: a dropped stream reconnects with backoff', async () => {
  const srv = await sseServer();
  const p = connectPush({ getCfg: () => ({ baseUrl: srv.url }), getToken: () => TOKEN, onWake: () => {} });
  try {
    assert.ok(await until(() => p.up));
    for (const c of srv.clients) c.destroy();
    assert.ok(await until(() => !p.up), 'down when the stream ends');
    assert.ok(await until(() => srv.connects === 2 && p.up, 4000), 'back within the first backoff step');
  } finally {
    p.stop();
    await srv.close();
  }
});

function mkCore() {
  let t = 10_000_000;
  const reports = [];
  let counts = { sessions: 0, sessionsWorkOs: 0, sessionsOther: 0, sessionsActive: 0, subagents: 0 };
  const state = { ids: {}, folders: {}, sessions: {}, markers: {} };
  const core = createCore({
    getConfig: () => ({ roots: [] }), state, save: () => {}, now: () => t,
    api: { postStatus: async (b) => void reports.push(JSON.parse(JSON.stringify(b))) },
    launcher: async () => {}, listProcesses: async () => [], killPid: async () => {},
    activity: async () => ({ counts, list: [] }),
  });
  return { core, state, reports, adv: (ms) => (t += ms), setCounts: (c) => (counts = { ...counts, ...c }) };
}

test('status with push up: sent only when something changed (and at least every STATUS_IDLE_MS)', async () => {
  const m = mkCore();
  assert.equal(await m.core.statusTick(true), true, 'first status goes out');
  m.adv(STATUS_EVERY_MS);
  assert.equal(await m.core.statusTick(true), false, 'nothing changed: nothing sent');
  m.setCounts({ sessions: 1, sessionsOther: 1 });
  assert.equal(await m.core.statusTick(true), true, 'a new session: sent');
  m.adv(STATUS_IDLE_MS);
  assert.equal(await m.core.statusTick(true), true, 'long quiet: sent anyway');
  assert.equal(m.reports.length, 3);
});

test('status without push, or with a Work OS session running: every STATUS_EVERY_MS as before', async () => {
  const m = mkCore();
  assert.equal(await m.core.statusTick(false), true);
  m.adv(STATUS_EVERY_MS - 1000);
  assert.equal(await m.core.statusTick(false), false);
  m.adv(1000);
  assert.equal(await m.core.statusTick(false), true, 'heartbeat without push');
  m.state.sessions['11111111-2222-4333-8444-555555555555'] = { folderId: 'f_x', state: 'running', startedAt: 0 };
  m.adv(STATUS_EVERY_MS);
  assert.equal(await m.core.statusTick(true), true, 'heartbeat while a session runs, push or not');
});
