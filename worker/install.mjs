import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const TASK = 'work-os-worker';
const LABEL = 'in.delpat.work-os-worker';
// Autostart runs the supervisor, which runs `worker.mjs run` and restarts it when the code changes.
const workerPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs');
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'WorkOSWorker';
export const handCommand = () => `"${process.execPath}" "${workerPath()}"`;

// Windows autostart for the signed-in user, no administrator needed: a value under HKCU\...\Run (what "startup apps" lists)
// that runs the supervisor hidden at every logon. conhost --headless: no console window stays open. Started now too.
// An old scheduled task from earlier versions is removed (errors ignored: it may not exist, or not be ours to end).
export function installWindows({ run = (cmd, args, opts) => execFileSync(cmd, args, opts), start = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref() } = {}) {
  const args = ['--headless', process.execPath, workerPath()];
  const value = `conhost.exe --headless "${process.execPath}" "${workerPath()}"`;
  for (const a of [['/End', '/TN', TASK], ['/Delete', '/TN', TASK, '/F']]) { try { run('schtasks', a, { stdio: 'ignore' }); } catch {} }
  try { run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' }); }
  catch { throw new Error(`could not add the worker to this user's startup apps. Run it by hand instead: ${handCommand()}`); }
  start('conhost.exe', args); // the supervisor keeps one copy (supervisor.pid), so a second start exits at once
  return value;
}

export function uninstallWindows({ run = (cmd, args, opts) => execFileSync(cmd, args, opts) } = {}) {
  for (const a of [['/End', '/TN', TASK], ['/Delete', '/TN', TASK, '/F']]) { try { run('schtasks', a, { stdio: 'ignore' }); } catch {} }
  try { run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { stdio: 'ignore' }); } catch {}
}

export function install() {
  if (process.platform === 'win32') {
    installWindows();
  } else if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(workerPath())}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    try { execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['load', plistPath()], { stdio: 'inherit' });
  } else throw new Error('unsupported platform');
}

export function uninstall() {
  if (process.platform === 'win32') {
    uninstallWindows();
  } else if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['unload', plistPath()], { stdio: 'inherit' }); } catch {}
    try { fs.unlinkSync(plistPath()); } catch {}
  } else throw new Error('unsupported platform');
}
