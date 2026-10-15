import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core.mjs';

const SID = '11111111-2222-4333-8444-555555555555';

function mk() {
  let t = 1_000_000;
  let procs = [{ pid: 1, cmd: `claude --session-id ${SID}` }];
  const reports = [];
  const state = { ids: {}, folders: {}, sessions: { [SID]: { folderId: 'f_x', state: 'running', startedAt: t } }, markers: {} };
  const core = createCore({
    getConfig: () => ({ roots: [] }), state, save: () => {}, now: () => t,
    api: { postStatus: async (b) => void reports.push(JSON.parse(JSON.stringify(b))) },
    launcher: async () => {}, listProcesses: async () => procs, killPid: async () => {},
  });
  return { core, state, reports, adv: (ms) => (t += ms), setProcs: (p) => (procs = p) };
}

test('one empty process listing does not close a live session', async () => {
  const m = mk();
  m.adv(60_000);
  m.setProcs([]);
  await m.core.sendStatus(); // first miss
  assert.equal(m.reports.at(-1).sessions[0].state, 'running');
  m.setProcs([{ pid: 1, cmd: `claude --session-id ${SID}` }]);
  m.adv(30_000);
  await m.core.sendStatus(); // back: miss forgotten
  m.setProcs([]);
  m.adv(30_000);
  await m.core.sendStatus(); // a new first miss, still running
  assert.equal(m.reports.at(-1).sessions[0].state, 'running');
});

test('claude gone for 20 s+ after grace reports dead once, then is dropped', async () => {
  const m = mk();
  m.adv(60_000);
  m.setProcs([]);
  await m.core.sendStatus();
  m.adv(25_000);
  await m.core.sendStatus();
  assert.equal(m.reports.at(-1).sessions[0].state, 'dead');
  assert.deepEqual(m.state.sessions, {});
});
