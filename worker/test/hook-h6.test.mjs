// H6 hook side: session-state events (POST /api/agent/event) from user-prompt, notification, stop, session-end and pre-tool,
// and the extra fields of the start body. An installed copy beside a throwaway worker config; a stub server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h6-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
const { FILES } = await import('../hooks-install.mjs');

const WKR = 'wkr_' + 'D'.repeat(43);
const TOKEN = 'wst_' + 't'.repeat(43);
const seen = [];
let eventMode = 'ok'; // ok | http500 | hang
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/agent/start') {
      const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: 'none', state: { now: { text: 'x' } }, stateVersion: 2 };
      return req.headers.authorization === `Bearer ${WKR}` ? json(200, { brief, token: TOKEN, expiresAt: new Date(Date.now() + 3600e3).toISOString() }) : json(200, { brief });
    }
    if (req.url === '/api/agent/event') {
      if (eventMode === 'hang') return;
      if (eventMode === 'http500') return json(500, { error: 'x' });
      return json(200, { state: 'working' });
    }
    json(404, {});
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: URL_ }));
const dev = await import(pathToFileURL(path.join(home, 'hooks', 'hook.mjs')).href);
dev.deps.deviceKey = (dir) => (dir === home ? WKR : null);

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
sh(repo, 'init', '-q', '-b', 'main');
sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
fs.writeFileSync(path.join(repo, 'a.txt'), '1');
sh(repo, 'add', '.');
sh(repo, 'commit', '-qm', 'init');
const transcript = path.join(tmp, 't.jsonl');
fs.writeFileSync(transcript, '{"type":"user"}\n');

const UUID = '0b6f2c1e-3d4a-4b5c-8d9e-1a2b3c4d5e6f';
const UUID2 = '1c7a3d2f-4e5b-4c6d-9eaf-2b3c4d5e6f70';
const run = (event, sid, extra = {}) => dev.main(event, JSON.stringify({ session_id: sid, cwd: repo, transcript_path: transcript, ...extra }));
const events = () => seen.filter((s) => s.url === '/api/agent/event');
const marker = (sid) => JSON.parse(fs.readFileSync(path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`), 'utf8'));
const reset = () => { seen.length = 0; eventMode = 'ok'; };

test('session start sends ccSession (UUID session ids only) and source, and records presence on', async () => {
  reset();
  assert.ok(await run('session-start', UUID, { source: 'startup' }));
  assert.equal(seen[0].url, '/api/agent/start');
  assert.equal(seen[0].body.ccSession, UUID);
  assert.equal(seen[0].body.source, 'startup');
  assert.equal(marker(UUID).presence.state, 'on');
  reset();
  assert.ok(await run('session-start', 'not-a-uuid', { source: 'bogus' }));
  assert.equal('ccSession' in seen[0].body, false);
  assert.equal('source' in seen[0].body, false);
  reset();
  assert.ok(await run('session-start', UUID2, { source: 'compact' }));
  assert.equal(marker(UUID2).presence.state, 'working', 'after a compaction the session was working');
});

test('user-prompt posts prompt (asking for a delivery) with the kept token, prints nothing when there is none, and the marker says working', async () => {
  reset();
  assert.equal(await run('user-prompt', UUID, { prompt: 'secret words' }), '');
  assert.equal(events().length, 1);
  assert.equal(events()[0].auth, `Bearer ${TOKEN}`);
  assert.equal(events()[0].body.event, 'prompt');
  assert.equal(typeof events()[0].body.at, 'number');
  assert.deepEqual(Object.keys(events()[0].body).sort(), ['at', 'deliver', 'event'], 'nothing of the prompt is sent');
  assert.equal(events()[0].body.deliver, true);
  assert.equal(marker(UUID).presence.state, 'working');
});

test('no kept token (or no session id): nothing is posted', async () => {
  reset();
  assert.equal(await run('user-prompt', 'never-started'), '');
  assert.equal(await run('session-end', 'never-started'), '');
  assert.equal(await run('user-prompt', undefined), '');
  assert.equal(seen.length, 0);
});

test('a 500 is silent and keeps the old state in the marker; a server that never answers is given up on', async () => {
  reset(); eventMode = 'http500';
  assert.equal(await run('user-prompt', UUID), '');
  assert.equal(events().length, 1);
  assert.equal(marker(UUID).presence.state, 'working');
  reset(); eventMode = 'hang';
  const t = Date.now();
  assert.equal(await run('notification', UUID, { notification_type: 'permission_prompt' }), '');
  assert.ok(Date.now() - t < 3000, 'gave up inside the hook time');
  assert.equal(marker(UUID).presence.state, 'working', 'a failed post does not change the recorded state');
});

test('notification sends the kind only, for the three kinds only, never the message', async () => {
  reset();
  assert.equal(await run('notification', UUID, { notification_type: 'permission_prompt', message: 'Claude needs your permission to run rm -rf' }), '');
  assert.deepEqual(events()[0].body.event, 'notify');
  assert.equal(events()[0].body.kind, 'permission_prompt');
  assert.equal(JSON.stringify(events()[0].body).includes('rm -rf'), false);
  assert.equal(marker(UUID).presence.state, 'waiting');
  await run('notification', UUID, { notification_type: 'idle_prompt' });
  assert.equal(events().at(-1).body.kind, 'idle_prompt');
  assert.equal(marker(UUID).presence.state, 'idle');
  await run('notification', UUID, { notification_type: 'elicitation_dialog' });
  assert.equal(events().at(-1).body.kind, 'elicitation_dialog');
  const n = events().length;
  await run('notification', UUID, { notification_type: 'auth_success' });
  await run('notification', UUID, {});
  assert.equal(events().length, n, 'other types send nothing');
});

test('stop posts stop when it does not block, and nothing when it holds the session', async () => {
  reset();
  assert.equal(await run('stop', UUID), '', 'nothing changed: no block');
  assert.equal(events().length, 1);
  assert.equal(events()[0].body.event, 'stop');
  assert.equal(marker(UUID).presence.state, 'idle');
  reset();
  fs.writeFileSync(path.join(repo, 'changed.txt'), 'x'); // files changed, State not saved
  const out = await run('stop', UUID);
  assert.equal(JSON.parse(out).decision, 'block');
  assert.equal(events().length, 1, 'the session goes on working: only a tool event asks for what is waiting, no stop');
  assert.equal(events()[0].body.event, 'tool');
  assert.equal(await run('stop', UUID), '', 'asked once: the next stop is the end of the turn');
  assert.equal(events().length, 2);
  assert.equal(events()[1].body.event, 'stop');
  fs.rmSync(path.join(repo, 'changed.txt'));
});

test('session-end posts end and prints nothing', async () => {
  reset();
  assert.equal(await run('session-end', UUID), '');
  assert.equal(events().length, 1);
  assert.equal(events()[0].body.event, 'end');
  assert.equal(marker(UUID).presence.state, 'off');
});

test('pre-tool pings once after waiting, then at most once per 5 minutes while working, and never changes its answer', async () => {
  const real = Date.now;
  try {
    reset();
    await run('notification', UUID, { notification_type: 'permission_prompt' });
    reset();
    assert.equal(await run('pre-tool', UUID, { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default' }), '');
    assert.equal(events().length, 1);
    assert.equal(events()[0].body.event, 'tool');
    assert.equal(marker(UUID).presence.state, 'working');
    for (let i = 0; i < 5; i++) await run('pre-tool', UUID, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(events().length, 1, 'no network on the next calls');
    const t0 = real();
    Date.now = () => t0 + 6 * 60_000;
    assert.equal(await run('pre-tool', UUID, { tool_name: 'Edit', tool_input: { file_path: 'x.txt' } }), '');
    assert.equal(events().length, 2, 'quiet for 6 minutes: one more ping');
    await run('pre-tool', UUID, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(events().length, 2);
  } finally { Date.now = real; }
});

test('pre-tool: a server that fails does not change the answer and is tried once per 5 minutes; the WORK-STATE.md refusal still comes', async () => {
  reset();
  await run('notification', UUID, { notification_type: 'permission_prompt' });
  reset(); eventMode = 'http500';
  assert.equal(await run('pre-tool', UUID, { tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
  assert.equal(await run('pre-tool', UUID, { tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
  assert.equal(events().length, 1, 'a failed try is not repeated on every call (once per 5 minutes)');
  eventMode = 'ok';
  const deny = await run('pre-tool', UUID, { tool_name: 'Write', tool_input: { file_path: path.join(repo, 'WORK-STATE.md') } });
  assert.equal(JSON.parse(deny).hookSpecificOutput.permissionDecision, 'deny');
});

test('the WORK_OS_KEY path posts no events', async () => {
  reset();
  const keep = process.env.WORK_OS_KEY;
  process.env.WORK_OS_KEY = 'wos_' + 'k'.repeat(40);
  try {
    await run('user-prompt', 'keyed');
    await run('stop', 'keyed');
    await run('session-end', 'keyed');
  } finally { if (keep === undefined) delete process.env.WORK_OS_KEY; else process.env.WORK_OS_KEY = keep; }
  assert.equal(events().length, 0);
});

test('the brief shows each other session with its state and age', async () => {
  const { formatBrief } = await import('../hook.mjs');
  const b = formatBrief({
    project: { id: 'p1', name: 'Demo' }, session: 's', textRule: 'x', orders: 'no Orders set', state: 'no State',
    alsoHere: [
      { label: 'Demo builder', for: 'me', machine: 'Victus', state: 'working', minutesAgo: 2 },
      { label: 'Akash lead', for: 'Akash', state: 'waiting', minutesAgo: 9 },
      { label: 'old client', for: 'me', minutesAgo: 20 },
    ],
  });
  assert.match(b, /Demo builder, me, Victus \(working, 2 min ago\)/);
  assert.match(b, /Akash lead, Akash \(waiting, 9 min ago\)/);
  assert.match(b, /old client, me \(20 min ago\)/);
});

test('tool-start posts the event alone (never the command) and leaves the marker alone', async () => {
  reset();
  const cmd = 'npm test -- --secret-flag';
  assert.equal(await run('tool-start', UUID, { tool_name: 'Bash', tool_input: { command: cmd } }), '');
  assert.equal(events().length, 1);
  assert.deepEqual(Object.keys(events()[0].body).sort(), ['at', 'event']);
  assert.equal(events()[0].body.event, 'tool-start');
  assert.doesNotMatch(JSON.stringify(seen), /secret-flag/);
  reset();
  assert.equal(await run('tool-start', 'never-started', { tool_name: 'Bash' }), '');
  assert.equal(seen.length, 0, 'no token: nothing is posted');
});
