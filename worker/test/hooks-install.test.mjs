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
  fs.rmSync(tmp, { recursive: true, force: true });
});
