// Run keys, the worker side (docs/dispatcher.md "Run keys"): a dispatched run never gets its person's own Work OS credential. It runs
// with a strict MCP config holding only its own run key, a settings file that blanks WORK_OS_KEY in the settings env block, and an
// environment with the key removed; both files go when claude ends, and a dispatched run without a run key is never started.
// Keys here are generated test values; nothing prints one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as run from '../dispatch-run.mjs';
import { claudeArgs, launch, windowsWtArgs } from '../launch.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-run-key-'));
const dir = path.join(tmp, run.RUN_DIR_NAME);
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const tok = (p) => p + '_' + randomBytes(32).toString('base64url');
const runKey = tok('wdr');
const personKey = tok('wos');
const BASE = 'https://work.example.test';
// The person's own setup: Work OS through OAuth (no header), another Work OS entry with their key, a server on the Work OS host,
// and an unrelated server that stays.
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
  'work-os': { type: 'http', url: BASE + '/api/mcp' },
  wos2: { type: 'http', url: 'https://elsewhere.example.test/mcp', headers: { Authorization: 'Bearer ' + personKey } },
  same: { type: 'http', url: BASE + '/other' },
  envkey: { command: 'node', args: ['x.mjs'], env: { WORK_OS_KEY: personKey } },
  tools: { command: 'npx', args: ['some-mcp'] },
} }));
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { WORK_OS_KEY: personKey, OTHER_TOKEN: tok('wkr'), TEMP: 'D:/t' } }));

test('scrubEnv drops WORK_OS_KEY and any variable holding a Work OS credential, keeps the rest', () => {
  const e = run.scrubEnv({ WORK_OS_KEY: personKey, work_os_key: 'x', AUTH: 'Bearer ' + tok('wosat'), DEV: tok('wkr'), SESS: tok('wst'), PATH: '/usr/bin', HOME: '/h', NOTE: 'wos_ is a prefix' });
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'NOTE', 'PATH']);
});

test('runSettings blanks WORK_OS_KEY and any settings env value holding a Work OS credential, nothing else', () => {
  assert.deepEqual(run.runSettings(home), { env: { WORK_OS_KEY: '', OTHER_TOKEN: '' } });
  assert.deepEqual(run.runSettings(path.join(tmp, 'nohome')), { env: { WORK_OS_KEY: '' } });
  // the run's folder: its project and local settings env blocks count too
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ env: { PROJ_KEY: tok('wos'), PLAIN: 'x' } }));
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { LOCAL_KEY: 'Bearer ' + tok('wst') } }));
  assert.deepEqual(run.runSettings(home, repo), { env: { WORK_OS_KEY: '', OTHER_TOKEN: '', PROJ_KEY: '', LOCAL_KEY: '' } });
  const f = run.writeRunFiles({ sessionId: randomUUID(), baseUrl: BASE, key: runKey, dir, home, folder: repo });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8')).env, { WORK_OS_KEY: '', OTHER_TOKEN: '', PROJ_KEY: '', LOCAL_KEY: '' });
});

test('writeRunFiles: Work OS with the run key only, the other servers without any Work OS entry or credential, and the settings', () => {
  const sid = randomUUID();
  const f = run.writeRunFiles({ sessionId: sid, baseUrl: BASE + '/', key: runKey, dir, home });
  assert.equal(f.mcpConfig, path.join(dir, `run-${sid}.json`));
  assert.equal(f.settings, path.join(dir, `run-${sid}.settings.json`));
  const cfg = JSON.parse(fs.readFileSync(f.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['tools', 'work-os']);
  assert.deepEqual(cfg.mcpServers['work-os'], { type: 'http', url: BASE + '/api/mcp', headers: { Authorization: 'Bearer ' + runKey } });
  assert.ok(!fs.readFileSync(f.mcpConfig, 'utf8').includes(personKey), "the person's key is nowhere in the run's config");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8')), { env: { WORK_OS_KEY: '', OTHER_TOKEN: '' } });
  assert.throws(() => run.writeRunFiles({ sessionId: sid, baseUrl: BASE, key: personKey, dir, home }), /bad run key/);
  assert.throws(() => run.writeRunFiles({ sessionId: '../x', baseUrl: BASE, key: runKey, dir, home }), /bad session id/);
});

test('claudeArgs: a dispatched run uses its strict config and its settings; an ordinary start is unchanged', () => {
  const sid = randomUUID();
  const a = claudeArgs({ kind: 'start', sessionId: sid, projectName: 'P', prompt: 'go', mcpConfig: 'C:/demo.json', runFiles: { mcpConfig: 'C:/t/work-os-run/r.json', settings: 'C:/t/work-os-run/r.settings.json' } });
  assert.deepEqual(a.slice(0, 7), ['--session-id', sid, '--strict-mcp-config', '--mcp-config', 'C:/t/work-os-run/r.json', '--settings', 'C:/t/work-os-run/r.settings.json']);
  assert.equal(a.at(-1), 'go');
  const plain = claudeArgs({ kind: 'start', sessionId: sid, projectName: 'P' });
  assert.ok(!plain.includes('--strict-mcp-config') && !plain.includes('--settings'));
});

test('launch: a dispatched run without a run key is never started; with one it starts on its own files, which go if the start fails', { skip: process.platform !== 'win32' && 'Windows path' }, async () => {
  const spawned = [];
  const spawn = async (cmd, args) => { spawned.push([cmd, args]); };
  const sid = randomUUID();
  const base = { kind: 'start', folder: tmp, sessionId: sid, projectName: 'P', claudePath: 'C:/claude.exe', dispatched: 12 };
  await assert.rejects(launch(base, { spawn, runDir: dir, home }), /needs its own Work OS key/);
  assert.equal(spawned.length, 0);
  await launch({ ...base, run: { key: runKey }, baseUrl: BASE }, { spawn, runDir: dir, home });
  const args = spawned[0][1];
  assert.equal(spawned[0][0], 'wt.exe');
  assert.ok(args.includes('--work-os-dispatched=12'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], path.join(dir, `run-${sid}.json`));
  assert.equal(args[args.indexOf('--settings') + 1], path.join(dir, `run-${sid}.settings.json`));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.some((x) => x.includes(runKey)), 'the key is in the file, never on the command line');
  assert.ok(fs.existsSync(path.join(dir, `run-${sid}.json`)));
  const sid2 = randomUUID();
  const boom = async () => { throw new Error('boom'); };
  await assert.rejects(launch({ ...base, sessionId: sid2, run: { key: runKey }, baseUrl: BASE }, { spawn: boom, runDir: dir, home }), /boom/);
  assert.ok(!fs.existsSync(path.join(dir, `run-${sid2}.json`)) && !fs.existsSync(path.join(dir, `run-${sid2}.settings.json`)));
  // an ordinary start writes no run files and passes no settings
  await launch({ ...base, dispatched: undefined, sessionId: randomUUID() }, { spawn, runDir: dir, home });
  assert.ok(!spawned[1][1].includes('--settings') && !spawned[1][1].includes('--strict-mcp-config'));
});

test('the wrapper: a dispatched run gets no WORK_OS_KEY or credential variable, and its run files are deleted when claude ends', () => {
  const sid = randomUUID();
  const f = run.writeRunFiles({ sessionId: sid, baseUrl: BASE, key: runKey, dir, home });
  const wrapper = fileURLToPath(new URL('../run-claude.mjs', import.meta.url));
  const probe = path.join(tmp, 'probe.mjs');
  fs.writeFileSync(probe, 'console.log("K=" + (process.env.WORK_OS_KEY === undefined ? "none" : "set") + " T=" + (process.env.SOME_TOKEN === undefined ? "none" : "set") + " P=" + (process.env.KEEP_ME || "") + " D=" + (process.env.WORK_OS_DISPATCHED || "none"));');
  const env = { ...process.env, WORK_OS_KEY: personKey, SOME_TOKEN: tok('wos'), KEEP_ME: 'yes' };
  // claudePath is node here and the probe script its first argument; the run files ride after it as they do on a claude command line
  const out = spawnSync(process.execPath, [wrapper, '--work-os-dispatched=12', process.execPath, probe, '--mcp-config', f.mcpConfig, '--settings', f.settings], { env, encoding: 'utf8' }).stdout;
  assert.match(out, /K=none T=none P=yes D=12/);
  assert.ok(!fs.existsSync(f.mcpConfig) && !fs.existsSync(f.settings), 'both run files are gone');
  // an ordinary run keeps its environment (the person's own session) and touches no file
  const g = run.writeRunFiles({ sessionId: randomUUID(), baseUrl: BASE, key: runKey, dir, home });
  const out2 = spawnSync(process.execPath, [wrapper, process.execPath, probe, '--mcp-config', g.mcpConfig], { env, encoding: 'utf8' }).stdout;
  assert.match(out2, /K=set T=set P=yes D=none/);
  assert.ok(fs.existsSync(g.mcpConfig));
  // a path that is not a run file is never deleted
  const other = path.join(tmp, 'keep.json');
  fs.writeFileSync(other, '{}');
  spawnSync(process.execPath, [wrapper, '--work-os-dispatched=12', process.execPath, probe, '--mcp-config', other], { env, encoding: 'utf8' });
  assert.ok(fs.existsSync(other));
  assert.equal(run.removeRunConfig(other), false);
});

test('sweepRunConfigs removes the run files of sessions that no longer run, never a young file or a running one', () => {
  const d = path.join(tmp, 'sweep', run.RUN_DIR_NAME);
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  for (const s of [a, b, c]) run.writeRunFiles({ sessionId: s, baseUrl: BASE, key: runKey, dir: d, home });
  fs.writeFileSync(path.join(d, 'other.json'), '{}');
  const later = Date.now() + 10 * 60_000;
  assert.equal(run.sweepRunConfigs(new Set([a]), d, { now: Date.now() }), 0, 'young files stay');
  assert.equal(run.sweepRunConfigs(new Set([a]), d, { now: later }), 4);
  assert.deepEqual(fs.readdirSync(d).sort(), ['other.json', `run-${a}.json`, `run-${a}.settings.json`].sort());
  void c;
});

test('runFor: asks the server for the run key of a dispatched start or resume; without one the run is not started', async () => {
  const sid = randomUUID();
  const asked = [];
  const api = { runKey: async (s) => (asked.push(s), { key: runKey, ref: 7 }) };
  assert.equal(await run.runFor({ sessionId: sid }, api), null);
  assert.deepEqual(await run.runFor({ sessionId: sid.toUpperCase(), dispatched: 7 }, api), { key: runKey });
  assert.deepEqual(asked, [sid]);
  assert.deepEqual(await run.runFor({ sessionId: sid, dispatched: 7, run: { key: runKey } }, { runKey: async () => { throw new Error('not asked twice'); } }), { key: runKey });
  await assert.rejects(run.runFor({ sessionId: sid, dispatched: 7 }, { runKey: async () => { throw new Error('HTTP 400: a dispatched run that cannot be opened'); } }), /no run key .*not started/);
  await assert.rejects(run.runFor({ sessionId: sid, dispatched: 7 }, { runKey: async () => ({ key: personKey, ref: 7 }) }), /no run key/);
  await assert.rejects(run.runFor({ sessionId: sid, dispatched: 7 }, { runKey: async () => ({ dispatched: false }) }), /does not know this as a dispatched run/);
});

test('askRun: a dispatched run (key and ref), an ordinary session (null), and anything else is an error, never "ordinary"', async () => {
  const sid = randomUUID();
  assert.deepEqual(await run.askRun({ runKey: async () => ({ key: runKey, ref: 4, expiresAt: 'x' }) }, sid), { ref: 4, key: runKey });
  assert.equal(await run.askRun({ runKey: async () => ({ dispatched: false }) }, sid), null);
  for (const api of [{}, { runKey: async () => { throw new Error('HTTP 500'); } }, { runKey: async () => ({}) }, { runKey: async () => null }, { runKey: async () => ({ dispatched: false, key: runKey }) }, { runKey: async () => ({ key: runKey }) }]) {
    await assert.rejects(run.askRun(api, sid), /dispatched run/);
  }
  await assert.rejects(run.askRun({ runKey: async () => ({ dispatched: false }) }, 'bad'), /bad session id/);
});

test('askRuns, isRun and releaseRun: one request for many; refusals and odd answers are errors, never "ordinary"', async () => {
  const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const got = await run.askRuns({ runKeys: async () => ({ runs: [{ sessionId: a, key: runKey, ref: 3 }, { sessionId: b, dispatched: false }, { sessionId: c, refused: 'nope' }, { sessionId: d, dispatched: false, key: runKey }] }) }, [a, b, c, d, a.toUpperCase()]);
  assert.deepEqual([...got.keys()], [a, b, c, d]);
  assert.deepEqual(got.get(a), { ref: 3, key: runKey }); assert.equal(got.get(b), null);
  assert.deepEqual(got.get(c), { error: 'nope' }); assert.match(got.get(d).error, /unexpected/);
  assert.match((await run.askRuns({ runKeys: async () => ({ runs: [] }) }, [a])).get(a).error, /no answer/);
  await assert.rejects(run.askRuns({ runKeys: async () => { throw Object.assign(new Error('HTTP 429'), { status: 429 }); } }, [a]), (e) => e.busy === true);
  await assert.rejects(run.askRuns({}, [a]), /cannot ask/);
  await assert.rejects(run.askRuns({ runKeys: async () => ({ runs: [] }) }, ['bad']), /bad session id/);
  assert.equal(await run.isRun({ runCheck: async () => ({ dispatched: true }) }, a), true);
  assert.equal(await run.isRun({ runCheck: async () => ({ dispatched: false }) }, a), false);
  for (const api of [{}, { runCheck: async () => { throw new Error('HTTP 500'); } }, { runCheck: async () => ({}) }]) await assert.rejects(run.isRun(api, a), /dispatched run/);
  const rel = [];
  assert.equal(await run.releaseRun({ runRelease: async (s, k) => (rel.push([s, k]), { released: true }) }, a.toUpperCase(), runKey), true);
  assert.deepEqual(rel, [[a, runKey]]);
  assert.equal(await run.releaseRun({ runRelease: async () => { throw new Error('HTTP 500'); } }, a, runKey), false, 'best effort');
  assert.equal(await run.releaseRun({ runRelease: async () => { throw new Error('never sent'); } }, a, personKey), false, 'only a run key is ever sent back');
});

test('Open in VS Code never opens a dispatched run: remembered here, known to the server, or the server cannot say', async () => {
  const { createCore } = await import('../core.mjs');
  const root = path.join(tmp, 'vscode-root');
  const app = path.join(root, 'app');
  fs.mkdirSync(app, { recursive: true });
  const S = randomUUID();
  const mk = (runCheck) => {
    const opened = [];
    const checks = [];
    const state = { ids: {}, folders: { f1: app }, sessions: {}, markers: {}, doneJobs: [], reopen: [], openSet: [] };
    const c = createCore({
      getConfig: () => ({ roots: [root] }), state, save() {}, api: { runCheck: async (s) => (checks.push(s), runCheck()) },
      launcher: async () => {}, listProcesses: async () => [], killPid: async () => {},
      sessionLocal: () => ({ cwd: app, origin: 'vscode' }), openVscode: async (a) => void opened.push(a),
    });
    c.applyLinks([{ folderId: 'f1', projectId: 'p1', projectName: 'Proj' }]);
    return { c, state, opened, checks };
  };
  const plain = mk(async () => ({ dispatched: false }));
  assert.equal((await plain.c.handleJob({ id: 'v0', kind: 'vscode', sessionId: S })).ok, true);
  assert.equal(plain.opened.length, 1); assert.deepEqual(plain.checks, [S]);
  const srv = mk(async () => ({ dispatched: true }));
  const r1 = await srv.c.handleJob({ id: 'v1', kind: 'vscode', sessionId: S });
  assert.equal(r1.ok, false); assert.match(r1.error, /runs on its own key: use Resume/); assert.equal(srv.opened.length, 0);
  const down = mk(async () => { throw new Error('HTTP 503'); });
  const r2 = await down.c.handleJob({ id: 'v2', kind: 'vscode', sessionId: S });
  assert.equal(r2.ok, false); assert.match(r2.error, /could not check/); assert.equal(down.opened.length, 0);
  for (const remember of [(st) => { st.sessions[S] = { folderId: 'f1', state: 'running', dispatched: 4 }; }, (st) => { st.openSet = [{ sessionId: S, dispatched: 4 }]; }, (st) => { st.reopen = [{ sessionId: S, origin: 'vscode', dispatched: 4 }]; }]) {
    const m = mk(async () => ({ dispatched: false }));
    remember(m.state);
    const r = await m.c.handleJob({ id: 'v3', kind: 'vscode', sessionId: S });
    assert.equal(r.ok, false); assert.match(r.error, /use Resume/); assert.equal(m.opened.length, 0);
  }
});

test('the reopen set keeps a dispatched run\'s ref after the worker forgets the run (restart, upgrade), and Reopen all asks the server', async () => {
  const { trackOpenSet } = await import('../openset.mjs');
  const { createCore } = await import('../core.mjs');
  const [D, P, U] = [randomUUID(), randomUUID(), randomUUID()];
  // Before the restart: two runs open, D dispatched (#9) per the worker's own sessions; then the worker forgets D (marked dead, pruned).
  const st = { sessions: { [D]: { folderId: 'f1', state: 'running', dispatched: 9 } }, reopen: [], openSet: [] };
  const t0 = 1_000_000;
  trackOpenSet(st, [{ sessionId: D, running: true, origin: 'cli' }, { sessionId: P, running: true, origin: 'cli' }], t0, true, (s) => st.sessions[s]?.dispatched);
  delete st.sessions[D];
  trackOpenSet(st, [{ sessionId: D, running: true, origin: 'cli' }, { sessionId: P, running: true, origin: 'cli' }], t0 + 60_000, false, () => undefined);
  assert.equal(st.openSet.find((s) => s.sessionId === D).dispatched, 9, 'the ref stays on the open set without the worker\'s session entry');
  assert.ok(!('dispatched' in st.openSet.find((s) => s.sessionId === P)));
  // Restart: both gone, both pending.
  trackOpenSet(st, [], t0 + 120_000, true, () => undefined);
  assert.equal(st.reopen.find((s) => s.sessionId === D).dispatched, 9);

  // Reopen all, against a fake server.
  const root = path.join(tmp, 'reopen-root');
  const app = path.join(root, 'app');
  fs.mkdirSync(app, { recursive: true });
  // answers: per session id, what the batched run-key call says (an Error for all: the request fails). launchFails: ids whose launch throws.
  const mk = (answers, { launchFails = [] } = {}) => {
    const launched = [];
    const opened = [];
    const calls = [];
    const released = [];
    const state = { ids: {}, folders: { f1: app }, sessions: {}, markers: {}, doneJobs: [], reopen: [] };
    const c = createCore({
      getConfig: () => ({ roots: [root] }), state, save() {},
      api: {
        runKeys: async (ids) => { calls.push(ids); if (answers instanceof Error) throw answers; return { runs: ids.filter((s) => answers[s]).map((s) => ({ sessionId: s, ...answers[s] })) }; },
        runRelease: async (s, key) => (released.push([s, key]), { released: true }),
      },
      launcher: async (a) => { if (launchFails.includes(a.sessionId)) throw new Error('wt not found'); launched.push(a); }, listProcesses: async () => [], killPid: async () => {},
      sessionLocal: () => ({ cwd: app, origin: 'cli' }), openVscode: async (a) => void opened.push(a),
    });
    c.applyLinks([{ folderId: 'f1', projectId: 'p1', projectName: 'Proj' }]);
    return { c, state, launched, opened, calls, released };
  };
  // D dispatched per the server (a fresh key); P ordinary; U refused by the server; X missing from the answer: neither opened.
  const X = randomUUID();
  const m = mk({ [D]: { key: runKey, ref: 9 }, [P]: { dispatched: false }, [U]: { refused: 'a dispatched run that cannot be opened on this computer' } });
  m.state.reopen = [{ sessionId: D, origin: 'vscode', dispatched: 9 }, { sessionId: P, origin: 'cli' }, { sessionId: U, origin: 'cli' }, { sessionId: X, origin: 'cli' }];
  const r = await m.c.handleJob({ id: 'r', kind: 'reopen' });
  assert.equal(m.calls.length, 1, 'one request for all of them'); assert.deepEqual(m.calls[0], [D, P, U, X]);
  assert.equal(m.opened.length, 0, 'a dispatched run is never opened in VS Code');
  const d = m.launched.find((a) => a.sessionId === D);
  assert.equal(d.dispatched, 9); assert.deepEqual(d.run, { key: runKey }); assert.equal(d.kind, 'resume');
  assert.ok(!('dispatched' in m.launched.find((a) => a.sessionId === P)));
  assert.ok(!m.launched.some((a) => a.sessionId === U || a.sessionId === X), 'refused or no answer: not opened');
  assert.equal(r.ok, false); assert.match(r.error, /Opened 2 of 4.*cannot be opened.*no answer/);
  assert.deepEqual({ ...m.state.sessions[D], startedAt: 0 }, { folderId: 'f1', state: 'running', startedAt: 0, dispatched: 9 });
  assert.deepEqual(m.state.reopen.map((s) => s.sessionId), [U, X], 'the ones not opened stay, so Reopen all can be pressed again');
  // The server cannot be reached, or is busy (429): nothing opens, nothing is dropped.
  for (const [err, re] of [[new Error('HTTP 503'), /could not check/], [Object.assign(new Error('HTTP 429: too many requests'), { status: 429 }), /busy, try Reopen all again/]]) {
    const b = mk(err);
    b.state.reopen = [{ sessionId: D, origin: 'cli', dispatched: 9 }, { sessionId: P, origin: 'cli' }];
    const rb = await b.c.handleJob({ id: 'rb', kind: 'reopen' });
    assert.equal(b.launched.length + b.opened.length, 0); assert.match(rb.error, re);
    assert.deepEqual(b.state.reopen.map((s) => s.sessionId), [D, P]);
  }
  // A launch that fails after its key was issued: the key is released (the server ends it and puts the row back); the session stays pending.
  const f = mk({ [D]: { key: runKey, ref: 9 } }, { launchFails: [D] });
  f.state.reopen = [{ sessionId: D, origin: 'cli', dispatched: 9 }];
  const rf = await f.c.handleJob({ id: 'rf', kind: 'reopen' });
  assert.match(rf.error, /Opened 0 of 1: wt not found/);
  assert.deepEqual(f.released, [[D, runKey]]);
  assert.ok(!f.state.sessions[D]); assert.deepEqual(f.state.reopen.map((s) => s.sessionId), [D]);
  // Remembered as dispatched here but ordinary to the server: refused, never opened as the person's own.
  const n = mk({ [D]: { dispatched: false } });
  n.state.reopen = [{ sessionId: D, origin: 'cli', dispatched: 9 }];
  const r2 = await n.c.handleJob({ id: 'r2', kind: 'reopen' });
  assert.equal(n.launched.length, 0); assert.match(r2.error, /not reopened/);
  // The worker's own entry for a dispatched session counts the same way.
  const o = mk({ [D]: { dispatched: false } });
  o.state.sessions[D] = { folderId: 'f1', state: 'running', dispatched: 9 };
  o.state.reopen = [{ sessionId: D, origin: 'cli' }];
  await o.c.handleJob({ id: 'r3', kind: 'reopen' });
  assert.equal(o.launched.length, 0);
});

test('the wt command line carries the strict config and the settings through to the wrapper unchanged', () => {
  const cargs = claudeArgs({ kind: 'resume', sessionId: randomUUID(), projectName: 'P', runFiles: { mcpConfig: 'C:/t/work-os-run/a.json', settings: 'C:/t/work-os-run/a.settings.json' } });
  const w = windowsWtArgs('C:/f', 'T', 'C:/claude.exe', cargs, 'node', 'wrap.mjs', 3);
  assert.deepEqual(w.slice(w.indexOf('wrap.mjs'), w.indexOf('wrap.mjs') + 3), ['wrap.mjs', '--work-os-dispatched=3', 'C:/claude.exe']);
  assert.ok(w.includes('--strict-mcp-config') && w.includes('C:/t/work-os-run/a.settings.json'));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
