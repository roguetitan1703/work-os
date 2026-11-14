import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg'); // no worker config: the URL comes from WORK_OS_URL
const KEY = 'wos_' + 'k'.repeat(40);
const { main } = await import('../hook.mjs');
const HOOK = fileURLToPath(new URL('../hook.mjs', import.meta.url));

// A stub of the MCP endpoint: start_work answers per `mode`.
const seen = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(b || '{}') });
    if (mode === 'hang') return; // never answers
    if (mode === 'http500') { res.writeHead(500); return res.end('x'); }
    const send = (text, isError = false) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError } })}\n\n`);
    };
    if (mode === 'unmatched') return send(JSON.stringify({ unmatched: true, candidates: [] }));
    if (mode === 'toolerror') return send('Error: nope', true);
    if (mode === 'garbage') return send('not json at all');
    send(JSON.stringify({ project: { id: 'p1', name: 'Demo' }, session: 'sess-123', orders: 'no Orders set', state: { now: { text: 'ship it' } }, stateVersion: 3 }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
before(() => { process.env.WORK_OS_KEY = KEY; process.env.WORK_OS_URL = URL_; });

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
sh(repo, 'init', '-q', '-b', 'main');
sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
fs.writeFileSync(path.join(repo, 'a.txt'), '1');
sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
const transcript = path.join(tmp, 'transcript.jsonl');
fs.writeFileSync(transcript, '{"type":"user"}\n');
let n = 0;
const start = (extra = {}) => main('session-start', JSON.stringify({ session_id: 's' + (extra.sid ?? ++n), cwd: repo, transcript_path: transcript }));

test('SessionStart prints the brief as Claude Code hook JSON, with repo facts and the key sent', async () => {
  mode = 'ok'; seen.length = 0;
  const out = JSON.parse(await start());
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /sess-123/);
  assert.match(out.hookSpecificOutput.additionalContext, /ship it/);
  const call = seen[0];
  assert.equal(call.auth, `Bearer ${KEY}`);
  assert.equal(call.body.params.name, 'start_work');
  assert.equal(call.body.params.arguments.remote, 'https://github.com/acme/demo.git');
  assert.equal(call.body.params.arguments.branch, 'main');
  assert.equal(call.body.params.arguments.path, repo);
});

test('SessionStart fails open: nothing printed for every failure', async () => {
  for (const m of ['unmatched', 'toolerror', 'garbage', 'http500']) { mode = m; assert.equal(await start(), '', m); }
  mode = 'ok';
  assert.equal(typeof (await main('session-start', 'not json')), 'string', 'garbage stdin does not throw');
  assert.equal(await main('session-start', JSON.stringify({ session_id: 'x', cwd: tmp })), '', 'not a git folder');
  const keep = process.env.WORK_OS_KEY;
  delete process.env.WORK_OS_KEY; assert.equal(await start(), '', 'no key');
  process.env.WORK_OS_KEY = 'wkr_' + 'A'.repeat(43); assert.equal(await start(), '', 'a worker key is not an MCP key');
  process.env.WORK_OS_KEY = keep;
  const url = process.env.WORK_OS_URL;
  process.env.WORK_OS_URL = 'http://127.0.0.1:1'; assert.equal(await start(), '', 'no network');
  process.env.WORK_OS_URL = 'not a url'; assert.equal(await start(), '', 'bad url');
  process.env.WORK_OS_URL = url;
});

test('SessionStart gives up after about 5 seconds', async () => {
  mode = 'hang';
  const t0 = Date.now();
  assert.equal(await start(), '');
  const ms = Date.now() - t0;
  assert.ok(ms >= 4500 && ms < 8000, `took ${ms} ms`);
  mode = 'ok';
});

test('Stop blocks exactly once when files changed and no save_state happened', async () => {
  mode = 'ok';
  assert.ok(await start({ sid: 'stop1' }));
  const stop = () => main('stop', JSON.stringify({ session_id: 'sstop1', cwd: repo, transcript_path: transcript }));
  assert.equal(await stop(), '', 'nothing changed yet: no block');
  fs.writeFileSync(path.join(repo, 'b.txt'), '2');
  const out = JSON.parse(await stop());
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /save_state/);
  assert.equal(await stop(), '', 'never twice in a session');
  fs.writeFileSync(path.join(repo, 'c.txt'), '3');
  assert.equal(await stop(), '');
});

test('Stop does not block after a save_state, with stop_hook_active, or without a recorded start', async () => {
  mode = 'ok';
  assert.ok(await start({ sid: 'stop2' }));
  fs.writeFileSync(path.join(repo, 'd.txt'), '4');
  fs.appendFileSync(transcript, '{"type":"assistant","tool":"mcp__work-os__save_state"}\n');
  assert.equal(await main('stop', JSON.stringify({ session_id: 'sstop2', cwd: repo, transcript_path: transcript })), '', 'saved');
  fs.writeFileSync(transcript, '{"type":"user"}\n'); // a fresh transcript for the next sessions
  assert.ok(await start({ sid: 'stop3' }));
  fs.writeFileSync(path.join(repo, 'e.txt'), '5');
  assert.equal(await main('stop', JSON.stringify({ session_id: 'sstop3', cwd: repo, transcript_path: transcript, stop_hook_active: true })), '', 'stop_hook_active');
  assert.equal(await main('stop', JSON.stringify({ session_id: 'neverstarted', cwd: repo, transcript_path: transcript })), '', 'no marker (start failed or no project)');
  assert.equal(await main('stop', 'junk'), '');
});

test('after compaction the start baseline stays', async () => {
  mode = 'ok';
  assert.ok(await start({ sid: 'cmp' }));
  fs.writeFileSync(path.join(repo, 'f.txt'), '6');
  assert.ok(await start({ sid: 'cmp' })); // compact: start_work again
  const out = JSON.parse(await main('stop', JSON.stringify({ session_id: 'scmp', cwd: repo, transcript_path: transcript })));
  assert.equal(out.decision, 'block');
});

const run = (arg, input) => new Promise((resolve) => {
  const c = spawn(process.execPath, [HOOK, arg], { env: { ...process.env } });
  let out = '';
  c.stdout.on('data', (d) => (out += d));
  c.on('close', (status) => resolve({ status, out }));
  c.stdin.end(input);
});
test('run as a command: JSON on stdout, exit 0, even with nothing to say', async () => {
  const r = await run('stop', '{}');
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  mode = 'ok';
  const r2 = await run('session-start', JSON.stringify({ session_id: 'cli1', cwd: repo, transcript_path: transcript }));
  assert.equal(r2.status, 0);
  assert.equal(JSON.parse(r2.out).hookSpecificOutput.hookEventName, 'SessionStart');
});
