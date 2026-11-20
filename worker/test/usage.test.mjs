import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectUsage, parseUsage, dayMaker } from '../usage.mjs';

const SID = '8c1d0a52-1111-4222-8333-444455556666';
const SID2 = '9d2e1b63-aaaa-4bbb-8ccc-ddddeeeeffff';
const SECRET = 'TOP SECRET MESSAGE TEXT';
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
    const a = collectUsage({ st, root: t.root, tz: 'UTC', now: NOW });
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
    try { const b = collectUsage({ st, root: t.root, tz: 'UTC', now: NOW + 1000 }); assert.equal(b.rows.length, 0); assert.equal(reads, 0); } finally { fs.readSync = orig; }

    // new records on the same day: the whole day's total is sent again; a repeat of an old message adds nothing
    fs.appendFileSync(t.main, lines(
      asst('a1', 'r1', 'claude-opus-4', [10, 100, 1000, 20], '2026-11-20T03:00:00Z'),
      asst('a3', 'r3', 'claude-opus-4', [5, 0, 0, 5], '2026-11-20T03:00:01Z'),
    ));
    const c = collectUsage({ st, root: t.root, tz: 'UTC', now: NOW + 2000 });
    assert.deepEqual(c.rows, [{ sessionId: SID, part: 'main', model: 'claude-opus-4', day: '2026-11-20', i: 15, cw: 100, cr: 1000, o: 25 }]);
    // not committed (the report failed): the same day is sent again with the same total
    const c2 = collectUsage({ st, root: t.root, tz: 'UTC', now: NOW + 3000 });
    assert.deepEqual(c2.rows, c.rows);
    c2.commit();
    assert.equal(collectUsage({ st, root: t.root, tz: 'UTC', now: NOW + 4000 }).rows.length, 0);

    // a half-written last line waits for its newline
    fs.appendFileSync(t.main, asst('a4', 'r4', 'claude-opus-4', [1, 1, 1, 1], '2026-11-20T04:00:00Z').slice(0, 60));
    assert.equal(collectUsage({ st, root: t.root, tz: 'UTC', now: NOW + 5000 }).rows.length, 0);
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
    const a = collectUsage({ st, root: t.root, tz: 'UTC', now: NOW, maxRows: 5 });
    assert.equal(a.rows.length, 5);
    assert.ok(a.rows.every((r) => r.day >= '2026-11-10'));
    a.commit();
    const b = collectUsage({ st, root: t.root, tz: 'UTC', now: NOW + 1000, maxRows: 5 });
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
    assert.equal(collectUsage({ st: {}, root: t.root, tz: 'UTC', now: NOW, onlyRoots: ['D:/elsewhere'] }).rows.length, 0);
    assert.ok(SID2);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});
