import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { collectUsage, parseUsage, dayMaker, readAccount } from '../usage.mjs';

const SID = '8c1d0a52-1111-4222-8333-444455556666';
const SID2 = '9d2e1b63-aaaa-4bbb-8ccc-ddddeeeeffff';
const SECRET = 'TOP SECRET MESSAGE TEXT';
const NOACC = path.join(os.tmpdir(), 'wos-usage-no-such-file.json');
const NOW = Date.parse('2026-11-20T10:00:00Z');

const asst = (id, req, model, u, ts, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: req, message: { id, model, role: 'assistant', content: [{ type: 'text', text: SECRET }], usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } }, ...extra });
const title = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t });

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-usage-'));
  const dir = path.join(root, 'projA');
  fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true });
  return { root, dir, main: path.join(dir, `${SID}.jsonl`), sub: path.join(dir, SID, 'subagents', 'agent-ab12.jsonl') };
}
const lines = (...l) => l.join('\n') + '\n';
const d = (o) => ({ ...o, rows: [...o.rows].sort((a, b) => (a.part + a.model + a.day < b.part + b.model + b.day ? -1 : 1)) });

test('parseUsage: dedupes repeats of one message, skips synthetic, keeps the largest count', () => {
  const got = [];
  const seen = new Set();
  const text = lines(
    asst('m1', 'r1', 'claude-opus-4', [10, 100, 1000, 1], '2026-11-20T01:00:00Z'),
    asst('m1', 'r1', 'claude-opus-4', [10, 100, 1000, 50], '2026-11-20T01:00:01Z'), // the same message, one more block
    asst('m2', 'r2', '<synthetic>', [5, 5, 5, 5], '2026-11-20T01:00:02Z'),
    asst('m3', 'r3', 'claude-sonnet-4', [1, 0, 0, 2], '2026-11-20T01:00:03Z'),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    'not json "assistant" "usage"',
  );
  parseUsage(text, seen, (r) => got.push(r), dayMaker('UTC'));
  assert.equal(got.length, 2);
  assert.deepEqual(got.find((r) => r.model === 'claude-opus-4'), { model: 'claude-opus-4', day: '2026-11-20', i: 10, cw: 100, cr: 1000, o: 50 });
  // the same message seen again in a later read is not counted twice
  parseUsage(asst('m1', 'r1', 'claude-opus-4', [10, 100, 1000, 50], '2026-11-20T01:00:05Z') + '\n', seen, (r) => got.push(r), dayMaker('UTC'));
  assert.equal(got.length, 2);
});

test('dayMaker: the person\'s timezone decides the day', () => {
  assert.equal(dayMaker('Asia/Kolkata')('2026-11-20T19:00:00Z'), '2026-11-21');
  assert.equal(dayMaker('UTC')('2026-11-20T19:00:00Z'), '2026-11-20');
  assert.match(dayMaker('Not/AZone')('2026-11-20T12:00:00Z'), /^2026-11-2[01]$/);
});

test('collectUsage: sessions, subagents, whole-day totals, no message text, incremental', () => {
  const t = tree();
  try {
    fs.writeFileSync(t.main, lines(
      title('Build the usage page'),
      JSON.stringify({ type: 'user', cwd: 'D:\\Work\\proj', message: { content: SECRET } }),
      asst('a1', 'r1', 'claude-opus-4', [10, 100, 1000, 20], '2026-11-20T01:00:00Z'),
      asst('a1', 'r1', 'claude-opus-4', [10, 100, 1000, 20], '2026-11-20T01:00:01Z'),
      asst('a2', 'r2', 'claude-sonnet-4', [1, 2, 3, 4], '2026-11-19T22:00:00Z'),
    ));
    fs.writeFileSync(t.sub, lines(title('Explore agent'), asst('s1', 'q1', 'claude-haiku-4', [7, 0, 0, 9], '2026-11-20T02:00:00Z')));
    const st = {};
    const a = collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW });
    assert.deepEqual(d(a).rows, [
      { sessionId: SID, part: 'agent-ab12', model: 'claude-haiku-4', day: '2026-11-20', i: 7, cw: 0, cr: 0, o: 9, partName: 'Explore agent' },
      { sessionId: SID, part: 'main', model: 'claude-opus-4', day: '2026-11-20', i: 10, cw: 100, cr: 1000, o: 20 },
      { sessionId: SID, part: 'main', model: 'claude-sonnet-4', day: '2026-11-19', i: 1, cw: 2, cr: 3, o: 4 },
    ]);
    assert.deepEqual(a.sessions, [{ sessionId: SID, title: 'Build the usage page', folder: 'proj', origin: 'other' }]);
    assert.ok(!JSON.stringify(a).includes(SECRET), 'message text never leaves the transcript');
    a.commit();
    assert.ok(!JSON.stringify(st).includes(SECRET), 'nor the remembered state');

    // nothing new: nothing to send, and the file is not read again
    const orig = fs.readSync; let reads = 0; fs.readSync = (...x) => { reads++; return orig(...x); };
    try { const b = collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW + 1000 }); assert.equal(b.rows.length, 0); assert.equal(reads, 0); } finally { fs.readSync = orig; }

    // new records on the same day: the whole day's total is sent again; a repeat of an old message adds nothing
    fs.appendFileSync(t.main, lines(
      asst('a1', 'r1', 'claude-opus-4', [10, 100, 1000, 20], '2026-11-20T03:00:00Z'),
      asst('a3', 'r3', 'claude-opus-4', [5, 0, 0, 5], '2026-11-20T03:00:01Z'),
    ));
    const c = collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW + 2000 });
    assert.deepEqual(c.rows, [{ sessionId: SID, part: 'main', model: 'claude-opus-4', day: '2026-11-20', i: 15, cw: 100, cr: 1000, o: 25 }]);
    // not committed (the report failed): the same day is sent again with the same total
    const c2 = collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW + 3000 });
    assert.deepEqual(c2.rows, c.rows);
    c2.commit();
    assert.equal(collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW + 4000 }).rows.length, 0);

    // a half-written last line waits for its newline
    fs.appendFileSync(t.main, asst('a4', 'r4', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T04:00:00Z').slice(0, 60));
    assert.equal(collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW + 5000 }).rows.length, 0);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('collectUsage: a subagent without a title is named by its file id; old days are not backfilled; rows are bounded', () => {
  const t = tree();
  try {
    fs.writeFileSync(t.sub, lines(asst('s1', 'q1', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T02:00:00Z')));
    fs.writeFileSync(t.main, lines(
      asst('old', 'r', 'claude-opus-4', [9, 9, 9, 9], '2026-09-01T02:00:00Z'), // 80 days ago: not kept
      ...Array.from({ length: 8 }, (_, i) => asst('m' + i, 'r' + i, 'claude-opus-4', [1, 0, 0, 1], `2026-11-${String(10 + i).padStart(2, '0')}T02:00:00Z`)),
    ));
    const st = {};
    const a = collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW, maxRows: 5 });
    assert.equal(a.rows.length, 5);
    assert.ok(a.rows.every((r) => r.day >= '2026-11-10'));
    a.commit();
    const b = collectUsage({ accountFile: NOACC, st, root: t.root, tz: 'UTC', now: NOW + 1000, maxRows: 5 });
    assert.equal(b.rows.length, 4); // 9 days rows in all (8 + the subagent), 5 sent before
    const days = new Set([...a.rows, ...b.rows].map((r) => r.part + r.day));
    assert.equal(days.size, 9);
    assert.equal([...a.rows, ...b.rows].find((r) => r.part === 'agent-ab12')?.partName, 'agent-ab12');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('collectUsage: a session of another folder is skipped under onlyRoots', () => {
  const t = tree();
  try {
    fs.writeFileSync(t.main, lines(asst('a1', 'r1', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T02:00:00Z')));
    assert.equal(collectUsage({ accountFile: NOACC, st: {}, root: t.root, tz: 'UTC', now: NOW, onlyRoots: ['D:/elsewhere'] }).rows.length, 0);
    assert.ok(SID2);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

// ── account, limit hits, compactions, buckets (note e6036c777f) ──
const UUID = 'aaaaaaaa-0000-4000-8000-123456789abc';
const OTHER_UUID = 'bbbbbbbb-0000-4000-8000-123456789abc';
const hash = (u) => crypto.createHash('sha256').update('work-os-acct:' + u).digest('hex').slice(0, 16);
const acctFile = (dir, uuid = UUID, mail = 'Pat.Example@example.test') => { const f = path.join(dir, 'claude.json'); fs.writeFileSync(f, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: mail } })); return f; };
const bridge = (uuid) => JSON.stringify({ type: 'bridge-session', ownerAccountUuid: uuid, note: 'padding to pass the line length check' });
const synth = (uuid, text, ts) => JSON.stringify({ type: 'assistant', uuid, timestamp: ts, message: { id: 'x' + uuid, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } } });
const compact = (uuid, ts, trigger, pre, post) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts, compactMetadata: { trigger, preTokens: pre, postTokens: post } });
const IST = 'Asia/Kolkata';
const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

test('readAccount: a hash id and the label before @; never the uuid; missing or bad file gives null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-acct-'));
  try {
    const a = readAccount(acctFile(dir));
    assert.deepEqual(a, { id: hash(UUID), label: 'Pat.Example' });
    assert.ok(!JSON.stringify(a).includes(UUID) && !JSON.stringify(a).includes('example.test'));
    assert.equal(readAccount(path.join(dir, 'nope.json')), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(readAccount(path.join(dir, 'bad.json')), null);
    fs.writeFileSync(path.join(dir, 'nouuid.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
    assert.equal(readAccount(path.join(dir, 'nouuid.json')), null);
    fs.writeFileSync(path.join(dir, 'long.json'), JSON.stringify({ oauthAccount: { accountUuid: UUID, emailAddress: 'x'.repeat(80) + '@b.c' } }));
    assert.equal(readAccount(path.join(dir, 'long.json')).label.length, 40);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("collectUsage: the bridge-session account wins over the computer's; rows and buckets carry it", () => {
  const t = tree();
  try {
    const own = acctFile(t.root);
    fs.writeFileSync(t.main, lines(asst('a1', 'r1', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T01:00:00Z')));
    fs.writeFileSync(t.sub, lines(bridge(OTHER_UUID), asst('s1', 'q1', 'claude-opus-4', [2, 2, 2, 2], '2026-11-20T01:01:00Z')));
    const a = collectUsage({ accountFile: own, st: {}, root: t.root, tz: 'UTC', now: NOW });
    assert.equal(a.rows.find((r) => r.part === 'main').acct, hash(UUID));
    assert.equal(a.rows.find((r) => r.part !== 'main').acct, hash(OTHER_UUID));
    const byId = (x, y) => (x.id < y.id ? -1 : 1);
    assert.deepEqual([...a.accounts].sort(byId), [{ id: hash(UUID), label: 'Pat.Example' }, { id: hash(OTHER_UUID), label: '' }].sort(byId));
    const json = JSON.stringify(a);
    assert.ok(!json.includes(UUID) && !json.includes(OTHER_UUID) && !json.includes('example.test'));
    assert.ok(a.buckets.every((b) => b.acct === (b.part === 'main' ? hash(UUID) : hash(OTHER_UUID))));
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test("collectUsage: limit hits (kind, reset time in the person's zone), compactions, sent once, no text", () => {
  const t = tree();
  try {
    const own = acctFile(t.root);
    fs.writeFileSync(t.main, lines(
      synth(U(1), SECRET + " You've hit your usage limit. Your limit resets 4:30pm", '2026-11-20T09:30:00Z'), // 15:00 IST: same day 16:30 IST
      synth(U(2), SECRET + ' Weekly limit reached, resets 4:30pm', '2026-11-20T11:30:00Z'), // 17:00 IST: next day
      synth(U(3), SECRET + ' Your 5-hour limit reached, resets 7pm', '2026-11-20T09:30:00Z'),
      synth(U(4), SECRET + ' some other rate limit text', '2026-11-20T09:30:00Z'),
      synth(U(5), SECRET + ' nothing about it', '2026-11-20T09:30:00Z'), // not a limit hit
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-20T09:30:00Z', message: { model: '<synthetic>', content: [{ type: 'text', text: 'usage limit ' + SECRET + ' padding' }] } }), // no uuid: dropped
      compact(U(6), '2026-11-20T09:40:00Z', 'auto', 150000, 12000),
      compact(U(7), '2026-11-20T09:41:00Z', 'weird', 1, 2),
      asst('a1', 'r1', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T09:42:00Z'),
    ));
    const st = {};
    const a = collectUsage({ accountFile: own, st, root: t.root, tz: IST, now: NOW });
    const ev = Object.fromEntries(a.events.map((e) => [e.id, e]));
    assert.equal(a.events.length, 6);
    assert.deepEqual(ev[U(1)], { kind: 'limit', id: U(1), sessionId: SID, part: 'main', at: '2026-11-20T09:30:00.000Z', acct: hash(UUID), which: 'other', resetAt: '2026-11-20T11:00:00.000Z' });
    assert.equal(ev[U(2)].which, 'weekly');
    assert.equal(ev[U(2)].resetAt, '2026-11-21T11:00:00.000Z');
    assert.equal(ev[U(3)].which, '5h');
    assert.equal(ev[U(3)].resetAt, '2026-11-20T13:30:00.000Z');
    assert.equal(ev[U(4)].resetAt, null);
    assert.deepEqual(ev[U(6)], { kind: 'compact', id: U(6), sessionId: SID, part: 'main', at: '2026-11-20T09:40:00.000Z', acct: hash(UUID), trigger: 'auto', pre: 150000, post: 12000 });
    assert.equal(ev[U(7)].trigger, 'other');
    assert.ok(!JSON.stringify(a).includes(SECRET), 'the notice text never leaves the transcript');
    a.commit();
    assert.ok(!JSON.stringify(st).includes(SECRET));
    // sent once: the second collect has none
    fs.appendFileSync(t.main, lines(asst('a2', 'r2', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T09:50:00Z')));
    assert.equal(collectUsage({ accountFile: own, st, root: t.root, tz: IST, now: NOW + 1000 }).events.length, 0);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('collectUsage: events over the limit of one report wait; an unreported scan loses none', () => {
  const t = tree();
  try {
    const own = acctFile(t.root);
    fs.writeFileSync(t.main, lines(...Array.from({ length: 205 }, (_, n) => compact(U(n), '2026-11-20T09:40:00Z', 'auto', 10, 5))));
    const st = {};
    const a = collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW });
    assert.equal(a.events.length, 200);
    const again = collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW + 1 });
    assert.equal(again.events.length, 200);
    a.commit();
    const b = collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW + 2 });
    assert.equal(b.events.length, 5);
    b.commit();
    assert.equal(collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW + 3 }).events.length, 0);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('collectUsage: 5-minute buckets (floored, cw1h, message count), newest first, bounded, only the last 7 days', () => {
  const t = tree();
  const t2 = tree();
  try {
    const own = acctFile(t.root);
    const m = (id, ts, cw1h) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r' + id, message: { id, model: 'claude-opus-4', content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: cw1h } } } });
    fs.writeFileSync(t.main, lines(
      m('b1', '2026-11-20T09:01:10Z', 4), m('b2', '2026-11-20T09:04:59Z', 6), m('b3', '2026-11-20T09:05:00Z', 0),
      m('old', '2026-11-05T09:05:00Z', 0), // 15 days back: a day total, no bucket
    ));
    const st = {};
    const a = collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW });
    assert.deepEqual(a.buckets.map((b) => [b.at, b.i, b.cw, b.cw1h, b.cr, b.o, b.n]), [
      ['2026-11-20T09:05:00.000Z', 1, 10, 0, 100, 2, 1],
      ['2026-11-20T09:00:00.000Z', 2, 20, 10, 200, 4, 2],
    ]);
    assert.equal(a.buckets[0].acct, hash(UUID));
    a.commit();
    fs.appendFileSync(t.main, lines(m('b4', '2026-11-20T09:06:00Z', 3)));
    const b = collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW + 1000 });
    assert.deepEqual(b.buckets.map((x) => [x.at, x.n, x.cw1h]), [['2026-11-20T09:05:00.000Z', 2, 3]]); // the whole bucket again
    b.commit();
    // later than 8 days: dropped from the remembered state
    collectUsage({ accountFile: own, st, root: t.root, tz: 'UTC', now: NOW + 9 * 86_400_000 }).commit();
    assert.deepEqual(Object.keys(st.bk), []);
    // bounded: the rest wait
    fs.writeFileSync(t2.main, lines(...Array.from({ length: 1005 }, (_, n) => m('k' + n, new Date(Date.parse('2026-11-19T00:00:00Z') + n * 300_000).toISOString(), 0))));
    const s2 = {};
    const big = collectUsage({ accountFile: own, st: s2, root: t2.root, tz: 'UTC', now: NOW, maxRows: 5000 });
    assert.equal(big.buckets.length, 1000);
    assert.ok(big.buckets[0].at > big.buckets[999].at);
    big.commit();
    assert.equal(collectUsage({ accountFile: own, st: s2, root: t2.root, tz: 'UTC', now: NOW + 1 }).buckets.length, 5);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); fs.rmSync(t2.root, { recursive: true, force: true }); }
});
