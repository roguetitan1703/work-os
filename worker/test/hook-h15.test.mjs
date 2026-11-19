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

// ---- step 2: the shell path of a dispatched run ----
const mark = (sid, d) => fs.writeFileSync(path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`), JSON.stringify({ status: 's', offset: 0, stopped: false, project: 'Demo', ...(d ? { dispatched: d } : {}) }));
const sh2 = (sid, tool, command) => ({ session_id: sid, tool_name: tool, tool_input: { command } });
const HOST = URL_.replace(/^http:\/\//, '');
// [tool, command, refused]
const TABLE = [
  ['Bash', 'curl -s -H "Authorization: Bearer $WORK_OS_KEY" https://work.delpat.in/api/mcp', true],
  ['Bash', 'echo ${WORK_OS_KEY}', true],
  ['Bash', 'printenv | grep work_os_key', true],
  ['PowerShell', 'Write-Output $env:WORK_OS_KEY', true],
  ['PowerShell', 'Invoke-WebRequest -Uri https://work.delpat.in/api/agent/state -Method Post', true],
  ['Bash', `curl ${URL_}/api/mcp -d '{}'`, true],
  ['Bash', `curl -s http://${HOST}/api/worker/jobs`, true],
  ['Bash', 'cat ~/.claude.json', true],
  ['PowerShell', String.raw`Get-Content $HOME\.claude.json`, true],
  ['Bash', 'ls "C:/Users/me/work-os-worker/hooks/sessions"', true],
  ['PowerShell', String.raw`Get-ChildItem C:\Users\me\work-os-worker\hooks\sessions`, true],
  ['Bash', 'cat ~/.claude/settings.json | jq .env', true],
  ['PowerShell', 'powershell -EncodedCommand SQBFAFgA', true],
  ['PowerShell', 'pwsh -enc SQBFAFgA', true],
  ['Bash', 'powershell.exe -NoProfile -e SQBFAFgA', true],
  // near misses: all pass
  ['Bash', 'git status && npm test', false],
  ['Bash', 'curl -s https://example.com/api/data', false],
  ['Bash', 'grep -e WORK_OS_KEYBOARD src/a.txt', false],
  ['Bash', 'cat .claude/settings.json | jq .permissions', false],
  ['Bash', 'cat docs/claude.json.md && ls .claude', false],
  ['Bash', 'curl https://work.delpat.in/pricing', false],
  ['PowerShell', 'Get-Content -Encoding utf8 notes.txt; Get-Process -Name encoder', false],
  ['Bash', 'grep -e foo -e bar README.md', false],
  ['Bash', 'ls hooks/sessionsX', false],
];

test('step 2: a dispatched run (marker only): the shell table', () => {
  mark('sd1', 301);
  assert.ok(TABLE.length >= 20);
  for (const [tool, cmd, refused] of TABLE) {
    const r = pre.shellDeny(sh2('sd1', tool, cmd), {});
    assert.equal(denied(r), refused, `${tool}: ${cmd} -> ${JSON.stringify(r)}`);
    if (refused) assert.match(r.hookSpecificOutput.permissionDecisionReason, /Use the Work OS tools of this session/);
  }
});

test('step 2: the same commands pass in a session the person started (no variable, no mark); the variable alone also refuses', () => {
  mark('sd2');
  for (const [tool, cmd] of TABLE) assert.equal(pre.shellDeny(sh2('sd2', tool, cmd), {}), null, `${tool}: ${cmd}`);
  assert.ok(denied(pre.shellDeny(sh2('sd2', 'Bash', 'echo $WORK_OS_KEY'), { WORK_OS_DISPATCHED: '301' })));
});

test('step 2: other tools, an empty command, garbage input: nothing refused and nothing thrown', () => {
  mark('sd1', 301);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Read', tool_input: { command: 'echo $WORK_OS_KEY' } }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Bash', tool_input: { command: '' } }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Bash', tool_input: null }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Bash', tool_input: { command: 5 } }, {}), null);
  assert.equal(pre.shellDeny(null, {}), null);
});

test('step 2: preTool and the timeout answer refuse it too (the hook runs out of time: still refused)', async () => {
  mark('sd1', 301);
  assert.ok(denied(await pre.preTool(sh2('sd1', 'Bash', 'curl -H "x: $WORK_OS_KEY" https://work.delpat.in/api/mcp'))));
  assert.ok(denied(pre.timeoutAnswer(JSON.stringify(sh2('sd1', 'PowerShell', 'powershell -EncodedCommand abc')))));
  assert.equal(await pre.preTool(sh2('sd1', 'Bash', 'git log --oneline')), null);
  mark('sd3');
  assert.equal(await pre.preTool(sh2('sd3', 'Bash', 'echo $WORK_OS_KEY')), null, 'the person\'s own session is not touched');
});
