// The stop's ask (Sessions list, 21 Nov review): a turn whose last tool call is the app's wrap_up with an `ask` sends that question
// with the stop event it already posts, so the session reads "Waiting on you". Never for a subagent or a headless run; nothing for
// another last call, no ask, or a missing or garbage transcript. An installed copy beside a throwaway worker config; a stub server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-ask-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
const ENTRY = process.env.CLAUDE_CODE_ENTRYPOINT;
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.WORK_OS_DISPATCHED;
const { FILES } = await import('../hooks-install.mjs');

const TOKEN = 'wst_' + 'q'.repeat(43);
const seen = [];
let status = 200;
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, body });
    const old = status === 'old' && body.ask;
    res.writeHead(old ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(old ? { error: 'bad body' } : { state: body.ask ? 'waiting' : 'idle' }));
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => {
  server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  if (ENTRY === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = ENTRY;
});

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}` }));
const hook = (f) => import(pathToFileURL(path.join(home, 'hooks', f)).href);
const dev = await hook('hook.mjs');
const lib = await hook('hook-lib.mjs');
const stopMod = await hook('hook-stop.mjs');

const NL = String.fromCharCode(10);
const line = (o) => JSON.stringify(o);
const prompt = line({ type: 'user', message: { role: 'user', content: 'go on' } });
const use = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } });
const result = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const said = (text) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const WRAP = 'mcp__ccd_turn__wrap_up';
const Q = 'Release 0.26.1 with the two framework fixes?';
const tx = (name, lines) => { const f = path.join(tmp, name); fs.writeFileSync(f, lines.join(NL) + NL); return f; };
const stops = () => seen.filter((s) => s.url === '/api/agent/event' && s.body.event === 'stop');
const run = (input) => dev.main('stop', JSON.stringify({ cwd: tmp, ...input }));
const start = (sid) => { lib.keepToken(sid, TOKEN); };

test('wrapUpAsk: the ask of the turn\'s last call when it is wrap_up; nothing otherwise', () => {
  const w = stopMod.wrapUpAsk;
  assert.equal(w(tx('a.jsonl', [prompt, use('Bash', { command: 'ls' }), result, use(WRAP, { recap: 'r', ask: Q }), result, said('Done. Shall I release?')])), Q);
  assert.equal(w(tx('b.jsonl', [prompt, use(WRAP, { recap: 'r' }), result, said('Done.')])), '', 'wrap_up without ask');
  assert.equal(w(tx('c.jsonl', [prompt, use(WRAP, { recap: 'r', ask: Q }), result, use('Bash', { command: 'ls' }), result, said('ok')])), '', 'a later call wins');
  assert.equal(w(tx('d.jsonl', [use(WRAP, { recap: 'r', ask: Q }), result, prompt, said('Hi.')])), '', 'a wrap_up of an earlier turn');
  assert.equal(w(tx('e.jsonl', ['{garbage', 'not json', ''])), '', 'garbage');
  assert.equal(w(path.join(tmp, 'missing.jsonl')), '', 'missing file');
  assert.equal(w(undefined), '');
  assert.equal(w(tx('f.jsonl', [prompt, use(WRAP, { ask: 42 })])), '', 'an ask that is not text');
  const long = w(tx('g.jsonl', [prompt, use(WRAP, { ask: 'a'.repeat(198) + '\u{1F600}' + 'b'.repeat(80) })]));
  assert.equal(long, 'a'.repeat(198) + '…', 'cut at 200, never inside a surrogate pair');
  assert.equal(w(tx('h.jsonl', [prompt, use(WRAP, { ask: 'Ship\nit\tnow?' })])), 'Ship it now?', 'one line');});

test('wrapUpAsk: past 50 ms of file work it gives up', () => {
  const f = tx('slow.jsonl', [prompt, use(WRAP, { ask: Q })]);
  assert.equal(stopMod.wrapUpAsk(f, Date.now() - 1000), '');
  assert.equal(stopMod.ASK_MS, 50);
  assert.equal(stopMod.ASK_TAIL, 262144);
});

test('a wrap_up ask goes with the stop event; a tail without one sends nothing extra', async () => {
  start('ask-1');
  seen.length = 0;
  await run({ session_id: 'ask-1', transcript_path: tx('s1.jsonl', [prompt, use(WRAP, { recap: 'r', ask: Q }), result, said('Done.')]) });
  assert.equal(stops().length, 1, 'one stop, no new server call');
  assert.equal(stops()[0].body.ask, Q);
  seen.length = 0;
  await run({ session_id: 'ask-1', transcript_path: tx('s2.jsonl', [prompt, use(WRAP, { recap: 'r' }), result, said('Done.')]) });
  assert.equal(stops().length, 1);
  assert.equal(stops()[0].body.ask, undefined);
});

test('a subagent stop never sends it; a headless run never sends it; a garbage or missing file sends nothing', async () => {
  start('ask-2');
  const f = tx('s3.jsonl', [prompt, use(WRAP, { recap: 'r', ask: Q }), result, said('Done.')]);
  seen.length = 0;
  await run({ session_id: 'ask-2', agent_id: 'sub-1', transcript_path: f });
  assert.equal(stops().length, 0, 'the gate skips a subagent stop');
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  seen.length = 0;
  await run({ session_id: 'ask-2', transcript_path: f });
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  assert.ok(stops().every((s) => s.body.ask === undefined), 'a -p run sends no ask');
  process.env.WORK_OS_DISPATCHED = '7';
  seen.length = 0;
  await run({ session_id: 'ask-2', transcript_path: f });
  delete process.env.WORK_OS_DISPATCHED;
  assert.ok(stops().every((s) => s.body.ask === undefined), 'a dispatched run sends no ask');
  for (const p of [tx('s4.jsonl', ['{nope', '']), path.join(tmp, 'gone.jsonl')]) {
    seen.length = 0;
    await run({ session_id: 'ask-2', transcript_path: p });
    assert.equal(stops().length, 1);
    assert.equal(stops()[0].body.ask, undefined);
  }
});

test('a server that does not know ask yet (400): the stop is sent again without it', async () => {
  start('ask-3');
  status = 'old';
  seen.length = 0;
  await run({ session_id: 'ask-3', transcript_path: tx('s5.jsonl', [prompt, use(WRAP, { ask: Q })]) });
  status = 200;
  assert.equal(stops().length, 2);
  assert.equal(stops()[1].body.ask, undefined);
});
