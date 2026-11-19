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
  // The folder decides the project (H13): the key path matches by the folder's path, never by the remote alone.
  await must(MCP, 'update_project', { project: NAME, code: [{ remote: 'acme/hooks-alpha' }, { path: repo }] });
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

  // H13: the folder decides the project. A second clone of the project's remote in another folder is unfiled (asks, with the
  // project as a "same remote" suggestion); filing it with start_work link makes the next session check in; a folder marked
  // not Work OS stays quiet; a subfolder of a filed folder is the same project. Temp folders are quiet, so the child process
  // is told another temp folder (os.tmpdir() reads TEMP / TMP / TMPDIR).
  const fakeTmp = path.join(tmp, 'faketmp');
  fs.mkdirSync(fakeTmp);
  const envOut = { ...env, TEMP: fakeTmp, TMP: fakeTmp, TMPDIR: fakeTmp };
  const machine = os.hostname().slice(0, 40);
  const clone = mkRepo('clone', 'https://github.com/acme/hooks-alpha.git');
  const ctxOf = r => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');
  fresh();
  const c1 = hook('session-start', { session_id: 'h13a', transcript_path: transcript, cwd: clone }, envOut);
  const c1text = ctxOf(c1);
  check('H13 hook: a second clone of the project\'s remote is unfiled, not briefed: it asks, naming the project as the same-remote suggestion', c1.status === 0 && /not filed in Work OS/.test(c1text) && /Suggestions: Hooks Alpha \(same remote\)/.test(c1text) && !c1text.includes('Hooked brief line'), c1.stdout + c1.stderr);
  check('H13 hook: the unfiled text names the link call with path and machine (no worker here) and not_work_os', /link: true/.test(c1text) && /not_work_os: true/.test(c1text) && c1text.length < 900, c1text);
  const c1q = hook('session-start', { session_id: 'h13a2', transcript_path: transcript, cwd: clone });
  check('H13 hook: the same folder under the (real) temp folder stays quiet', c1q.status === 0 && c1q.stdout === '', c1q.stdout);
  await must(MCP, 'start_work', { project: NAME, path: clone, machine, link: true, label: 'h13 test' });
  const c2 = hook('session-start', { session_id: 'h13b', transcript_path: transcript, cwd: clone }, envOut);
  check('H13 hook: after start_work link the next session in that folder gets the brief', c2.status === 0 && ctxOf(c2).includes('Hooked brief line'), c2.stdout.slice(0, 200));
  const deep = path.join(clone, 'sub', 'dir');
  fs.mkdirSync(deep, { recursive: true });
  const c3 = hook('session-start', { session_id: 'h13c', transcript_path: transcript, cwd: deep }, envOut);
  check('H13 hook: a subfolder of a filed folder is the same project', c3.status === 0 && ctxOf(c3).includes('Hooked brief line'), c3.stdout.slice(0, 200));
  const scratch = mkRepo('scratch', 'https://github.com/acme/scratch-thing.git');
  const c4 = hook('session-start', { session_id: 'h13d', transcript_path: transcript, cwd: scratch }, envOut);
  await must(MCP, 'start_work', { path: scratch, machine, not_work_os: true });
  const c5 = hook('session-start', { session_id: 'h13e', transcript_path: transcript, cwd: scratch }, envOut);
  check('H13 hook: an unknown folder asks; once the person says not Work OS the next session prints nothing', /not filed in Work OS/.test(ctxOf(c4)) && c5.status === 0 && c5.stdout === '', `${c4.stdout.slice(0, 100)} | ${c5.stdout}`);
  const plainDir = path.join(tmp, 'plain-dir');
  fs.mkdirSync(plainDir);
  const c6 = hook('session-start', { session_id: 'h13f', transcript_path: transcript, cwd: plainDir }, envOut);
  check('H13 hook: a folder that is not a git repo asks too', c6.status === 0 && /not filed in Work OS/.test(ctxOf(c6)), c6.stdout.slice(0, 200));
  const c7 = hook('session-start', { session_id: 'h13g', transcript_path: transcript, cwd: plainDir }, { ...envOut, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  check('H13 hook: claude -p (entrypoint sdk-cli) prints nothing, even in an unfiled folder', c7.status === 0 && c7.stdout === '', c7.stdout);
  const c8 = hook('session-start', { session_id: 'h13h', transcript_path: transcript, cwd: plainDir }, { ...envOut, WORK_OS_KEY: 'wos_' + 'x'.repeat(40) });
  check('H13 hook: a key the server refuses still prints nothing (fail open, also unfiled)', c8.status === 0 && c8.stdout === '', c8.stdout);

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
