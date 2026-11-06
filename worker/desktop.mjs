import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

// "Open in Claude Desktop": the documented link claude://code/new?q=<prompt>&folder=<absolute folder> (Anthropic support,
// "Open Claude Desktop with a link"). It opens the Code tab with the composer filled in; Claude Desktop asks the person to
// confirm the folder (any folder from a link is treated as untrusted) and nothing is sent until they press Enter.
// Only q and folder are used (both documented); values are URL-encoded; q is cut at the documented ~14,000 characters
// (ours is far shorter). The URL is handed to the OS directly with an argument array, never through a shell:
// Windows explorer.exe (absolute path under SystemRoot), macOS `open`. Claude Desktop does not exist for Linux.

export const MAX_Q = 14000;

export function desktopUrl(folder, prompt) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\u0000-\u001f]/.test(folder)) throw new Error('bad folder');
  let u = 'claude://code/new?';
  if (typeof prompt === 'string' && prompt) u += 'q=' + encodeURIComponent(prompt.slice(0, MAX_Q)) + '&';
  return u + 'folder=' + encodeURIComponent(folder);
}

// [command, args] that hands the URL to the OS, or null where Claude Desktop does not exist.
export function desktopCommand(url, platform = process.platform, env = process.env) {
  if (platform === 'win32') return [path.join(env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [url]];
  if (platform === 'darwin') return ['/usr/bin/open', [url]];
  return null;
}

// Is a claude:// handler registered? Windows: the registry (read-only query). Elsewhere: assume yes (the OS says if not).
export function desktopRegistered(platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCR\\claude\\shell\\open\\command', '/ve'], { timeout: 10000, windowsHide: true }, (err) => resolve(!err));
  });
}

function spawnOs(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openInDesktop({ folder, prompt, platform = process.platform, env = process.env, registeredFn = desktopRegistered, spawnFn = spawnOs }) {
  const url = desktopUrl(folder, prompt);
  const cmd = desktopCommand(url, platform, env);
  if (!cmd) throw new Error('Claude Desktop is not available on this computer');
  if (!(await registeredFn(platform))) throw new Error('Claude Desktop is not installed on this PC');
  await spawnFn(cmd[0], cmd[1]);
}
