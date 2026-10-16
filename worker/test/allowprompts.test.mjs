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
