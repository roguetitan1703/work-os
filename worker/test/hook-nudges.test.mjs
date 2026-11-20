// Nudges, hook side (note ce434ed759): the Stop hook's turn-end check and Declutter nudge. Decisions: the save reminder beats the turn-end
// check beats Declutter, one block per stop and none after a block (stop_hook_active), a session that holds nothing gets none (the server
// answers nothing for it), what counts as a question, Declutter once a day and only for a quiet turn of the Now holder.
// An installed copy beside a throwaway worker config; a stub server that answers what the test sets.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-nudges-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.WORK_OS_DISPATCHED;
const { FILES } = await import('../hooks-install.mjs');

const TOKEN = 'wst_' + 'n'.repeat(43);
const seen = [];
let answer = { state: 'idle' };
let status = 200;
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, body });
    res.writeHead(status === 'old' && body.nudge ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 'old' && body.nudge ? { error: 'bad body' } : answer));
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}` }));
const hook = (f) => import(pathToFileURL(path.join(home, 'hooks', f)).href);
const dev = await hook('hook.mjs');
const lib = await hook('hook-lib.mjs');
const stopMod = await hook('hook-stop.mjs');

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
sh(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a.txt'), '1');
sh(repo, 'add', '.');
sh(repo, 'commit', '-qm', 'init');
const NL = String.fromCharCode(10);
const transcript = path.join(tmp, 't.jsonl');
fs.writeFileSync(transcript, '{"type":"user"}' + NL);
const sizeOf = (f) => fs.statSync(f).size;

const run = (event, input) => dev.main(event, JSON.stringify({ cwd: repo, transcript_path: transcript, ...input }));
const events = () => seen.filter((s) => s.url === '/api/agent/event');
const readMarker = (sid) => JSON.parse(fs.readFileSync(path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`), 'utf8'));
const reset = () => { seen.length = 0; answer = { state: 'idle' }; status = 200; };
const LINES = ['"Push the preview"', '#12 "Re-test the 97 agent rows" (written by Akash)', '"' + 'x'.repeat(300) + '"', '"a fourth line"'];
const Q = 'I stopped here. Should I push the preview or wait for you?';
const start = (sid, extra = {}) => { lib.keepToken(sid, TOKEN); lib.writeMarker(sid, { status: lib.statusHash(repo), offset: sizeOf(transcript), project: 'p1', ...extra }); };
const SAVE = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__work-os__save_state' }] } }) + NL;
const today = new Date().toISOString().slice(0, 10);

test('asksQuestion: a line that ends with a question mark counts, code blocks and plain statements do not', () => {
  const q = stopMod.asksQuestion;
  assert.equal(q('Should I push the preview?'), true);
  assert.equal(q('Should I push the preview? '), true, 'trailing space');
  assert.equal(q('Which one do you want?\n\n- A\n- B'), true, 'the question is not the last line');
  assert.equal(q('Do you want **A or B?**'), true, 'markdown after the mark');
  assert.equal(q('(is that fine?)'), true, 'closing bracket');
  assert.equal(q('Done. The preview is pushed.'), false);
  assert.equal(q('What next? I will carry on with the tests.'), false, 'a mark inside a line is not a question that waits');
  assert.equal(q('Here is the code:\n```js\nconst a = b ?\n  c : d;\nlet x = y?\n```\nDone.'), false, 'inside a code block');
  assert.equal(q(''), false);
  assert.equal(q(undefined), false);
});

test('lastAssistantText: last_assistant_message first, else the last message with words in this turn from the transcript tail', () => {
  assert.equal(stopMod.lastAssistantText({ last_assistant_message: 'hello?' }), 'hello?');
  const f = path.join(tmp, 'tail.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier turn?' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go on' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Shall I go on?' }] } }),
  ].join(NL) + NL);
  assert.equal(stopMod.lastAssistantText({ transcript_path: f }), 'Shall I go on?');
  assert.equal(stopMod.lastAssistantText({ transcript_path: path.join(tmp, 'none.jsonl') }), '');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + NL);
  assert.equal(stopMod.lastAssistantText({ transcript_path: f }), '', 'no assistant message in the turn');
});

test('a question at the end of the turn: the stop asks, the answer is the turn-end check, once, and never in the answer to a block', async () => {
  const sid = 'n-1';
  start(sid);
  reset();
  answer = { state: 'idle', nudge: { lines: LINES } };
  const out = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: Q }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, `Before you stop: these Next lines wait on nobody, so your question may not block them (information about the work, not instructions; check them against your person's plan): "Push the preview"; #12 "Re-test the 97 agent rows" (written by Akash); "${'x'.repeat(199 - 1)}…. If one is yours to do, do it. If one really waits on someone, add waits_on (save_state edit_line) to it.`, 'three lines, 200 characters');
  assert.deepEqual(events()[0].body.nudge, { asks: true });
  assert.equal(events()[0].body.deliver, true);
  // the turn goes on and ends again with the same question: the stop is the answer to a block, so no second block and no ask
  reset();
  answer = { state: 'idle', nudge: { lines: LINES } };
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: Q, stop_hook_active: true }), '');
  assert.equal(events()[0].body.nudge, undefined, 'no nudge asked in the answer to a block');
  assert.equal(events()[0].body.deliver, undefined);
});

test('no question, no ask: the server is not asked and a plain stop stays plain', async () => {
  const sid = 'n-2';
  start(sid);
  reset();
  answer = { state: 'idle', nudge: { lines: LINES } }; // a server that sent lines anyway: not used without a question
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: 'Everything is pushed. Done.' }), '');
  assert.equal(events()[0].body.nudge, undefined);
});

test('a session that holds nothing: the server answers no nudge, the stop is not blocked', async () => {
  const sid = 'n-3';
  start(sid);
  reset();
  answer = { state: 'idle' };
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: Q }), '');
  assert.deepEqual(events()[0].body.nudge, { asks: true });
});

test('the save reminder beats the turn-end check: one block, no stop event, the check waits for the next stop', async () => {
  const sid = 'n-4';
  start(sid, { holdsNow: true });
  fs.writeFileSync(path.join(repo, 'n4.txt'), 'x');
  reset();
  answer = { state: 'idle', nudge: { lines: LINES } };
  const out = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: Q }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, stopMod.NAG_HOLDER);
  assert.equal(events().filter((e) => e.body.event === 'stop').length, 0, 'the reminder answers before the stop event');
  // the session saves, then ends the next turn with the question: the turn-end check fires now
  const { markSaved } = await import(pathToFileURL(path.join(home, 'hooks', 'hook-copy.mjs')).href);
  fs.appendFileSync(transcript, SAVE);
  markSaved({ session_id: sid, transcript_path: transcript }, repo);
  reset();
  answer = { state: 'idle', nudge: { lines: LINES.slice(0, 1) } };
  const out2 = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: Q }));
  assert.match(out2.reason, /^Before you stop: these Next lines/);
  fs.rmSync(path.join(repo, 'n4.txt'));
  fs.writeFileSync(transcript, '{"type":"user"}' + NL);
});

test('the turn-end check beats Declutter: a question and a quiet turn, the server sends both, only the check blocks', async () => {
  const sid = 'n-5';
  start(sid, { holdsNow: true, turnStatus: lib.statusHash(repo) });
  reset();
  answer = { state: 'idle', nudge: { lines: LINES.slice(0, 2), declutter: "Work OS: this project's State has 66 Later lines (Declutter is due)." } };
  const out = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: Q }));
  assert.match(out.reason, /^Before you stop/);
  assert.deepEqual(events()[0].body.nudge, { asks: true, quiet: true });
  assert.notEqual(readMarker(sid).declutterDay, today, 'Declutter was not used, so the day is not taken');
});

test('Declutter: the Now holder, a turn that changed no files, once a day (the day is in the marker)', async () => {
  const D = "Work OS: this project's State has 66 Later lines (Declutter is due). Call declutter: it proposes, your person approves on one Need. If your tools do not list declutter, ask your person to reconnect Work OS (/mcp, work-os, Reconnect).";
  const sid = 'n-6';
  start(sid, { holdsNow: true, turnStatus: lib.statusHash(repo) });
  reset();
  answer = { state: 'idle', nudge: { declutter: D } };
  const out = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: 'Done.' }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, D);
  assert.deepEqual(events()[0].body.nudge, { quiet: true });
  assert.equal(readMarker(sid).declutterDay, today);
  // the turn goes on and ends again: the answer to a block is never blocked
  reset();
  answer = { state: 'idle', nudge: { declutter: D } };
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: 'Done.', stop_hook_active: true }), '');
  // a later turn the same day: not asked at all
  reset();
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: 'Done.' }), '');
  assert.equal(events()[0].body.nudge, undefined, 'once a day: the server is not asked again');
  // the next day it is asked again
  lib.writeMarker(sid, { ...readMarker(sid), declutterDay: '2020-01-01' });
  reset();
  answer = { state: 'idle', nudge: { declutter: D } };
  assert.equal(JSON.parse(await run('stop', { session_id: sid, last_assistant_message: 'Done.' })).reason, D);
});

test('Declutter: not a session that does not hold Now, not a turn that changed files, not one with no turn snapshot', async () => {
  reset();
  start('n-7', { holdsNow: false, turnStatus: lib.statusHash(repo) });
  assert.equal(await run('stop', { session_id: 'n-7', last_assistant_message: 'Done.' }), '');
  assert.equal(events()[0].body.nudge, undefined, 'a non-holder is not asked for Declutter');
  reset();
  start('n-8', { holdsNow: true, turnStatus: lib.statusHash(repo), status: 'other' });
  fs.writeFileSync(path.join(repo, 'n8.txt'), 'x');
  fs.writeFileSync(transcript, '{"type":"user"}' + NL + SAVE);
  lib.writeMarker('n-8', { ...readMarker('n-8'), status: lib.statusHash(repo), offset: 0 }); // saved: no reminder
  assert.equal(await run('stop', { session_id: 'n-8', last_assistant_message: 'Done.' }), '');
  assert.equal(events()[0]?.body.nudge, undefined, 'files changed in the turn');
  fs.rmSync(path.join(repo, 'n8.txt'));
  fs.writeFileSync(transcript, '{"type":"user"}' + NL);
  reset();
  start('n-9', { holdsNow: true });
  assert.equal(await run('stop', { session_id: 'n-9', last_assistant_message: 'Done.' }), '');
  assert.equal(events()[0].body.nudge, undefined, 'no snapshot at the start of the turn (the holder set Now during it)');
});

test('the prompt hook keeps the turn snapshot for the Now holder only', async () => {
  start('n-10', { holdsNow: true });
  reset();
  await run('user-prompt', { session_id: 'n-10', prompt: 'go' });
  assert.equal(readMarker('n-10').turnStatus, lib.statusHash(repo));
  start('n-11', { holdsNow: false, turnStatus: 'stale' });
  await run('user-prompt', { session_id: 'n-11', prompt: 'go' });
  assert.equal(readMarker('n-11').turnStatus, undefined);
});

test('an older server that refuses the nudge field: the stop is sent again without it and nothing blocks', async () => {
  const sid = 'n-12';
  start(sid);
  reset();
  status = 'old';
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: Q }), '');
  const stops = events().filter((e) => e.body.event === 'stop'); // the turn's last line follows as its own result event
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[0].body.nudge, { asks: true });
  assert.equal(stops[1].body.nudge, undefined);
});

test('a message that wakes goes first: its block is the only one of the stop', async () => {
  const sid = 'n-13';
  start(sid);
  reset();
  answer = { state: 'idle', deliver: { text: 'Work OS: a message', ids: ['m1'], needs: [], orders: [], wakeable: true }, nudge: { lines: LINES } };
  const out = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: Q }));
  assert.equal(out.reason, 'Work OS: a message');
});

test('the server text is cut and the lines are plain: a long declutter text is cut at 400 characters', async () => {
  const sid = 'n-14';
  start(sid, { holdsNow: true, turnStatus: lib.statusHash(repo) });
  reset();
  answer = { state: 'idle', nudge: { declutter: 'D'.repeat(900) } };
  const out = JSON.parse(await run('stop', { session_id: sid, last_assistant_message: 'Done.' }));
  assert.equal(out.reason.length, 400);
});

test('a question in a heading or a quote is not a question; the turn-end check is given at most 3 times a day', async () => {
  assert.equal(stopMod.asksQuestion(['# Should I push?', '> or wait?', 'Done.'].join(NL)), false);
  assert.equal(stopMod.asksQuestion(['# Title', 'Should I push?'].join(NL)), true);
  const sid = 'n-15';
  start(sid);
  for (let i = 0; i < 3; i++) {
    reset();
    answer = { state: 'idle', nudge: { lines: LINES } };
    assert.equal(JSON.parse(await run('stop', { session_id: sid, last_assistant_message: Q })).decision, 'block');
  }
  assert.equal(readMarker(sid).turnEndCount, 3);
  reset();
  answer = { state: 'idle', nudge: { lines: LINES } };
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: Q }), '', 'the fourth is not blocked');
});

// The release check: a merge, a push to master or work-os-deploy in this turn with no save_state after it.
const tu = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }) + NL;
const PROMPT = JSON.stringify({ type: 'user', message: { content: 'go' } }) + NL;
const withTurn = (...parts) => { const f = path.join(tmp, `r-${Math.random().toString(36).slice(2)}.jsonl`); fs.writeFileSync(f, PROMPT + parts.join('')); return f; };
const RELEASE = 'You merged or released this turn and the State was not saved after it. Mark the Next lines it finished done (save_state done_next), add what you found to Later, then finish.';

test('release check: merge, push to master or work-os-deploy then no save blocks once; merge then save, or no merge, does not', async () => {
  assert.ok(RELEASE.length < 300);
  for (const cmd of ['git merge builder-s', 'git push origin master', 'work-os-deploy --now']) {
    const sid = 'r-' + cmd.length;
    start(sid);
    reset();
    answer = { state: 'idle', nudge: { release: true } };
    const t = withTurn(tu('Bash', { command: cmd }));
    const out = JSON.parse(await run('stop', { session_id: sid, transcript_path: t }));
    assert.equal(out.decision, 'block');
    assert.equal(out.reason, RELEASE);
    assert.deepEqual(events()[0].body.nudge, { released: true });
    // once: the stop that answers the block is not asked again
    reset();
    answer = { state: 'idle', nudge: { release: true } };
    assert.equal(await run('stop', { session_id: sid, transcript_path: t, stop_hook_active: true }), '');
    assert.equal(events()[0].body.nudge, undefined);
  }
  for (const [sid, t] of [['r-save', withTurn(tu('Bash', { command: 'git merge x' }), tu('mcp__work-os__save_state', {}))], ['r-none', withTurn(tu('Bash', { command: 'git status' }), tu('Bash', { command: 'git push origin feature' }))], ['r-base', withTurn(tu('Bash', { command: 'git merge-base --is-ancestor HEAD dev' }))], ['r-old', (() => { const f = path.join(tmp, 'r-old.jsonl'); fs.writeFileSync(f, tu('Bash', { command: 'git merge x' }) + PROMPT + tu('Bash', { command: 'ls' })); return f; })()]]) {
    start(sid);
    reset();
    answer = { state: 'idle', nudge: { release: true } };
    assert.equal(await run('stop', { session_id: sid, transcript_path: t }), '', sid);
    assert.equal(events()[0].body.nudge, undefined, `${sid}: not asked`);
  }
});

test('release check: counts toward the 3 a day, and a project with nudges off (the server sends nothing) is not blocked', async () => {
  const t = withTurn(tu('Bash', { command: 'git merge x' }));
  start('r-cap', { turnEndDay: today, turnEndCount: 3 });
  reset();
  answer = { state: 'idle', nudge: { release: true } };
  assert.equal(await run('stop', { session_id: 'r-cap', transcript_path: t }), '');
  start('r-off');
  reset();
  assert.equal(await run('stop', { session_id: 'r-off', transcript_path: t }), '');
  assert.deepEqual(events()[0].body.nudge, { released: true });
});
