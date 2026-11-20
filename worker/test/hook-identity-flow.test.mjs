// Identity steps 3 and 4 through the installed hook: the start sends the session's name, Claude's title, the model and the tool
// (and no "Claude Code" label), keeps the transcript path and what it sent in the marker, writes the .proc file; a later prompt or stop
// sends the identity once when it changed; a tool event never does. An installed copy beside a throwaway worker config; a stub server.
// Every title and model is made up.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-ident-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
process.env.CLAUDE_PID = String(process.pid); // stands for the claude process: any live process will do
process.env.CLAUDE_CODE_USER_EMAIL = 'made-up@example.com'; // the account label comes from here, never from the real ~/.claude.json
delete process.env.CLAUDE_CODE_ACCOUNT_UUID;
const { FILES } = await import('../hooks-install.mjs');

const WKR = 'wkr_' + 'D'.repeat(43);
const TOKEN = 'wst_' + 't'.repeat(43);
const seen = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, hook: req.headers['x-work-os-hook'], body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/agent/start') {
      const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: 'none', state: { now: { text: 'x' } }, stateVersion: 2 };
      return json(200, { brief, token: TOKEN, expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (req.url === '/api/agent/event') return json(200, { state: 'working' });
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
const SID = '0a0a0a0a-1111-4222-8333-444444444444';
const transcript = path.join(tmp, 't.jsonl');
const rec = (o) => JSON.stringify(o) + '\n';
fs.writeFileSync(transcript, rec({ type: 'user', message: 'hello' }) + rec({ type: 'ai-title', aiTitle: 'Made-up AI title' }) + rec({ type: 'custom-title', customTitle: 'Made-up own name' }) + rec({ type: 'assistant', message: { model: 'made-up-model-1', content: [] } }));
const event = (name, input = {}) => dev.main(name, JSON.stringify({ session_id: SID, cwd: repo, transcript_path: transcript, ...input }));
const events = () => seen.filter((s) => s.url === '/api/agent/event');

test('the start sends title, aiTitle, model and tool (no label), keeps the transcript and what it sent, and writes the .proc file', async () => {
  seen.length = 0;
  await event('session-start', { source: 'startup' });
  const b = seen[0].body;
  assert.equal(seen[0].url, '/api/agent/start');
  assert.equal(seen[0].hook, '4');
  assert.equal(b.title, 'Made-up own name');
  assert.equal(b.aiTitle, 'Made-up AI title');
  assert.equal(b.model, 'made-up-model-1');
  assert.equal(b.tool, 'vscode');
  assert.ok(!('label' in b), 'the old plain "Claude Code" label is gone');
  const marker = JSON.parse(fs.readFileSync(path.join(tmp, 'markers', `${SID}.json`), 'utf8'));
  assert.equal(marker.transcript, transcript);
  assert.ok(marker.ident && marker.ident.includes('Made-up own name'));
  const proc = JSON.parse(fs.readFileSync(path.join(home, 'hooks', 'sessions', `${SID}.proc`), 'utf8'));
  assert.equal(proc.pid, process.pid);
});

test('a prompt with nothing changed sends no identity; after a rename and a new model, one prompt sends it, the next does not', async () => {
  seen.length = 0;
  await event('user-prompt', { prompt: 'go on' });
  assert.equal(events().length, 1);
  assert.ok(!('identity' in events()[0].body));
  fs.appendFileSync(transcript, rec({ type: 'custom-title', customTitle: 'Renamed later' }) + rec({ type: 'assistant', message: { model: 'made-up-model-2', content: [] } }));
  seen.length = 0;
  await event('user-prompt', { prompt: 'again' });
  assert.deepEqual(events()[0].body.identity, { title: 'Renamed later', aiTitle: 'Made-up AI title', model: 'made-up-model-2', account: 'made-up' });
  seen.length = 0;
  await event('user-prompt', { prompt: 'and again' });
  assert.ok(!('identity' in events()[0].body), 'sent once per change');
});

test('a login switch mid-session sends the new account label once (hooks review M9)', async () => {
  process.env.CLAUDE_CODE_USER_EMAIL = 'other-made-up@example.com';
  try {
    seen.length = 0;
    await event('user-prompt', { prompt: 'after the switch' });
    assert.equal(events()[0].body.identity?.account, 'other-made-up');
    assert.ok(!JSON.stringify(events()[0].body).includes('example.com'), 'never the full email');
    seen.length = 0;
    await event('user-prompt', { prompt: 'once more' });
    assert.ok(!('identity' in events()[0].body), 'sent once per change');
  } finally { process.env.CLAUDE_CODE_USER_EMAIL = 'made-up@example.com'; }
});

test('a stop sends a changed identity too; a tool-batch event never does', async () => {
  fs.appendFileSync(transcript, rec({ type: 'ai-title', aiTitle: 'Newer made-up AI title' }));
  seen.length = 0;
  await event('tool-batch');
  assert.ok(events().every((e) => !('identity' in e.body)), 'a tool event carries no identity');
  seen.length = 0;
  await event('stop', { stop_hook_active: false });
  const stop = events().find((e) => e.body.event === 'stop');
  assert.equal(stop?.body.identity?.aiTitle, 'Newer made-up AI title');
});
