// H4 hook side: the protocol header, Where facts on start, the copy fetched after a short answer, and Edit forwarding.
// An installed copy of the hook beside a throwaway worker config; a stub server for /api/agent/* and /api/mcp.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h4-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
const { FILES } = await import('../hooks-install.mjs');

const WKR = 'wkr_' + 'D'.repeat(43);
const TOKEN = 'wst_' + 't'.repeat(43);
const KEY = 'wos_' + 'k'.repeat(40);
const seen = [];
let cur = { v: 9, line: '- ship it' };
let stateMode = 'ok'; // ok | http400 | http500 | hang | nomd
const md = (v, line = '- ship it') => `Copy of the Work OS state, version ${v}. Edit it in Work OS (https://x/projects/p1); this file is its copy.\n\n# Work state: Demo\n\n## Now\n${line}\n`;
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, hook: req.headers['x-work-os-hook'], body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/agent/start') {
      const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: 'none', state: { now: { text: 'x' } }, stateVersion: 2 };
      return req.headers.authorization === `Bearer ${WKR}` ? json(200, { brief, token: TOKEN, expiresAt: new Date(Date.now() + 3600e3).toISOString() }) : json(200, { brief });
    }
    if (req.url === '/api/agent/state') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
      if (stateMode === 'hang') return;
      if (stateMode === 'http500') return json(500, { error: 'x' });
      if (stateMode === 'http400') return json(400, { error: 'That line is in two places.' });
      // The server's State: an edit bumps it past the file's version and later answers keep it.
      if (body.edit) cur = { v: 12, line: body.edit.new ? `- ${body.edit.new.replace(/^- /, '')}` : '- (empty)' };
      const { v, line } = cur;
      return json(200, { project: 'p1', version: v, markdown: stateMode === 'nomd' ? 'nothing' : md(v, line), ...(body.edit ? { applied: { version: v, closedTasks: [], sentForReview: [] } } : {}) });
    }
    if (req.url === '/api/mcp') {
      const text = JSON.stringify({ project: 'Demo', version: 7, markdown: md(7) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`);
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
fs.writeFileSync(path.join(repo, 'b.txt'), 'dirty'); // untracked: the tree is dirty
const transcript = path.join(tmp, 't.jsonl');
fs.writeFileSync(transcript, '{"type":"user"}\n');
const lastMsg = () => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim();
const startSid = (sid) => dev.main('session-start', JSON.stringify({ session_id: sid, cwd: repo, transcript_path: transcript }));
const answer = (o) => [{ type: 'text', text: JSON.stringify(o) }];
const post = (sid, tool, o) => dev.main('post-tool', JSON.stringify({ session_id: sid, cwd: repo, tool_name: `mcp__work-os__${tool}`, tool_input: {}, tool_response: answer(o) }));
const pre = (sid, tool_name, tool_input, permission_mode = 'acceptEdits') => dev.main('pre-tool', JSON.stringify({ session_id: sid, cwd: repo, tool_name, tool_input, permission_mode }));
const copyFile = path.join(repo, 'WORK-STATE.md');
const posts = () => seen.filter((s) => s.url === '/api/agent/state');
const reason = (out) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;

test('session start sends the protocol header and Where facts (head, dirty, worktrees)', async () => {
  seen.length = 0;
  assert.ok(await startSid('h1'));
  assert.equal(seen[0].url, '/api/agent/start');
  assert.equal(seen[0].hook, '2');
  const b = seen[0].body;
  assert.match(b.head, /^[0-9a-f]{7,}$/);
  assert.equal(b.dirty, true);
  assert.ok(Array.isArray(b.worktrees) && b.worktrees.length === 1 && b.worktrees[0].endsWith('[main]'), JSON.stringify(b.worktrees));
});

test('a short save answer: the hook fetches the copy with the kept token, sends Where, writes and commits', async () => {
  seen.length = 0; stateMode = 'ok';
  const out = JSON.parse(await post('h1', 'save_state', { saved: true, project: 'Demo', version: 9, message: 'Saved v9. Next 1, Later 0.' }));
  assert.match(out.hookSpecificOutput.additionalContext, /v9, committed/);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].auth, `Bearer ${TOKEN}`);
  assert.equal(posts()[0].hook, '2');
  assert.equal(posts()[0].body.where.branch, 'main');
  assert.match(posts()[0].body.where.head, /^[0-9a-f]{7,}$/);
  assert.match(fs.readFileSync(copyFile, 'utf8'), /^Copy of the Work OS state, version 9\./);
  assert.equal(lastMsg(), 'WORK-STATE.md: copy of the Work OS State v9');
});

test('an answer that still has markdown makes no fetch; get_state fetches without Where; other projects and errors are not fetched', async () => {
  seen.length = 0;
  await post('h1', 'save_state', { saved: true, project: 'Demo', version: 10, markdown: md(10, '- ship it\n- more') });
  assert.equal(posts().length, 0);
  assert.match(fs.readFileSync(copyFile, 'utf8'), /version 10\./);
  await post('h1', 'get_state', { project: 'Demo', version: 10, state: {} });
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.where, undefined);
  await post('h1', 'save_state', { saved: true, project: 'Other', version: 3 });
  assert.equal(posts().length, 1, 'only the marker project');
  await post('h1', 'save_state', { error: 'x', project: 'Demo' });
  assert.equal(posts().length, 1, 'an error answer fetches nothing');
});

test('the copy fetch fails open: server trouble, a bad copy, no marker for the session', async () => {
  for (const m of ['http500', 'nomd']) { stateMode = m; assert.equal(await post('h1', 'save_state', { saved: true, project: 'Demo', version: 11 }), '', m); }
  stateMode = 'ok';
  assert.equal(await post('nosuch', 'save_state', { saved: true, project: 'Demo', version: 11 }), '', 'no marker for this session');
  assert.match(fs.readFileSync(copyFile, 'utf8'), /version 10\./);
});

test('WORK_OS_KEY: the copy comes from get_state copy:true, with the protocol header', async () => {
  const sid = 'hkey';
  fs.mkdirSync(process.env.WORK_OS_HOOK_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`), JSON.stringify({ status: 'x', offset: 0, stopped: false, project: 'Demo' }));
  process.env.WORK_OS_KEY = KEY; process.env.WORK_OS_URL = URL_;
  try {
    seen.length = 0;
    await post(sid, 'save_state', { saved: true, project: 'Demo', version: 7 }); // v7 is older than the file: nothing written, the call is the point
  } finally { delete process.env.WORK_OS_KEY; delete process.env.WORK_OS_URL; }
  assert.equal(posts().length, 0);
  const m = seen.find((s) => s.url === '/api/mcp');
  assert.equal(m.hook, '2');
  assert.equal(m.body.params.name, 'get_state');
  assert.deepEqual(m.body.params.arguments, { project: 'Demo', copy: true });
});

test('Edit of one line of WORK-STATE.md is forwarded; the Edit is refused saying it was applied', async () => {
  stateMode = 'ok'; seen.length = 0;
  const out = await pre('h1', 'Edit', { file_path: copyFile, old_string: 'ship it', new_string: 'shipped' });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /Applied to Work OS State v12; the file is updated/);
  assert.deepEqual(posts()[0].body, { edit: { old: '- ship it', new: '- shipped' } }, 'whole lines, from the part the Edit named');
  assert.equal(posts()[0].auth, `Bearer ${TOKEN}`);
  assert.match(fs.readFileSync(copyFile, 'utf8'), /version 12\.[\s\S]*- shipped/);
  assert.notEqual(lastMsg(), 'WORK-STATE.md: copy of the Work OS State v12', 'pre-tool never runs git commit');
  assert.match(reason(out), /the next save commits it/);
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), /WORK-STATE\.md/, 'written, waiting for its commit');
  // the next post-tool (the same State again) commits what pre-tool wrote
  const o2 = JSON.parse(await post('h1', 'get_state', { project: 'Demo', version: 12, state: {} }));
  assert.match(o2.hookSpecificOutput.additionalContext, /committed/);
  assert.equal(lastMsg(), 'WORK-STATE.md: copy of the Work OS State v12');
});

test('Edit forwarding only when the session would allow the edit: default, plan or no mode send nothing', async () => {
  seen.length = 0;
  const edit = { file_path: copyFile, old_string: 'shipped', new_string: 'sent' };
  for (const mode of ['default', 'plan', null, 'dontAsk'])
    assert.match(reason(await pre('h1', 'Edit', edit, mode)), /^WORK-STATE\.md is a copy/, String(mode));
  assert.equal(posts().length, 0);
  for (const mode of ['bypassPermissions', 'auto']) {
    seen.length = 0;
    assert.match(reason(await pre('h1', 'Edit', edit, mode)), /^Applied to Work OS State/, mode);
    assert.equal(posts().length, 1);
    cur = { v: 12, line: '- shipped' }; // put the State and the file back
    await post('h1', 'get_state', { project: 'Demo', version: 12, state: {} });
  }
  assert.match(fs.readFileSync(copyFile, 'utf8'), /- shipped/);
});

test('the hook timer answers a write of the copy with the plain refusal, and nothing for other calls', async () => {
  const { timeoutAnswer } = await import(pathToFileURL(path.join(home, 'hooks', 'hook-pre-tool.mjs')).href);
  assert.match(timeoutAnswer(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: copyFile } })).hookSpecificOutput.permissionDecisionReason, /^WORK-STATE\.md is a copy/);
  assert.equal(timeoutAnswer(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'a.txt' } })), null);
  assert.equal(timeoutAnswer('not json'), null);
});

test('Edit forwarding: removing a line; several lines, added lines and no match are refused without a call', async () => {
  seen.length = 0;
  const f = fs.readFileSync(copyFile, 'utf8');
  assert.match(f, /- shipped/);
  assert.match(reason(await pre('h1', 'Edit', { file_path: copyFile, old_string: '- shipped\n', new_string: '' })), /Applied to Work OS State/);
  assert.deepEqual(posts()[0].body, { edit: { old: '- shipped', new: '' } });
  seen.length = 0;
  fs.writeFileSync(copyFile, f);
  for (const i of [{ old_string: '## Now\n- shipped\n', new_string: '' }, { old_string: '- shipped', new_string: '- shipped\n- and more' }, { old_string: 'zzz', new_string: 'y' }])
    assert.match(reason(await pre('h1', 'Edit', { file_path: copyFile, ...i })), /^WORK-STATE\.md is a copy/, JSON.stringify(i));
  assert.equal(posts().length, 0, 'nothing sent for those');
});

test('Edit forwarding: a 400 says why; no token, a timeout or a server error give the plain refusal; Write, MultiEdit and Bash never forward', async () => {
  const edit = { file_path: copyFile, old_string: 'shipped', new_string: 'x' };
  stateMode = 'http400'; seen.length = 0;
  assert.match(reason(await pre('h1', 'Edit', edit)), /^Work OS did not apply this edit: That line is in two places\. WORK-STATE\.md is a copy/);
  stateMode = 'http500';
  assert.match(reason(await pre('h1', 'Edit', edit)), /^WORK-STATE\.md is a copy/);
  stateMode = 'hang';
  const t0 = Date.now();
  assert.match(reason(await pre('h1', 'Edit', edit)), /^WORK-STATE\.md is a copy/);
  assert.ok(Date.now() - t0 < 4500, 'gives up inside the 5 s hook limit');
  stateMode = 'ok'; seen.length = 0;
  assert.match(reason(await pre('nosuch', 'Edit', edit)), /^WORK-STATE\.md is a copy/);
  for (const [t, i] of [['Write', { file_path: copyFile, content: 'x' }], ['MultiEdit', { file_path: copyFile, edits: [] }], ['Bash', { command: 'echo x >> WORK-STATE.md' }]])
    assert.match(reason(await pre('h1', t, i)), /^WORK-STATE\.md is a copy/, t);
  assert.equal(posts().length, 0);
});
