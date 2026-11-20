import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core.mjs';

// The heartbeat carries the state of this PC's Claude Code hooks (Computers shows "hooks on / out of date / no hooks").
function mk(hooksStatus, selfUpdate) {
  const reports = [];
  const core = createCore({
    hooksStatus, selfUpdate, getConfig: () => ({ roots: [] }), state: { ids: {}, folders: {}, sessions: {}, markers: {} }, save: () => {},
    api: { postStatus: async (b) => void reports.push(JSON.parse(JSON.stringify(b))) },
    launcher: async () => {}, listProcesses: async () => [], killPid: async () => {}, log: () => {},
  });
  return { core, reports };
}

test('the status body carries worker.hooks', async () => {
  const h = { version: '1a2b3c4d5e6f', events: 7, stale: false, signIn: 'worker' };
  const m = mk(() => h);
  await m.core.sendStatus();
  assert.deepEqual(m.reports.at(-1).worker.hooks, h);
});

test('a throwing hooksStatus leaves hooks out and the heartbeat still goes', async () => {
  const m = mk(() => { throw new Error('settings.json is not valid JSON'); });
  await m.core.sendStatus();
  assert.equal(m.reports.length, 1);
  assert.equal('hooks' in m.reports.at(-1).worker, false);
});

test('without hooksStatus there is no hooks field', async () => {
  const m = mk(undefined);
  await m.core.sendStatus();
  assert.equal('hooks' in m.reports.at(-1).worker, false);
  assert.equal('selfUpdate' in m.reports.at(-1).worker, false, 'a repo run reports no self-update');
});

test('the status body carries worker.selfUpdate (Computers shows the last update or the refusal)', async () => {
  const u = { on: true, updatedAt: '2026-11-20T10:00:00.000Z', from: '0.5.0', problem: 'update refused: bad signature' };
  const m = mk(undefined, () => u);
  await m.core.sendStatus();
  assert.deepEqual(m.reports.at(-1).worker.selfUpdate, u);
  const t = mk(undefined, () => { throw new Error('x'); });
  await t.core.sendStatus();
  assert.equal(t.reports.length, 1);
  assert.equal('selfUpdate' in t.reports.at(-1).worker, false);
});
