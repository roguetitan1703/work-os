import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { insideRoot, UUID_RE } from './validate.mjs';

// "Open in VS Code": `Code.exe <folder>` (reuses the window already showing that folder), then
// `Code.exe --open-url -- vscode://anthropic.claude-code/open?session=<id>`, which is exactly what Windows runs
// for a vscode:// link. The Claude Code extension then opens that session in the window. No shell anywhere:
// Code.exe is started directly with an argument array (code.cmd would need a shell). VS Code asks once
// "Allow 'Claude Code for VS Code' to open this URI?"; the person answers it (the checkbox makes it permanent).

export const URI_BASE = 'vscode://anthropic.claude-code/open?session=';
export const FOLDER_WAIT_MS = 8000; // time for the window to be up before the session link is sent
export const COLD_WAIT_MS = 25000; // VS Code was not running (after a reboot): it needs longer to start a window and its extensions

export function sessionUri(sessionId) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) throw new Error('bad session id');
  return URI_BASE + sessionId.toLowerCase();
}

// Standard install locations only (never PATH, never inside an allowed root: a planted Code.exe in a repo must not run).
export function knownCodePaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const out = [];
    if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'));
    if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'));
    if (env['ProgramFiles(x86)']) out.push(path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'));
    return out;
  }
  if (platform === 'darwin') {
    const rel = path.join('Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code');
    const out = [path.join('/Applications', rel)];
    if (env.HOME) out.push(path.join(env.HOME, 'Applications', rel));
    return out;
  }
  return [];
}
export function resolveCode(roots, known = knownCodePaths, exists = fs.existsSync) {
  for (const p of known()) {
    if (path.isAbsolute(p) && !insideRoot(p, roots) && exists(p)) return p;
  }
  return null;
}

// The two commands, as [argument array, ...]. folder: an absolute path (resolved by the caller).
export function codeCommands(folder, sessionId) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\u0000-\u001f]/.test(folder)) throw new Error('bad folder');
  return [[folder], ['--open-url', '--', sessionUri(sessionId)]];
}

// VS Code (an Electron app) must not run as plain Node, and must not talk to another VS Code's terminal.
export function cleanEnv(env = process.env) {
  const e = { ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(e)) if (k.startsWith('VSCODE_')) delete e[k];
  return e;
}

// Is a VS Code main process running? Windows only (tasklist); unknown elsewhere counts as running.
export function codeRunning() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/FO', 'CSV', '/NH'], { timeout: 10000, windowsHide: true }, (err, out) => resolve(err ? true : /"Code\.exe"/i.test(String(out))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnCode(codePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(codePath, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false, env: cleanEnv() });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// One at a time: the session link goes to the window that is active, so two opens must not interleave.
let chain = Promise.resolve();
export function openInVscode({ codePath, folder, sessionId, folderWaitMs = FOLDER_WAIT_MS, coldWaitMs = COLD_WAIT_MS, runningFn = codeRunning, spawnFn = spawnCode, sleepFn = sleep }) {
  if (!codePath) return Promise.reject(new Error('VS Code not found in its standard install folders'));
  let open, url;
  try { [open, url] = codeCommands(folder, sessionId); } catch (e) { return Promise.reject(e); } // validated before anything runs
  const run = async () => {
    const warm = await runningFn();
    await spawnFn(codePath, open);
    await sleepFn(warm ? folderWaitMs : Math.max(folderWaitMs, coldWaitMs));
    await spawnFn(codePath, url);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
