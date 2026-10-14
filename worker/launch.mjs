import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macScript, asEscape } from './quote.mjs';

const execFileP = promisify(execFile);

// claude args: --session-id|--resume <id>, --name <projectName>, optional prompt last.
export function claudeArgs({ kind, sessionId, projectName, prompt }) {
  const a = [kind === 'resume' ? '--resume' : '--session-id', sessionId];
  if (projectName) a.push('--name', String(projectName).slice(0, 120));
  if (prompt) a.push(prompt.startsWith('-') ? ' ' + prompt : prompt); // never let a prompt read as a flag
  return a;
}

// wt.exe treats ';' as a command separator; escape it so a prompt cannot add wt commands.
const wtEsc = (s) => String(s).replace(/;/g, '\\;');

export function windowsWtArgs(folder, title, cargs) {
  return ['-w', 'new', '-d', folder, '--title', title, 'claude', ...cargs].map(wtEsc);
}

// cmd.exe fallback: reject characters that cmd would interpret even inside quotes.
export function windowsCmdLine(folder, cargs) {
  const bad = /["%^!\r\n`]/;
  for (const v of [folder, ...cargs]) if (bad.test(v)) throw new Error('value has characters unsafe for the cmd.exe fallback');
  const q = (v) => `"${v}"`;
  return `/c start "" /D ${q(folder)} claude ${cargs.map(q).join(' ')}`;
}

function spawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, ...opts });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function launch({ kind, folder, sessionId, projectName, prompt }) {
  const cargs = claudeArgs({ kind, sessionId, projectName, prompt });
  const title = projectName || 'claude';
  if (process.platform === 'win32') {
    try {
      await spawnDetached('wt.exe', windowsWtArgs(folder, title, cargs));
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
      await spawnDetached('cmd.exe', [windowsCmdLine(folder, cargs)], { windowsVerbatimArguments: true });
    }
  } else if (process.platform === 'darwin') {
    const cmd = macScript(folder, cargs.map((c) => c.replace(/\r?\n/g, ' ')));
    await execFileP('osascript', ['-e', `tell application "Terminal" to do script "${asEscape(cmd)}"`]);
  } else throw new Error('unsupported platform');
}

// [{pid, cmd}] for node/claude processes (Windows) or everything (macOS).
export async function listProcesses() {
  if (process.platform === 'win32') {
    const script = "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='claude.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress";
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16e6, timeout: 30000 });
    if (!stdout.trim()) return [];
    let j = JSON.parse(stdout);
    if (!Array.isArray(j)) j = [j];
    return j.filter((p) => p && p.CommandLine && p.ProcessId !== process.pid).map((p) => ({ pid: p.ProcessId, cmd: p.CommandLine }));
  }
  const { stdout } = await execFileP('ps', ['-axo', 'pid,command'], { maxBuffer: 16e6, timeout: 30000 });
  return stdout.split('\n').slice(1).map((l) => l.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
    .filter((p) => p.pid !== process.pid && !/\bosascript\b/.test(p.cmd));
}

export async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bad pid');
  if (process.platform === 'win32') await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']);
  else process.kill(pid, 'SIGTERM');
}
