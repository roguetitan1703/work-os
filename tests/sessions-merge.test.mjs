// mergeSessions unit tests (lib/session-item.ts): the roster and the computer's own list make one list of sessions.
// Run: node --test --experimental-strip-types tests/sessions-merge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessions } from '../lib/session-item.ts';

const now = Date.parse('2026-11-20T10:00:00Z');
const iso = min => new Date(now - min * 60_000).toISOString();
const tz = 'Asia/Kolkata';

const worker = (id, x = {}) => ({ id, session: id, person: 'Om', mine: true, ai: 'Claude Code', tool: '', model: '', account: '', machine: 'Om-PC', project: { id: 'p1', name: 'Alpha' }, branch: '', label: id, slot: '', doing: null, state: 'working', since: iso(1), nextWork: 0, lastSeen: iso(1), depth: 0, ...x });
const row = (key, x = {}) => ({ key, title: key, deviceId: 'd1', folder: 'f', projectId: 'p1', projectName: 'Alpha', deviceName: 'Om-PC', state: 'working', live: true, subagents: 0, lastActiveAt: iso(1), workOs: false, canVscode: true, canStop: false, canResume: false, canRemove: false, ...x });

test('a session in both lists is one row, with the controls of the computer list', () => {
  const v = mergeSessions([worker('w1', { cc: 's1' })], [row('d1:s1'), row('d1:s2')], { tz, now });
  assert.equal(v.live.length, 2);
  const one = v.live.find(i => i.id === 'w1');
  assert.equal(one.control.key, 'd1:s1');
  assert.ok(v.live.find(i => i.id === 'd1:s2'));
});

test('live first by state, then ended today under finished, older under earlier', () => {
  const v = mergeSessions(
    [worker('idle', { state: 'idle', lastSeen: iso(20) }), worker('work'), worker('gone', { state: 'off', lastSeen: iso(30) }), worker('old', { state: 'off', lastSeen: iso(60 * 20) })],
    [],
    { tz, now },
  );
  assert.deepEqual(v.live.map(i => i.id), ['work', 'idle']);
  assert.deepEqual(v.finished.map(i => i.id), ['gone']);
  assert.deepEqual(v.earlier.map(i => i.id), ['old']);
  assert.deepEqual(v.counts, { live: 2, working: 1, waiting: 0, finished: 1 });
});

test('a builder stays under its orchestrator while the group is live, even when off', () => {
  const v = mergeSessions([worker('orch'), worker('b1', { depth: 1, state: 'off' })], [], { tz, now });
  assert.deepEqual(v.live.map(i => [i.id, i.depth]), [['orch', 0], ['b1', 1]]);
  assert.equal(v.finished.length, 0);
});

test('a project page keeps only that project of the computer list', () => {
  const v = mergeSessions([], [row('d1:a'), row('d1:b', { projectId: 'p2' })], { tz, now, projectId: 'p1' });
  assert.deepEqual(v.live.map(i => i.id), ['d1:a']);
});

test('state words: waiting on your prompt, a closed row is off, a trust prompt says so', () => {
  const v = mergeSessions([worker('w', { state: 'waiting', waitingOn: 'prompt' })], [row('d1:c', { state: 'closed', live: false, lastActiveAt: iso(5) }), row('d1:t', { state: 'starting', needsTrust: true })], { tz, now });
  assert.equal(v.live.find(i => i.id === 'w').word, 'Waiting on you');
  assert.equal(v.finished.find(i => i.id === 'd1:c').state, 'off');
  assert.match(v.live.find(i => i.id === 'd1:t').word, /trust this new repo on Om-PC/);
});

test('three rows of one Claude session with the daemon reporting subagents: exactly one Working', () => {
  const idle = id => worker(id, { cc: 's1', state: 'idle', subagents: 0 });
  const v = mergeSessions([idle('a'), idle('b'), worker('c', { cc: 's1', state: 'idle', subagents: 2 })], [row('d1:s1', { subagents: 2 })], { tz, now });
  assert.equal(v.live.filter(i => i.state === 'working').length, 1);
  assert.equal(v.live.find(i => i.id === 'a').subagents, 2);
  assert.equal(v.live.find(i => i.id === 'b').subagents, 0);
  assert.equal(v.live.find(i => i.id === 'c').subagents, 0);
});
