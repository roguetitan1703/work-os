// H9 hook side: Orders versions. The version in the brief's Orders heading, the "Orders changed" section right after the
// Orders, and (later steps) the delivery of changes and the subagent short form. No server: formatBrief gets a brief as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h9-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
const { formatBrief } = await import('../hook.mjs');

const base = { project: { id: 'p1', name: 'Demo' }, session: 's-1', state: { now: { text: 'x' } }, stateVersion: 2 };

test('formatBrief: the Orders heading carries the page version', () => {
  const b = formatBrief({ ...base, orders: [{ layer: 'organisation', title: 'Delpat Orders', version: 14, text: 'Rule one.' }, { layer: 'project', title: 'P rules', version: 1, text: 'Two.', writtenBy: 'Akash' }] });
  assert.match(b, /## Orders \(organisation: Delpat Orders, v14\)\nRule one\./);
  assert.match(b, /## Orders \(project: P rules, v1, writtenBy Akash\)/);
  const old = formatBrief({ ...base, orders: [{ layer: 'organisation', title: 'Delpat Orders', text: 'Rule one.' }] });
  assert.match(old, /## Orders \(organisation: Delpat Orders\)\n/, 'an older server sends no version: the heading stays as it was');
});

test('formatBrief: "Orders changed" sits right after the Orders, with who, why and the lines out and in', () => {
  const b = formatBrief({
    ...base,
    orders: [{ layer: 'organisation', title: 'Delpat Orders', version: 14, text: 'Rule one.' }],
    ordersChanged: [
      { layer: 'organisation', title: 'Delpat Orders', version: 14, at: new Date(2026, 10, 19, 10, 42).toISOString(), by: 'me', session: 'Work OS · lead', why: 'Om 19 Nov: merging to dev needs no ask', removed: ['Ask Om before merging'], added: ['Merge to dev without asking'], noteId: 'n1', own: true },
      { layer: 'project', title: 'P rules', version: 3, at: new Date().toISOString(), by: 'claude', removed: [], added: ['A line'], noteId: 'n2', writtenBy: 'Akash' },
    ],
  });
  assert.ok(b.indexOf('## Orders (') < b.indexOf('## Orders changed') && b.indexOf('## Orders changed') < b.indexOf('## State'));
  assert.match(b, /- organisation v14 "Delpat Orders" by me \(Work OS · lead\), 10:42; why: Om 19 Nov: merging to dev needs no ask; undo in the app: Orders page, Changes\n  - Ask Om before merging\n  \+ Merge to dev without asking/);
  assert.match(b, /- project v3 "P rules" by claude.*writtenBy Akash/);
  assert.doesNotMatch(b.split('## Orders changed')[1].split('\n\n')[0].split('project v3')[1], /undo in the app/, 'no undo hint on a change that is not the holder\'s own');
  assert.match(b, /These are your rules from now on\./);
});

test('formatBrief: no section without changes, and it stays inside 1,200 characters', () => {
  assert.doesNotMatch(formatBrief({ ...base, orders: 'no Orders set' }), /Orders changed/);
  const many = Array.from({ length: 5 }, (_, i) => ({ layer: 'organisation', title: 'T', version: 20 + i, at: new Date().toISOString(), by: 'claude', removed: Array.from({ length: 6 }, (_, j) => 'r'.repeat(190) + j), added: Array.from({ length: 6 }, (_, j) => 'a'.repeat(190) + j), noteId: 'n' }));
  const b = formatBrief({ ...base, orders: [{ layer: 'organisation', title: 'T', version: 24, text: 'x' }], ordersChanged: many });
  const sec = b.split('## Orders changed\n')[1].split('\n\n')[0];
  assert.ok(sec.length <= 1200 + 60, `section is ${sec.length}`);
});

// ---- step 4: changes handed into running sessions ----
const lib = await import('../hook-lib.mjs');

test('keepAck: the ids to acknowledge include the Orders versions handed over', () => {
  lib.writeMarker('h9-ack', { status: 'x' });
  lib.keepAck('h9-ack', { status: 200, b: { deliver: { text: 't', ids: ['m_1'], needs: ['n_1'], orders: ['ord:abc:8'] } } });
  assert.deepEqual(lib.readMarker('h9-ack').ack, ['m_1', 'n_1', 'ord:abc:8']);
  lib.writeMarker('h9-ack2', { status: 'x' });
  lib.keepAck('h9-ack2', { status: 200, b: { deliver: { text: 't', ids: [], needs: [], orders: ['ord:abc:9'] } } });
  assert.deepEqual(lib.readMarker('h9-ack2').ack, ['ord:abc:9'], 'an Orders-only delivery is acknowledged too');
});

test('deliverOut: the short form of a changed organization Orders replaces the one kept at the start', () => {
  lib.writeMarker('h9-short', { status: 'x', short: 'old line' });
  const out = lib.deliverOut('PostToolBatch', { status: 200, b: { deliver: { text: 'Work OS: changed', ids: [], needs: [], orders: ['ord:a:2'], short: 'Rule one.\nRule two.' } } }, 'h9-short');
  assert.equal(out.hookSpecificOutput.additionalContext, 'Work OS: changed');
  assert.equal(lib.readMarker('h9-short').short, 'Rule one.\nRule two.');
  assert.deepEqual(lib.readMarker('h9-short').ack, ['ord:a:2']);
  lib.deliverOut('PostToolBatch', { status: 200, b: { deliver: { text: 'again', ids: [], needs: [], orders: ['ord:a:3'], short: '' } } }, 'h9-short');
  assert.equal(lib.readMarker('h9-short').short, undefined, 'an empty short form removes it');
  lib.writeMarker('h9-keep', { status: 'x', short: 'kept' });
  lib.deliverOut('PostToolBatch', { status: 200, b: { deliver: { text: 'msg only', ids: ['m_1'], needs: [], orders: [] } } }, 'h9-keep');
  assert.equal(lib.readMarker('h9-keep').short, 'kept', 'a delivery without Orders leaves the short form alone');
  assert.equal(lib.deliverOut('PostToolBatch', { status: 200, b: {} }, 'h9-keep'), null);
});

// ---- step 7: the subagent short form ----
test('subagent-start: prints the marker short form with its version, and nothing without one', async () => {
  const { main } = await import('../hook.mjs');
  lib.writeMarker('h9-sub', { status: 'x', short: 'Rule one.\nRule two.', shortV: 14 });
  const out = JSON.parse(await main('subagent-start', JSON.stringify({ session_id: 'h9-sub', agent_id: 'a1', agent_type: 'Explore', hook_event_name: 'SubagentStart' })));
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.equal(out.hookSpecificOutput.additionalContext, "## Work OS Orders, short form (v14; the full Orders are in your parent's brief)\nYour parent records the State; never call save_state, import_state or end_work.\nRule one.\nRule two.");
  lib.writeMarker('h9-sub2', { status: 'x', short: 'Only.' });
  assert.match(JSON.parse(await main('subagent-start', JSON.stringify({ session_id: 'h9-sub2' }))).hookSpecificOutput.additionalContext, /^## Work OS Orders, short form \(the full Orders/, 'no version known: the heading says so by leaving it out');
  lib.writeMarker('h9-none', { status: 'x' });
  assert.equal(await main('subagent-start', JSON.stringify({ session_id: 'h9-none' })), '');
  assert.equal(await main('subagent-start', JSON.stringify({ session_id: 'h9-never-started' })), '');
  assert.equal(await main('subagent-start', '{}'), '');
  assert.equal(await main('subagent-start', 'not json'), '');
});

test('subagent-start: reads the marker only (no key, no token, no network) and is in EVENTS for cloud too', async () => {
  const { EVENTS } = lib;
  const row = EVENTS.find((e) => e.event === 'subagent-start');
  assert.deepEqual({ claudeEvent: row.claudeEvent, matcher: row.matcher, timeoutS: row.timeoutS, local: !!row.localOnly }, { claudeEvent: 'SubagentStart', matcher: null, timeoutS: 2, local: false });
  const src = fs.readFileSync(new URL('../hook-subagent-start.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /fetch|postAgent|postEvent|mcpCall|http/i);
});

test('the session start stores the short form and its version in the marker', async () => {
  const start = await import('../hook-session-start.mjs');
  assert.equal(typeof start.formatBrief, 'function');
  const src = fs.readFileSync(new URL('../hook-session-start.mjs', import.meta.url), 'utf8');
  assert.match(src, /short: r\.shortOrders\.slice\(0, 1200\)/);
  assert.match(src, /shortV: r\.shortOrdersVersion/);
});

test('deliverOut keeps the version of the new short form with it', () => {
  lib.writeMarker('h9-v', { status: 'x', short: 'old', shortV: 3 });
  lib.deliverOut('PostToolBatch', { status: 200, b: { deliver: { text: 't', ids: [], needs: [], orders: ['ord:a:5'], short: 'new line', shortV: 5 } } }, 'h9-v');
  assert.deepEqual([lib.readMarker('h9-v').short, lib.readMarker('h9-v').shortV], ['new line', 5]);
});
