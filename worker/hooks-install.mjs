// Installs the Work OS hooks (hook.mjs) into Claude Code's user settings on this PC (docs/setup-pc.md).
//   node worker.mjs hooks install   copy hook.mjs + config.mjs to <worker config dir>/hooks and merge the hook entries
//                                   into ~/.claude/settings.json (a dated backup first; other settings and hooks kept)
//   node worker.mjs hooks remove    take the Work OS entries out again
//   node worker.mjs hooks status    say what is installed
// Never touches ~/.claude.json. Safe to run again (it replaces its own entries only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const settingsPath = () => process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
export const hooksDir = () => path.join(configDir(), 'hooks');
const MARK = 'work-os-worker'; // every entry we write runs a hook.mjs inside the worker config dir

/** The hook entries, by Claude Code event. `hook` is the absolute path of the installed hook.mjs. */
export function entries(hook) {
  const h = hook.split(path.sep).join('/');
  const c = (e, t) => ({ type: 'command', command: `node "${h}" ${e}`, timeout: t });
  return {
    // The brief (Orders, State, tasks) at start and after every compaction. Needs WORK_OS_KEY (see docs/setup-pc.md).
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [c('session-start', 8)] }],
    // Files changed and State not saved: hold the session once and ask for save_state.
    Stop: [{ hooks: [c('stop', 8)] }],
    // Refuse hand edits of WORK-STATE.md (it is a copy of the Work OS State).
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [c('pre-tool', 5)] }],
    // After a State save or read: write WORK-STATE.md from the answer and commit that file alone.
    PostToolUse: [{ matcher: 'mcp__.*__(save_state|import_state|get_state)', hooks: [c('post-tool', 20)] }],
  };
}

const ours = (group) => (group?.hooks || []).some((x) => String(x.command || '').includes(MARK) && /hook\.mjs/.test(String(x.command || '')));
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${f} is not valid JSON; fix it first (${e.message})`); } };

/** The settings object with our entries removed (and empty events dropped). */
export function withoutOurs(settings) {
  const s = { ...settings };
  if (!s.hooks) return s;
  const hooks = {};
  for (const [ev, groups] of Object.entries(s.hooks)) {
    const keep = (groups || []).filter((g) => !ours(g));
    if (keep.length) hooks[ev] = keep;
  }
  if (Object.keys(hooks).length) s.hooks = hooks; else delete s.hooks;
  return s;
}

export function merge(settings, hook) {
  const s = withoutOurs(settings);
  s.hooks = { ...(s.hooks || {}) };
  for (const [ev, groups] of Object.entries(entries(hook))) s.hooks[ev] = [...(s.hooks[ev] || []), ...groups];
  return s;
}

function write(f, obj) {
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n');
}

export function install() {
  const dir = hooksDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['hook.mjs', 'config.mjs']) fs.copyFileSync(path.join(here, f), path.join(dir, f));
  const hook = path.join(dir, 'hook.mjs');
  const f = settingsPath();
  write(f, merge(read(f), hook));
  return { hook, settings: f, key: !!(read(f).env?.WORK_OS_KEY || process.env.WORK_OS_KEY) };
}

export function remove() {
  const f = settingsPath();
  const s = read(f);
  if (!s.hooks || !Object.values(s.hooks).flat().some(ours)) return false;
  write(f, withoutOurs(s));
  return true;
}

export function status() {
  const s = read(settingsPath());
  const events = Object.entries(s.hooks || {}).filter(([, g]) => (g || []).some(ours)).map(([ev]) => ev);
  return { settings: settingsPath(), events, hookFile: fs.existsSync(path.join(hooksDir(), 'hook.mjs')), key: !!s.env?.WORK_OS_KEY };
}

export function cli(sub) {
  if (sub === 'install') {
    const r = install();
    console.log(`Work OS hooks installed in ${r.settings} (hook: ${r.hook}).`);
    console.log(r.key ? 'WORK_OS_KEY is set: the start brief and the stop check are on.' : 'No WORK_OS_KEY yet: the WORK-STATE.md copy and edit guard work now; the start brief and the stop check turn on when you add a Claude Code key (docs/setup-pc.md).');
    console.log('Open Claude Code sessions pick this up on their next tool call; restart them to get the start brief.');
  } else if (sub === 'remove') console.log(remove() ? 'Work OS hooks removed.' : 'No Work OS hooks were installed.');
  else if (sub === 'status') console.log(JSON.stringify(status(), null, 2));
  else { console.error('usage: node worker.mjs hooks [install|remove|status]'); process.exitCode = 2; }
}
