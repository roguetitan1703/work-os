// The save reminder that rides with a merge, push to master or release (hook-pre-tool.mjs saveWithAction, Om 21 Nov), so the Stop hook
// does not send the session back for a turn of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAVE_WITH_ACTION, joinNotes, saveWithAction } from '../hook-pre-tool.mjs';

const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, session_id: 's1', ...extra });
const note = (a) => a?.hookSpecificOutput?.additionalContext;

test('merge, push to master and deploy get the reminder', () => {
  for (const c of ['git merge --no-ff dev -m x', 'git -C repo merge dev', 'git push origin master', 'git push -q delpat main', 'sudo work-os-deploy abc --artifact x.tar.gz']) {
    assert.equal(note(saveWithAction(bash(c))), SAVE_WITH_ACTION, c);
  }
  assert.equal(note(saveWithAction({ tool_name: 'PowerShell', tool_input: { command: 'git merge dev' } })), SAVE_WITH_ACTION);
});

test('other commands, other tools and subagents get nothing', () => {
  for (const c of ['git push origin dev', 'git merge --abort', 'git merge-base --is-ancestor a b', 'git log --oneline', 'npm test']) {
    assert.equal(saveWithAction(bash(c)), null, c);
  }
  assert.equal(saveWithAction({ tool_name: 'Read', tool_input: { file_path: 'x' } }), null);
  assert.equal(saveWithAction(bash('git merge dev', { agent_id: 'a1' })), null);
  assert.equal(saveWithAction({}), null);
});

test('notes are joined into one answer; none gives null', () => {
  const a = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'one' } };
  const b = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'two' } };
  assert.equal(note(joinNotes([a, null, b])), 'one\n\ntwo');
  assert.equal(joinNotes([null, undefined, {}]), null);
});
