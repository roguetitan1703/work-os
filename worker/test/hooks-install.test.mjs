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
const awaitedChildProcess = await import('node:child_process');
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
  assert.match(s.hooks.PostToolUse.find(h => /hook\.mjs" post-tool$/.test(h.hooks[0].command)).matcher, /\(save_state\|import_state\|get_state\|end_work\)$/, 'end_work is a save the copy follows');
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

test('the entries equal the strings older workers wrote, except the PostToolUse matcher that now also lists end_work (H5)', () => {
  const h = 'C:/Users/x/AppData/Roaming/work-os-worker/hooks/hook.mjs';
  const c = (e, t) => ({ type: 'command', command: `node "${h}" ${e}`, timeout: t });
  assert.deepEqual(m.entries(h), {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [c('session-start', 8)] }],
    Stop: [{ hooks: [c('stop', 8)] }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [c('pre-tool', 5)] }],
    PostToolUse: [{ matcher: 'mcp__.*__(save_state|import_state|get_state|end_work)', hooks: [c('post-tool', 20)] }],
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

test('hooks repo: files under .claude/work-os, four cloud entries, other settings kept, safe to rerun', () => {
  const { execFileSync } = awaitedChildProcess;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hooks-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, '.claude'));
    const other = { type: 'command', command: 'node other.mjs' };
    fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [other] }] } }));
    const r = m.repo(repoDir, { server: 'https://work.example' });
    for (const f of m.FILES) assert.ok(fs.existsSync(path.join(repoDir, '.claude', 'work-os', f)), f);
    const read = () => JSON.parse(fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf8'));
    const first = fs.readFileSync(r.settings, 'utf8');
    let s = read();
    assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] }, 'permissions untouched');
    assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/work-os/hook.mjs" session-start --cloud --server \"https://work.example\"');
    assert.equal(s.hooks.PostToolUse[0].hooks[0].timeout, 20);
    m.repo(repoDir, { server: 'https://work.example' });
    assert.equal(fs.readFileSync(r.settings, 'utf8'), first, 'rerun changes nothing');
    m.repo(path.join(repoDir, '.claude'), { server: 'https://other.example' });
    s = read();
    assert.equal(s.hooks.Stop.length, 2);
    assert.match(s.hooks.Stop[1].hooks[0].command, /--server "https:\/\/other\.example"$/, 'a rerun from a subfolder finds the repo top and replaces the entries');
    assert.throws(() => m.repo(os.tmpdir(), { server: 'https://x.example' }), /not inside a git repo/);
    assert.throws(() => m.repo(repoDir, { server: 'http://example.com' }), /https/);
  } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
});

test('a worker folder not named work-os-worker: two installs leave no duplicates, and status and remove see the entries', () => {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-odd-'));
  const keepS = process.env.CLAUDE_SETTINGS_PATH; const keepD = process.env.WORK_OS_WORKER_DIR;
  try {
    process.env.CLAUDE_SETTINGS_PATH = path.join(t2, 'settings.json');
    process.env.WORK_OS_WORKER_DIR = path.join(t2, 'elsewhere');
    m.install({ force: true });
    m.install({ force: true });
    const s = JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));
    assert.equal(s.hooks.Stop.length, 1);
    assert.equal(s.hooks.SessionStart.length, 1);
    assert.equal(m.status().events.length, 4);
    assert.equal(m.refreshIfStale(), null);
    assert.equal(m.remove(), true);
    assert.equal(m.status().events.length, 0);
  } finally { process.env.CLAUDE_SETTINGS_PATH = keepS; process.env.WORK_OS_WORKER_DIR = keepD; fs.rmSync(t2, { recursive: true, force: true }); }
});

test('hooks repo quotes the server origin and refuses a linked .claude/work-os', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-repo-link-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-repo-target-'));
  try {
    awaitedChildProcess.execFileSync('git', ['init', '-q'], { cwd: dir });
    const r = m.repo(dir, { server: 'https://work.example/path?x=1;rm' });
    assert.equal(r.server, 'https://work.example');
    assert.match(fs.readFileSync(r.settings, 'utf8'), /--server \\"https:\/\/work\.example\\"/);
    fs.rmSync(path.join(dir, '.claude', 'work-os'), { recursive: true, force: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    try { fs.symlinkSync(target, path.join(dir, '.claude', 'work-os'), 'junction'); } catch { return; } // the OS refused the link
    assert.throws(() => m.repo(dir, { server: 'https://work.example' }), /link or not a folder/);
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')));
    assert.equal(fs.readdirSync(target).length, 1, 'nothing was written through the link');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
});
