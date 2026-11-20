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

async function setup(deps, extra = []) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const out = []; const log = console.log; console.log = (...a) => out.push(a.join(' '));
  const input = new PassThrough(); input.isTTY = false;
  // readline drops a line typed before the question is asked: type the key only once the prompt has been written.
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    if (String(chunk).includes('Device key: ')) { process.stdout.write = write; setImmediate(() => input.write('k-test-device-key\n')); }
    return write.call(this, chunk, ...rest);
  };
  let error = null;
  try {
    await runSetup({ argv: ['--server', 'https://x.example', '--name', 'n', '--root', root, ...extra], deps: { input, verify: async () => ({ ok: true, status: 200 }), getToken: () => null, setToken() {}, readSecret: async () => '', scanAndReport: async () => 1, install() {}, ...deps } });
  } catch (e) { error = e; } finally { console.log = log; process.stdout.write = write; }
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
});

test('--no-autostart leaves autostart alone; the ending names the hooks version and the next step', async () => {
  let installs = 0;
  const r = await setup({ install: () => { installs++; }, installHooks: () => ({ version: 'abc123def456' }) }, ['--no-autostart']);
  assert.equal(r.error, null);
  assert.equal(installs, 0);
  assert.match(r.out, /autostart skipped/);
  assert.match(r.out, /Work OS hooks installed \(version abc123def456\)/);
  assert.match(r.out, /Done: in Work OS, Claude › Setup › Computers › n › Folders, press Link matching folders\./);
  // The full path of the installed worker.mjs, so the line works from any folder (setup often runs from the home folder).
  const { WORKER_MJS } = await import('../setup.mjs');
  assert.ok(path.isAbsolute(WORKER_MJS) && fs.existsSync(WORKER_MJS));
  assert.ok(r.out.includes(`Then check with: node "${WORKER_MJS}" hooks check <a project folder>`), r.out);
  const r2 = await setup({ install: () => { installs++; }, installHooks: () => ({ version: 'abc123def456' }) });
  assert.equal(installs, 1, 'without the flag autostart is installed');
});

test('the folder hint keeps its backslash on Windows', async () => {
  const { rootHint } = await import('../setup.mjs');
  assert.equal(rootHint(), process.platform === 'win32' ? 'D:\\Work' : '~/Work');
  fs.rmSync(tmp, { recursive: true, force: true });
});
