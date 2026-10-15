import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchesClaudeProcess } from './launch.mjs';

// Activity counts (docs/launcher.md "Activity counts"). Read-only, numbers only:
// process command lines are looked at but never leave this machine; transcript files are
// only stat()ed (mtime), never opened or read.

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

export async function collectActivity({ listProcesses, workOsIds = [], root, now = Date.now() }) {
  const procs = await listProcesses();
  const s = countSessions(procs, workOsIds);
  const t = scanTranscripts(root, now);
  return { ...s, sessionsActive: t.sessionsActive, subagents: t.subagents, at: now };
}
