// presenceState unit tests (lib/data/presence-state.ts): an open working row (a Bash or PowerShell call began) stays working.
// Run: node --test --experimental-strip-types tests/presence-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceState, eventState } from '../lib/data/presence-state.ts';

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
  assert.equal(presenceState(bare(3), { now }).state, 'idle');
  assert.equal(presenceState(bare(4), { now, daemon: 'running' }).state, 'idle');
  assert.equal(presenceState(bare(2), { now }).state, 'working');
  assert.equal(presenceState(bare(), { now }).state, 'working');
  assert.equal(presenceState(bare(3), { now, needs: true }).state, 'waiting');
  assert.equal(presenceState({ lastSeen: ago(40), hook: 3 }, { now }).state, 'off');
  assert.equal(presenceState({ lastSeen: ago(40), hook: 3 }, { now, daemon: 'running' }).state, 'idle');
});
