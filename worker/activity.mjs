import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesClaudeProcess } from './launch.mjs';

// Activity counts and the named session list (docs/launcher.md "Activity counts").
// Counts: numbers only, transcripts only stat()ed. Session list: per session only sessionId, the
// folder NAME (last path segment), a title (<= 80 chars) and a few numbers/flags. The title comes from
// the title records Claude Code writes into the transcript (custom-title, ai-title, agent-name, summary);
// message text is never read into the payload. Process command lines never leave this machine.

export const ACTIVE_MS = 2 * 60_000; // a transcript modified this recently counts as active
export const DIR_MAX_AGE_MS = 24 * 3600_000; // a subagents folder untouched this long is not visited
const MAX_STATS = 20000;

const isClaudeName = (t) => /^claude(\.exe)?$/i.test(String(t).replace(/^"|"$/g, '').split(/[\\/]/).pop());
const tokens = (cmd) => cmd.match(/"[^"]*"|\S+/g) || [];
const unq = (t) => t.replace(/^"|"$/g, '');
const NON_SESSION = new Set(['mcp', 'update', 'upgrade', 'doctor', 'install', 'config', 'setup-token', 'migrate-installer', 'plugin', 'plugins', 'agents', 'auth', 'api-key']);

export function isClaudeProcess(p) {
  const cmd = String((p && p.cmd) || '');
  if (!cmd) return false;
  return p.name ? isClaudeName(p.name) : tokens(cmd).slice(0, 2).some(isClaudeName);
}

// A command that is not an interactive/SDK session: `claude mcp serve`, `claude update`, `claude --version`.
export function isHelperCommand(cmd) {
  const t = tokens(cmd);
  const i = t.findIndex(isClaudeName);
  const args = t.slice(i + 1).map(unq);
  if (args.some((a) => a === '--version' || a === '-v' || a === '--help' || a === '-h')) return true;
  const first = args.find((a) => !a.startsWith('-'));
  return !!first && NON_SESSION.has(first) && args.indexOf(first) === 0;
}

function sessionIdOf(cmd) {
  const m = cmd.match(/--(?:session-id|resume)(?:=|\s+)"?([0-9a-fA-F-]{36})\b/);
  return m ? m[1].toLowerCase() : null;
}

// procs: [{pid, ppid?, name?, cmd}], workOsIds: session ids this worker started (running).
// One count per session: helper commands are skipped, a claude process whose parent is another
// claude process is a child of that session, and repeated session ids count once.
export function countSessions(procs, workOsIds = []) {
  const claude = (procs || []).filter((p) => p && Number.isInteger(p.pid) && isClaudeProcess(p) && !isHelperCommand(p.cmd));
  const pids = new Set(claude.map((p) => p.pid));
  const seen = new Set();
  let sessions = 0;
  let sessionsWorkOs = 0;
  for (const p of claude) {
    if (p.ppid !== undefined && pids.has(p.ppid) && p.ppid !== p.pid) continue;
    const sid = sessionIdOf(p.cmd);
    if (sid) { if (seen.has(sid)) continue; seen.add(sid); }
    sessions++;
    if (workOsIds.some((id) => matchesClaudeProcess(p, id))) sessionsWorkOs++;
  }
  return { sessions, sessionsWorkOs, sessionsOther: sessions - sessionsWorkOs };
}

export function defaultProjectsRoot() {
  return path.join(process.env.WORK_OS_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects'));
}

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };

// stat only. Returns { subagents, sessionsActive }.
//   subagents: <project>/<session>/subagents/agent-*.jsonl modified within ACTIVE_MS
//   sessionsActive: <project>/<session>.jsonl modified within ACTIVE_MS
export function scanTranscripts(root = defaultProjectsRoot(), nowMs = Date.now()) {
  const out = { subagents: 0, sessionsActive: 0 };
  let stats = 0;
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (stats > MAX_STATS) return out;
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        stats++;
        const m = mtime(path.join(pdir, e.name));
        if (m !== null && nowMs - m <= ACTIVE_MS) out.sessionsActive++;
      } else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents');
        stats++;
        const dm = mtime(sub); // changes when an agent file is created
        if (dm === null || nowMs - dm > DIR_MAX_AGE_MS) continue;
        let files;
        try { files = fs.readdirSync(sub); } catch { continue; }
        for (const f of files) {
          if (!/^agent-.*\.jsonl$/.test(f)) continue;
          stats++;
          const m = mtime(path.join(sub, f));
          if (m !== null && nowMs - m <= ACTIVE_MS) out.subagents++;
        }
      }
    }
  }
  return out;
}

// Claude Code keeps a folder's transcripts in ~/.claude/projects/<folder path, every non-alphanumeric as '-'>.
export const projectDirName = (folder) => String(folder).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
// onlyRoots (config sessionsInRootsOnly, e.g. a demo worker): a project dir is kept only when its folder is a root or inside one.
// The dir name has no path separators, so a sibling whose name starts with the root's (D:\demo-old for root D:\demo) also
// passes: give such a root a distinctive name.
export function rootsFilter(roots) {
  if (!roots) return null;
  const pre = roots.map((r) => projectDirName(String(r).replace(/[\\/]+$/, '')));
  return (name) => { const n = name.toLowerCase(); return pre.some((r) => n === r || n.startsWith(r + '-')); };
}

export async function collectActivity({ listProcesses, workOsIds = [], root, now = Date.now(), withSessions = false, onlyRoots = null }) {
  const procs = await listProcesses();
  const keep = rootsFilter(onlyRoots);
  if (keep) {
    // Only sessions under the roots: counts come from the filtered list, so nothing about other sessions is sent.
    const list = listSessions({ procs, workOsIds, root, now, keep });
    const run = list.filter((s) => s.running);
    const sessionsWorkOs = run.filter((s) => s.startedByWorkOs).length;
    const counts = { sessions: run.length, sessionsWorkOs, sessionsOther: run.length - sessionsWorkOs, sessionsActive: list.filter((s) => now - s.lastActiveAt <= ACTIVE_MS).length, subagents: list.reduce((n, s) => n + s.subagentsActive, 0), at: now };
    return withSessions ? { counts, list } : counts;
  }
  const s = countSessions(procs, workOsIds);
  const t = scanTranscripts(root, now);
  const counts = { ...s, sessionsActive: t.sessionsActive, subagents: t.subagents, at: now };
  return withSessions ? { counts, list: listSessions({ procs, workOsIds, root, now }) } : counts;
}

// ── Named session list ──────────────────────────────────────────────────────

export const LIST_WINDOW_MS = 10 * 60_000; // a transcript modified this recently is listed even with no process
export const MAX_LISTED = 50;
export const MAX_TITLE = 80;
export const MAX_FOLDER = 80;
const TAIL_BYTES = 512 * 1024;
const HEAD_BYTES = 128 * 1024;
const UNMAPPED_WINDOW_MS = 24 * 3600_000;
const SID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Title record types, best first: a name the user gave (custom-title), Claude's generated title, an agent name, an old summary.
const TITLE_KINDS = [
  ['custom-title', 'customTitle'],
  ['ai-title', 'aiTitle'],
  ['agent-name', 'agentName'],
  ['summary', 'summary'],
];

export const lastSegment = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).pop() || '';
const oneLine = (s, max) => String(s).replace(/\s+/g, ' ').trim().slice(0, max);

function readChunk(file, size, fromEnd) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    const n = Math.min(size, len);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, fromEnd ? len - n : 0);
    let text = buf.toString('utf8');
    if (fromEnd && len > n) text = text.slice(text.indexOf('\n') + 1); // drop the cut first line
    return text;
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Returns { title, cwdName } from a chunk of transcript text. Only title records are parsed; the cwd is
// pulled out with a pattern and reduced to its last segment at once. Nothing else is kept.
function inspect(text, found) {
  for (const line of text.split('\n')) {
    if (line.length > 20000) continue;
    for (const [type, key] of TITLE_KINDS) {
      if (line.includes(`"${type}"`) && line.includes(`"${key}"`)) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o && o.type === type && typeof o[key] === 'string' && o[key].trim()) found.titles[type] = oneLine(o[key], MAX_TITLE); // later lines win
      }
    }
    if (!found.cwdName) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) { try { found.cwdName = oneLine(lastSegment(JSON.parse(`"${m[1]}"`)), MAX_FOLDER); } catch {} }
    }
  }
}

export function readSessionMeta(file) {
  const found = { titles: {}, cwdName: '' };
  inspect(readChunk(file, TAIL_BYTES, true), found);
  const best = () => TITLE_KINDS.map(([t]) => found.titles[t]).find(Boolean) || '';
  if (!best() || !found.cwdName) inspect(readChunk(file, HEAD_BYTES, false), found);
  return { title: best(), folder: found.cwdName };
}

function nameArg(cmd) {
  const m = String(cmd).match(/--name(?:=|\s+)(?:"([^"]*)"|(\S+))/);
  return m ? oneLine(m[1] ?? m[2], MAX_TITLE) : '';
}

// procs: process list. Returns { byId: Map(sessionId -> {pid, name}), unmapped: number } over real session processes.
export function sessionProcs(procs) {
  const claude = (procs || []).filter((p) => p && Number.isInteger(p.pid) && isClaudeProcess(p) && !isHelperCommand(p.cmd));
  const pids = new Set(claude.map((p) => p.pid));
  const byId = new Map();
  let unmapped = 0;
  for (const p of claude) {
    if (p.ppid !== undefined && pids.has(p.ppid) && p.ppid !== p.pid) continue;
    const sid = sessionIdOf(p.cmd);
    if (sid) { if (!byId.has(sid)) byId.set(sid, { name: nameArg(p.cmd) }); }
    else unmapped++;
  }
  return { byId, unmapped };
}

// Active Claude Code sessions: a running claude process, or a transcript written in the last LIST_WINDOW_MS.
// A process without a session id in its arguments (a plain terminal or VS Code session) cannot be tied to a
// transcript by id, so each one is matched to the most recently written transcript not already tied to a process
// (best effort, within a day).
// keep (optional): project dir name filter; with it, processes without a session id are not matched (they could be anyone's).
export function listSessions({ procs, workOsIds = [], root = defaultProjectsRoot(), now = Date.now(), keep = null }) {
  const { byId, unmapped: allUnmapped } = sessionProcs(procs);
  const unmapped = keep ? 0 : allUnmapped;
  const files = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  let stats = 0;
  for (const proj of projects) {
    if (!proj.isDirectory() || (keep && !keep(proj.name))) continue;
    const pdir = path.join(root, proj.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const m = e.isFile() && SID_FILE.exec(e.name);
      if (!m || ++stats > MAX_STATS) continue;
      const mt = mtime(path.join(pdir, e.name));
      if (mt !== null) files.push({ sid: m[1].toLowerCase(), file: path.join(pdir, e.name), dir: path.join(pdir, m[1]), mt });
    }
  }
  files.sort((a, b) => b.mt - a.mt);
  const chosen = new Map();
  for (const f of files) if (byId.has(f.sid) && !chosen.has(f.sid)) chosen.set(f.sid, { ...f, running: true });
  let slots = unmapped;
  for (const f of files) {
    if (chosen.has(f.sid)) continue;
    if (slots > 0 && now - f.mt <= UNMAPPED_WINDOW_MS) { chosen.set(f.sid, { ...f, running: true }); slots--; }
    else if (now - f.mt <= LIST_WINDOW_MS) chosen.set(f.sid, { ...f, running: false });
  }
  const wos = new Set(workOsIds.map((i) => String(i).toLowerCase()));
  const out = [];
  for (const f of [...chosen.values()].sort((a, b) => b.mt - a.mt).slice(0, MAX_LISTED)) {
    const meta = readSessionMeta(f.file);
    const folder = meta.folder || 'unknown';
    let subagentsActive = 0;
    const sub = path.join(f.dir, 'subagents');
    const dm = mtime(sub);
    if (dm !== null && now - dm <= DIR_MAX_AGE_MS) {
      try {
        for (const n of fs.readdirSync(sub)) {
          if (!/^agent-.*\.jsonl$/.test(n)) continue;
          const m = mtime(path.join(sub, n));
          if (m !== null && now - m <= ACTIVE_MS) subagentsActive++;
        }
      } catch {}
    }
    out.push({
      sessionId: f.sid,
      folder,
      title: meta.title || (byId.get(f.sid) && byId.get(f.sid).name) || folder,
      lastActiveAt: Math.round(f.mt),
      subagentsActive: Math.min(subagentsActive, 99),
      startedByWorkOs: wos.has(f.sid),
      running: f.running,
    });
  }
  return out;
}
