import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopUrl, desktopCommand, openInDesktop } from '../desktop.mjs';
import { windowsWtArgs, claudeArgs } from '../launch.mjs';
import { createCore } from '../core.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wos-d-')));
const SID = '8c1d2f3a-1b2c-4d5e-8f90-123456789abc';
const PROMPT = 'This session was opened from Work OS task #7.\nRead it: get_task 7 & "quotes"; $(x)';

test('desktopUrl: documented claude://code/new with only q and folder, both URL-encoded', () => {
  const u = desktopUrl('C:\\Work\\my app', PROMPT);
  assert.ok(u.startsWith('claude://code/new?q='));
  const p = new URL(u).searchParams;
  assert.deepEqual([...p.keys()], ['q', 'folder']);
  assert.equal(p.get('q'), PROMPT);
  assert.equal(p.get('folder'), 'C:\\Work\\my app');
  assert.equal(desktopUrl('/a/b', undefined), 'claude://code/new?folder=%2Fa%2Fb');
  assert.throws(() => desktopUrl('relative/x', 'q'), /bad folder/);
  assert.throws(() => desktopUrl('/a/b\u0000', 'q'), /bad folder/);
});

test('desktopCommand: explorer.exe / open with the URL as one argument; none on Linux', () => {
  const u = desktopUrl('/a', 'x y');
  assert.deepEqual(desktopCommand(u, 'win32', { SystemRoot: 'C:\\Windows' }), [path.join('C:\\Windows', 'explorer.exe'), [u]]);
  assert.deepEqual(desktopCommand(u, 'darwin', {}), ['/usr/bin/open', [u]]);
  assert.equal(desktopCommand(u, 'linux', {}), null);
});

test('openInDesktop: runs the command once; not installed and Linux refuse without running anything', async () => {
  const ran = [];
  const spawnFn = async (c, a) => void ran.push([c, a]);
  await openInDesktop({ folder: '/a/b', prompt: 'hi', platform: 'darwin', registeredFn: async () => true, spawnFn });
  assert.equal(ran.length, 1);
  assert.equal(ran[0][1][0], 'claude://code/new?q=hi&folder=%2Fa%2Fb');
  await assert.rejects(() => openInDesktop({ folder: '/a/b', prompt: 'hi', platform: 'win32', registeredFn: async () => false, spawnFn }), /not installed/);
  await assert.rejects(() => openInDesktop({ folder: '/a/b', prompt: 'hi', platform: 'linux', spawnFn }), /not available/);
  assert.equal(ran.length, 1);
});

test('Open in Claude Code: a start job with the task prompt runs wt with claude and the prompt as its last argument', async () => {
  const cargs = claudeArgs({ kind: 'start', sessionId: SID, projectName: 'Alpha', prompt: PROMPT });
  assert.equal(cargs.at(-1), PROMPT);
  assert.ok(cargs.includes('--session-id') && !cargs.some((a) => /dangerously|bare/.test(a)));
  const wt = windowsWtArgs('C:\\Work\\alpha', 'Alpha', 'C:\\bin\\claude.exe', cargs, 'C:\\n\\node.exe', 'C:\\w\\run-claude.mjs');
  assert.ok(wt.includes('C:\\Work\\alpha') && wt.includes(PROMPT.split(';').join('\\;')));
});

function mk(over = {}) {
  const dir = tmp();
  const calls = [];
  const core = createCore({
    getConfig: () => ({ roots: [dir], ...(over.config || {}) }),
    state: { ids: {}, folders: { f_a: dir }, sessions: {}, markers: {} }, save: () => {},
    api: { postStatus: async () => {} }, launcher: async () => {}, listProcesses: async () => [], killPid: async () => {},
    openDesktop: over.noDesktop ? undefined : async (a) => void calls.push(a),
  });
  if (!over.unlinked) core.applyLinks([{ folderId: 'f_a', projectId: 'p1', projectName: 'Alpha' }]);
  return { core, dir, calls };
}

test('desktop job: linked folder gets the link; unlinked, unknown, no prompt and no Desktop are refused', async () => {
  const m = mk();
  try {
    const ok = await m.core.handleJob({ id: 'j1', kind: 'desktop', folderId: 'f_a', projectId: 'p1', prompt: PROMPT });
    assert.deepEqual(ok, { id: 'j1', ok: true });
    assert.deepEqual(m.calls, [{ folder: m.dir, prompt: PROMPT }]);
    assert.equal((await m.core.handleJob({ id: 'j2', kind: 'desktop', folderId: 'f_nope', prompt: PROMPT })).error, 'unknown folder');
    assert.equal((await m.core.handleJob({ id: 'j3', kind: 'desktop', folderId: 'f_a' })).error, 'bad prompt');
    assert.equal(m.calls.length, 1);
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
  const u = mk({ unlinked: true });
  try {
    const r = await u.core.handleJob({ id: 'j4', kind: 'desktop', folderId: 'f_a', prompt: PROMPT });
    assert.equal(r.error, 'folder not linked to a project');
    assert.equal(u.calls.length, 0);
  } finally { fs.rmSync(u.dir, { recursive: true, force: true }); }
  const n = mk({ noDesktop: true });
  try { assert.match((await n.core.handleJob({ id: 'j5', kind: 'desktop', folderId: 'f_a', prompt: PROMPT })).error, /not available/); } finally { fs.rmSync(n.dir, { recursive: true, force: true }); }
  const off = mk({ config: { allowPrompts: false } });
  try {
    assert.equal(off.calls.length, 0);
    assert.match((await off.core.handleJob({ id: 'j6', kind: 'desktop', folderId: 'f_a', prompt: PROMPT })).error, /allowPrompts/);
  } finally { fs.rmSync(off.dir, { recursive: true, force: true }); }
});

test('desktop job: the same job id again opens nothing more; at most 4 opens a minute', async () => {
  const m = mk();
  try {
    assert.equal((await m.core.handleJob({ id: 'a', kind: 'desktop', folderId: 'f_a', prompt: PROMPT })).ok, true);
    assert.equal((await m.core.handleJob({ id: 'a', kind: 'desktop', folderId: 'f_a', prompt: PROMPT })).ok, true);
    assert.equal(m.calls.length, 1);
    for (const i of ['b', 'c', 'd']) assert.equal((await m.core.handleJob({ id: i, kind: 'desktop', folderId: 'f_a', prompt: PROMPT })).ok, true);
    const over = await m.core.handleJob({ id: 'e', kind: 'desktop', folderId: 'f_a', prompt: PROMPT });
    assert.equal(over.ok, false); assert.match(over.error, /Too many/);
    assert.equal(m.calls.length, 4);
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});
