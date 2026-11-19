// H15 hook side. Step 1: the server marks a dispatched session in its start answer (`dispatched: <task ref>`), SessionStart keeps it
// in the marker (also through a compaction with a kept token) and the PreToolUse hook treats the mark like WORK_OS_DISPATCHED.
// Step 2: the shell path (Bash and PowerShell commands that reach the Work OS key, API, Claude config or hook files) is refused for a
// dispatched run. An installed copy beside a throwaway worker config; a stub server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h15-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.WORK_OS_DISPATCHED;
const { FILES } = await import('../hooks-install.mjs');

const WKR = 'wkr_' + 'D'.repeat(43);
const TOKEN = 'wst_' + 't'.repeat(43);
const DISPATCHED_CC = '0b6f2c1e-3d4a-4b5c-8d9e-1a2b3c4d5e6f';
const seen = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/agent/start') {
      const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: [{ layer: 'project', title: 'P', version: 1, text: 't', noteId: 'ordersProj2' }], state: { now: { text: 'x' } }, stateVersion: 2 };
      const d = body.ccSession === DISPATCHED_CC ? { dispatched: 301 } : {};
      return req.headers.authorization === `Bearer ${WKR}` ? json(200, { brief, token: TOKEN, expiresAt: new Date(Date.now() + 3600e3).toISOString(), ...d }) : json(200, { brief, ...d });
    }
    json(200, { state: 'on' });
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
const pre = await import(pathToFileURL(path.join(home, 'hooks', 'hook-pre-tool.mjs')).href);

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
const OTHER_CC = '1c7a3d2f-4e5b-4c6d-9eaf-2b3c4d5e6f70';
const run = (event, sid, extra = {}) => dev.main(event, JSON.stringify({ session_id: sid, cwd: repo, transcript_path: transcript, ...extra }));
const marker = (sid) => JSON.parse(fs.readFileSync(path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`), 'utf8'));
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('step 1: a start the server answers with dispatched keeps the task ref in the marker; any other start has none', async () => {
  await run('session-start', DISPATCHED_CC, { source: 'startup' });
  assert.equal(marker(DISPATCHED_CC).dispatched, 301);
  await run('session-start', OTHER_CC, { source: 'startup' });
  assert.equal(marker(OTHER_CC).dispatched, undefined);
});

test('step 1: a compaction start (kept token) keeps the mark, and the marker alone makes the run refuse Orders edits', async () => {
  seen.length = 0;
  await run('session-start', DISPATCHED_CC, { source: 'compact' });
  assert.equal(seen[0]?.auth, `Bearer ${TOKEN}`, 'the kept token was shown');
  assert.equal(marker(DISPATCHED_CC).dispatched, 301);
  assert.ok(denied(await pre.preTool({ session_id: DISPATCHED_CC, tool_name: 'mcp__work-os__write_note', tool_input: { note_id: 'ordersProj2', append: 'x' } })), 'no WORK_OS_DISPATCHED variable, marker only');
  assert.equal(await pre.preTool({ session_id: OTHER_CC, tool_name: 'mcp__work-os__write_note', tool_input: { note_id: 'ordersProj2', append: 'x' } }), null, 'the person\'s own session passes');
});
