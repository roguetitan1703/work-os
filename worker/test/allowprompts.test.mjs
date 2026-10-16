import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core.mjs';

// The task dispatcher (docs/dispatcher.md) only sends a task to a worker that reports allowPrompts: true.
function mk(config) {
  const reports = [];
  const core = createCore({
    getConfig: () => ({ roots: [], ...config }), state: { ids: {}, folders: {}, sessions: {}, markers: {} }, save: () => {},
    api: { postStatus: async (b) => void reports.push(JSON.parse(JSON.stringify(b))) },
    launcher: async () => {}, listProcesses: async () => [], killPid: async () => {},
  });
  return { core, reports };
}

test('status reports allowPrompts: true by default', async () => {
  const m = mk({});
  await m.core.sendStatus();
  assert.equal(m.reports.at(-1).worker.allowPrompts, true);
});

test('status reports allowPrompts: false when the config turns prompts off', async () => {
  const m = mk({ allowPrompts: false });
  await m.core.sendStatus();
  assert.equal(m.reports.at(-1).worker.allowPrompts, false);
});

test('a start job for a session this worker already runs is not launched again', async () => {
  const SID = '11111111-2222-4333-8444-555555555555';
  const launches = [];
  const core = createCore({
    getConfig: () => ({ roots: [] }), state: { ids: {}, folders: {}, sessions: { [SID]: { folderId: 'f_x', state: 'running', startedAt: 1 } }, markers: {} }, save: () => {},
    api: { postStatus: async () => {} },
    launcher: async (a) => void launches.push(a), listProcesses: async () => [], killPid: async () => {},
  });
  const r = await core.handleJob({ id: 'j_1', kind: 'start', folderId: 'f_x', sessionId: SID });
  assert.deepEqual(r, { id: 'j_1', ok: true });
  assert.equal(launches.length, 0);
});
