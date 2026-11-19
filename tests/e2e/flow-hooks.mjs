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

  // H4: a hook (protocol 2) gets a short save answer; the post-tool hook fetches the copy with get_state copy:true and writes the copy file
  const short = await fetch(B + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + key, 'x-work-os-hook': '2' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_state', arguments: { project: NAME, session: sess, ops: [{ op: 'add_later', text: 'Short answer line' }] } } }),
  }).then(async (r) => { const t = await r.text(); const d = t.split('\n').find((l) => l.startsWith('data:')); return JSON.parse(d ? d.slice(5) : t).result?.content?.[0]?.text ?? ''; });
  check('H4: a protocol 2 save answers short, with no markdown and no state', /"saved":\s*true/.test(short) && !/"markdown"/.test(short) && !/"state"/.test(short) && short.length < 400, short.slice(0, 200));
  const gitEnv = { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const p = hook('post-tool', { session_id: 'hk5', transcript_path: transcript, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'mcp__work-os__save_state', tool_input: {}, tool_response: [{ type: 'text', text: short }] }, gitEnv);
  const copy = (() => { try { return fs.readFileSync(path.join(repo, 'WORK-STATE' + '.md'), 'utf8'); } catch { return ''; } })();
  check('H4: post-tool wrote the copy file through get_state copy:true (has the new line, no Where)', p.status === 0 && /^Copy of the Work OS state, version \d+\./.test(copy) && copy.includes('Short answer line') && !/## Where/.test(copy), p.stdout + p.stderr + copy.slice(0, 200));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
await finish();
