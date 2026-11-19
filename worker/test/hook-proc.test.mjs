// Identity step 3: the hook notes the session's claude process (CLAUDE_PID, else the nearest claude ancestor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeProcess, keepProc } from '../hook-lib.mjs';

const tree = {
  100: { ppid: 90, name: 'node.exe', start: '10' },
  90: { ppid: 80, name: 'cmd.exe', start: '9' },
  80: { ppid: 70, name: 'C:/Users/made-up/.local/bin/claude.exe', start: '8' },
  70: { ppid: 1, name: 'Code.exe', start: '7' },
  55: { ppid: 54, name: 'claude', start: undefined },
};
const facts = (pid) => tree[pid] || null;

test('CLAUDE_PID is the process (desktop, VS Code and the terminal all set it); its start time is added when known', () => {
  assert.deepEqual(claudeProcess({ CLAUDE_PID: '80' }, facts, 100), { pid: 80, procStart: '8' });
  assert.deepEqual(claudeProcess({ CLAUDE_PID: '55' }, facts, 100), { pid: 55 });
  assert.deepEqual(claudeProcess({ CLAUDE_PID: '4242' }, () => null, 100), { pid: 4242 }); // facts failed: the pid still counts
});

test('without CLAUDE_PID the nearest claude ancestor of the hook is found', () => {
  assert.deepEqual(claudeProcess({}, facts, 100), { pid: 80, procStart: '8' });
});

test('a bad CLAUDE_PID is ignored; no claude ancestor (or a failing lookup) gives null', () => {
  assert.deepEqual(claudeProcess({ CLAUDE_PID: 'abc; rm -rf' }, facts, 100), { pid: 80, procStart: '8' });
  assert.equal(claudeProcess({}, facts, 70), null);
  assert.equal(claudeProcess({}, () => null, 100), null);
});

test('a copy that is not installed beside a worker writes nothing', () => {
  assert.equal(keepProc('00000000-0000-4000-8000-000000000001', () => ({ pid: 5 })), null);
});
