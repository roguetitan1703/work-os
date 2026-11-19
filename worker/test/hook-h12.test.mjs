// H12 hook side (the Monday numbers): the stop check sends `files` / `reminded` only for a session whose files changed, once each; a refused
// WORK-STATE.md write that never reached the server posts `copy: 'refused'` with a short timeout and never fails or waits on it.
// An installed copy beside a throwaway worker config; a stub server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h12-'));
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


const UUID3 = '2d8b4e3a-5f6c-4d7e-8fb0-3c4d5e6f7081';
const UUID4 = '3e9c5f4b-6a7d-4e8f-90c1-4d5e6f708192';
const SAVED = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__work-os__save_state"}]}}' + String.fromCharCode(10);
const startSession = async (sid) => { reset(); assert.ok(await run('session-start', sid, { source: 'startup' })); reset(); };
const counts = (e) => Object.fromEntries(Object.entries(e.body).filter(([k]) => ['files', 'reminded', 'copy'].includes(k)));

test('a session whose files never changed sends a plain stop: no counts', async () => {
  await startSession(UUID);
  assert.equal(await run('stop', UUID), '');
  assert.deepEqual(counts(events()[0]), {});
  assert.deepEqual(Object.keys(events()[0].body).sort(), ['at', 'deliver', 'event']);
});

test('files changed and reminded, not saved: the end of the turn says unsaved and reminded, once', async () => {
  await startSession(UUID2);
  fs.writeFileSync(path.join(repo, 'h12-a.txt'), 'x');
  assert.equal(JSON.parse(await run('stop', UUID2)).decision, 'block');
  assert.equal(events().length, 1);
  assert.deepEqual(counts(events()[0]), {}, 'the block itself sends no counts');
  assert.equal(await run('stop', UUID2, { stop_hook_active: true }), '');
  assert.deepEqual(counts(events()[1]), { files: 'unsaved', reminded: true });
  reset();
  assert.equal(await run('stop', UUID2), '');
  assert.deepEqual(counts(events()[0]), {}, 'the same answer is not sent twice');
  fs.rmSync(path.join(repo, 'h12-a.txt'));
});

test('files changed and saved without a reminder: saved, no reminded; a save after the reminder says saved and reminded', async () => {
  await startSession(UUID3);
  fs.writeFileSync(path.join(repo, 'h12-b.txt'), 'x');
  fs.appendFileSync(transcript, SAVED);
  assert.equal(await run('stop', UUID3), '');
  assert.deepEqual(counts(events()[0]), { files: 'saved' });
  await startSession(UUID4);
  fs.writeFileSync(path.join(repo, 'h12-c.txt'), 'y');
  fs.writeFileSync(transcript, '{"type":"user"}' + String.fromCharCode(10));
  assert.equal(JSON.parse(await run('stop', UUID4)).decision, 'block', 'reminded');
  reset();
  // the session saves: the post-tool hook (markSaved) sees the State answer, then it stops
  assert.equal(marker(UUID4).reminded, true);
  const { markSaved } = await import(pathToFileURL(path.join(home, 'hooks', 'hook-copy.mjs')).href);
  markSaved({ session_id: UUID4, transcript_path: transcript }, repo);
  assert.equal(await run('stop', UUID4), '');
  assert.deepEqual(counts(events()[0]), { files: 'saved', reminded: true });
  // the next save after that count is a new story: no leftover reminder, and a new reminder can fire
  reset();
  fs.writeFileSync(path.join(repo, 'h12-d.txt'), 'z');
  markSaved({ session_id: UUID4, transcript_path: transcript }, repo);
  assert.notEqual(marker(UUID4).reminded, true, 'the reminder of the earlier stop is not carried over');
  assert.equal(await run('stop', UUID4), '');
  assert.deepEqual(counts(events()[0]), { files: 'saved' }, 'saved with no reminder this time');
  fs.writeFileSync(path.join(repo, 'h12-e.txt'), 'w');
  assert.equal(JSON.parse(await run('stop', UUID4)).decision, 'block', 'a new reminder fires');
  fs.rmSync(path.join(repo, 'h12-b.txt'));
  fs.rmSync(path.join(repo, 'h12-c.txt'));
  fs.rmSync(path.join(repo, 'h12-d.txt'));
  fs.rmSync(path.join(repo, 'h12-e.txt'));
});

test('a refused WORK-STATE.md write posts copy: refused (and nothing else), without a token nothing, and a hung server costs under a second more', async () => {
  await startSession(UUID);
  const copy = path.join(repo, 'WORK-STATE.md');
  const out = await run('pre-tool', UUID, { tool_name: 'Write', tool_input: { file_path: copy, content: 'x' }, permission_mode: 'default' });
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /^WORK-STATE\.md is a copy/);
  assert.equal(events().length, 1);
  assert.equal(events()[0].body.event, 'tool');
  assert.equal(events()[0].body.copy, 'refused');
  assert.deepEqual(Object.keys(events()[0].body).sort(), ['at', 'copy', 'event'], 'a count, no path, no text');
  reset();
  const t0 = Date.now();
  eventMode = 'hang';
  const hung = await run('pre-tool', UUID, { tool_name: 'Bash', tool_input: { command: 'echo x > WORK-STATE.md' } });
  assert.match(JSON.parse(hung).hookSpecificOutput.permissionDecisionReason, /^WORK-STATE\.md is a copy/);
  assert.ok(Date.now() - t0 < 1500, `the refusal waited ${Date.now() - t0} ms`);
  reset();
  assert.match(JSON.parse(await run('pre-tool', 'nosession-h12', { tool_name: 'Write', tool_input: { file_path: copy, content: 'x' } })).hookSpecificOutput.permissionDecisionReason, /^WORK-STATE\.md is a copy/);
  assert.equal(events().length, 0, 'no kept token: nothing is posted');
});

test('a server that is down changes nothing in the refusal', async () => {
  reset();
  eventMode = 'http500';
  const out = await run('pre-tool', UUID, { tool_name: 'Write', tool_input: { file_path: path.join(repo, 'WORK-STATE.md'), content: 'x' } });
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /^WORK-STATE\.md is a copy/);
  reset();
});
