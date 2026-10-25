import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../bundle/build.mjs';
import { runSetup, checkPrereqs, DEFAULT_SERVER } from '../setup.mjs';
import { checkForUpdate } from '../update.mjs';
import { bundleId } from '../config.mjs';
import { TEST_TOKEN } from './fake-server.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wos-install-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('bundle: same bytes every time, sha256 matches, tests and secrets are not in it', () => {
  const a = buildBundle(WORKER), b = buildBundle(WORKER);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, createHash('sha256').update(a.body).digest('hex'));
  assert.ok(a.files.includes('worker.mjs') && a.files.includes('setup.mjs') && a.files.includes('supervisor.mjs'));
  assert.ok(!a.files.some((f) => f.includes('test')), 'no test files');
  assert.ok(!/wkr_[A-Za-z0-9_-]{20,}/.test(a.body), 'no device key in the bundle');
  assert.ok(!/BETTER_AUTH_SECRET\s*=|mongodb\+srv|CRON_SECRET\s*=/.test(a.body));
  assert.match(a.version, /^\d+\.\d+\.\d+$/);
});

test('bundle: run once it unpacks beside itself, marks its sha256, and passes arguments on', () => {
  const d = tmp();
  try {
    const b = buildBundle(WORKER);
    const f = path.join(d, 'work-os-worker.mjs');
    fs.writeFileSync(f, b.body);
    const env = { ...process.env, WORK_OS_WORKER_DIR: path.join(d, 'cfg') };
    const r = spawnSync(process.execPath, [f, 'status'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /worker unpacked/);
    assert.match(r.stdout, new RegExp(`downloaded bundle ${b.sha256.slice(0, 12)}`));
    assert.equal(bundleId(path.join(d, 'worker')), b.sha256);
    assert.ok(fs.existsSync(path.join(d, 'worker', 'supervisor.mjs')));
    assert.ok(!fs.existsSync(path.join(d, 'worker', 'test')));
    // second run: nothing to unpack
    const r2 = spawnSync(process.execPath, [f, 'status'], { encoding: 'utf8', env });
    assert.ok(!/worker unpacked/.test(r2.stdout));
    // a stale file from an older version goes away on update
    fs.writeFileSync(path.join(d, 'worker', 'old.mjs'), 'x');
    fs.writeFileSync(path.join(d, 'worker', 'BUNDLE'), 'old\n');
    spawnSync(process.execPath, [f, 'status'], { encoding: 'utf8', env });
    assert.ok(!fs.existsSync(path.join(d, 'worker', 'old.mjs')));
  } finally { rm(d); }
});

test('update check: only a downloaded bundle asks, and only a different sha256 counts', async () => {
  const cur = 'a'.repeat(64), other = 'b'.repeat(64);
  const serve = (sha) => async () => ({ status: 200, json: async () => ({ version: '9.9.9', sha256: sha }) });
  assert.equal(await checkForUpdate({ baseUrl: 'https://x.example', fetchImpl: serve(other), current: null }), null);
  assert.equal(await checkForUpdate({ baseUrl: 'https://x.example', fetchImpl: serve(cur), current: cur }), null);
  assert.deepEqual(await checkForUpdate({ baseUrl: 'https://x.example', fetchImpl: serve(other), current: cur }), { current: cur, latest: other, version: '9.9.9' });
  assert.equal(await checkForUpdate({ baseUrl: 'https://x.example', fetchImpl: async () => ({ status: 404 }), current: cur }), null);
  assert.equal(await checkForUpdate({ baseUrl: 'https://x.example', fetchImpl: async () => { throw new Error('down'); }, current: cur }), null);
});

test('prereqs: old Node and missing Claude Code are named with a link', () => {
  assert.deepEqual(checkPrereqs([], { nodeVersion: '22.1.0', find: () => '/x/claude' }), []);
  const p = checkPrereqs([], { nodeVersion: '20.11.0', find: () => null });
  assert.equal(p.length, 2);
  assert.match(p[0], /Node 22 or newer.*nodejs\.org/);
  assert.match(p[1], /Claude Code was not found.*https:\/\//);
});

// ---- setup flow with a stub server ----
function stub(status) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    const ok = req.headers.authorization === `Bearer ${TEST_TOKEN}` && status === 200;
    res.writeHead(ok ? 200 : req.headers.authorization === `Bearer ${TEST_TOKEN}` ? status : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { enabled: true, pollSeconds: 30, links: [], jobs: [] } : { error: 'no' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => { server.closeAllConnections?.(); return new Promise((x) => server.close(x)); } })));
}

async function setup({ argv, lines, config, token = null, verify, defaultServer, tty = false }) {
  const dir = tmp();
  const prev = process.env.WORK_OS_WORKER_DIR;
  process.env.WORK_OS_WORKER_DIR = dir;
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(' '));
  // One line at a time, as a person types: readline drops a line that arrives before the next question is asked.
  const input = new PassThrough();
  input.isTTY = tty;
  (async () => { for (const l of lines) { await new Promise((r) => setTimeout(r, tty ? 150 : 40)); input.write(l + '\n'); } })();
  const stored = { token };
  const calls = { scans: 0, installs: 0 };
  let error = null;
  try {
    await runSetup({
      argv,
      deps: {
        input, verify, defaultServer,
        getToken: () => stored.token, setToken: (t) => { stored.token = t; }, readSecret: async () => TEST_TOKEN,
        scanAndReport: async () => { calls.scans++; return 3; }, install: () => { calls.installs++; },
      },
    });
  } catch (e) { error = e; } finally { console.log = log; }
  const cfg = fs.existsSync(path.join(dir, 'config.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) : null;
  if (prev === undefined) delete process.env.WORK_OS_WORKER_DIR; else process.env.WORK_OS_WORKER_DIR = prev;
  rm(dir);
  return { out: out.join('\n'), cfg, stored, calls, error };
}

test('setup: a fresh install against a stub server asks for the key on stdin, never the command line, and finishes', async () => {
  const s = await stub(200);
  const root = tmp();
  try {
    const r = await setup({ argv: ['--server', s.url, '--name', 'Test-PC', '--root', root], lines: [TEST_TOKEN] });
    assert.equal(r.error, null);
    assert.equal(r.stored.token, TEST_TOKEN);
    assert.equal(r.cfg.baseUrl, s.url);
    assert.ok(!JSON.stringify(r.cfg).includes(TEST_TOKEN), 'key never in config.json');
    assert.deepEqual(r.calls, { scans: 1, installs: 1 });
    assert.deepEqual(s.calls.map((c) => c.url), ['/api/worker/jobs']);
    // a refused key stops before anything is written
    const bad = await setup({ argv: ['--server', s.url, '--name', 'T', '--root', root], lines: ['wkr_' + 'Z'.repeat(43)] });
    assert.match(String(bad.error), /key refused/);
    assert.equal(bad.cfg, null);
    assert.equal(bad.stored.token, null);
  } finally { await s.close(); rm(root); }
});

test('setup: the default server is the Delpat address', () => {
  assert.equal(DEFAULT_SERVER, 'https://work.delpat.in');
});

test('setup: a config that points at a *.vercel.app address says so and offers the new one (Y switches, n keeps)', async () => {
  const root = tmp();
  const config = { baseUrl: 'https://work-os-old.vercel.app', deviceName: 'Om-PC', roots: [root] };
  const verified = [];
  const verify = async (url) => { verified.push(url); return { ok: true, status: 200 }; };
  try {
    const yes = await setup({ argv: [], config, lines: ['', TEST_TOKEN], verify, defaultServer: 'https://work.example.test' });
    assert.equal(yes.error, null, String(yes.error));
    assert.match(yes.out, /This config points at https:\/\/work-os-old\.vercel\.app/);
    assert.equal(yes.cfg.baseUrl, 'https://work.example.test');
    assert.deepEqual(verified, ['https://work.example.test']);
    verified.length = 0;
    const no = await setup({ argv: [], config, lines: ['n', TEST_TOKEN], verify, defaultServer: 'https://work.example.test' });
    assert.equal(no.cfg.baseUrl, 'https://work-os-old.vercel.app');
    assert.deepEqual(verified, ['https://work-os-old.vercel.app']);
    // an explicit --server is never second-guessed
    verified.length = 0;
    const flag = await setup({ argv: ['--server', 'https://work-os-old.vercel.app'], config, lines: [TEST_TOKEN], verify, defaultServer: 'https://work.example.test' });
    assert.equal(flag.cfg.baseUrl, 'https://work-os-old.vercel.app');
    assert.ok(!/old address/.test(flag.out));
  } finally { rm(root); }
});

test('setup: 402/404 offers the current address only for an old *.vercel.app host from the stored config, and only after a typed yes', async () => {
  const root = tmp();
  const D = 'https://work.example.test', OLD = 'https://work-os-old.vercel.app';
  const run = (code, o) => {
    const verified = [];
    const verify = async (url) => { verified.push(url); return url === D ? { ok: true, status: 200 } : { ok: false, status: code }; };
    return setup({ verify, defaultServer: D, ...o }).then((r) => ({ ...r, verified }));
  };
  const cfg = (baseUrl) => ({ baseUrl, deviceName: 'Om-PC', roots: [root] });
  for (const code of [402, 404]) {
    // piped input: nobody can answer, so nothing is switched and the key never goes to the new host
    let r = await run(code, { argv: [], config: cfg(OLD), lines: ['n', TEST_TOKEN] });
    assert.match(String(r.error), /nothing was changed.*--server https:\/\/work\.example\.test/);
    assert.deepEqual(r.verified, [OLD]);
    assert.equal(r.cfg?.baseUrl, OLD);
    // not an old host: never offered, plain error
    r = await run(code, { argv: [], config: cfg('https://old.example'), lines: [TEST_TOKEN] });
    assert.match(String(r.error), new RegExp(`HTTP ${code}`));
    assert.deepEqual(r.verified, ['https://old.example']);
    // --server given on the command line: never second-guessed, even a vercel address
    r = await run(code, { argv: ['--server', OLD, '--name', 'n', '--root', root], config: cfg(OLD), lines: [TEST_TOKEN] });
    assert.match(String(r.error), new RegExp(`HTTP ${code}`));
    assert.deepEqual(r.verified, [OLD]);
    // at a terminal: 'n' to the first question (keep the old address), then yes to the second -> verified there next
    r = await run(code, { argv: [], config: cfg(OLD), lines: ['n', 'y'], tty: true });
    assert.equal(r.error, null, String(r.error));
    assert.deepEqual(r.verified, [OLD, D]);
    assert.equal(r.cfg.baseUrl, D);
    // at a terminal, a no: the key is not sent to the new host
    r = await run(code, { argv: [], config: cfg(OLD), lines: ['n', 'n'], tty: true });
    assert.match(String(r.error), /nothing was changed/);
    assert.deepEqual(r.verified, [OLD]);
  }
  rm(root);
});

test('windows autostart: per-user Run key, no schtasks create, old task removed with errors ignored, started now; failure says how to run by hand', async () => {
  const { installWindows, uninstallWindows } = await import('../install.mjs');
  const ran = [], started = [];
  const run = (cmd, args) => { ran.push([cmd, ...args]); if (cmd === 'schtasks') throw new Error('Access is denied'); };
  const v = installWindows({ run, start: (c, a) => started.push([c, ...a]) });
  assert.ok(ran.some((r) => r[0] === 'reg' && r[1] === 'add' && r[2].startsWith('HKCU\\') && r.includes('/f')));
  assert.ok(!ran.some((r) => r[0] === 'schtasks' && r.includes('/Create')), 'no ONLOGON task (needs admin)');
  assert.ok(ran.some((r) => r[0] === 'schtasks' && r.includes('/Delete')), 'old task removal attempted');
  assert.match(v, /conhost\.exe --headless .*supervisor\.mjs/);
  assert.equal(started.length, 1);
  assert.throws(() => installWindows({ run: (c) => { if (c === 'reg') throw new Error('x'); }, start: () => assert.fail('must not start') }), /Run it by hand instead: ".*supervisor\.mjs"/);
  ran.length = 0;
  uninstallWindows({ run });
  assert.ok(ran.some((r) => r[0] === 'reg' && r[1] === 'delete') && ran.some((r) => r[0] === 'schtasks'));
});

test('setup: an autostart failure is one line with the hand command, then setup still finishes', async () => {
  const root = tmp();
  const r = await (async () => {
    const dir = tmp(); process.env.WORK_OS_WORKER_DIR = dir;
    const out = []; const log = console.log; console.log = (...a) => out.push(a.join(' '));
    const input = new PassThrough(); input.isTTY = false;
    (async () => { await new Promise((x) => setTimeout(x, 40)); input.write(TEST_TOKEN + '\n'); })();
    let error = null;
    try { await runSetup({ argv: ['--server', 'https://x.example', '--name', 'n', '--root', root], deps: { input, verify: async () => ({ ok: true, status: 200 }), getToken: () => null, setToken() {}, readSecret: async () => '', scanAndReport: async () => 2, install: () => { throw new Error('could not add it. Run it by hand instead: node supervisor.mjs\nstack line'); } } }); } catch (e) { error = e; }
    console.log = log; delete process.env.WORK_OS_WORKER_DIR; rm(dir);
    return { out: out.join('\n'), error };
  })();
  rm(root);
  assert.equal(r.error, null);
  assert.match(r.out, /autostart not set: could not add it\. Run it by hand instead: node supervisor\.mjs\n?/);
  assert.ok(!/stack line/.test(r.out));
  assert.match(r.out, /Done:/);
});

test('supervisor lock: created atomically; a live pid from this boot blocks a second; a dead pid or one from before the boot does not', async () => {
  const { takeLock } = await import('../supervisor.mjs');
  const d = tmp(); const f = path.join(d, 'supervisor.pid');
  try {
    const boot = Date.now() - 3600_000;
    assert.equal(takeLock(f, 111, () => true, boot), true);
    assert.equal(fs.readFileSync(f, 'utf8'), '111');
    assert.equal(takeLock(f, 222, () => true, boot), false, 'alive: blocked however old the file (a laptop sleep must not free it)');
    fs.utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    assert.equal(takeLock(f, 222, () => true, boot), false, 'alive and written after the boot: still blocked');
    assert.equal(takeLock(f, 222, () => false, boot), true, 'dead pid: replaced');
    assert.equal(fs.readFileSync(f, 'utf8'), '222');
    assert.equal(takeLock(f, 333, () => true, Date.now() + 60_000), true, 'written before the last boot: its pid may be another program');
    // two starts at the same moment: 'wx' lets only one create the file
    const g = path.join(d, 'race.pid');
    const first = takeLock(g, 1, () => true, boot), second = takeLock(g, 2, () => true, boot);
    assert.deepEqual([first, second], [true, false]);
  } finally { rm(d); }
});
