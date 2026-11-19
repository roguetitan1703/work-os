// lib/live.ts shutdown: releaseAll answers every pending wait and ends every stream.
// Run: node --test --experimental-strip-types --no-warnings --conditions=react-server tests/live-release.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
const { waitFor, waiterCount, releaseAll, register } = await import('../lib/live.ts');

test('releaseAll answers every pending wait at once and ends every stream with ttl', async () => {
  const a = waitFor('o1', 'u1:s1', 60_000);
  const b = waitFor('o1', 'u2:s2', 60_000);
  assert.equal(waiterCount(), 2);
  const closed = [];
  register({ kind: 'page', orgId: 'o1', userId: 'u1', send() {}, close: r => closed.push(r) });
  releaseAll();
  assert.deepEqual(await Promise.all([a, b]), ['bumped', 'bumped']);
  assert.equal(waiterCount(), 0);
  assert.deepEqual(closed, ['ttl']);
});
