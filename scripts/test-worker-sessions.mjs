// API check for the named session list (POST /api/worker/status "claudeSessions").
// Usage: BASE=http://localhost:3472 DEVICE_KEY=wkr_... node scripts/test-worker-sessions.mjs
// Run it only against a throwaway database (it replaces the device's session list).
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3472';
const KEY = process.env.DEVICE_KEY;
if (!KEY) throw new Error('set DEVICE_KEY');
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ok = (o = {}) => ({ sessionId: u(1), folder: 'pms', title: 'A title', lastActiveAt: Date.now(), subagentsActive: 0, startedByWorkOs: false, running: true, ...o });
const post = async (claudeSessions) => {
  const r = await fetch(`${BASE}/api/worker/status`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ worker: { version: '0.1.0', os: 'win32' }, claudeSessions }) });
  return r.status;
};

assert.equal(await post([ok(), ok({ sessionId: u(2), title: 'x'.repeat(300) })]), 200, 'valid list (long title is trimmed)');
assert.equal(await post([]), 200, 'empty list');
const bad = {
  'not an array': 'x',
  'too many': Array.from({ length: 51 }, (_, i) => ok({ sessionId: u(i + 1) })),
  'bad session id': [ok({ sessionId: 'nope' })],
  'repeated id': [ok(), ok()],
  'windows path folder': [ok({ folder: 'C:\\Users\\om\\proj' })],
  'unix path folder': [ok({ folder: '/home/om/proj' })],
  'nested folder': [ok({ folder: 'a/b' })],
  'dot dot': [ok({ folder: '..' })],
  'home folder': [ok({ folder: '~' })],
  'long folder': [ok({ folder: 'f'.repeat(81) })],
  'empty folder': [ok({ folder: '' })],
  'huge title': [ok({ title: 'x'.repeat(501) })],
  'title not a string': [ok({ title: { a: 1 } })],
  'time as string': [ok({ lastActiveAt: 'now' })],
  'time far in the future': [ok({ lastActiveAt: Date.now() + 10 * 86400_000 })],
  'negative subagents': [ok({ subagentsActive: -1 })],
  'fractional subagents': [ok({ subagentsActive: 1.5 })],
  'flag not bool': [ok({ running: 'yes' })],
  'item not an object': [42],
};
for (const [name, v] of Object.entries(bad)) assert.equal(await post(v), 400, `rejected: ${name}`);
console.log(`ok: 2 accepted, ${Object.keys(bad).length} rejected`);
