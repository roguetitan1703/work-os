// H9 hardening: a run the task dispatcher started shares the person's key, so the server cannot tell it from an interactive
// session by what it sends. The worker puts WORK_OS_DISPATCHED=<task ref> in that run's environment and the PreToolUse hook
// refuses Orders edits there: write_note and apply_changes on a note id the brief named as Orders, and propose_order outright.
// Everything else passes (fail closed for those ids only). No server: the marker is written the way SessionStart writes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-disp-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.WORK_OS_DISPATCHED;
const lib = await import('../hook-lib.mjs');
const pre = await import('../hook-pre-tool.mjs');
const launch = await import('../launch.mjs');
const { macScript } = await import('../quote.mjs');
const { EVENTS } = lib;

const ORDERS = ['ordersOrg01', 'ordersProj2', 'ordersMe003'];
const mark = (sid, orders = ORDERS) => lib.writeMarker(sid, { status: 's', offset: 0, stopped: false, project: 'Demo', ...(orders ? { orders } : {}) });
const env = { WORK_OS_DISPATCHED: '290' };
const call = (tool_name, tool_input, session_id = 'd1') => ({ tool_name, tool_input, session_id });
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('the pre-tool hook matcher covers the Work OS tools that can change Orders, beside the file tools', () => {
  const row = EVENTS.find((e) => e.event === 'pre-tool');
  const re = new RegExp('^(?:' + row.matcher + ')$');
  for (const n of ['Edit', 'Write', 'Bash', 'PowerShell', 'mcp__work-os__write_note', 'mcp__plugin_x_work-os__propose_order', 'mcp__work-os__apply_changes', 'Read', 'Grep', 'Glob']) assert.ok(re.test(n), n);
  for (const n of ['mcp__work-os__read_note', 'mcp__work-os__start_work', 'WebFetch']) assert.ok(!re.test(n), n);
});

test('dispatched run: write_note on an Orders note id is refused, on any other note it passes', () => {
  mark('d1');
  const r = pre.ordersDeny(call('mcp__work-os__write_note', { note_id: 'ordersProj2', append: 'x' }), env);
  assert.ok(denied(r), JSON.stringify(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /dispatched run does not change Orders/);
  assert.equal(pre.ordersDeny(call('mcp__work-os__write_note', { note_id: 'someOtherNote', append: 'x' }), env), null);
  assert.equal(pre.ordersDeny(call('mcp__work-os__write_note', { task: 12, body: 'x' }), env), null, 'a task\'s own note is not Orders');
});

test('dispatched run: apply_changes that touches an Orders note id is refused, one that does not passes', () => {
  mark('d1');
  assert.ok(denied(pre.ordersDeny(call('mcp__work-os__apply_changes', { ops: [{ op: 'update_note', note_id: 'ordersOrg01', body: 'x' }] }), env)));
  assert.equal(pre.ordersDeny(call('mcp__work-os__apply_changes', { ops: [{ op: 'update_note', note_id: 'plainNote99', body: 'x' }] }), env), null);
});

test('dispatched run: propose_order is refused outright (it always targets Orders)', () => {
  mark('d1', null);
  assert.ok(denied(pre.ordersDeny(call('mcp__work-os__propose_order', { project: 'p', layer: 'project', new: 'A rule', why: 'x' }), env)));
});

test('not a dispatched run (no variable, or a value that is not a task ref): nothing is refused', () => {
  mark('d1');
  const c = call('mcp__work-os__write_note', { note_id: 'ordersOrg01', append: 'x' });
  assert.equal(pre.ordersDeny(c, {}), null);
  for (const v of ['', 'yes', '0x1', '12; rm', '-1']) assert.equal(pre.ordersDeny(c, { WORK_OS_DISPATCHED: v }), null, v);
  assert.equal(pre.ordersDeny(call('mcp__work-os__propose_order', { project: 'p' }), {}), null);
});

test('fails closed only for the Orders ids: no marker, no Orders ids in it, or another tool passes', () => {
  assert.equal(pre.ordersDeny(call('mcp__work-os__write_note', { note_id: 'ordersOrg01' }, 'no-such-session'), env), null, 'no marker: nothing known to refuse');
  mark('d2', null);
  assert.equal(pre.ordersDeny(call('mcp__work-os__write_note', { note_id: 'ordersOrg01' }, 'd2'), env), null, 'a marker without Orders ids');
  mark('d1');
  assert.equal(pre.ordersDeny(call('mcp__work-os__read_note', { note_id: 'ordersOrg01' }), env), null, 'reading is fine');
  assert.equal(pre.ordersDeny(call('Edit', { file_path: 'x', old_string: 'ordersOrg01', new_string: 'y' }), env), null, 'an Edit of a file is not an Orders edit');
  assert.equal(pre.ordersDeny({ tool_name: 'mcp__work-os__write_note', tool_input: null }, env), null, 'garbage input does not throw');
});

test('preTool and the timeout answer use it (process.env, as the real hook runs)', async () => {
  mark('d1');
  process.env.WORK_OS_DISPATCHED = '290';
  try {
    assert.ok(denied(await pre.preTool(call('mcp__work-os__write_note', { note_id: 'ordersMe003', append: 'x' }))));
    assert.ok(denied(pre.timeoutAnswer(JSON.stringify(call('mcp__work-os__write_note', { note_id: 'ordersMe003' })))), 'a hook out of time still refuses it');
    assert.equal(await pre.preTool(call('mcp__work-os__write_note', { note_id: 'aNote123' })), null);
  } finally { delete process.env.WORK_OS_DISPATCHED; }
  assert.equal(await pre.preTool(call('mcp__work-os__write_note', { note_id: 'ordersMe003', append: 'x' })), null, 'the same call from the person\'s own session passes');
});

test('SessionStart keeps the brief\'s Orders note ids in the marker (only well-formed ids)', async () => {
  const { sessionStart } = await import('../hook-session-start.mjs');
  assert.equal(typeof sessionStart, 'function');
  // briefMarker is internal: drive it through the module's own cloud path with a stub fetch
  const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: [{ layer: 'organisation', title: 'O', version: 1, text: 't', noteId: 'ordersOrg01' }, { layer: 'project', title: 'P', text: 't', noteId: 'bad id!' }, { layer: 'person', title: 'M', text: 't', noteId: 'ordersMe003' }], state: { now: { text: 'x' } }, stateVersion: 1 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(brief) }], isError: false } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  process.env.WORK_OS_KEY = 'wos_' + 'k'.repeat(40);
  process.env.WORK_OS_URL = 'http://127.0.0.1:9';
  try {
    const out = await sessionStart({ session_id: 'ds1', cwd: tmp, transcript_path: path.join(tmp, 't.jsonl') });
    assert.ok(out, 'a brief was shown');
    assert.deepEqual(lib.readMarker('ds1').orders, ['ordersOrg01', 'ordersMe003']);
  } finally { globalThis.fetch = realFetch; delete process.env.WORK_OS_KEY; delete process.env.WORK_OS_URL; }
});

test('the worker passes the task ref on: the wrapper argument, the macOS script, and the wrapper sets (and never inherits) the variable', () => {
  assert.deepEqual(launch.dispatchedArg(290), ['--work-os-dispatched=290']);
  assert.deepEqual(launch.dispatchedArg(null), []);
  assert.deepEqual(launch.dispatchedArg('290; calc'), []);
  assert.deepEqual(launch.dispatchedArg(0), []);
  const plain = launch.windowsWtArgs('C:/f', 'T', 'C:/claude.exe', ['--session-id', 'x']);
  const disp = launch.windowsWtArgs('C:/f', 'T', 'C:/claude.exe', ['--session-id', 'x'], 'node', 'wrap.mjs', 290);
  assert.ok(!plain.some((a) => /dispatched/.test(a)), 'an ordinary start has no marker');
  assert.deepEqual(disp.slice(disp.indexOf('wrap.mjs')), ['wrap.mjs', '--work-os-dispatched=290', 'C:/claude.exe', '--session-id', 'x']);
  assert.match(macScript('/f', '/c/claude', ['a'], 290), /&& WORK_OS_DISPATCHED=290 '\/c\/claude'/);
  assert.ok(!/WORK_OS_DISPATCHED/.test(macScript('/f', '/c/claude', ['a'])));
  // the wrapper itself: a fake "claude" prints what it sees
  const wrapper = fileURLToPath(new URL('../run-claude.mjs', import.meta.url));
  const probe = path.join(tmp, 'probe.mjs');
  fs.writeFileSync(probe, 'console.log("D=" + (process.env.WORK_OS_DISPATCHED ?? "none"));');
  const run = (args, e = {}) => spawnSync(process.execPath, [wrapper, ...args], { env: { ...process.env, ...e }, encoding: 'utf8' }).stdout;
  // claudePath is the node binary here and the probe script its first argument
  assert.match(run(['--work-os-dispatched=290', process.execPath, probe]), /D=290/);
  assert.match(run([process.execPath, probe]), /D=none/);
  assert.match(run([process.execPath, probe], { WORK_OS_DISPATCHED: '55' }), /D=none/, 'a value in the terminal\'s environment is not passed on');
});

test('the server hands the task ref to the worker in the job, and the core passes it to the launcher', async () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../core.mjs', import.meta.url)), 'utf8');
  assert.match(src, /dispatched: Number\.isInteger\(job\.dispatched\) \? job\.dispatched : undefined/);
  const clone = fs.readFileSync(fileURLToPath(new URL('../clone.mjs', import.meta.url)), 'utf8');
  assert.match(clone, /dispatched: Number\.isInteger\(job\.dispatched\)/);
});

test('H15: the server mark in the session marker counts like the variable (a resumed run with no variable stays refused); a bad or missing mark does not', async () => {
  const marked = (sid, d) => lib.writeMarker(sid, { status: 's', offset: 0, stopped: false, project: 'Demo', orders: ORDERS, ...(d === undefined ? {} : { dispatched: d }) });
  const c = (sid) => call('mcp__work-os__write_note', { note_id: 'ordersProj2', append: 'x' }, sid);
  marked('m1', 301);
  assert.ok(denied(pre.ordersDeny(c('m1'), {})), 'marker only, no variable: refused');
  assert.ok(denied(pre.ordersDeny(call('mcp__work-os__propose_order', { project: 'p' }, 'm1'), {})));
  assert.ok(denied(await pre.preTool(c('m1'))), 'preTool reads the marker too');
  assert.ok(pre.isDispatched({ session_id: 'm1' }, {}));
  for (const [sid, d] of [['m2', undefined], ['m3', 0], ['m4', '301'], ['m5', -4], ['m6', 1.5], ['m7', true]]) {
    marked(sid, d);
    assert.equal(pre.ordersDeny(c(sid), {}), null, 'mark ' + String(d));
  }
  assert.equal(pre.ordersDeny(c('no-marker'), {}), null);
  assert.equal(pre.isDispatched({}, {}), false, 'no session id');
  // a run that deletes its own marker is accepted (the mark only adds refusals); with the variable it is still refused
  fs.rmSync(path.join(process.env.WORK_OS_HOOK_DIR), { recursive: true, force: true });
  assert.equal(pre.ordersDeny(c('m1'), {}), null);
  marked('m8', 301);
  assert.ok(denied(pre.ordersDeny(c('m8'), env)));
});

test('cleanup', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
