// Session state on the Sessions list (Om, 21 Nov): On is Idle, Last active, Quiet, a lead with running subagents, the filter.
// Run: node --test --experimental-strip-types tests/session-quiet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceState, lastActive, isQuiet } from '../lib/data/presence-state.ts';
import { mergeSessions, filterSessions, badgeOf, DEFAULT_FILTER } from '../lib/session-item.ts';

const now = Date.parse('2026-11-21T10:00:00Z');
const ago = min => new Date(now - min * 60_000);
const iso = min => ago(min).toISOString();
const tz = 'Asia/Kolkata';

test('a started session with no prompt yet is idle, not on', () => {
  assert.equal(presenceState({ lastSeen: ago(1), activity: { state: 'on', at: ago(1) } }, { now }).state, 'idle');
});

test('last active: activeAt, else the last prompt or a working event; the idle wait (lastSeen) and a resume (activity on) do not count', () => {
  const resumed = { lastSeen: ago(0), activity: { state: 'on', at: ago(1) }, promptAt: ago(2 * 24 * 60) };
  assert.equal(lastActive(resumed).getTime(), ago(2 * 24 * 60).getTime());
  assert.equal(isQuiet('idle', resumed, now), true);
  const fresh = { lastSeen: ago(0), activity: { state: 'on', at: ago(1) }, activeAt: ago(1) };
  assert.equal(isQuiet('idle', fresh, now), false);
  const turnEnd = { lastSeen: ago(0), activity: { state: 'idle', at: ago(1) }, activeAt: ago(90) };
  assert.equal(isQuiet('idle', turnEnd, now), false);
  assert.equal(isQuiet('idle', { ...turnEnd, activeAt: ago(121) }, now), true);
  assert.equal(isQuiet('waiting', { ...turnEnd, activeAt: ago(500) }, now), false, 'waiting is never quiet');
  // A row with no hook (claude.ai chat): every call is activity.
  assert.equal(lastActive({ lastSeen: ago(3) }).getTime(), ago(3).getTime());
});

const worker = (id, x = {}) => ({ id, session: id, person: 'Om', mine: true, ai: 'Claude Code', tool: '', model: '', account: '', machine: 'Om-PC', project: { id: 'p1', name: 'Alpha' }, branch: '', label: id, slot: '', doing: null, state: 'idle', since: iso(30), nextWork: 0, lastSeen: iso(0), lastActive: iso(30), quiet: false, subagents: 0, depth: 0, ...x });

test('an idle lead whose subagents run reads "Working · 3 subagents" with no since', () => {
  const v = mergeSessions([worker('lead', { subagents: 3 })], [], { tz, now });
  const it = v.live[0];
  assert.equal(it.state, 'working');
  assert.equal(it.word, 'Working · 3 subagents');
  assert.equal(it.since, undefined);
  assert.equal(badgeOf(it.state, it.word), 'Working');
});

test('a quiet session reads Quiet, sorts after idle and is out of the default filter', () => {
  const v = mergeSessions([worker('old', { quiet: true, lastActive: iso(2 * 24 * 60) }), worker('now')], [], { tz, now });
  assert.deepEqual(v.live.map(i => [i.id, i.state, i.word]), [['now', 'idle', 'Idle'], ['old', 'quiet', 'Quiet']]);
  assert.equal(v.live[1].since, undefined);
  assert.equal(v.counts.live, 1, 'a quiet session is not counted live');
  const f = filterSessions(v, DEFAULT_FILTER);
  assert.deepEqual(f.live.map(i => i.id), ['now']);
  assert.deepEqual(f.more, { everyone: 0, quiet: 1 });
  assert.deepEqual(filterSessions(v, { everyone: false, quiet: true }).live.map(i => i.id), ['now', 'old']);
});

test("the default filter shows only the viewer's own sessions; Everyone adds teammates'; a linked session stays", () => {
  const v = mergeSessions([worker('mine'), worker('akash', { mine: false, person: 'Akash Patel', state: 'working' })], [], { tz, now });
  const f = filterSessions(v, DEFAULT_FILTER);
  assert.deepEqual(f.live.map(i => i.id), ['mine']);
  assert.deepEqual(f.more, { everyone: 1, quiet: 0 });
  assert.deepEqual(filterSessions(v, { everyone: true, quiet: false }).live.map(i => i.id).sort(), ['akash', 'mine']);
  assert.deepEqual(filterSessions(v, DEFAULT_FILTER, 'akash').live.map(i => i.id).sort(), ['akash', 'mine']);
});

test('ended sessions show only with Quiet and off', () => {
  const v = mergeSessions([worker('done', { state: 'off', lastActive: iso(30) })], [], { tz, now });
  assert.equal(v.finished.length, 1);
  assert.equal(filterSessions(v, DEFAULT_FILTER).finished.length, 0);
  assert.equal(filterSessions(v, { everyone: false, quiet: true }).finished.length, 1);
});

test('a computer-only session open and quiet for over 2 hours is Quiet; open within 2 hours is Idle (never On)', () => {
  const row = (key, x) => ({ key, title: key, deviceId: 'd1', folder: 'f', projectId: 'p1', projectName: 'Alpha', deviceName: 'Om-PC', state: 'open', live: true, subagents: 0, lastActiveAt: iso(5), workOs: false, canVscode: false, canStop: false, canResume: false, canRemove: false, ...x });
  const v = mergeSessions([], [row('d1:a'), row('d1:b', { lastActiveAt: iso(200) })], { tz, now });
  assert.deepEqual(v.live.map(i => i.state), ['idle', 'quiet']);
});

test('a turn that ended with a question waits on its person: "Waiting on you" for its owner, "Waiting on a person" for others', () => {
  assert.deepEqual(presenceState({ lastSeen: ago(1), activity: { state: 'waiting', at: ago(30), why: 'question' } }, { now }).why, 'question');
  const v = mergeSessions([worker('akar', { state: 'waiting', waitingOn: 'question', ask: 'Release 0.26.1?' }), worker('tm', { mine: false, person: 'Akash', state: 'waiting', waitingOn: 'need' })], [], { tz, now });
  const akar = v.live.find(i => i.id === 'akar');
  assert.equal(akar.word, 'Waiting on you');
  assert.equal(akar.ask, 'Release 0.26.1?');
  assert.equal(v.live.find(i => i.id === 'tm').word, 'Waiting on a person');
});

test('review fix 2: a row from before activeAt counts its last turn end; activeAt rows do not count the idle wait', () => {
  const old = { lastSeen: ago(0), activity: { state: 'idle', at: ago(10) }, promptAt: ago(300) };
  assert.equal(lastActive(old).getTime(), ago(10).getTime());
  assert.equal(isQuiet('idle', old, now), false);
  const kept = { ...old, activeAt: ago(200) };
  assert.equal(lastActive(kept).getTime(), ago(200).getTime(), 'with activeAt an idle event (the idle wait) is not activity');
});

test('review fix 2: last active is the newer of the session\'s word and the computer\'s', () => {
  const row = (lastActiveAt) => ({ key: 'd1:cc1', title: 'x', deviceId: 'd1', folder: 'f', projectId: 'p1', projectName: 'Alpha', deviceName: 'Om-PC', state: 'open', live: true, subagents: 0, lastActiveAt, workOs: true, canVscode: false, canStop: false, canResume: false, canRemove: false });
  const a = mergeSessions([worker('w', { cc: 'cc1', lastActive: iso(90) })], [row(iso(5))], { tz, now });
  assert.equal(a.live[0].lastActiveAt, iso(5));
  const b = mergeSessions([worker('w', { cc: 'cc1', lastActive: iso(5) })], [row(iso(90))], { tz, now });
  assert.equal(b.live[0].lastActiveAt, iso(5));
});

test('review fix 2: a quiet session keeps its own last active (the computer\'s time moves on a reopen)', () => {
  const row = { key: 'd1:cc1', title: 'x', deviceId: 'd1', folder: 'f', projectId: 'p1', projectName: 'Alpha', deviceName: 'Om-PC', state: 'open', live: true, subagents: 0, lastActiveAt: iso(3), workOs: true, canVscode: false, canStop: false, canResume: false, canRemove: false };
  const v = mergeSessions([worker('w', { cc: 'cc1', quiet: true, lastActive: iso(2 * 24 * 60) })], [row], { tz, now });
  assert.equal(v.live[0].lastActiveAt, iso(2 * 24 * 60));
});
