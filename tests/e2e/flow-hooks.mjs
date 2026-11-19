// Claude Code hooks (slice 1b) against the real server: worker/hook.mjs session-start and stop, run as processes with
// Claude Code's hook JSON on stdin, a seeded wos_ key, the real start_work and a temp git repo whose remote matches a
// seeded project. Seed profile: none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { B, MCP, check, finish, mkKey, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const HOOK = fileURLToPath(new URL('../../worker/hook.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hooks-e2e-'));
try {
  const NAME = 'Hooks Alpha';
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/hooks-alpha' }] });
  await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'add_next', text: 'Hooked brief line' }] });
  const key = await mkKey({ agent: 'claude-code', name: 'Claude Code hooks' });

  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  const mkRepo = (name, remote) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d);
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'remote', 'add', 'origin', remote);
    fs.writeFileSync(path.join(d, 'a.txt'), '1');
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return d;
  };
  const repo = mkRepo('repo', 'https://github.com/acme/hooks-alpha.git');
  const other = mkRepo('other', 'https://github.com/acme/not-a-project.git');
  const env = { ...process.env, WORK_OS_KEY: key, WORK_OS_URL: B, WORK_OS_HOOK_DIR: path.join(tmp, 'markers'), WORK_OS_WORKER_DIR: path.join(tmp, 'cfg') };
  const hook = (arg, input, e = env) => spawnSync(process.execPath, [HOOK, arg], { input: JSON.stringify(input), encoding: 'utf8', env: e, timeout: 20000 });
  const transcript = path.join(tmp, 't.jsonl');
  const fresh = () => fs.writeFileSync(transcript, '{"type":"user","message":"hi"}\n');

  // SessionStart: the real brief as additionalContext
  fresh();
  const s1 = hook('session-start', { session_id: 'hk1', transcript_path: transcript, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  const o1 = s1.status === 0 && s1.stdout ? JSON.parse(s1.stdout) : null;
  const ctx = o1?.hookSpecificOutput?.additionalContext ?? '';
  check('session-start: exit 0 and Claude Code hook JSON (hookEventName SessionStart)', s1.status === 0 && o1?.hookSpecificOutput?.hookEventName === 'SessionStart', s1.stdout + s1.stderr);
  check('session-start: the brief names the project, the State line and a session id', ctx.includes(NAME) && ctx.includes('Hooked brief line') && /Session id: [0-9a-f-]{8,}\./.test(ctx), ctx.slice(0, 300));
  check('session-start: within the 10,000 character cap', ctx.length <= 10000, String(ctx.length));
  const presence = await rawDb.collection('presence').countDocuments({ label: 'Claude Code' });
  check('session-start: the session is registered as present', presence === 1, String(presence));

  // H5: a handover left with end_work comes first in the next session's brief
  const hov = await must(MCP, 'end_work', { project: NAME, state: [{ op: 'set_where', machine: 'hk-box', branch: 'main' }], friction: 'none', handover: { step: 'hooked handover step' } });
  fresh();
  const sH = hook('session-start', { session_id: 'hk-ho', transcript_path: transcript, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  const ctxH = JSON.parse(sH.stdout || '{}')?.hookSpecificOutput?.additionalContext ?? '';
  check('session-start: a handover is the first section of the brief, before Orders and State', ctxH.includes(`## Handover (note ${hov.handover.id}`) && ctxH.includes('hooked handover step') && ctxH.indexOf('## Handover') < ctxH.indexOf('## Orders') && ctxH.indexOf('## Handover') < ctxH.indexOf('## State'), ctxH.slice(0, 400));

  // Fail open, for real
  fresh();
  const bad = hook('session-start', { session_id: 'hk2', transcript_path: transcript, cwd: repo }, { ...env, WORK_OS_KEY: 'wos_' + 'x'.repeat(40) });
  check('session-start: a key the server refuses prints nothing, exit 0', bad.status === 0 && bad.stdout === '', bad.stdout);
  const un = hook('session-start', { session_id: 'hk3', transcript_path: transcript, cwd: other });
  check('session-start: a repo no project has prints nothing, exit 0', un.status === 0 && un.stdout === '', un.stdout);
  const down = hook('session-start', { session_id: 'hk4', transcript_path: transcript, cwd: repo }, { ...env, WORK_OS_URL: 'http://127.0.0.1:1' });
  check('session-start: server unreachable prints nothing, exit 0', down.status === 0 && down.stdout === '', down.stdout);

  // Stop: quiet with nothing changed, blocks once after a change
  const stopIn = (sid, extra = {}) => ({ session_id: sid, transcript_path: transcript, cwd: repo, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
  const q = hook('stop', stopIn('hk1'));
  check('stop: nothing changed since the start: no block', q.status === 0 && q.stdout === '', q.stdout);
  fs.writeFileSync(path.join(repo, 'b.txt'), '2');
  const b1 = hook('stop', stopIn('hk1'));
  const ob = b1.stdout ? JSON.parse(b1.stdout) : null;
  check('stop: a changed file and no save_state: decision block with a reason naming save_state', b1.status === 0 && ob?.decision === 'block' && /save_state/.test(ob.reason ?? ''), b1.stdout);
  const b2 = hook('stop', stopIn('hk1', { stop_hook_active: true }));
  const b3 = hook('stop', stopIn('hk1'));
  check('stop: never a second block in the session', b2.stdout === '' && b3.stdout === '', b2.stdout + b3.stdout);

  // A session that saved: really call save_state, and the transcript shows the tool use
  fresh();
  const s2 = hook('session-start', { session_id: 'hk5', transcript_path: transcript, cwd: repo });
  const sess = /Session id: ([0-9a-f-]{8,})\./.exec(JSON.parse(s2.stdout).hookSpecificOutput.additionalContext)?.[1];
  fs.writeFileSync(path.join(repo, 'c.txt'), '3');
  const saved = await must(key, 'save_state', { project: NAME, session: sess, ops: [{ op: 'add_later', text: 'Saved by the hooked session', waitsOn: 'nobody' }] }).catch(() => null);
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__work-os__save_state', input: {} }] } }) + '\n');
  const after = hook('stop', stopIn('hk5'));
  check('stop: after a save_state in the session: no block', after.status === 0 && after.stdout === '', after.stdout + JSON.stringify(saved).slice(0, 100));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
await finish();
