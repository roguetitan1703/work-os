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
const HOME = os.homedir().replace(/\\/g, '/');
// [tool, command, refused]
const TABLE = [
  // credential files
  ['Bash', 'cat ~/.claude/settings.json', true],
  ['Bash', 'head -50 $HOME/.claude/settings.json | grep KEY', true],
  ['PowerShell', String.raw`Get-Content $HOME\.claude\settings.json`, true],
  ['PowerShell', String.raw`gc $env:USERPROFILE\.claude\settings.json`, true],
  ['Bash', `sed -n 1,5p ${HOME}/.claude/settings.json`, true],
  ['Bash', 'cd ~/.claude && cat settings.json', true],
  ['Bash', 'cat ~/.claude.json', true],
  ['PowerShell', String.raw`Get-Content $HOME\.claude.json`, true],
  ['Bash', 'cat C:/Users/me/AppData/Roaming/work-os-worker/hooks/sessions/abc.json', true],
  ['Bash', 'cd /c/Users/me/work-os-worker/hooks; cat sessions/*', true],
  ['PowerShell', String.raw`type C:\Users\me\AppData\Roaming\work-os-worker\config.json`, true],
  ['Bash', `python3 -c "print(open('${HOME}/.claude.json').read())"`, true],
  // environment dumps and the key
  ['Bash', 'env', true],
  ['Bash', 'printenv', true],
  ['Bash', 'env | grep WORK', true],
  ['Bash', 'printenv WORK_OS_KEY', true],
  ['Bash', 'echo hi; set', true],
  ['Bash', 'export -p', true],
  ['PowerShell', 'gci env:', true],
  ['PowerShell', 'Get-ChildItem Env:', true],
  ['PowerShell', 'dir env:', true],
  ['PowerShell', 'cmd /c set', true],
  ['PowerShell', '[Environment]::GetEnvironmentVariables()', true],
  ['Bash', 'node -e "console.log(JSON.stringify(process.env))"', true],
  ['Bash', 'node -e "console.log(process.env.WORK_OS_KEY)"', true],
  ['Bash', 'python -c "import os; print(dict(os.environ))"', true],
  ['Bash', 'echo $WORK_OS_KEY', true],
  ['Bash', 'echo ${WORK_OS_KEY}', true],
  ['PowerShell', 'Write-Output $env:WORK_OS_KEY', true],
  // encoded commands
  ['PowerShell', 'powershell -EncodedCommand SQBFAFgA', true],
  ['PowerShell', 'powershell -enco SQBFAFgA', true],
  ['PowerShell', 'powershell.exe -NoProfile -encod SQBFAFgA', true],
  ['PowerShell', 'pwsh /enc SQBFAFgA', true],
  ['PowerShell', 'powershell \u2013enc SQBFAFgA', true],
  ['Bash', 'powershell.exe -e SQBFAFgA', true],
  ['Bash', 'echo SQBFAFgA | base64 -d | sh', true],
  ['PowerShell', '[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($x)) | iex', true],
  // the API
  ['Bash', 'curl -s https://work.delpat.in/api/mcp -d {}', true],
  ['Bash', `curl ${URL_}/api/worker/jobs`, true],
  ['Bash', `curl -s http://${HOST}/api/mcp`, true],
  ['PowerShell', 'Invoke-WebRequest -Uri https://work.delpat.in/api/agent/state', true],
  // false positives and near misses: all pass
  ['Bash', 'git status && npm test', false],
  ['Bash', 'bash -ec "echo hi"', false],
  ['Bash', "sh -ec 'ls'", false],
  ['Bash', 'grep WORK_OS_KEY README.md', false],
  ['Bash', 'git grep hooks/sessions', false],
  ['Bash', 'git commit -m "mention WORK_OS_KEY, hooks/sessions, the env and settings.json"', false],
  ['Bash', 'cat .claude/settings.json | jq .permissions', false],
  ['Bash', 'cat docs/claude.json.md && ls .claude', false],
  ['Bash', 'ls hooks/sessionsX', false],
  ['Bash', 'ls ~/.claude', false],
  ['Bash', 'set -e && npm test', false],
  ['Bash', 'env FOO=1 npm test', false],
  ['Bash', 'export FOO=1', false],
  ['Bash', 'node -e "console.log(process.env.NODE_ENV)"', false],
  ['Bash', 'python -c "import os; print(os.environ.get(\'HOME\'))"', false],
  ['Bash', 'curl -s https://example.com/api/data', false],
  ['Bash', 'curl https://work.delpat.in/pricing', false],
  ['PowerShell', 'Get-Content -Encoding utf8 notes.txt; Get-Process -Name encoder', false],
  ['Bash', 'grep -e foo -e bar README.md', false],
  ['PowerShell', 'powershell -NoProfile -Command "Get-Date"', false],
];

test('step 2: a dispatched run (marker only): the shell table', () => {
  mark('sd1', 301);
  assert.ok(TABLE.length >= 50);
  for (const [tool, cmd, refused] of TABLE) {
    const r = pre.shellDeny(sh2('sd1', tool, cmd), {});
    assert.equal(denied(r), refused, `${tool}: ${cmd} -> ${JSON.stringify(r)}`);
    if (refused) assert.match(r.hookSpecificOutput.permissionDecisionReason, /Use the Work OS tools of this session/);
  }
});

test('step 2: Read, Grep and Glob on the credential files are refused for a dispatched run; other paths pass', () => {
  mark('sd1', 301);
  const tool = (tool_name, tool_input) => ({ session_id: 'sd1', tool_name, tool_input });
  const refused = [
    tool('Read', { file_path: `${HOME}/.claude/settings.json` }),
    tool('Read', { file_path: os.homedir() + path.sep + '.claude.json' }),
    tool('Read', { file_path: 'C:\\Users\\me\\AppData\\Roaming\\work-os-worker\\hooks\\sessions\\abc.json' }),
    tool('Read', { file_path: 'C:\\Users\\me\\AppData\\Roaming\\work-os-worker\\config.json' }),
    tool('Grep', { pattern: 'WORK_OS_KEY', path: `${HOME}/.claude/settings.json` }),
    tool('Grep', { pattern: 'wst_', path: '/x/work-os-worker/hooks/sessions' }),
    tool('Glob', { pattern: 'settings*.json', path: `${HOME}/.claude` }),
  ];
  for (const r of refused) assert.ok(denied(pre.shellDeny(r, {})), JSON.stringify(r));
  const fine = [
    tool('Read', { file_path: 'D:/Work/proj/.claude/settings.json' }),
    tool('Read', { file_path: 'D:/Work/proj/src/app.ts' }),
    tool('Grep', { pattern: 'foo', path: 'D:/Work/proj' }),
    tool('Glob', { pattern: '**/*.ts', path: 'D:/Work/proj' }),
    tool('Read', {}),
  ];
  for (const r of fine) assert.equal(pre.shellDeny(r, {}), null, JSON.stringify(r));
  mark('sd2');
  assert.equal(pre.shellDeny({ session_id: 'sd2', tool_name: 'Read', tool_input: { file_path: `${HOME}/.claude/settings.json` } }, {}), null, 'the person own session reads its settings');
});

test('step 2: the same commands pass in a session the person started (no variable, no mark); the variable alone also refuses', () => {
  mark('sd2');
  for (const [tool, cmd] of TABLE) assert.equal(pre.shellDeny(sh2('sd2', tool, cmd), {}), null, `${tool}: ${cmd}`);
  assert.ok(denied(pre.shellDeny(sh2('sd2', 'Bash', 'echo $WORK_OS_KEY'), { WORK_OS_DISPATCHED: '301' })));
});

test('step 2: other tools, an empty command, garbage input: nothing refused and nothing thrown', () => {
  mark('sd1', 301);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'WebFetch', tool_input: { command: 'echo $WORK_OS_KEY' } }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Bash', tool_input: { command: '' } }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Bash', tool_input: null }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Bash', tool_input: { command: 5 } }, {}), null);
  assert.equal(pre.shellDeny({ session_id: 'sd1', tool_name: 'Read', tool_input: null }, {}), null);
  assert.equal(pre.shellDeny(null, {}), null);
});

test('step 2: preTool and the timeout answer refuse it too (the hook runs out of time: still refused)', async () => {
  mark('sd1', 301);
  assert.ok(denied(await pre.preTool(sh2('sd1', 'Bash', 'curl -H "x: $WORK_OS_KEY" https://work.delpat.in/api/mcp'))));
  assert.ok(denied(pre.timeoutAnswer(JSON.stringify(sh2('sd1', 'PowerShell', 'powershell -EncodedCommand abc')))));
  assert.ok(denied(await pre.preTool({ session_id: 'sd1', tool_name: 'Read', tool_input: { file_path: `${HOME}/.claude.json` } })));
  assert.equal(await pre.preTool(sh2('sd1', 'Bash', 'git log --oneline')), null);
  mark('sd3');
  assert.equal(await pre.preTool(sh2('sd3', 'Bash', 'echo $WORK_OS_KEY')), null, 'the person own session is not touched');
});

// ---- the wrapper's note: closed or quit is not a crash ----
test('run-claude.mjs leaves a note for a clean exit and none for a crash (the worker then reports stopped, not dead)', async () => {
  const { spawnSync } = await import('node:child_process');
  const wrapper = fileURLToPath(new URL('../run-claude.mjs', import.meta.url));
  const tdir = path.join(tmp, 'wtmp');
  fs.mkdirSync(tdir, { recursive: true });
  const probe = path.join(tmp, 'exit.mjs');
  fs.writeFileSync(probe, 'process.exit(Number(process.argv[2]));');
  const A = 'aaaaaaaa-1111-4222-8333-444444444444';
  const B = 'bbbbbbbb-1111-4222-8333-444444444444';
  const env = { ...process.env, TMPDIR: tdir, TEMP: tdir, TMP: tdir };
  spawnSync(process.execPath, [wrapper, process.execPath, probe, '0', '--session-id', A], { env });
  spawnSync(process.execPath, [wrapper, process.execPath, probe, '3', '--session-id', B], { env });
  const ended = path.join(tdir, 'work-os-ended');
  assert.equal(fs.readFileSync(path.join(ended, A), 'utf8'), 'clean exit');
  assert.equal(fs.existsSync(path.join(ended, B)), false, 'a crash leaves no note');
  fs.writeFileSync(path.join(ended, B), 'stale');
  spawnSync(process.execPath, [wrapper, process.execPath, probe, '3', '--session-id', B], { env });
  assert.equal(fs.existsSync(path.join(ended, B)), false, 'a stale note from an earlier run is cleared at start');
});
