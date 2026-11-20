// Context warning, hook side (note 3e92845ac0): the transcript tail's context size, the subagent's transcript path, one warning per 25k
// step, the stop text 50k past the line, no read when the project has no line, and no output for a missing or garbage file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-context-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { contextOfTail, transcriptOf, warningFor, contextWarning, readTail, TAIL_BYTES } = await import('../hook-context.mjs');
const { writeMarker, readMarker } = await import('../hook-lib.mjs');
const { preTool } = await import('../hook-pre-tool.mjs');

const rec = (i, cr, cw) => JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: 5 } } });
const user = JSON.stringify({ type: 'user', message: { content: 'hi' } });
const dir = path.join(tmp, 'proj');
fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
const main = path.join(dir, 'sess.jsonl');
const sub = path.join(dir, 'sess', 'subagents', 'agent-abc123.jsonl');
const put = (f, tokens) => fs.writeFileSync(f, [rec(10, 1000, 0), user, rec(tokens - 2000, 1500, 500), user].join('\n') + '\n');

test('the context is input + cache read + cache write of the last assistant line with usage', () => {
  assert.equal(contextOfTail([rec(1, 100, 10), user, rec(5, 200, 20), user].join('\n')), 225);
  assert.equal(contextOfTail('{"type":"assistant","message":{"usage":{"input_tokens":3'.concat('\n', rec(2, 3, 4))), 9, 'a cut first line is skipped');
  assert.equal(contextOfTail(user), null);
  assert.equal(contextOfTail('not json "assistant" "usage"\n{garbage'), null);
});

test('the transcript: the session\'s own, or the subagent\'s beside it', () => {
  assert.equal(transcriptOf({ transcript_path: main }), main);
  assert.equal(transcriptOf({ transcript_path: main, agent_id: 'abc123' }), sub);
  assert.equal(transcriptOf({ transcript_path: main, agent_id: '../x' }), null);
  assert.equal(transcriptOf({ agent_id: 'abc123' }), null);
});

test('warningFor: nothing below the line, a step every 25k, the stop text 50k past', () => {
  assert.equal(warningFor(149_999, 150), null);
  assert.equal(warningFor(150_000, 150).step, 0);
  assert.equal(warningFor(174_999, 150).step, 0);
  assert.equal(warningFor(175_000, 150).step, 1);
  assert.match(warningFor(160_000, 150).text, /context at 160k \(warning line 150k\): finish this step, write a code-map note/);
  assert.match(warningFor(200_000, 150).text, /stop now, write the code-map note/);
  assert.equal(warningFor(200_000, 150).step, 2);
});

function session(sid, extra = {}) { writeMarker(sid, { project: 'P', ctxWarn: 150, ...extra }); return { session_id: sid, transcript_path: main, tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmp }; }

test('warns once per step, again at the next step, the stop text at line + 50k', () => {
  const inp = session('s1');
  put(main, 140_000);
  assert.equal(contextWarning(inp), null);
  put(main, 152_000);
  assert.match(contextWarning(inp).hookSpecificOutput.additionalContext, /context at 152k/);
  assert.equal(contextWarning(inp), null, 'the same step is not said again');
  put(main, 160_000);
  assert.equal(contextWarning(inp), null);
  put(main, 178_000);
  assert.match(contextWarning(inp).hookSpecificOutput.additionalContext, /context at 178k.*finish this step/);
  put(main, 203_000);
  const stop = contextWarning(inp);
  assert.equal(stop.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(stop.hookSpecificOutput.additionalContext, /stop now/);
  assert.deepEqual(readMarker('s1').ctxSteps, { main: 2 });
});

test('a subagent is tracked by its own transcript and its own step', () => {
  const inp = session('s2');
  put(main, 190_000);
  put(sub, 160_000);
  const s = contextWarning({ ...inp, agent_id: 'abc123' });
  assert.match(s.hookSpecificOutput.additionalContext, /context at 160k/);
  assert.match(contextWarning(inp).hookSpecificOutput.additionalContext, /context at 190k/, 'the lead still gets its own');
  assert.deepEqual(readMarker('s2').ctxSteps, { abc123: 0, main: 1 });
});

test('the setting off (no ctxWarn in the marker) reads nothing', () => {
  writeMarker('s3', { project: 'P' });
  put(main, 400_000);
  const orig = fs.openSync;
  let opened = 0;
  fs.openSync = (...a) => { opened++; return orig(...a); };
  try { assert.equal(contextWarning({ session_id: 's3', transcript_path: main }), null); } finally { fs.openSync = orig; }
  assert.equal(opened, 0);
});

test('a missing, empty or garbage transcript, or no marker, gives no output', () => {
  const inp = session('s4');
  assert.equal(contextWarning({ ...inp, transcript_path: path.join(tmp, 'nope.jsonl') }), null);
  fs.writeFileSync(main, '');
  assert.equal(contextWarning(inp), null);
  fs.writeFileSync(main, 'xx "assistant" "usage" {{{\n\u0000\u0001');
  assert.equal(contextWarning(inp), null);
  assert.equal(contextWarning({ session_id: 'nomarker', transcript_path: main }), null);
  assert.equal(contextWarning(null), null);
});

test('only the last 256 KB is read', () => {
  const big = [rec(1, 400_000, 0), 'x'.repeat(TAIL_BYTES + 10), rec(1, 10, 0)].join('\n');
  fs.writeFileSync(main, big);
  assert.ok(readTail(main).length <= TAIL_BYTES);
  assert.equal(contextOfTail(readTail(main)), 11, 'the old big call lies outside the tail');
});

test('pre-tool: the warning comes through the hook answer, and a refusal is not hidden by it', async () => {
  const inp = session('s5');
  put(main, 155_000);
  const out = await preTool(inp);
  assert.match(out.hookSpecificOutput.additionalContext, /warning line 150k/);
  assert.equal(await preTool(inp), null);
  put(main, 300_000);
  const deny = await preTool({ ...inp, tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'WORK-STATE.md'), old_string: 'a', new_string: 'b' } });
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
});
