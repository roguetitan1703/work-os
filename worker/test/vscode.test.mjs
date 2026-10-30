import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionUri, codeCommands, cleanEnv, knownCodePaths, resolveCode, openInVscode } from '../vscode.mjs';
import { validateJob } from '../validate.mjs';
import { originOf, lastEntrypoint, readSessionMeta, sessionLocal, listSessions } from '../activity.mjs';
import { trackOpenSet, reopenReport } from '../openset.mjs';
import { createCore } from '../core.mjs';

const SID = '8c1d2f3a-1b2c-4d5e-8f90-123456789abc';
const SID2 = '8c1d2f3a-1b2c-4d5e-8f90-123456789abd';
const SID3 = '8c1d2f3a-1b2c-4d5e-8f90-123456789abe';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wos-vsc-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('uri and commands: args arrays, id validated, folder absolute', () => {
  assert.equal(sessionUri(SID.toUpperCase()), 'vscode://anthropic.claude-code/open?session=' + SID);
  for (const bad of ['', 'x', SID + '&prompt=rm', SID + ' ', '../' + SID, null, undefined, 5]) assert.throws(() => sessionUri(bad), /bad session id/);
  const dir = path.resolve('some folder; & calc');
  const [open, url] = codeCommands(dir, SID);
  assert.deepEqual(open, [dir]);
  assert.deepEqual(url, ['--open-url', '--', 'vscode://anthropic.claude-code/open?session=' + SID]);
  assert.throws(() => codeCommands('relative/dir', SID), /bad folder/);
  assert.throws(() => codeCommands('-n', SID), /bad folder/);
  assert.throws(() => codeCommands(dir + '\n', SID), /bad folder/);
});

test('cleanEnv drops ELECTRON_RUN_AS_NODE and VSCODE_*', () => {
  assert.deepEqual(cleanEnv({ A: '1', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', NODE_OPTIONS: '--require x', VSCODE_IPC_HOOK_CLI: 'x', VSCODE_DEV: '' }), { A: '1' });
});

test('resolveCode: standard paths only, never inside a root', () => {
  const k = knownCodePaths('win32', { LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local', ProgramFiles: 'C:\\Program Files' });
  assert.ok(k[0].endsWith('Code.exe') && k[0].includes('Programs'));
  assert.equal(k.length, 2);
  assert.ok(knownCodePaths('darwin', { HOME: '/Users/o' })[0].split(path.sep).join('/').startsWith('/Applications/Visual Studio Code.app'));
  const root = tmp();
  const other = tmp();
  try {
    const planted = path.join(root, 'Code.exe');
    fs.writeFileSync(planted, '');
    assert.equal(resolveCode([root], () => [planted], fs.existsSync), null);
    const ok = path.join(other, 'Code.exe');
    fs.writeFileSync(ok, '');
    assert.equal(resolveCode([root], () => [planted, ok], fs.existsSync), ok);
    assert.equal(resolveCode([root], () => ['relative/Code.exe'], () => true), null);
  } finally { rm(root); rm(other); }
});

test('openInVscode: folder first, then the link after a wait, one at a time; bad input runs nothing', async () => {
  const calls = [];
  const spawnFn = async (file, args) => void calls.push(['spawn', file, args]);
  const sleepFn = async (ms) => void calls.push(['sleep', ms]);
  const dir = path.resolve('proj');
  await Promise.all([
    openInVscode({ codePath: '/x/Code.exe', folder: dir, sessionId: SID, folderWaitMs: 5, coldWaitMs: 50, runningFn: async () => true, spawnFn, sleepFn }),
    openInVscode({ codePath: '/x/Code.exe', folder: dir, sessionId: SID2, folderWaitMs: 5, coldWaitMs: 50, runningFn: async () => false, spawnFn, sleepFn }),
  ]);
  assert.deepEqual(calls.map((c) => c[0]), ['spawn', 'sleep', 'spawn', 'spawn', 'sleep', 'spawn']);
  assert.deepEqual(calls[0][2], [dir]);
  assert.ok(calls[2][2][2].endsWith(SID) && calls[5][2][2].endsWith(SID2));
  assert.deepEqual([calls[1][1], calls[4][1]], [5, 50]); // warm: short wait; VS Code not running: long wait
  const n = calls.length;
  await assert.rejects(() => openInVscode({ codePath: '/x/Code.exe', folder: dir, sessionId: 'nope', spawnFn, sleepFn }), /bad session id/);
  await assert.rejects(() => openInVscode({ codePath: null, folder: dir, sessionId: SID, spawnFn, sleepFn }), /not found/);
  assert.equal(calls.length, n);
});

test('validateJob: vscode needs a uuid; reopen and dismiss need nothing', () => {
  const ctx = { folders: {}, roots: [] };
  assert.equal(validateJob({ kind: 'vscode', sessionId: SID }, ctx).ok, true);
  assert.equal(validateJob({ kind: 'vscode', sessionId: 'x' }, ctx).ok, false);
  assert.equal(validateJob({ kind: 'vscode' }, ctx).ok, false);
  assert.equal(validateJob({ kind: 'reopen' }, ctx).ok, true);
  assert.equal(validateJob({ kind: 'dismiss' }, ctx).ok, true);
  assert.equal(validateJob({ kind: 'resume', sessionId: SID, folderId: 'f' }, ctx).ok, false);
});

test('entrypoint parsing: last one wins, only a short token, absent = other', () => {
  assert.equal(originOf('claude-vscode'), 'vscode');
  assert.equal(originOf('cli'), 'cli');
  assert.equal(originOf('sdk-cli'), 'other');
  assert.equal(originOf(null), 'other');
  assert.equal(lastEntrypoint('{"entrypoint":"cli"}\n{"x":1}\n{"entrypoint":"claude-vscode"}'), 'claude-vscode');
  assert.equal(lastEntrypoint('{"text":"\\"entrypoint\\":\\"claude-vscode\\""}'), null);
  assert.equal(lastEntrypoint('nothing'), null);
});

function transcript(root, proj, sid, lines) {
  const f = path.join(root, proj, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('readSessionMeta / sessionLocal / listSessions carry origin; cwd stays local', () => {
  const root = tmp();
  try {
    const cwd = path.join(root, 'work dir', 'App');
    const f = transcript(root, 'p1', SID, [{ type: 'user', cwd, entrypoint: 'claude-vscode', sessionId: SID, message: { content: 'SECRET-TEXT' } }, { type: 'ai-title', aiTitle: 'T' }]);
    assert.deepEqual(readSessionMeta(f), { title: 'T', folder: 'App', origin: 'vscode' });
    assert.deepEqual(sessionLocal(SID, root), { cwd, origin: 'vscode' });
    assert.equal(sessionLocal(SID2, root), null);
    assert.equal(sessionLocal('../../x', root), null);
    const list = listSessions({ procs: [], root, now: Date.now() });
    assert.equal(list[0].origin, 'vscode');
    assert.ok(!JSON.stringify(list).includes('work dir') && !JSON.stringify(list).includes('SECRET-TEXT'));
    // started in VS Code, later used in a terminal: where it was last used
    transcript(root, 'p1', SID2, [{ type: 'user', cwd, entrypoint: 'claude-vscode' }, { type: 'user', cwd, entrypoint: 'cli' }]);
    assert.equal(sessionLocal(SID2, root).origin, 'cli');
  } finally { rm(root); }
});

const item = (sessionId, running, origin = 'vscode') => ({ sessionId, running, origin, title: 't', folder: 'f' });

test('open set: remembered, compared once at start, closed ones leave it, expiry', () => {
  const st = {};
  trackOpenSet(st, [item(SID, true), item(SID2, true, 'cli'), item(SID3, false)], 1000, true);
  assert.equal(st.openSet.length, 2);
  assert.deepEqual(st.reopen, []); // first ever start: nothing remembered yet
  trackOpenSet(st, [item(SID, true)], 2000, false); // SID2 closed normally: forgotten
  assert.deepEqual(st.openSet.map((s) => s.sessionId), [SID]);
  assert.deepEqual(st.reopen, []);
  trackOpenSet(st, [], 3000, true); // crash and restart: nothing running at the first list
  assert.deepEqual(reopenReport(st), [{ sessionId: SID, origin: 'vscode', title: 't', folder: 'f' }]);
  assert.deepEqual(st.openSet, []);
  trackOpenSet(st, [], 4000, false); // pending survives later empty ticks
  assert.equal(st.reopen.length, 1);
  trackOpenSet(st, [item(SID, true)], 5000, false); // opened by hand: no longer pending
  assert.equal(st.reopen.length, 0);
  trackOpenSet(st, [item(SID, true)], 6000, true); // worker-only restart, session still running
  assert.equal(st.reopen.length, 0);
  const old = { openSet: [{ sessionId: SID, origin: 'cli', at: 0 }] };
  trackOpenSet(old, [], 8 * 24 * 3600_000, true); // too old
  assert.equal(old.reopen.length, 0);
});

function mkCore(over = {}) {
  const root = tmp();
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'sub'), { recursive: true });
  fs.mkdirSync(app + '-evil');
  const outside = tmp();
  const opened = [];
  const launched = [];
  const state = { ids: {}, folders: { f_app: app }, sessions: {}, markers: {}, doneJobs: [], reopen: [] };
  const locals = { [SID]: { cwd: path.join(app, 'sub'), origin: 'vscode' }, [SID2]: { cwd: outside, origin: 'vscode' }, [SID3]: { cwd: app + '-evil', origin: 'cli' }, ...(over.locals || {}) };
  const c = createCore({
    getConfig: () => ({ roots: [root] }), state, save() {}, api: {},
    launcher: async (a) => void launched.push(a), listProcesses: async () => over.procs || [], killPid: async () => {},
    sessionLocal: (sid) => locals[sid] || null,
    openVscode: async (a) => void opened.push(a),
  });
  c.applyLinks(over.links ?? [{ folderId: 'f_app', projectId: 'p1', projectName: 'Proj' }]);
  return { c, state, opened, launched, app, done: () => { rm(root); rm(outside); } };
}

test('vscode job: opens the transcript folder when linked and inside a root; same refusals as resume', async () => {
  const m = mkCore();
  try {
    assert.deepEqual(await m.c.handleJob({ id: 'j1', kind: 'vscode', sessionId: SID }), { id: 'j1', ok: true });
    assert.equal(m.opened.length, 1);
    assert.equal(fs.realpathSync(m.opened[0].folder), fs.realpathSync(path.join(m.app, 'sub')));
    assert.equal(m.opened[0].sessionId, SID);
    const out = await m.c.handleJob({ id: 'j2', kind: 'vscode', sessionId: SID2 });
    assert.equal(out.ok, false); assert.match(out.error, /outside allowed roots/);
    const evil = await m.c.handleJob({ id: 'j2b', kind: 'vscode', sessionId: SID3 }); // sibling whose name starts with the linked one's
    assert.equal(evil.ok, false); assert.equal(evil.error, 'folder not linked to a project');
    assert.equal((await m.c.handleJob({ id: 'j3', kind: 'vscode', sessionId: '8c1d2f3a-1b2c-4d5e-8f90-000000000000' })).ok, false);
    assert.equal((await m.c.handleJob({ id: 'j4', kind: 'vscode', sessionId: 'bad' })).error, 'bad session id');
    assert.equal(m.opened.length, 1);
  } finally { m.done(); }
  const n = mkCore({ links: [] });
  try {
    const r = await n.c.handleJob({ id: 'j5', kind: 'vscode', sessionId: SID });
    assert.equal(r.ok, false); assert.equal(r.error, 'folder not linked to a project');
    assert.equal(n.opened.length, 0);
  } finally { n.done(); }
});

test('vscode job: the same session again within a minute opens nothing; more than 4 a minute are refused; a file as folder is refused', async () => {
  const m = mkCore();
  try {
    let t = 1_000_000;
    const ids = [SID, '8c1d2f3a-1b2c-4d5e-8f90-0000000000a1', '8c1d2f3a-1b2c-4d5e-8f90-0000000000a2', '8c1d2f3a-1b2c-4d5e-8f90-0000000000a3', '8c1d2f3a-1b2c-4d5e-8f90-0000000000a4'];
    const locals = {};
    for (const i of ids) locals[i] = { cwd: path.join(m.app, 'sub'), origin: 'vscode' };
    const opened = [];
    const c = createCore({ getConfig: () => ({ roots: [path.dirname(m.app)] }), state: m.state, save() {}, api: {}, now: () => t, launcher: async () => {}, listProcesses: async () => [], killPid: async () => {}, sessionLocal: (s) => locals[s] || null, openVscode: async (a) => void opened.push(a.sessionId) });
    c.applyLinks([{ folderId: 'f_app', projectId: 'p1', projectName: 'Proj' }]);
    assert.equal((await c.handleJob({ id: 'a', kind: 'vscode', sessionId: ids[0] })).ok, true);
    assert.equal((await c.handleJob({ id: 'b', kind: 'vscode', sessionId: ids[0] })).ok, true); // dropped
    assert.equal(opened.length, 1);
    for (const i of ids.slice(1, 4)) assert.equal((await c.handleJob({ id: i, kind: 'vscode', sessionId: i })).ok, true);
    const over = await c.handleJob({ id: 'x', kind: 'vscode', sessionId: ids[4] });
    assert.equal(over.ok, false); assert.equal(over.error, 'Too many opens at once, try again in a minute');
    assert.equal(opened.length, 4);
    t += 61_000;
    assert.equal((await c.handleJob({ id: 'y', kind: 'vscode', sessionId: ids[4] })).ok, true);
    assert.equal(opened.length, 5);
    // a transcript whose cwd is a file, not a folder
    const f = path.join(m.app, 'a-file.txt');
    fs.writeFileSync(f, 'x');
    locals[ids[0]] = { cwd: f, origin: 'vscode' };
    t += 61_000;
    const r = await c.handleJob({ id: 'z', kind: 'vscode', sessionId: ids[0] });
    assert.equal(r.ok, false); assert.equal(opened.length, 5);
  } finally { m.done(); }
});

test('reopen: each opened where it was made, running ones skipped, refusals reported, set cleared; dismiss clears', async () => {
  const m = mkCore({ procs: [{ pid: 9, name: 'claude.exe', cmd: `claude.exe --resume=${SID2}` }] });
  try {
    m.state.reopen = [
      { sessionId: SID, origin: 'vscode', title: 'a', folder: 'app' },
      { sessionId: SID3, origin: 'cli', title: 'b', folder: 'app-evil' }, // refused: not linked
      { sessionId: SID2, origin: 'vscode', title: 'c', folder: 'x' }, // already running again: skipped
    ];
    const r = await m.c.handleJob({ id: 'r1', kind: 'reopen' });
    assert.equal(m.opened.length, 1);
    assert.equal(m.launched.length, 0);
    assert.equal(r.ok, false); assert.match(r.error, /Opened 1 of 2.*not linked/);
    assert.deepEqual(m.state.reopen, []);
  } finally { m.done(); }
  const k = mkCore();
  try {
    k.state.reopen = [{ sessionId: SID, origin: 'cli', title: 'a', folder: 'app' }];
    assert.deepEqual(await k.c.handleJob({ id: 'r2', kind: 'reopen' }), { id: 'r2', ok: true });
    assert.equal(k.launched.length, 1);
    assert.equal(k.launched[0].kind, 'resume'); assert.equal(k.launched[0].sessionId, SID); assert.equal(k.launched[0].projectName, 'Proj');
    assert.equal(k.opened.length, 0);
    k.state.reopen = [{ sessionId: SID, origin: 'cli', title: 'a', folder: 'app' }];
    assert.deepEqual(await k.c.handleJob({ id: 'd1', kind: 'dismiss' }), { id: 'd1', ok: true });
    assert.deepEqual(k.state.reopen, []);
    assert.deepEqual(await k.c.handleJob({ id: 'r3', kind: 'reopen' }), { id: 'r3', ok: true });
  } finally { k.done(); }
});

test('status carries the remembered open set and the pending reopen list', async () => {
  const posted = [];
  const state = { ids: {}, folders: {}, sessions: {}, markers: {}, doneJobs: [], openSet: [{ sessionId: SID, origin: 'vscode', title: 'a', folder: 'f', at: Date.now() - 1000 }], reopen: [] };
  const core = createCore({
    getConfig: () => ({ roots: [] }), state, save() {}, api: { postStatus: async (b) => void posted.push(b) },
    launcher: async () => {}, listProcesses: async () => [], killPid: async () => {},
    activity: async () => ({ counts: { sessions: 0 }, list: [] }),
  });
  await core.sendStatus();
  assert.deepEqual(posted[0].reopen, [{ sessionId: SID, origin: 'vscode', title: 'a', folder: 'f' }]);
  await core.sendStatus(); // not forgotten until reopened, dismissed or running
  assert.equal(posted[1].reopen.length, 1);
});
