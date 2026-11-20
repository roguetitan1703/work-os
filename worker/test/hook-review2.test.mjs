// The independent review of the hooks change (21 Nov), on an installed copy against a stub server: an old %TEMP% marker is moved
// beside the hook; a down server silences tool events only; a subagent's notify posts nothing and its tool call clears a prompt wait;
// markers and copies/ backups are pruned; .proc is written before the brief; a 400 on the account field is retried without it; the
// WORK_OS_KEY path never takes WORK_OS_URL from the environment. Every value is made up.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-rev2-'));
const KEEP = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
const temp = path.join(tmp, 'temp');
fs.mkdirSync(temp);
Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp }); // the old marker folder (%TEMP%/work-os-hooks) is a throwaway one
delete process.env.WORK_OS_HOOK_DIR; // an installed copy: markers beside the hook
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.CLAUDE_CODE_REMOTE;
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
process.env.CLAUDE_PID = String(process.pid);
process.env.CLAUDE_CODE_USER_EMAIL = 'made-up@example.com';
const { FILES } = await import('../hooks-install.mjs');

const TOKEN = 'wst_' + 'r'.repeat(43);
const seen = [];
let eventStatus = () => 200;
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, body });
    const st = req.url === '/api/agent/event' ? eventStatus(body) : 200;
    res.writeHead(st, { 'content-type': 'application/json' });
    res.end(JSON.stringify(st === 200 ? { state: 'idle' } : { error: 'no' }));
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.closeAllConnections?.();
  server.close();
  for (const [k, v] of Object.entries(KEEP)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: URL_ }));
const hook = (f) => import(pathToFileURL(path.join(home, 'hooks', f)).href);
const dev = await hook('hook.mjs');
const lib = await hook('hook-lib.mjs');
const ss = await hook('hook-session-start.mjs');
dev.deps.deviceKey = () => null;

const SID = '5a1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e51';
lib.keepToken(SID, TOKEN);
const events = () => seen.filter((x) => x.url === '/api/agent/event');
const main = (event, extra = {}) => dev.main(event, JSON.stringify({ session_id: SID, cwd: tmp, ...extra }));

test('1. a marker in the old %TEMP%/work-os-hooks folder is read once and moved beside the hook (the production guard survives the update)', () => {
  const SID1 = '5a1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e52';
  const oldDir = path.join(temp, 'work-os-hooks');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, SID1 + '.json'), JSON.stringify({ production: { commands: ['deploy'] }, presence: { state: 'idle', at: 1, postedAt: 1 } }));
  const m = lib.readMarker(SID1);
  assert.deepEqual(m.production, { commands: ['deploy'] });
  assert.ok(fs.existsSync(path.join(lib.markerDir(), SID1 + '.json')), 'now beside the hook');
  assert.ok(!fs.existsSync(path.join(oldDir, SID1 + '.json')), 'the old copy is gone');
  assert.ok(lib.markerDir().startsWith(path.join(home, 'hooks')));
  assert.equal(lib.readMarker('5a1d2e3f-0000-4c6d-8e9f-0a1b2c3d4e59'), null, 'no marker anywhere: null');
});

test('2. a down server silences tool events for 5 minutes, never a state change (stop, prompt, notify, end)', async () => {
  const now = Date.now();
  lib.writeMarker(SID, { presence: { state: 'working', at: now, postedAt: now, failed: true } });
  seen.length = 0;
  assert.equal(await lib.postEvent(SID, 'tool'), null);
  assert.equal(await lib.postEvent(SID, 'tool-start'), null);
  assert.equal(events().length, 0, 'tool events wait out the 5 minutes');
  await lib.postEvent(SID, 'stop');
  assert.equal(events().length, 1, 'a stop is still sent');
  assert.equal(lib.readMarker(SID).presence.state, 'idle');
});

test('4. a subagent\'s notification posts nothing; its next tool call clears a permission-prompt wait to idle, and never sets working', async () => {
  lib.writeMarker(SID, { presence: { state: 'working', at: Date.now(), postedAt: Date.now() } });
  seen.length = 0;
  await main('notification', { agent_id: 'sub-1', notification_type: 'permission_prompt' });
  assert.equal(events().length, 0, 'a subagent notify: nothing');
  await main('notification', { notification_type: 'permission_prompt' });
  assert.equal(events().length, 1);
  assert.deepEqual([lib.readMarker(SID).presence.state, lib.readMarker(SID).presence.kind], ['waiting', 'permission_prompt']);
  seen.length = 0;
  await main('tool-batch', { agent_id: 'sub-1', tool_name: 'Bash' });
  assert.equal(events().length, 1, 'the subagent tool call after the prompt clears it');
  assert.deepEqual([events()[0].body.event, events()[0].body.kind], ['notify', 'idle_prompt']);
  assert.equal(lib.readMarker(SID).presence.state, 'idle');
  seen.length = 0;
  await main('tool-start', { agent_id: 'sub-1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(events().length, 0, 'idle: a subagent call posts nothing (never working)');
  lib.writeMarker(SID, { presence: { state: 'waiting', at: Date.now(), postedAt: Date.now(), kind: 'idle_prompt' } });
  await main('tool-batch', { agent_id: 'sub-1', tool_name: 'Bash' });
  assert.equal(events().length, 0, 'only a prompt wait is cleared');
});

test('6. markers older than 14 days and copies/ backups older than 30 are pruned, folders kept, at most once a day', () => {
  const dir = lib.markerDir();
  fs.mkdirSync(path.join(dir, 'copies'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'a-folder'), { recursive: true });
  const old = (f, days) => { fs.writeFileSync(f, '{}'); const t = (Date.now() - days * 86_400_000) / 1000; fs.utimesSync(f, t, t); };
  old(path.join(dir, 'old.json'), 15);
  old(path.join(dir, 'young.json'), 3);
  old(path.join(dir, 'copies', 'old.md'), 31);
  old(path.join(dir, 'copies', 'mid.md'), 20);
  try { fs.rmSync(path.join(dir, '.pruned'), { force: true }); } catch {}
  lib.pruneOld();
  assert.ok(!fs.existsSync(path.join(dir, 'old.json')));
  assert.ok(fs.existsSync(path.join(dir, 'young.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'copies', 'old.md')));
  assert.ok(fs.existsSync(path.join(dir, 'copies', 'mid.md')), 'backups keep 30 days');
  assert.ok(fs.existsSync(path.join(dir, 'a-folder')), 'folders are never removed');
  old(path.join(dir, 'later.json'), 20);
  lib.pruneOld();
  assert.ok(fs.existsSync(path.join(dir, 'later.json')), 'once a day');
});

test('7. session-start writes .proc (the pid) before the brief, even with no time left for the process lookup', async () => {
  const SID7 = '5a1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e57';
  const proc = path.join(home, 'hooks', 'sessions', SID7 + '.proc');
  lib.run.deadline = Date.now() + 1000; // under 1.5 s left: the lookup after the brief is skipped
  try { await ss.sessionStart({ session_id: SID7, cwd: tmp, source: 'startup' }); } finally { lib.run.deadline = 0; }
  assert.equal(JSON.parse(fs.readFileSync(proc, 'utf8')).pid, process.pid);
});

test('8. a 400 on the identity account is retried once without it, and the account is not sent again', async () => {
  const tr = path.join(tmp, 'tr.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ type: 'custom-title', customTitle: 'Made-up name' }) + '\n');
  lib.writeMarker(SID, { transcript: tr, ident: '', presence: { state: 'idle', at: Date.now(), postedAt: Date.now() } });
  eventStatus = (b) => (b.identity && 'account' in b.identity ? 400 : 200);
  try {
    seen.length = 0;
    await lib.postEvent(SID, 'prompt');
    assert.equal(events().length, 2);
    assert.equal(events()[0].body.identity.account, 'made-up');
    assert.deepEqual(events()[1].body.identity, { title: 'Made-up name' });
    const m = lib.readMarker(SID);
    assert.equal(typeof m.noAccountAt, 'number');
    assert.equal(m.presence.state, 'working', 'the retry was accepted');
    fs.appendFileSync(tr, JSON.stringify({ type: 'custom-title', customTitle: 'Another name' }) + '\n');
    seen.length = 0;
    await lib.postEvent(SID, 'stop');
    assert.equal(events().length, 1);
    assert.deepEqual(events()[0].body.identity, { title: 'Another name' }, 'no account, one call');
  } finally { eventStatus = () => 200; }
});

test('5. the WORK_OS_KEY path with no worker config: the user settings file, else Work OS itself; never WORK_OS_URL from the environment', async () => {
  const repoLib = await import('../hook-lib.mjs'); // a copy with no worker config beside it
  const keep = { key: process.env.WORK_OS_KEY, url: process.env.WORK_OS_URL, userUrl: repoLib.deps.userUrl, server: repoLib.run.server };
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (u) => { asked.push(String(u)); return new Response('{}', { status: 500 }); };
  process.env.WORK_OS_KEY = 'wos_' + 'k'.repeat(40);
  process.env.WORK_OS_URL = 'https://evil.example';
  repoLib.run.server = 'https://repo-named.example';
  try {
    repoLib.deps.userUrl = () => '';
    await repoLib.mcpCall('get_state', {});
    assert.equal(asked.at(-1), 'https://work.delpat.in/api/mcp', 'neither the env nor a repo --server');
    repoLib.deps.userUrl = () => 'https://mine.example';
    await repoLib.mcpCall('get_state', {});
    assert.equal(asked.at(-1), 'https://mine.example/api/mcp', 'the person\'s own settings file');
    const f = path.join(tmp, 'settings.json');
    fs.writeFileSync(f, JSON.stringify({ env: { WORK_OS_URL: 'https://from-file.example' } }));
    assert.equal(repoLib.userSettingsUrl(f), 'https://from-file.example');
    assert.equal(repoLib.userSettingsUrl(path.join(tmp, 'none.json')), '');
  } finally {
    globalThis.fetch = realFetch;
    repoLib.deps.userUrl = keep.userUrl;
    repoLib.run.server = keep.server;
    if (keep.key === undefined) delete process.env.WORK_OS_KEY; else process.env.WORK_OS_KEY = keep.key;
    if (keep.url === undefined) delete process.env.WORK_OS_URL; else process.env.WORK_OS_URL = keep.url;
  }
});
