// presenceState unit tests (lib/data/presence-state.ts): an open working row (a Bash or PowerShell call began) stays working.
// Run: node --test --experimental-strip-types tests/presence-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceState, claimDaemon, eventState } from '../lib/data/presence-state.ts';

const now = Date.now();
const ago = (min) => new Date(now - min * 60_000);
const row = (activityAgo, extra = {}, lastSeenAgo = activityAgo) => ({ lastSeen: ago(lastSeenAgo), activity: { state: 'working', at: ago(activityAgo), ...extra } });

test('tool-start is a working event', () => {
  assert.deepEqual(eventState({ event: 'tool-start' }), { state: 'working' });
});

test('an open working row stays working at 15 minutes, with or without the daemon', () => {
  assert.equal(presenceState(row(15, { open: true }), { now }).state, 'working');
  assert.equal(presenceState(row(15, { open: true }), { now, daemon: 'running' }).state, 'working');
});

test('without open the old rule holds: idle at 15 minutes', () => {
  assert.equal(presenceState(row(15), { now }).state, 'idle');
});

test('an open row at 3 hours with no daemon evidence falls back to the normal rules (off, nothing heard for 30 minutes)', () => {
  assert.equal(presenceState(row(180, { open: true }), { now }).state, 'off');
  assert.equal(presenceState(row(180, { open: true }), { now, daemon: 'unknown' }).state, 'off');
});

test('an open row at 3 hours with something heard lately falls back to idle', () => {
  assert.equal(presenceState(row(180, { open: true }, 5), { now }).state, 'idle');
});

test('an open row at 3 hours with the daemon running is idle, not working for ever (hooks review H2)', () => {
  assert.equal(presenceState(row(180, { open: true }), { now, daemon: 'running' }).state, 'idle');
  assert.equal(presenceState(row(100, { open: true }), { now, daemon: 'running' }).state, 'working');
});

test('the daemon saying stopped, or an ended row, is off at once even when open', () => {
  assert.equal(presenceState(row(15, { open: true }), { now, daemon: 'stopped' }).state, 'off');
  assert.equal(presenceState({ ...row(15, { open: true }), endedAt: ago(1) }, { now }).state, 'off');
});

test('a later stop (activity replaced, no open) is idle again', () => {
  const r = { lastSeen: ago(14), activity: { state: 'idle', at: ago(14) } };
  assert.equal(presenceState(r, { now }).state, 'idle');
});

test('waiting rules are unchanged by open', () => {
  const r = { lastSeen: ago(15), activity: { state: 'waiting', at: ago(15), why: 'prompt', open: true } };
  assert.equal(presenceState(r, { now }).state, 'waiting');
});

test('a hook 3 row with no activity is idle, even seen a minute ago or with the daemon running; hook 2 keeps the call-based rule', () => {
  const bare = (h) => ({ lastSeen: ago(1), ...(h === undefined ? {} : { hook: h }) });
  assert.equal(presenceState(bare(3), { hookIdle: true, now }).state, 'idle');
  assert.equal(presenceState(bare(4), { hookIdle: true, now, daemon: 'running' }).state, 'idle');
  assert.equal(presenceState(bare(2), { hookIdle: true, now }).state, 'working');
  assert.equal(presenceState(bare(), { hookIdle: true, now }).state, 'working');
  assert.equal(presenceState(bare(3), { hookIdle: true, now, needs: true }).state, 'waiting');
  assert.equal(presenceState({ lastSeen: ago(40), hook: 3 }, { hookIdle: true, now }).state, 'off');
  assert.equal(presenceState({ lastSeen: ago(40), hook: 3 }, { hookIdle: true, now, daemon: 'running' }).state, 'idle');
});

test('without hookIdle a hook 3 row with no activity keeps the call-based rule (busy() and other callers)', () => {
  assert.equal(presenceState({ lastSeen: ago(1), hook: 3 }, { now }).state, 'working');
});

// claimDaemon: the 'taken' logic of loadRaw (D1).
const crow = (id, x = {}) => ({ _id: id, machine: 'm1', ccSession: 's1', lastSeen: ago(1), projectId: 'p1', ...x });
const says = (v = 'running') => new Map([['m1:s1', v]]);
const subs = new Map([['m1:s1', 2]]);

test('claimDaemon: only the newest open row gets running and the subagents', () => {
  const rows = [crow('new'), crow('old', { lastSeen: ago(5) })];
  const out = claimDaemon(rows, rows, says(), subs);
  assert.deepEqual(out.map(o => [o.row._id, o.daemon, o.subagents]), [['new', 'running', 2], ['old', 'unknown', 0]]);
});

test('claimDaemon: an older open row with no activity for 30 minutes goes off', () => {
  const rows = [crow('new', { hook: 3 }), crow('old', { lastSeen: ago(31), hook: 3 })];
  const out = claimDaemon(rows, rows, says(), subs);
  assert.equal(presenceState(out[1].row, { now, daemon: out[1].daemon, hookIdle: true }).state, 'off');
  assert.equal(presenceState(out[0].row, { now, daemon: out[0].daemon, hookIdle: true }).state, 'idle');
});

test('claimDaemon: stopped still ends every row; an ended row never takes the claim', () => {
  const rows = [crow('new'), crow('old', { lastSeen: ago(5) })];
  const out = claimDaemon(rows, rows, says('stopped'), subs);
  assert.deepEqual(out.map(o => o.daemon), ['stopped', 'stopped']);
  assert.ok(out.every(o => presenceState(o.row, { now, daemon: o.daemon }).state === 'off'));
  const ended = [crow('e', { endedAt: ago(0) }), crow('o', { lastSeen: ago(5) })];
  assert.equal(claimDaemon(ended, ended, says(), subs)[1].daemon, 'running');
});

test('claimDaemon: a project page keeps the owner across projects; a session that moved loses running on the old page', () => {
  const moved = crow('q', { projectId: 'p2' });
  const here = crow('p', { lastSeen: ago(5) });
  const out = claimDaemon([moved, here], [here], says(), subs); // the page of p1 shows only the old row
  assert.deepEqual([out[0].daemon, out[0].subagents], ['unknown', 0]);
  // the owner is in a project the viewer cannot read: the visible older row still loses running
  assert.equal(claimDaemon([moved, here], [here], says(), subs)[0].daemon, 'unknown');
  // only row visible and owner: keeps it
  assert.equal(claimDaemon([here], [here], says(), subs)[0].daemon, 'running');
});

test('claimDaemon: a different user newer row with the same key never takes the claim', () => {
  const mine = crow('mine', { userId: 'u1', lastSeen: ago(5) });
  const theirs = crow('theirs', { userId: 'u2' });
  const out = claimDaemon([theirs, mine], [mine], says(), subs);
  assert.deepEqual([out[0].daemon, out[0].subagents], ['running', 2]);
});
