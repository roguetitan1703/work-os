// Lanes step 3 hook side: subagents cannot write the State (pre-tool deny on agent_id), the main conversation's last message goes to the
// server as the lane result (Stop; SubagentStop sends nothing), the SubagentStart preface, the Stop reminder for sessions that do not hold Now, and the lane calls that
// count as "Work OS has heard from this session". An installed copy beside a throwaway worker config; a stub server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-lanes-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.WORK_OS_DISPATCHED;
const { FILES } = await import('../hooks-install.mjs');

const TOKEN = 'wst_' + 't'.repeat(43);
const seen = [];
let eventReply = null; // extra fields on POST /api/agent/event answers
let stateReply = null; // what POST /api/agent/state answers (Lanes step 6)
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, hook: req.headers['x-work-os-hook'], body: b ? JSON.parse(b) : {} });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/agent/state' && stateReply ? stateReply : { state: 'working', ...(req.url === '/api/agent/event' ? eventReply : {}) }));
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
const pre = await hook('hook-pre-tool.mjs');
const stopMod = await hook('hook-stop.mjs');
const sub = await hook('hook-subagent-stop.mjs');

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
const reset = () => { seen.length = 0; };
const DENY = "Work OS: you are a subagent; your parent session records the State (save_state, import_state, end_work). Nothing was sent. Put what you found in your final message: your parent reads it.";
const reason = (out) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
const toolUse = (tool) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__work-os__${tool}` }] } }) + NL;
// A marker as the start hook leaves it: the status of the repo now, the transcript offset now.
const start = (sid, extra = {}) => lib.writeMarker(sid, { status: lib.statusHash(repo), offset: sizeOf(transcript), project: 'p1', ...extra });

test('pre-tool: a subagent (agent_id) is denied save_state, import_state and end_work with the exact text; a main session is not', async () => {
  for (const t of ['save_state', 'import_state', 'end_work']) {
    const out = await run('pre-tool', { session_id: 'l-1', tool_name: `mcp__work-os__${t}`, tool_input: {}, agent_id: 'a1' });
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(reason(out), DENY);
    assert.equal(await run('pre-tool', { session_id: 'l-1', tool_name: `mcp__work-os__${t}`, tool_input: {} }), '', `${t} in the main session passes`);
  }
  assert.equal(await run('pre-tool', { session_id: 'l-1', tool_name: 'mcp__work-os__log_progress', tool_input: {}, agent_id: 'a1' }), '', 'a subagent may still log progress');
  assert.equal(await run('pre-tool', { session_id: 'l-1', tool_name: 'mcp__work-os__get_state', tool_input: {}, agent_id: 'a1' }), '');
});

test('pre-tool: the timeout answer denies a subagent State write the same way and passes a main session', () => {
  const t = pre.timeoutAnswer(JSON.stringify({ session_id: 'l-1', tool_name: 'mcp__work-os__save_state', agent_id: 'a1' }));
  assert.equal(t.hookSpecificOutput.permissionDecisionReason, DENY);
  assert.equal(pre.timeoutAnswer(JSON.stringify({ session_id: 'l-1', tool_name: 'mcp__work-os__save_state' })), null);
});

test('the hook rows: pre-tool matches the State writes, post-tool the lane calls, no subagent-stop row, protocol 4', () => {
  const row = (e) => lib.EVENTS.find((r) => r.event === e);
  for (const t of ['save_state', 'import_state', 'end_work']) assert.ok(new RegExp(`^(${row('pre-tool').matcher})$`).test(`mcp__work-os__${t}`), t);
  for (const t of ['save_state', 'import_state', 'get_state', 'end_work', 'log_progress', 'set_doing', 'hand_in', 'complete_task']) assert.ok(new RegExp(`^(${row('post-tool').matcher})$`).test(`mcp__work-os__${t}`), t);
  assert.equal(row('subagent-stop'), undefined, 'SubagentStop runs no Work OS hook');
  assert.equal(lib.HOOK_PROTOCOL, 4);
  assert.deepEqual(lib.hookHeaders(), { 'x-work-os-hook': '4' });
});

test('subagent-stop: sends nothing, even with a kept token and a message (a subagent\'s report is never the session\'s last line)', async () => {
  const sid = 'l-sub-1';
  lib.keepToken(sid, TOKEN);
  start(sid);
  reset();
  const agentFile = path.join(tmp, 'agent.jsonl');
  fs.writeFileSync(agentFile, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found two failing tests.' }] } }) + NL);
  assert.equal(await run('subagent-stop', { session_id: sid, agent_id: 'a1', last_assistant_message: '<analysis> I am an Opus builder subagent' }), '');
  assert.equal(await run('subagent-stop', { session_id: sid, agent_id: 'a1', agent_transcript_path: agentFile }), '');
  assert.equal(events().length, 0);
  assert.equal(sub.cleanResult('a\u0000b\r\nc'), 'a b c');
});

const results = () => events().filter((e) => e.body.event === 'result');
const line = (o) => JSON.stringify(o) + NL;
const said = (text, extra = {}) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

test('stop: the turn\'s last message goes to the event route as result after the stop, control characters out, 300 characters, protocol 4 header; once per text', async () => {
  const sid = 'l-res-1';
  lib.keepToken(sid, TOKEN);
  start(sid);
  reset();
  const long = 'Tests pass.\u0007' + NL + 'second line ' + 'x'.repeat(500);
  assert.equal(await run('stop', { session_id: sid, last_assistant_message: long }), '');
  assert.deepEqual(events().map((e) => e.body.event), ['stop', 'result'], 'the stop first, then the result');
  const e = results()[0];
  assert.equal(e.auth, `Bearer ${TOKEN}`);
  assert.equal(e.hook, '4');
  assert.equal(e.body.result.length, 300);
  assert.doesNotMatch(e.body.result, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(e.body.result, /^Tests pass\. second line x+/);
  reset();
  await run('stop', { session_id: sid, last_assistant_message: long });
  assert.equal(results().length, 0, 'the same text is not sent twice');
  await run('stop', { session_id: sid, last_assistant_message: 'Merged into dev.' });
  assert.equal(results()[0].body.result, 'Merged into dev.');
});

test('stop: without last_assistant_message the main conversation\'s last text is used; subagent (sidechain) messages, compaction summaries and analysis blocks never are', async () => {
  const sid = 'l-res-2';
  lib.keepToken(sid, TOKEN);
  start(sid);
  fs.writeFileSync(transcript, [
    '{"type":"user"}' + NL,
    said('Built the session row; tests pass.'),
    said('I am an Opus builder subagent. Report: done.', { isSidechain: true }),
    said('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
    said('<summary>1. Primary request</summary>'),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
  ].join(''));
  reset();
  await run('stop', { session_id: sid });
  assert.equal(results()[0].body.result, 'Built the session row; tests pass.');
  reset();
  await run('stop', { session_id: sid, last_assistant_message: '<analysis> I am an Opus builder subagent...' });
  assert.equal(results().length, 0, 'an analysis message falls back to the transcript, whose text was sent already');
  assert.equal(stopMod.resultOf({ last_assistant_message: '<analysis> x', transcript_path: transcript }), 'Built the session row; tests pass.');
  assert.equal(stopMod.resultOf({ last_assistant_message: 'This session is being continued from a previous conversation. Summary...' }), '');
  fs.writeFileSync(transcript, '{"type":"user"}' + NL);
});

test('stop: no token, no text, no session id or a stop that answers a block sends no result', async () => {
  reset();
  start('l-res-3');
  await run('stop', { session_id: 'l-res-3', last_assistant_message: 'hello' });
  lib.keepToken('l-res-4', TOKEN);
  start('l-res-4');
  await run('stop', { session_id: 'l-res-4', last_assistant_message: ' \u0007 ' });
  await run('stop', { session_id: 'l-res-4', last_assistant_message: 'again', stop_hook_active: true });
  await run('stop', { last_assistant_message: 'hello' });
  assert.equal(results().length, 0);
});

test('subagent-start: the preface line comes before the short form; nothing without one', async () => {
  lib.writeMarker('l-start', { short: '* One home per fact.', shortV: 3 });
  const ctx = JSON.parse(await run('subagent-start', { session_id: 'l-start', agent_id: 'a1' })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^## Work OS Orders, short form \(v3; the full Orders are in your parent's brief\)\nYour parent records the State; never call save_state, import_state or end_work\.\n\* One home per fact\./);
  assert.equal(await run('subagent-start', { session_id: 'l-none' }), '');
});

test('stop: a session that holds Now (or has no holdsNow yet) gets today\'s text; a non-holder gets the lane text', async () => {
  assert.equal(stopMod.nagText({}), stopMod.NAG_HOLDER, 'holdsNow absent: holder, today\'s text (until Lanes step 1 sets it)');
  assert.equal(stopMod.nagText({ holdsNow: true }), stopMod.NAG_HOLDER);
  assert.match(stopMod.NAG_HOLDER, /^Files changed in this session and the State was not saved since\. Call save_state/);
  assert.equal(stopMod.nagText({ holdsNow: false }), 'Files changed and Work OS has not heard from this session since. Update your lane: set_doing or log_progress, or save_state with add_next / add_decision for anything new. Then finish. Asked once.');
  for (const [sid, holds, re] of [['l-stop-a', undefined, /Call save_state/], ['l-stop-b', false, /Update your lane/]]) {
    start(sid, holds === undefined ? {} : { holdsNow: holds });
    fs.writeFileSync(path.join(repo, `${sid}.txt`), 'x');
    assert.match(JSON.parse(await run('stop', { session_id: sid })).reason, re);
    fs.rmSync(path.join(repo, `${sid}.txt`));
  }
});

test('stop: a lane call in the transcript (log_progress, set_doing, hand_in, complete_task) counts as heard from, like a save, for holdsNow false; a read does not', async () => {
  for (const [i, tool] of ['log_progress', 'set_doing', 'hand_in', 'complete_task', 'save_state'].entries()) {
    const sid = `l-heard-${i}`;
    start(sid, { holdsNow: false });
    fs.writeFileSync(path.join(repo, `${sid}.txt`), 'x');
    fs.appendFileSync(transcript, toolUse(tool));
    assert.equal(await run('stop', { session_id: sid }), '', tool);
    fs.rmSync(path.join(repo, `${sid}.txt`));
  }
  start('l-heard-none', { holdsNow: false });
  fs.writeFileSync(path.join(repo, 'n.txt'), 'x');
  fs.appendFileSync(transcript, toolUse('get_state'));
  assert.equal(JSON.parse(await run('stop', { session_id: 'l-heard-none' })).decision, 'block', 'a read is not a save');
  fs.rmSync(path.join(repo, 'n.txt'));
});

test('post-tool: for a session with holdsNow false, lane calls mark the session saved (the next stop does not ask); an error answer, a subagent call, a holder (holdsNow true) or no holdsNow yet still gets asked', async () => {
  for (const [sid, input, asks, holds] of [
    ['l-post-a', { tool_name: 'mcp__work-os__log_progress', tool_response: JSON.stringify({ ok: true }) }, false, false],
    ['l-post-b', { tool_name: 'mcp__work-os__set_doing', tool_response: JSON.stringify({ doing: 12 }) }, false, false],
    ['l-post-c', { tool_name: 'mcp__work-os__complete_task', tool_response: JSON.stringify({ error: 'no such task' }) }, true, false],
    ['l-post-d', { tool_name: 'mcp__work-os__hand_in', tool_response: JSON.stringify({ ok: true }), agent_id: 'a1' }, true, false],
    ['l-post-e', { tool_name: 'mcp__work-os__log_progress', tool_response: JSON.stringify({ ok: true }) }, true, true],
    ['l-post-f', { tool_name: 'mcp__work-os__log_progress', tool_response: JSON.stringify({ ok: true }) }, true, undefined],
  ]) {
    start(sid, holds === undefined ? {} : { holdsNow: holds });
    fs.writeFileSync(path.join(repo, `${sid}.txt`), 'x');
    assert.equal(await run('post-tool', { session_id: sid, ...input }), '');
    const out = await run('stop', { session_id: sid });
    assert.equal(out ? JSON.parse(out).decision === 'block' : false, asks, sid);
    fs.rmSync(path.join(repo, `${sid}.txt`));
  }
});

test('post-tool (Lanes step 1): holdsNow from a save_state, end_work or get_state answer for this session and the marker’s project is kept in the marker; anything else leaves it', async () => {
  const ans = (o) => JSON.stringify(o);
  const sid = 'l-holds';
  lib.keepToken(sid, TOKEN);
  const W = createHash('sha256').update(TOKEN, 'utf8').digest('hex').slice(0, 32); // the Work OS session id of that token
  const post = (tool, o, extra = {}) => run('post-tool', { session_id: sid, tool_name: `mcp__work-os__${tool}`, tool_response: ans(o), ...extra });
  start(sid);
  await post('save_state', { saved: true, project: 'p1', version: 3, holdsNow: false, holdsNowFor: W });
  assert.equal(readMarker(sid).holdsNow, false, 'save_state: not the holder');
  await post('get_state', { project: 'p1', version: 3, holdsNow: true, holdsNowFor: W });
  assert.equal(readMarker(sid).holdsNow, true, 'get_state: the holder now');
  await post('end_work', { ended: true, project: 'p1', version: 4, holdsNow: false, holdsNowFor: W }, { agent_id: 'a1' });
  assert.equal(readMarker(sid).holdsNow, true, 'a subagent’s answer changes nothing');
  await post('get_state', { project: 'p2', version: 1, holdsNow: false, holdsNowFor: W });
  assert.equal(readMarker(sid).holdsNow, true, 'another project’s answer changes nothing');
  await post('save_state', { saved: true, project: 'p1', version: 4, holdsNow: false });
  assert.equal(readMarker(sid).holdsNow, true, 'an answer for no session (a call without session) changes nothing');
  await post('save_state', { saved: true, project: 'p1', version: 4, holdsNow: false, holdsNowFor: 'f'.repeat(32) });
  assert.equal(readMarker(sid).holdsNow, true, 'an answer for another session changes nothing');
  await post('save_state', { saved: true, project: 'p1', version: 4 });
  assert.equal(readMarker(sid).holdsNow, true, 'no holdsNow (an older server): kept');
  await post('end_work', { ended: true, project: 'p1', version: 5, holdsNow: false, holdsNowFor: W });
  assert.equal(readMarker(sid).holdsNow, false, 'end_work');
  // With holdsNow false from the server, a lane call now counts as heard from (Lanes step 3 reads it).
  fs.writeFileSync(path.join(repo, 'l-holds.txt'), 'x');
  await post('log_progress', { ok: true });
  assert.equal(await run('stop', { session_id: sid }), '');
  fs.rmSync(path.join(repo, 'l-holds.txt'));
});

// ---- Lanes step 6: the same-folder warning once, every session commits only WORK-STATE.md ----
const SAME = 'Another session works in this folder: "side lead" (working). Commits and the WORK-STATE.md copy collide; use a worktree.';
test('the brief prints the same-folder warning; the first prompt prints it once and not again', async () => {
  const brief = { project: { id: 'p1', name: 'Demo' }, session: 's6', orders: 'no Orders set', state: { now: { text: 'x' } }, sameFolder: { label: 'side lead', state: 'working' } };
  assert.match(dev.formatBrief(brief), /## Same folder[^]Another session works in this folder: "side lead" \(working\)\. Commits and the WORK-STATE\.md copy collide; use a worktree\./);
  assert.match(dev.formatBrief({ ...brief, sameFolder: { label: 'side lead', state: 'idle', more: 2 } }), /\(idle\) and 2 more\. Commits/);
  assert.doesNotMatch(dev.formatBrief({ ...brief, sameFolder: undefined }), /Same folder/);
  const sid = 'l-same';
  start(sid, { sameFolder: SAME });
  const first = JSON.parse(await run('user-prompt', { session_id: sid, prompt: 'hello' }));
  assert.equal(first.hookSpecificOutput.additionalContext, SAME);
  assert.equal(readMarker(sid).sameFolder, undefined, 'the marker drops it');
  assert.equal(await run('user-prompt', { session_id: sid, prompt: 'again' }), '', 'not printed again');
});

test('post-tool: every saving session commits WORK-STATE.md alone, whatever a server says about commit (no election); other staged files stay out', async () => {
  const repo2 = path.join(tmp, 'repo2');
  fs.mkdirSync(repo2);
  sh(repo2, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo2, 'a.txt'), '1');
  sh(repo2, 'add', '.');
  sh(repo2, 'commit', '-qm', 'init');
  const md = (v) => `Copy of the Work OS state, version ${v}. Edit it in Work OS (https://x/projects/p1); this file is its copy.${NL}${NL}# Work state: Demo${NL}${NL}## Now${NL}- ship ${v}${NL}`;
  const last = () => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo2, encoding: 'utf8' }).trim();
  const sid = 'l-commit';
  lib.keepToken(sid, TOKEN);
  start(sid, { project: 'Demo' });
  const post = () => dev.main('post-tool', JSON.stringify({ session_id: sid, cwd: repo2, tool_name: 'mcp__work-os__save_state', tool_input: {}, tool_response: JSON.stringify({ saved: true, project: 'Demo', version: 7 }) }));
  // a file another session staged must not ride along in the copy's commit
  fs.writeFileSync(path.join(repo2, 'other.txt'), 'staged by someone else');
  sh(repo2, 'add', 'other.txt');
  stateReply = { project: 'p1', version: 7, markdown: md(7), holdsNow: false, commit: false }; // an older server's commit:false is ignored
  assert.match(JSON.parse(await post()).hookSpecificOutput.additionalContext, /v7, committed/);
  assert.equal(last(), 'WORK-STATE.md: copy of the Work OS State v7');
  assert.equal(execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo2, encoding: 'utf8' }).trim(), 'WORK-STATE.md', 'path-limited commit');
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: repo2, encoding: 'utf8' }), /^A  other\.txt/m, 'the other staged file is still staged, not committed');
  stateReply = { project: 'p1', version: 8, markdown: md(8), holdsNow: true, commit: true };
  assert.match(JSON.parse(await post()).hookSpecificOutput.additionalContext, /v8, committed/);
  assert.equal(last(), 'WORK-STATE.md: copy of the Work OS State v8');
  stateReply = { project: 'p1', version: 9, markdown: md(9) }; // an older server says nothing: committed as before
  assert.match(JSON.parse(await post()).hookSpecificOutput.additionalContext, /v9, committed/);
  stateReply = null;
  fs.rmSync(repo2, { recursive: true, force: true });
});

test('stop: a marker with holdsNow unknown gets the holder text unless the server says the session does not hold Now (then the lane text, and the marker keeps false); a holder answer keeps the holder text', async () => {
  for (const [sid, reply, re, kept] of [['l-srv-a', { holdsNow: false }, /Update your lane/, false], ['l-srv-b', { holdsNow: true }, /Call save_state/, undefined], ['l-srv-c', {}, /Call save_state/, undefined]]) {
    eventReply = reply;
    seen.length = 0;
    start(sid, {});
    lib.keepToken(sid, TOKEN);
    fs.writeFileSync(path.join(repo, `${sid}.txt`), 'x');
    assert.match(JSON.parse(await run('stop', { session_id: sid })).reason, re);
    assert.equal(seen.find((x) => x.url === '/api/agent/event')?.body.holds, true, 'the hook asks whether it holds Now');
    assert.equal(lib.readMarker(sid).holdsNow, kept);
    fs.rmSync(path.join(repo, `${sid}.txt`));
  }
  eventReply = null;
});

test('stop: a session that shares its folder with another live session is not asked to save State for the files (hooks review 13)', async () => {
  const sid = 'l-shared';
  start(sid, { sharedFolder: true });
  fs.writeFileSync(path.join(repo, `${sid}.txt`), 'x');
  try {
    assert.equal(await run('stop', { session_id: sid }), '', 'no block: the changes may be the other session\'s');
    start('l-alone');
    fs.writeFileSync(path.join(repo, 'l-alone.txt'), 'x');
    assert.equal(JSON.parse(await run('stop', { session_id: 'l-alone' })).decision, 'block', 'a session alone in its folder is still asked');
  } finally {
    fs.rmSync(path.join(repo, `${sid}.txt`), { force: true });
    fs.rmSync(path.join(repo, 'l-alone.txt'), { force: true });
  }
});
