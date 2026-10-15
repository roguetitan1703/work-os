import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countSessions, scanTranscripts, collectActivity, ACTIVE_MS } from '../activity.mjs';
import { createCore } from '../core.mjs';

const SID1 = '8c1d0a52-1111-4222-8333-444455556666';
const SID2 = '9d2e1b63-aaaa-4bbb-8ccc-ddddeeeeffff';
const SID3 = '0a0a0a0a-1111-4222-8333-444455556666';
const vscode = (pid, ppid, sid) => ({ pid, ppid, name: 'claude.exe', cmd: `"c:/ext/claude.exe" --output-format stream-json --verbose --resume=${sid}` });

test('countSessions: real sessions vs helpers, children and repeats', () => {
  const procs = [
    vscode(10, 1, SID1), // VS Code session
    { pid: 11, ppid: 2, name: 'claude.exe', cmd: `"C:/bin/claude.exe" --session-id ${SID2} --name PMS --remote-control=PMS` }, // Work OS launched
    { pid: 12, ppid: 3, name: 'claude.exe', cmd: '"C:/bin/claude.exe"' }, // plain terminal session
    { pid: 13, ppid: 11, name: 'claude.exe', cmd: '"C:/bin/claude.exe" --some child' }, // child of session 11
    { pid: 14, ppid: 4, name: 'claude.exe', cmd: '"C:/bin/claude.exe" mcp serve' }, // helper
    { pid: 15, ppid: 5, name: 'claude.exe', cmd: '"C:/bin/claude.exe" --version' }, // helper
    { pid: 16, ppid: 6, name: 'claude.exe', cmd: `"c:/ext/claude.exe" --resume=${SID1}` }, // same session id again
    { pid: 17, ppid: 7, name: 'node.exe', cmd: `node something --resume ${SID3}` }, // not claude
  ];
  assert.deepEqual(countSessions(procs, [SID2]), { sessions: 3, sessionsWorkOs: 1, sessionsOther: 2 });
  assert.deepEqual(countSessions([], [SID2]), { sessions: 0, sessionsWorkOs: 0, sessionsOther: 0 });
  assert.deepEqual(countSessions(null), { sessions: 0, sessionsWorkOs: 0, sessionsOther: 0 });
});

test('countSessions: macOS style list without image names', () => {
  const procs = [
    { pid: 1, ppid: 0, cmd: `/usr/local/bin/claude --session-id ${SID1}` },
    { pid: 2, ppid: 0, cmd: 'node /usr/local/bin/claude' },
    { pid: 3, ppid: 0, cmd: 'vim claude.txt' },
  ];
  assert.equal(countSessions(procs, [SID1]).sessions, 2);
  assert.equal(countSessions(procs, [SID1]).sessionsWorkOs, 1);
});

function fakeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-proj-'));
  const now = Date.now();
  const put = (rel, ageMs, text = 'SECRET TRANSCRIPT') => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    const t = new Date(now - ageMs);
    fs.utimesSync(f, t, t);
  };
  put('projA/s1.jsonl', 10_000); // active session
  put('projA/s2.jsonl', 10 * 60_000); // old session
  put('projA/s1/subagents/agent-a1.jsonl', 5_000); // active
  put('projA/s1/subagents/agent-a2.jsonl', 60_000); // active
  put('projA/s1/subagents/agent-a3.jsonl', 10 * 60_000); // old
  put('projB/s3.jsonl', 5_000); // active
  put('projB/s3/subagents/agent-b1.jsonl', 1_000); // active
  put('projB/s3/subagents/notes.txt', 1_000); // not an agent file
  put('projB/s9/subagents/agent-old.jsonl', 3 * 24 * 3600_000); // folder untouched for days (dir time set below)
  const old = new Date(now - 3 * 24 * 3600_000);
  fs.utimesSync(path.join(root, 'projB/s9/subagents'), old, old);
  return { root, now };
}

test('scanTranscripts counts recent files by mtime and never reads contents', () => {
  const { root, now } = fakeTree();
  const names = ['readFileSync', 'openSync', 'readSync', 'createReadStream', 'opendirSync'];
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) fs[n] = () => { throw new Error('contents must never be read: ' + n); };
  try {
    assert.deepEqual(scanTranscripts(root, now), { subagents: 3, sessionsActive: 2 });
  } finally { Object.assign(fs, orig); fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanTranscripts: missing root and window edge', () => {
  assert.deepEqual(scanTranscripts(path.join(os.tmpdir(), 'wos-does-not-exist-' + Date.now())), { subagents: 0, sessionsActive: 0 });
  const { root, now } = fakeTree();
  try { assert.equal(scanTranscripts(root, now + ACTIVE_MS).subagents, 0 + 0); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('collectActivity combines both, numbers only', async () => {
  const { root, now } = fakeTree();
  try {
    const a = await collectActivity({ listProcesses: async () => [vscode(10, 1, SID1)], workOsIds: [], root, now });
    assert.deepEqual(a, { sessions: 1, sessionsWorkOs: 0, sessionsOther: 1, sessionsActive: 2, subagents: 3, at: now });
    assert.ok(Object.values(a).every((v) => Number.isInteger(v)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('status report carries activity; a failing count never blocks the heartbeat', async () => {
  const posted = [];
  const mk = (activity) => createCore({ getConfig: () => ({ roots: [], maxDepth: 3 }), state: { sessions: { [SID2]: { folderId: 'f', state: 'running', startedAt: 0 } }, folders: {}, ids: {}, markers: {} }, save() {}, api: { postStatus: async (b) => posted.push(b) }, launcher: async () => {}, listProcesses: async () => [], killPid: async () => {}, activity });
  let seen;
  await mk(async (ids) => { seen = ids; return { sessions: 1, sessionsWorkOs: 1, sessionsOther: 0, sessionsActive: 1, subagents: 0, at: 1 }; }).sendStatus();
  assert.deepEqual(seen, [SID2]);
  assert.equal(posted[0].activity.sessions, 1);
  await mk(async () => { throw new Error('boom'); }).sendStatus();
  assert.equal(posted[1].activity, undefined);
  await mk(undefined).sendStatus();
  assert.equal(posted.length, 3);
});
