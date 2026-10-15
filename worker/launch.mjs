import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { insideRoot } from './validate.mjs';
import { promisify } from 'node:util';
import { macScript, asEscape } from './quote.mjs';

const execFileP = promisify(execFile);

// claude args: --session-id|--resume <id>, --name <projectName>,
// --remote-control=<name> (one token, so the optional name can never swallow the next argument), optional prompt last.
export function claudeArgs({ kind, sessionId, projectName, prompt }) {
  // No --permission-mode: the user's own Claude default applies (Om's choice).
  const a = [kind === 'resume' ? '--resume' : '--session-id', sessionId];
  const name = String(projectName || 'claude').replace(/\s+/g, ' ').slice(0, 120);
  if (projectName) a.push('--name', name);
  a.push('--remote-control=' + name);
  if (prompt) a.push(prompt.startsWith('-') ? ' ' + prompt : prompt); // never let a prompt read as a flag
  return a;
}

// wt.exe treats ';' as a command separator; escape it so a prompt cannot add wt commands.
const wtEsc = (s) => String(s).replace(/;/g, '\\;');

// wt runs `node run-claude.mjs <claudePath> <args...>`: the wrapper runs claude (no shell) and exits 0
// when it ends, so wt closes the tab (including after Stop kills claude).
export const WRAPPER = fileURLToPath(new URL('./run-claude.mjs', import.meta.url));
export function windowsWtArgs(folder, title, claudePath, cargs, nodePath = process.execPath, wrapper = WRAPPER) {
  return ['-w', 'new', '-d', folder, '--title', title, nodePath, wrapper, claudePath, ...cargs].map(wtEsc);
}

// Absolute path of claude, never from inside an allowed root (a planted claude.exe / claude.cmd in a
// repo must not be runnable). PATH first, then the standard install locations, because a worker started
// at logon can see an incomplete PATH.
export function resolveClaude(roots, which = defaultWhich, known = knownClaudePaths, exists = fs.existsSync) {
  for (const p of which()) {
    if (path.isAbsolute(p) && !insideRoot(p, roots)) return p;
  }
  for (const p of known()) {
    if (path.isAbsolute(p) && !insideRoot(p, roots) && exists(p)) return p;
  }
  return null;
}
export function knownClaudePaths(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return [path.join(home, '.local', 'bin', 'claude.exe')];
  return [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}
function defaultWhich() {
  try {
    const cmd = process.platform === 'win32' ? ['where', ['claude']] : ['which', ['-a', 'claude']];
    return execFileSync(cmd[0], cmd[1], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

// Exact command-line match for a session this worker launched.
export function matchesSession(cmd, sid) {
  return cmd.includes('--session-id ' + sid) || cmd.includes('--resume ' + sid);
}

// A claude process (image name claude / claude.exe) for this session; never the wrapper or any other node/shell process.
export function matchesClaudeProcess(p, sid) {
  const isClaude = (t) => /^claude(\.exe)?$/i.test(String(t).replace(/^"|"$/g, '').split(/[\/]/).pop());
  // Windows gives the image name; elsewhere use the program (or, for `node <script>`, the script) in the command line.
  const ok = p.name ? isClaude(p.name) : (p.cmd.match(/"[^"]*"|\S+/g) || []).slice(0, 2).some(isClaude);
  return ok && matchesSession(p.cmd, sid);
}

function spawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, ...opts });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function launch({ kind, folder, sessionId, projectName, prompt, claudePath }) {
  if (!claudePath) throw new Error('claude not found on PATH outside the allowed roots');
  const cargs = claudeArgs({ kind, sessionId, projectName, prompt });
  const title = projectName || 'claude';
  if (process.platform === 'win32') {
    try {
      await spawnDetached('wt.exe', windowsWtArgs(folder, title, claudePath, cargs));
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new Error('Install Windows Terminal (wt.exe)');
      throw e;
    }
  } else if (process.platform === 'darwin') {
    const cmd = macScript(folder, claudePath, cargs.map((c) => c.replace(/\r?\n/g, ' '))) + '; exit';
    await execFileP('osascript', ['-e', `tell application "Terminal" to do script "${asEscape(cmd)}"`]);
  } else throw new Error('unsupported platform');
}

// [{pid, name?, cmd}] for claude.exe processes (Windows) or everything (macOS).
export async function listProcesses() {
  if (process.platform === 'win32') {
    const script = "@(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress";
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16e6, timeout: 30000 });
    if (!stdout.trim()) return [];
    let j = JSON.parse(stdout);
    if (!Array.isArray(j)) j = [j];
    return j.filter((p) => p && p.CommandLine && p.ProcessId !== process.pid).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine }));
  }
  const { stdout } = await execFileP('ps', ['-axo', 'pid,ppid,command'], { maxBuffer: 16e6, timeout: 30000 });
  return stdout.split('\n').slice(1).map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }))
    .filter((p) => p.pid !== process.pid && !/\bosascript\b/.test(p.cmd));
}

export async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bad pid');
  if (process.platform === 'win32') await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']);
  else process.kill(pid, 'SIGTERM');
}
