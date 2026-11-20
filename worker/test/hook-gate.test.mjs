// The one gate every hook passes (hook-gate.mjs): each hook of EVENTS run through hook.mjs main against each case (the
// person's own call, a subagent's call, a claude -p / SDK run, and for the wait a parent claude process that is gone), on an
// installed copy against a stub server. A skipped hook prints nothing and makes no call at all; the cases a hook runs in reach
// its handler. Every EVENTS row has a RULES row.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-gate-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
const ENTRY = process.env.CLAUDE_CODE_ENTRYPOINT;
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
const { FILES } = await import('../hooks-install.mjs');

const TOKEN = 'wst_' + 'g'.repeat(43);
const seen = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    seen.push({ url: req.url, body: b ? JSON.parse(b) : {} });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/agent/wait') return res.end(JSON.stringify({ wake: true, text: 'Work OS: wake' }));
    if (req.url === '/api/agent/event') return res.end(JSON.stringify({ state: 'idle' }));
    res.end(JSON.stringify({}));
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (ENTRY === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = ENTRY;
});

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}` }));
const hook = (f) => import(pathToFileURL(path.join(home, 'hooks', f)).href);
const dev = await hook('hook.mjs');
const lib = await hook('hook-lib.mjs');
const g = await hook('hook-gate.mjs');
const waiter = await hook('hook-wait.mjs');
dev.deps.deviceKey = () => null; // no worker sign-in: session-start asks nothing of the server
waiter.clock.sleep = async () => {};
waiter.parent.find = () => ({ pid: 4242 });
let parentAlive = true;
waiter.parent.alive = () => parentAlive;

const SID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
lib.keepToken(SID, TOKEN);
const idle = () => lib.writeMarker(SID, { project: 'Demo', presence: { state: 'idle', at: Date.now(), postedAt: 0 }, lastTool: 0 });

/** One input per hook, as Claude Code sends it. */
const INPUTS = {
  'session-start': { source: 'startup' },
  stop: {},
  'pre-tool': { tool_name: 'Read', tool_input: { file_path: path.join(tmp, 'a.txt') } },
  'post-tool': { tool_name: 'mcp__work-os__get_state', tool_response: JSON.stringify({ project: 'Other' }) },
  'user-prompt': { prompt: 'hi' },
  'tool-batch': { tool_name: 'Bash' },
  'tool-start': { tool_name: 'Bash', tool_input: { command: 'npm test' } },
  wait: { hook_event_name: 'Stop' },
  notification: { notification_type: 'permission_prompt' },
  'session-end': { reason: 'exit' },
  'subagent-start': { agent_type: 'general-purpose' },
  'subagent-stop': { agent_type: 'general-purpose' },
};
/** The hooks that post the session's state for the person's own call (each reaches the server in the plain case). */
const POSTS = new Set(['user-prompt', 'tool-start', 'tool-batch', 'wait', 'notification', 'session-end']);

const runHook = async (event, extra = {}, env = 'cli') => {
  process.env.CLAUDE_CODE_ENTRYPOINT = env;
  idle();
  seen.length = 0;
  lib.run.exitCode = 0;
  lib.run.stderr = '';
  const out = await dev.main(event, JSON.stringify({ session_id: SID, cwd: tmp, ...INPUTS[event], ...extra }));
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  return { out, calls: seen.length, exit: lib.run.exitCode };
};

test('every EVENTS row has a RULES row', () => {
  for (const e of new Set(lib.EVENTS.map((x) => x.event))) assert.ok(g.RULES[e], e);
});

for (const event of Object.keys(g.RULES)) {
  test(`gate: ${event}, each case`, async () => {
    const rule = g.RULES[event];
    // the person's own call
    const own = await runHook(event);
    if (POSTS.has(event)) assert.ok(own.calls > 0, `${event}: the person's own call reaches the server`);
    // a subagent's call (it shares the session id)
    const sub = await runHook(event, { agent_id: 'sub-1', agent_type: 'general-purpose' });
    if (rule.subagent === 'skip') {
      assert.equal(sub.out, '', `${event}: a subagent prints nothing`);
      assert.equal(sub.calls, 0, `${event}: a subagent makes no call`);
      assert.equal(sub.exit, 0);
    }
    // a claude -p or SDK run
    for (const env of ['sdk-cli', 'sdk-ts', 'sdk-py']) {
      const q = await runHook(event, {}, env);
      if (rule.quiet === 'skip') {
        assert.equal(q.out, '', `${event} ${env}: prints nothing`);
        assert.equal(q.calls, 0, `${event} ${env}: makes no call`);
        assert.equal(q.exit, 0);
      }
    }
  });
}

test('gate: the decisions themselves (subagent, -p run, unknown parent)', () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  const a = g.gate('tool-start', { session_id: SID });
  assert.deepEqual([a.run, a.subagent, a.quiet, a.sid], [true, false, false, SID]);
  const b = g.gate('tool-start', { session_id: SID, agent_id: 'x' });
  assert.deepEqual([b.run, b.why, b.subagent], [false, 'subagent', true]);
  assert.equal(g.gate('pre-tool', { session_id: SID, agent_id: 'x' }).run, true, 'the guards run for a subagent');
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  const c = g.gate('wait', { session_id: SID });
  assert.deepEqual([c.run, c.why, c.quiet], [false, 'quiet run', true]);
  assert.equal(g.gate('pre-tool', { session_id: SID }).run, true, 'the guards run in a -p run');
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  const keep = g.parent.find;
  g.parent.find = () => null;
  try { assert.equal(g.gate('wait', { session_id: SID }).parentGone(), false, 'an unknown parent is never gone'); } finally { g.parent.find = keep; }
});

test('gate: the wait with its parent claude process gone makes no call and wakes nobody; alive, it wakes', async () => {
  parentAlive = false;
  const dead = await runHook('wait');
  assert.deepEqual([dead.out, dead.calls, dead.exit], ['', 0, 0]);
  parentAlive = true;
  const live = await runHook('wait');
  assert.equal(live.exit, 2);
  assert.equal(live.calls, 1);
});
