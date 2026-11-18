import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hooks-install-'));
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'work-os-worker');
process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, 'claude', 'settings.json');
delete process.env.WORK_OS_KEY; // a PC with the key set in Claude Code settings passes it to every child process
const m = await import('../hooks-install.mjs');
const settings = () => JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));

test('install copies the hook, merges four events, keeps other settings and hooks, and is safe to rerun', () => {
  fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH), { recursive: true });
  const other = { type: 'command', command: 'node other.mjs' };
  fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH, JSON.stringify({ model: 'opus', env: { A: '1' }, hooks: { Stop: [{ hooks: [other] }] } }));
  const r = m.install();
  assert.ok(fs.existsSync(path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'hook.mjs')));
  assert.ok(fs.existsSync(path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'config.mjs')));
  assert.ok(fs.existsSync(path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'secret.mjs')), 'the start hook reads the device key with it');
  assert.equal(r.signIn, null, 'no worker config and no WORK_OS_KEY: nothing to sign in with yet');
  fs.writeFileSync(path.join(process.env.WORK_OS_WORKER_DIR, 'config.json'), JSON.stringify({ baseUrl: 'https://x.example' }));
  assert.equal(m.install().signIn, 'worker', 'with the worker set up the hooks need no key');
  assert.equal(m.status().signIn, 'worker');
  fs.rmSync(path.join(process.env.WORK_OS_WORKER_DIR, 'config.json'));
  let s = settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { A: '1' });
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  assert.equal(s.hooks.Stop.length, 2, 'the other Stop hook is kept');
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /hook\.mjs" pre-tool$/);
  assert.doesNotMatch(s.hooks.PreToolUse[0].hooks[0].command, /\\/, 'forward slashes only');
  m.install();
  s = settings();
  assert.equal(s.hooks.Stop.length, 2, 'rerun replaces its own entries, no duplicates');
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.deepEqual(m.status().events.sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  assert.ok(fs.readdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH)).some((f) => f.startsWith('settings.json.bak-')), 'a backup is kept');
});

test('remove takes out only the Work OS entries', () => {
  assert.equal(m.remove(), true);
  const s = settings();
  assert.deepEqual(Object.keys(s.hooks), ['Stop']);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'node other.mjs');
  assert.equal(m.remove(), false);
});

const hooksOf = (dir) => path.join(dir, 'hooks');

test('install copies every FILES entry, removes a stray hook-*.mjs, and writes the entry commands as before', () => {
  const dir = path.join(tmp, 'work-os-worker-files');
  process.env.WORK_OS_WORKER_DIR = dir;
  m.install();
  for (const f of m.FILES) assert.ok(fs.existsSync(path.join(hooksOf(dir), f)), f);
  assert.equal(fs.readdirSync(hooksOf(dir)).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
  fs.writeFileSync(path.join(hooksOf(dir), 'hook-old.mjs'), 'export {};');
  fs.writeFileSync(path.join(hooksOf(dir), 'notes.txt'), 'keep');
  m.install();
  assert.equal(fs.existsSync(path.join(hooksOf(dir), 'hook-old.mjs')), false);
  assert.ok(fs.existsSync(path.join(hooksOf(dir), 'notes.txt')));
});

test('the entries equal the strings older workers wrote', () => {
  const h = 'C:/Users/x/AppData/Roaming/work-os-worker/hooks/hook.mjs';
  const c = (e, t) => ({ type: 'command', command: `node "${h}" ${e}`, timeout: t });
  assert.deepEqual(m.entries(h), {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [c('session-start', 8)] }],
    Stop: [{ hooks: [c('stop', 8)] }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [c('pre-tool', 5)] }],
    PostToolUse: [{ matcher: 'mcp__.*__(save_state|import_state|get_state)', hooks: [c('post-tool', 20)] }],
  });
});

test('the hooks version changes when any file changes', () => {
  const dir = path.join(tmp, 'copy-of-worker');
  fs.mkdirSync(dir);
  for (const f of m.FILES) fs.copyFileSync(new URL(`../${f}`, import.meta.url), path.join(dir, f));
  const v = m.hooksVersion(dir);
  assert.equal(v, m.hooksVersion());
  for (const f of m.FILES) {
    fs.appendFileSync(path.join(dir, f), '// x');
    assert.notEqual(m.hooksVersion(dir), v, f);
    fs.copyFileSync(new URL(`../${f}`, import.meta.url), path.join(dir, f));
  }
});

test('a second worker folder does not take over the global hooks, and its refresh skips them', () => {
  const a = path.join(tmp, 'work-os-worker-a'); const b = path.join(tmp, 'work-os-worker-b');
  process.env.WORK_OS_WORKER_DIR = a;
  m.install({ force: true });
  const before = fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8');
  process.env.WORK_OS_WORKER_DIR = b;
  assert.throws(() => m.install(), /not this worker folder/);
  assert.equal(m.refreshIfStale(), null, 'b has no installed version, so it looks stale, but the entries are in folder a');
  assert.equal(fs.existsSync(path.join(b, 'hooks')), false);
  assert.equal(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'), before);
  m.install({ force: true });
  assert.ok(JSON.stringify(settings().hooks).includes('work-os-worker-b/hooks/hook.mjs'));
  assert.ok(fs.existsSync(path.join(b, 'hooks', 'hook-lib.mjs')));
  process.env.WORK_OS_WORKER_DIR = a;
  assert.equal(m.refreshIfStale(), null, 'now b owns the entries: a leaves them alone');
  m.remove();
  fs.rmSync(tmp, { recursive: true, force: true });
});
