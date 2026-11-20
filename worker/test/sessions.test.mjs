import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, readSessionMeta, lastSegment, collectActivity, MAX_LISTED, MAX_TITLE } from '../activity.mjs';
import { createCore } from '../core.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SECRET = 'TOP-SECRET-MESSAGE-TEXT-do-not-send';
const rec = (o) => JSON.stringify(o) + '\n';
const claudeProc = (pid, sid, extra = '') => ({ pid, ppid: 1, name: 'claude.exe', cmd: `"C:/bin/claude.exe" --session-id ${sid} ${extra}` });

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-sess-'));
  const now = Date.now();
  const put = (proj, sid, ageMs, records) => {
    const f = path.join(root, proj, `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, records.join(''));
    const t = new Date(now - ageMs);
    fs.utimesSync(f, t, t);
    return f;
  };
  return { root, now, put };
}
const msg = (cwd) => rec({ type: 'user', cwd, sessionId: 'x', message: { role: 'user', content: SECRET } });

test('title: custom-title beats ai-title, last record wins, cwd reduced to last segment', () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(1), 5_000, [msg('C:\\Users\\om\\work\\My Project'), rec({ type: 'ai-title', aiTitle: 'First guess' }), rec({ type: 'ai-title', aiTitle: 'Second guess' }), msg('C:\\Users\\om\\work\\My Project')]);
    put('p2', uuid(2), 5_000, [msg('/home/om/code/api'), rec({ type: 'ai-title', aiTitle: 'Generated' }), rec({ type: 'custom-title', customTitle: 'My own name', sessionId: 'x' }), rec({ type: 'ai-title', aiTitle: 'Later generated' })]);
    const list = listSessions({ procs: [], root, now });
    const by = Object.fromEntries(list.map((s) => [s.sessionId, s]));
    assert.equal(by[uuid(1)].title, 'Second guess');
    assert.equal(by[uuid(1)].folder, 'My Project');
    assert.equal(by[uuid(2)].title, 'My own name');
    assert.equal(by[uuid(2)].folder, 'api');
    assert.equal(by[uuid(1)].running, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('payload has only the allowed keys and no message text or full path', () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(1), 5_000, [msg('C:\\Users\\om\\secret-dir\\proj'), rec({ type: 'ai-title', aiTitle: 'Fix the login' }), msg('C:\\Users\\om\\secret-dir\\proj')]);
    put('p1', uuid(2), 5_000, [msg('/x/y/notitle')]); // no title record at all
    const list = listSessions({ procs: [], root, now });
    assert.equal(list.length, 2);
    const json = JSON.stringify(list);
    assert.ok(!json.includes(SECRET));
    assert.ok(!json.includes('secret-dir'));
    assert.ok(!/[\\/]/.test(json.replace(/\\"/g, '')), 'no path separators anywhere in the payload');
    for (const s of list) {
      // Identity step 3: a session no process evidence names also says `unknown: true` (the machine cannot say whether it runs).
      assert.deepEqual(Object.keys(s).sort(), ['folder', 'lastActiveAt', 'origin', 'running', 'sessionId', 'startedByWorkOs', 'subagentsActive', 'title', 'unknown']);
      const strings = Object.values(s).filter((v) => typeof v === 'string');
      assert.equal(strings.length, 4); // sessionId, folder, title, origin
      assert.ok(Number.isInteger(s.lastActiveAt) && Number.isInteger(s.subagentsActive));
    }
    const untitled = list.find((s) => s.sessionId === uuid(2));
    assert.equal(untitled.title, 'notitle'); // falls back to the folder name
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('title fallback: --name argument when the transcript has none and no cwd', () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(3), 5_000, [rec({ type: 'mode' })]);
    const list = listSessions({ procs: [claudeProc(10, uuid(3), '--name PMS --remote-control=PMS')], workOsIds: [uuid(3)], root, now });
    assert.equal(list[0].title, 'PMS');
    assert.equal(list[0].folder, 'unknown');
    assert.equal(list[0].running, true);
    assert.equal(list[0].startedByWorkOs, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('window, running and subagents', () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(1), 5_000, [msg('/a/one')]); // recent
    put('p1', uuid(2), 20 * 60_000, [msg('/a/two')]); // old, with a process by id
    put('p1', uuid(3), 20 * 60_000, [msg('/a/three')]); // old, no process: not listed
    const sub = path.join(root, 'p1', uuid(1), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), SECRET);
    fs.writeFileSync(path.join(sub, 'agent-b.jsonl'), SECRET);
    const old = new Date(now - 10 * 60_000);
    fs.utimesSync(path.join(sub, 'agent-b.jsonl'), old, old);
    const list = listSessions({ procs: [claudeProc(10, uuid(2))], root, now });
    assert.deepEqual(list.map((s) => s.sessionId).sort(), [uuid(1), uuid(2)].sort());
    assert.equal(list.find((s) => s.sessionId === uuid(1)).subagentsActive, 1);
    assert.equal(list.find((s) => s.sessionId === uuid(2)).running, true);
    assert.equal(list.find((s) => s.sessionId === uuid(1)).running, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Identity step 3: the guess that tied a process with no session id to the newest transcript is gone.
test('a process with no session id is not evidence: an old transcript is not listed, a recent one is unknown and not running', () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(1), 60 * 60_000, [msg('/a/vscode')]); // an hour old, a plain claude process is open: still not listed
    put('p1', uuid(2), 3 * 24 * 3600_000, [msg('/a/ancient')]);
    put('p1', uuid(3), 60_000, [msg('/a/recent')]);
    const list = listSessions({ procs: [{ pid: 5, ppid: 1, name: 'claude.exe', cmd: '"C:/bin/claude.exe"' }], root, now, sessionsDir: path.join(root, 'none') });
    assert.deepEqual(list.map((s) => s.sessionId), [uuid(3)]);
    assert.equal(list[0].running, false);
    assert.equal(list[0].unknown, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const writeSessionFile = (dir, o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${o.pid}.json`), JSON.stringify({ kind: 'interactive', messagingSocketPath: 'MADE-UP-SOCKET', messagingToken: 'MADE-UP-TOKEN', ...o })); };
const plain = (pid, start) => ({ pid, ppid: 1, name: 'claude.exe', cmd: '"C:/bin/claude.exe"', ...(start ? { start } : {}) });

test('the Claude Code own session file (pid, sessionId, name, procStart) says the session runs; the name is a title fallback; nothing else is read', () => {
  const { root, now, put } = tree();
  const dir = path.join(root, 'sessions');
  try {
    put('p1', uuid(1), 5 * 3600_000, [msg('/a/desktop')]); // old transcript, but its process runs
    put('p1', uuid(2), 5 * 3600_000, [msg('/a/gone')]); // old transcript, file for a pid that is gone
    writeSessionFile(dir, { pid: 4321, sessionId: uuid(1), name: 'Made up session name', procStart: '134395156985665484', entrypoint: 'claude-desktop' });
    writeSessionFile(dir, { pid: 999, sessionId: uuid(2), name: 'Gone', procStart: '134395156985665484' });
    fs.writeFileSync(path.join(dir, '4321.key'), 'MADE-UP-KEY-never-read');
    const list = listSessions({ procs: [plain(4321, '134395156985665480')], root, now, sessionsDir: dir });
    assert.deepEqual(list.map((s) => s.sessionId), [uuid(1)]); // the gone one is old and not running: not listed
    assert.equal(list[0].running, true);
    assert.equal(list[0].unknown, undefined);
    assert.equal(list[0].title, 'Made up session name');
    const json = JSON.stringify(list);
    assert.ok(!json.includes('MADE-UP-TOKEN') && !json.includes('MADE-UP-SOCKET') && !json.includes('never-read'));
    // a recent transcript whose file's process is gone: known stopped, not unknown
    put('p1', uuid(3), 30_000, [msg('/a/closed')]);
    writeSessionFile(dir, { pid: 777, sessionId: uuid(3), name: 'Closed', procStart: '1' });
    const l2 = listSessions({ procs: [plain(4321, '134395156985665480')], root, now, sessionsDir: dir });
    const closed = l2.find((s) => s.sessionId === uuid(3));
    assert.equal(closed.running, false);
    assert.equal(closed.unknown, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a pid that another process took does not count: the process start time must match (within a second)', () => {
  const { root, now, put } = tree();
  const dir = path.join(root, 'sessions');
  try {
    put('p1', uuid(1), 30_000, [msg('/a/one')]);
    writeSessionFile(dir, { pid: 50, sessionId: uuid(1), procStart: '134395156985665484' });
    const same = listSessions({ procs: [plain(50, '134395156985665480')], root, now, sessionsDir: dir });
    assert.equal(same[0].running, true);
    const reused = listSessions({ procs: [plain(50, '134395999999999999')], root, now, sessionsDir: dir });
    assert.equal(reused[0].running, false);
    assert.equal(reused[0].unknown, undefined);
    const noStart = listSessions({ procs: [plain(50)], root, now, sessionsDir: dir }); // a platform that does not report it: the pid counts
    assert.equal(noStart[0].running, true);
    const notClaude = listSessions({ procs: [{ pid: 50, ppid: 1, name: 'node.exe', cmd: 'node x.js' }], root, now, sessionsDir: dir });
    assert.equal(notClaude[0].running, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the hook .proc file (<sessionId>.proc) says the session runs (a terminal or VS Code session, which has no file of its own)', () => {
  const { root, now, put } = tree();
  const procDir = path.join(root, 'hooks-sessions');
  try {
    put('p1', uuid(1), 2 * 3600_000, [msg('/a/terminal')]);
    put('p1', uuid(2), 2 * 3600_000, [msg('/a/vscode')]);
    fs.mkdirSync(procDir, { recursive: true });
    fs.writeFileSync(path.join(procDir, `${uuid(1)}.proc`), JSON.stringify({ pid: 61, procStart: '77' }));
    fs.writeFileSync(path.join(procDir, `${uuid(2)}.proc`), JSON.stringify({ pid: 62 }));
    fs.writeFileSync(path.join(procDir, 'not-a-session.proc'), JSON.stringify({ pid: 63 }));
    const list = listSessions({ procs: [plain(61, '77'), plain(62)], root, now, procDir, sessionsDir: path.join(root, 'none') });
    assert.deepEqual(list.map((s) => s.sessionId).sort(), [uuid(1), uuid(2)].sort());
    assert.ok(list.every((s) => s.running === true));
    const stopped = listSessions({ procs: [], root, now, procDir, sessionsDir: path.join(root, 'none') });
    assert.deepEqual(stopped, []); // old transcripts, nothing runs
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session this worker started and that is not on a command line is known stopped, not unknown', () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(1), 30_000, [msg('/a/one')]);
    const list = listSessions({ procs: [], workOsIds: [uuid(1)], root, now, sessionsDir: path.join(root, 'none') });
    assert.equal(list[0].running, false);
    assert.equal(list[0].unknown, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('caps: at most 50 sessions, title at most 80 chars, folder at most 80', () => {
  const { root, now, put } = tree();
  try {
    for (let i = 1; i <= 60; i++) put('p1', uuid(i), i * 1000, [msg('/a/' + 'f'.repeat(200)), rec({ type: 'ai-title', aiTitle: 'T'.repeat(300) + '\n second line' })]);
    const list = listSessions({ procs: [], root, now });
    assert.equal(list.length, MAX_LISTED);
    assert.equal(list[0].sessionId, uuid(1)); // newest first
    assert.ok(list.every((s) => s.title.length <= MAX_TITLE && s.folder.length <= 80 && !s.title.includes('\n')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('large transcript: title found in the tail without reading the whole file', () => {
  const { root, put } = tree();
  try {
    const big = rec({ type: 'user', cwd: '/a/big', message: { content: 'x'.repeat(2000) } }).repeat(1500); // ~3 MB
    const f = put('p1', uuid(1), 1000, [big, rec({ type: 'ai-title', aiTitle: 'Tail title' })]);
    assert.deepEqual(readSessionMeta(f), { title: 'Tail title', folder: 'big', origin: 'other' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('folder is where the session started: a later cd into a subfolder does not move it (AKAR/server, 20 Nov)', () => {
  const { root, put } = tree();
  try {
    const later = rec({ type: 'user', cwd: 'D:\\Work\\AKAR\\server', entrypoint: 'claude-desktop', message: { content: 'x'.repeat(2000) } }).repeat(1500); // tail only sees server
    const f = put('p1', uuid(1), 1000, [rec({ type: 'user', cwd: 'D:\\Work\\AKAR', entrypoint: 'claude-desktop', message: { content: 'start' } }), later, rec({ type: 'ai-title', aiTitle: 'AKAR lead' })]);
    assert.deepEqual(readSessionMeta(f), { title: 'AKAR lead', folder: 'AKAR', origin: 'desktop' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a status body with desktop sessions falls back to other for an older server', async () => {
  const { hasDesktop, withoutDesktop } = await import('../core.mjs');
  const b = { worker: {}, claudeSessions: [{ sessionId: 'a', origin: 'desktop' }, { sessionId: 'b', origin: 'vscode' }], reopen: [{ sessionId: 'a', origin: 'desktop' }] };
  assert.equal(hasDesktop(b), true);
  const w = withoutDesktop(b);
  assert.deepEqual(w.claudeSessions.map((x) => x.origin), ['other', 'vscode']);
  assert.deepEqual(w.reopen.map((x) => x.origin), ['other']);
  assert.equal(hasDesktop(w), false);
  assert.equal(b.claudeSessions[0].origin, 'desktop'); // the original is not changed
});

test('lastSegment', () => {
  assert.equal(lastSegment('C:\\a\\b\\c\\'), 'c');
  assert.equal(lastSegment('/a/b'), 'b');
  assert.equal(lastSegment(''), '');
});

test('collectActivity withSessions, and the status body carries claudeSessions', async () => {
  const { root, now, put } = tree();
  try {
    put('p1', uuid(1), 5_000, [msg('/a/one'), rec({ type: 'ai-title', aiTitle: 'One' })]);
    const r = await collectActivity({ listProcesses: async () => [], root, now, withSessions: true });
    assert.equal(r.list.length, 1);
    assert.equal(r.counts.sessionsActive, 1);
    const posted = [];
    const core = createCore({ getConfig: () => ({ roots: [], maxDepth: 3 }), state: { sessions: {}, folders: {}, ids: {}, markers: {} }, save() {}, api: { postStatus: async (b) => posted.push(b) }, launcher: async () => {}, listProcesses: async () => [], killPid: async () => {}, activity: async () => r });
    await core.sendStatus();
    assert.equal(posted[0].claudeSessions.length, 1);
    assert.equal(posted[0].activity.sessionsActive, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessionsInRootsOnly: only sessions under the roots are listed and counted; other processes are ignored', async () => {
  const { root, now, put } = tree();
  try {
    put('D--work-os-demo-site', uuid(1), 5_000, [msg('D:/work-os-demo/site'), rec({ type: 'ai-title', aiTitle: 'Demo work' })]);
    put('D--work-os-demo', uuid(2), 5_000, [msg('D:/work-os-demo'), rec({ type: 'ai-title', aiTitle: 'Demo root' })]);
    put('D--work-os-demo2-x', uuid(3), 5_000, [msg('D:/work-os-demo2/x'), rec({ type: 'ai-title', aiTitle: 'Not demo' })]);
    put('D--Work-Delpat-real', uuid(4), 5_000, [msg('D:/Work/Delpat/real'), rec({ type: 'ai-title', aiTitle: 'Real client work' })]);
    const procs = [claudeProc(10, uuid(1)), claudeProc(11, uuid(4)), { pid: 12, ppid: 1, name: 'claude.exe', cmd: '"C:/bin/claude.exe"' }];
    const r = await collectActivity({ listProcesses: async () => procs, workOsIds: [uuid(1)], root, now, withSessions: true, onlyRoots: ['D:\\work-os-demo\\'] });
    assert.deepEqual(r.list.map((s) => s.title).sort(), ['Demo root', 'Demo work']);
    assert.ok(!JSON.stringify(r).includes('Real client work'));
    assert.equal(r.list.find((s) => s.sessionId === uuid(1)).running, true);
    assert.equal(r.list.find((s) => s.sessionId === uuid(2)).running, false, 'a process without a session id is not matched');
    assert.equal(r.counts.sessions, 1);
    assert.equal(r.counts.sessionsWorkOs, 1);
    assert.equal(r.counts.sessionsOther, 0);
    const all = await collectActivity({ listProcesses: async () => procs, root, now, withSessions: true });
    assert.equal(all.list.length, 4, 'off by default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('liveProc: on macOS a start time missing on either side is unknown (null), never running; Windows still counts the pid', async () => {
  const { liveProc } = await import('../activity.mjs');
  const { lstartTicks } = await import('../hook-identity.mjs');
  const t = lstartTicks('Thu Nov 19 10:00:00 2026');
  assert.match(t, /^\d{17,19}$/);
  assert.equal(lstartTicks('not a time'), null);
  const procs = [plain(50, t)];
  assert.equal(liveProc(procs, { pid: 50, procStart: t }, 'darwin'), true);
  assert.equal(liveProc(procs, { pid: 50, procStart: lstartTicks('Thu Nov 19 11:00:00 2026') }, 'darwin'), false);
  assert.equal(liveProc(procs, { pid: 50, procStart: '' }, 'darwin'), null); // the record has no start time
  assert.equal(liveProc([plain(50)], { pid: 50, procStart: t }, 'darwin'), null); // the process list has none
  assert.equal(liveProc([plain(50)], { pid: 50, procStart: '' }, 'darwin'), null);
  assert.equal(liveProc([plain(50)], { pid: 50, procStart: '' }, 'win32'), true); // Windows as before
  assert.equal(liveProc([], { pid: 50, procStart: t }, 'darwin'), false); // no such process at all: gone
});
