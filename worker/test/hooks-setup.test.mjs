import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hooks-setup-'));
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'work-os-worker');
process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, 'claude', 'settings.json');
delete process.env.WORK_OS_KEY;
const m = await import('../hooks-install.mjs');
const { runSetup } = await import('../setup.mjs');
const vfile = () => path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'hooks.version');

async function setup(deps) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const out = []; const log = console.log; console.log = (...a) => out.push(a.join(' '));
  const input = new PassThrough(); input.isTTY = false;
  (async () => { await new Promise((x) => setTimeout(x, 40)); input.write('k-test-device-key\n'); })();
  let error = null;
  try {
    await runSetup({ argv: ['--server', 'https://x.example', '--name', 'n', '--root', root], deps: { input, verify: async () => ({ ok: true, status: 200 }), getToken: () => null, setToken() {}, readSecret: async () => '', scanAndReport: async () => 1, install() {}, ...deps } });
  } catch (e) { error = e; } finally { console.log = log; }
  return { out: out.join('\n'), error };
}

test('setup installs the hooks at the end and says so', async () => {
  const r = await setup({ installHooks: m.install });
  assert.equal(r.error, null);
  assert.match(r.out, /Work OS hooks installed/);
  assert.ok(fs.existsSync(vfile()));
  assert.equal(fs.readFileSync(vfile(), 'utf8').trim(), m.hooksVersion());
  assert.equal(m.status().version, m.hooksVersion());
  assert.equal(m.status().stale, false);
});

test('setup still finishes when the hook install fails, and says why', async () => {
  const r = await setup({ installHooks: () => { throw new Error('settings.json is not valid JSON\nmore'); } });
  assert.equal(r.error, null);
  assert.match(r.out, /hooks not installed: settings\.json is not valid JSON/);
  assert.doesNotMatch(r.out, /\bmore\b/);
  assert.match(r.out, /Done:/);
});

test('a stale installed hook is refreshed; a current one is left alone', () => {
  m.install();
  assert.equal(m.refreshIfStale(), null, 'current: nothing to do');
  fs.writeFileSync(vfile(), 'oldversion00\n');
  assert.equal(m.status().stale, true);
  assert.equal(m.refreshIfStale(), m.hooksVersion());
  assert.equal(m.status().stale, false);
});

test('refresh does nothing when no hooks are installed', () => {
  m.remove();
  assert.equal(fs.existsSync(vfile()), false, 'remove deletes the version file');
  assert.equal(m.refreshIfStale(), null);
  assert.equal(m.status().events.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
