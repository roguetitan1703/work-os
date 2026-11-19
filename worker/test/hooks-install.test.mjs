import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hooks-install-'));
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'work-os-worker');
process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, 'claude', 'settings.json');
delete process.env.WORK_OS_KEY; // a PC with the key set in Claude Code settings passes it to every child process
const m = await import('../hooks-install.mjs');
const awaitedChildProcess = await import('node:child_process');
const settings = () => JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));

test('install copies the hook, merges ten events (eleven entries), keeps other settings and hooks, and is safe to rerun', () => {
  fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH), { recursive: true });
  const other = { type: 'command', command: 'node other.mjs' };
  fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH, JSON.stringify({ model: 'opus', env: { A: '1' }, hooks: { Stop: [{ hooks: [other] }] } }));
  const r = m.install();
  assert.ok(fs.existsSync(path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'hook.mjs')));
  assert.ok(fs.existsSync(path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'config.mjs')));
  assert.ok(fs.existsSync(path.join(process.env.WORK_OS_WORKER_DIR, 'hooks', 'secret.mjs')), 'the start hook reads the device key with it');
  assert.equal(r.signIn, null, 'no worker config and no WORK_OS_KEY: nothing to sign in with yet');
  fs.writeFileSync(path.join(process.env.WORK_OS_WORKER_DIR, 'config.json'), JSON.stringify({ baseUrl: 'https://x.example' }));
  assert.equal(m.install().signIn, 'worker', 'with the worker set up the hooks need no key');
  assert.equal(m.status().signIn, 'worker');
  process.env.WORK_OS_KEY = 'wos_' + 'k'.repeat(40);
  assert.equal(m.status().signIn, 'worker', 'the worker is first, the key only its fallback');
  delete process.env.WORK_OS_KEY;
  fs.rmSync(path.join(process.env.WORK_OS_WORKER_DIR, 'config.json'));
  let s = settings();
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { A: '1' });
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'PostToolBatch', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].async, undefined, 'the prompt hook is awaited: a message waiting for the session goes into its context');
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].timeout, 3);
  assert.equal(s.hooks.PostToolBatch[0].hooks[0].timeout, 3);
  assert.match(s.hooks.PostToolBatch[0].hooks[0].command, /hook\.mjs" tool-batch$/);
  assert.equal(s.hooks.Notification[0].hooks[0].async, true);
  assert.equal(s.hooks.Notification[0].matcher, 'permission_prompt|idle_prompt|elicitation_dialog');
  assert.equal(s.hooks.SessionEnd[0].hooks[0].async, undefined, 'SessionEnd is awaited');
  assert.equal(s.hooks.SessionEnd[0].hooks[0].timeout, 2);
  assert.equal(s.hooks.Stop.length, 3, 'the other Stop hook is kept, then the stop check and the idle wait');
  const wait = s.hooks.Stop.map(g => g.hooks[0]).find(h => /hook\.mjs" wait$/.test(h.command));
  assert.equal(wait.asyncRewake, true, 'the idle wait wakes the session when it ends with exit 2');
  assert.equal(wait.timeout, 3600);
  assert.equal(wait.async, undefined);
  assert.equal(s.hooks.Stop.map(g => g.hooks[0]).find(h => /hook\.mjs" stop$/.test(h.command)).asyncRewake, undefined);
  assert.equal(s.hooks.SessionStart.length, 2, 'the brief and the idle wait');
  assert.equal(s.hooks.SessionStart.find(g => /hook\.mjs" wait$/.test(g.hooks[0].command)).hooks[0].asyncRewake, true);
  assert.match(s.hooks.PostToolUse.find(h => /hook\.mjs" post-tool$/.test(h.hooks[0].command)).matcher, /\(save_state\|import_state\|get_state\|end_work\|log_progress\|set_doing\|hand_in\|complete_task\)$/, 'end_work is a save the copy follows, and a lane call counts as heard from');
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /hook\.mjs" pre-tool$/);
  assert.equal(s.hooks.PreToolUse[1].matcher, 'Bash|PowerShell');
  assert.match(s.hooks.PreToolUse[1].hooks[0].command, /hook\.mjs" tool-start$/);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].async, true, 'tool-start never delays the tool');
  assert.doesNotMatch(s.hooks.PreToolUse[0].hooks[0].command, /\\/, 'forward slashes only');
  m.install();
  s = settings();
  assert.equal(s.hooks.Stop.length, 3, 'rerun replaces its own entries, no duplicates');
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.deepEqual(m.status().events.sort(), ['Notification', 'PostToolBatch', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  assert.ok(fs.readdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH)).some((f) => f.startsWith('settings.json.bak-')), 'a backup is kept');
});

test('remove takes out only the Work OS entries', () => {
  assert.equal(m.remove(), true);
  const s = settings();
  assert.deepEqual(Object.keys(s.hooks), ['Stop']);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'node other.mjs');
  assert.equal(m.remove(), false);
});

const hooksOf = (dir) => path.join(dir, 'hooks');

test('install copies every FILES entry, removes a stray hook-*.mjs, and writes the entry commands as before', () => {
  const dir = path.join(tmp, 'work-os-worker-files');
  process.env.WORK_OS_WORKER_DIR = dir;
  m.install();
  for (const f of m.FILES) assert.ok(fs.existsSync(path.join(hooksOf(dir), f)), f);
  assert.equal(fs.readdirSync(hooksOf(dir)).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
  fs.writeFileSync(path.join(hooksOf(dir), 'hook-old.mjs'), 'export {};');
  fs.writeFileSync(path.join(hooksOf(dir), 'notes.txt'), 'keep');
  m.install();
  assert.equal(fs.existsSync(path.join(hooksOf(dir), 'hook-old.mjs')), false);
  assert.ok(fs.existsSync(path.join(hooksOf(dir), 'notes.txt')));
});

test('the entries equal the strings older workers wrote, except the PostToolUse matcher that now also lists end_work (H5) the session-state rows (H6) and the message rows (H7: PostToolBatch, the idle wait) and the subagent row (H9: SubagentStart)', () => {
  const h = 'C:/Users/x/AppData/Roaming/work-os-worker/hooks/hook.mjs';
  const c = (e, t) => ({ type: 'command', command: `node "${h}" ${e}`, timeout: t });
  const old = {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [c('session-start', 8)] }],
    Stop: [{ hooks: [c('stop', 8)] }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Read|Grep|Glob|mcp__.*__(write_note|propose_order|apply_changes|save_state|import_state|end_work)', hooks: [c('pre-tool', 5)] }],
    PostToolUse: [{ matcher: 'mcp__.*__(save_state|import_state|get_state|end_work|log_progress|set_doing|hand_in|complete_task)', hooks: [c('post-tool', 20)] }],
  };
  // H9: the subagent row reads only the session's marker (no network), so a repo's cloud entries have it too.
  const sub = { SubagentStart: [{ hooks: [c('subagent-start', 2)] }] };
  assert.deepEqual(m.entries(h, '', { cloud: true }), { ...old, ...sub }, 'a repo gets the four cloud entries and the subagent one only');
  const rewake = (e) => ({ ...c(e, 3600), asyncRewake: true });
  assert.deepEqual(m.entries(h), {
    ...old,
    SessionStart: [...old.SessionStart, { matcher: 'startup|resume|clear|compact', hooks: [rewake('wait')] }],
    Stop: [...old.Stop, { hooks: [rewake('wait')] }],
    UserPromptSubmit: [{ hooks: [c('user-prompt', 3)] }],
    PostToolBatch: [{ hooks: [c('tool-batch', 3)] }],
    Notification: [{ matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: [{ ...c('notification', 3), async: true }] }],
    SessionEnd: [{ hooks: [c('session-end', 2)] }],
    PreToolUse: [...old.PreToolUse, { matcher: 'Bash|PowerShell', hooks: [{ ...c('tool-start', 3), async: true }] }], // a running tool keeps the session working: async, a PC's own hook
    SubagentStop: [{ hooks: [c('subagent-stop', 3)] }], // Lanes step 3: a PC's own hook (localOnly), so a repo's cloud entries leave it out
    ...sub,
  });
});

test('every EVENTS row has its hook file, its FILES entry and exactly one settings entry', async () => {
  const { EVENTS } = await import('../hook-lib.mjs');
  const e = m.entries('C:/x/hooks/hook.mjs');
  assert.equal(Object.keys(e).length, new Set(EVENTS.map(r => r.claudeEvent)).size);
  for (const row of EVENTS) {
    assert.ok(m.FILES.includes(`hook-${row.event}.mjs`), row.event);
    assert.equal(e[row.claudeEvent].filter(g => g.hooks[0].command.endsWith(` ${row.event}`)).length, 1);
    assert.ok(fs.existsSync(new URL(`../hook-${row.event}.mjs`, import.meta.url)), row.event);
  }
});

test('the hooks version changes when any file changes', () => {
  const dir = path.join(tmp, 'copy-of-worker');
  fs.mkdirSync(dir);
  for (const f of m.FILES) fs.copyFileSync(new URL(`../${f}`, import.meta.url), path.join(dir, f));
  const v = m.hooksVersion(dir);
  assert.equal(v, m.hooksVersion());
  for (const f of m.FILES) {
    fs.appendFileSync(path.join(dir, f), '// x');
    assert.notEqual(m.hooksVersion(dir), v, f);
    fs.copyFileSync(new URL(`../${f}`, import.meta.url), path.join(dir, f));
  }
});

test('a second worker folder does not take over the global hooks, and its refresh skips them', () => {
  const a = path.join(tmp, 'work-os-worker-a'); const b = path.join(tmp, 'work-os-worker-b');
  process.env.WORK_OS_WORKER_DIR = a;
  m.install({ force: true });
  const before = fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8');
  process.env.WORK_OS_WORKER_DIR = b;
  assert.throws(() => m.install(), /not this worker folder/);
  assert.equal(m.refreshIfStale(), null, 'b has no installed version, so it looks stale, but the entries are in folder a');
  assert.equal(fs.existsSync(path.join(b, 'hooks')), false);
  assert.equal(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'), before);
  m.install({ force: true });
  assert.ok(JSON.stringify(settings().hooks).includes('work-os-worker-b/hooks/hook.mjs'));
  assert.ok(fs.existsSync(path.join(b, 'hooks', 'hook-lib.mjs')));
  process.env.WORK_OS_WORKER_DIR = a;
  assert.equal(m.refreshIfStale(), null, 'now b owns the entries: a leaves them alone');
  m.remove();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hooks repo: files under .claude/work-os, five cloud entries (the four and the subagent one), other settings kept, safe to rerun', () => {
  const { execFileSync } = awaitedChildProcess;
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hooks-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, '.claude'));
    const other = { type: 'command', command: 'node other.mjs' };
    fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [other] }] } }));
    const r = m.repo(repoDir, { server: 'https://work.example' });
    for (const f of m.FILES) assert.ok(fs.existsSync(path.join(repoDir, '.claude', 'work-os', f)), f);
    const read = () => JSON.parse(fs.readFileSync(path.join(repoDir, '.claude', 'settings.json'), 'utf8'));
    const first = fs.readFileSync(r.settings, 'utf8');
    let s = read();
    assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] }, 'permissions untouched');
    assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart']);
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/work-os/hook.mjs" session-start --cloud --server \"https://work.example\"');
    assert.equal(s.hooks.PostToolUse[0].hooks[0].timeout, 20);
    m.repo(repoDir, { server: 'https://work.example' });
    assert.equal(fs.readFileSync(r.settings, 'utf8'), first, 'rerun changes nothing');
    m.repo(path.join(repoDir, '.claude'), { server: 'https://other.example' });
    s = read();
    assert.equal(s.hooks.Stop.length, 2);
    assert.match(s.hooks.Stop[1].hooks[0].command, /--server "https:\/\/other\.example"$/, 'a rerun from a subfolder finds the repo top and replaces the entries');
    assert.throws(() => m.repo(os.tmpdir(), { server: 'https://x.example' }), /not inside a git repo/);
    assert.throws(() => m.repo(repoDir, { server: 'http://example.com' }), /https/);
  } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
});

test('a worker folder not named work-os-worker: two installs leave no duplicates, and status and remove see the entries', () => {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-odd-'));
  const keepS = process.env.CLAUDE_SETTINGS_PATH; const keepD = process.env.WORK_OS_WORKER_DIR;
  try {
    process.env.CLAUDE_SETTINGS_PATH = path.join(t2, 'settings.json');
    process.env.WORK_OS_WORKER_DIR = path.join(t2, 'elsewhere');
    m.install({ force: true });
    m.install({ force: true });
    const s = JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, 'utf8'));
    assert.equal(s.hooks.Stop.length, 2, 'the stop check and the idle wait');
    assert.equal(s.hooks.SessionStart.length, 2, 'the brief and the idle wait');
    assert.equal(m.status().events.length, 10);
    assert.equal(m.refreshIfStale(), null);
    assert.equal(m.remove(), true);
    assert.equal(m.status().events.length, 0);
  } finally { process.env.CLAUDE_SETTINGS_PATH = keepS; process.env.WORK_OS_WORKER_DIR = keepD; fs.rmSync(t2, { recursive: true, force: true }); }
});

test('hooks repo quotes the server origin and refuses a linked .claude/work-os', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-repo-link-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-repo-target-'));
  try {
    awaitedChildProcess.execFileSync('git', ['init', '-q'], { cwd: dir });
    const r = m.repo(dir, { server: 'https://work.example/path?x=1;rm' });
    assert.equal(r.server, 'https://work.example');
    assert.match(fs.readFileSync(r.settings, 'utf8'), /--server \\"https:\/\/work\.example\\"/);
    fs.rmSync(path.join(dir, '.claude', 'work-os'), { recursive: true, force: true });
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    try { fs.symlinkSync(target, path.join(dir, '.claude', 'work-os'), 'junction'); } catch { return; } // the OS refused the link
    assert.throws(() => m.repo(dir, { server: 'https://work.example' }), /link or not a folder/);
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')));
    assert.equal(fs.readdirSync(target).length, 1, 'nothing was written through the link');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
});

test('H8: the production blocks ship with the hooks (hook-release.mjs and remote.mjs are in FILES) and import only files that ship; no new event', async () => {
  assert.ok(m.FILES.includes('hook-release.mjs') && m.FILES.includes('remote.mjs'));
  for (const f of ['hook-release.mjs', 'remote.mjs', 'hook-pre-tool.mjs']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const imp of src.matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) assert.ok(m.FILES.includes(imp[1]), `${f} imports ${imp[1]}, which is not in FILES`);
  }
  const { EVENTS } = await import('../hook-lib.mjs');
  assert.equal(EVENTS.filter(r => r.event === 'pre-tool').length, 1);
  assert.match(EVENTS.find(r => r.event === 'pre-tool').matcher, /Bash\|PowerShell/, 'the one pre-tool row already covers Bash and PowerShell');
  assert.equal(EVENTS.length, 13, 'H8 adds no event row (ten, plus H9 subagent-start, plus Lanes step 3 subagent-stop, plus tool-start)');
});

test('H13 hooks repo --project: the project id goes into the four entries, a name is refused, none keeps the old entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-repo-project-'));
  try {
    awaitedChildProcess.execFileSync('git', ['init', '-q'], { cwd: dir });
    const r = m.repo(dir, { server: 'https://work.example', project: 'cutroom-a1b2c3d4' });
    assert.equal(r.project, 'cutroom-a1b2c3d4');
    const s = JSON.parse(fs.readFileSync(r.settings, 'utf8'));
    const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    assert.equal(cmds.length, 5); // H9 added the SubagentStart entry after this test was written (4 then)
    assert.ok(cmds.every((c) => c.endsWith(' --project "cutroom-a1b2c3d4"') && c.includes(' --cloud ')), cmds.join('\n'));
    for (const bad of ['Cutroom Site', 'a"b', 'x; rm -rf', '../up', '', 'A']) assert.throws(() => m.repo(dir, { server: 'https://work.example', project: bad }), /project id/, bad);
    const again = m.repo(dir, { server: 'https://work.example' });
    assert.equal(again.project, null);
    const cmds2 = Object.values(JSON.parse(fs.readFileSync(again.settings, 'utf8')).hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds2.every((c) => !c.includes('--project')), 'a rerun without --project replaces the entries without it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
