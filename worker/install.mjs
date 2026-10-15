import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const TASK = 'work-os-worker';
const LABEL = 'in.delpat.work-os-worker';
// Autostart runs the supervisor, which runs `worker.mjs run` and restarts it when the code changes.
const workerPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs');
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function install() {
  if (process.platform === 'win32') {
    // conhost --headless: no console window stays open at logon. Started now too, not only at the next logon.
    const tr = `conhost.exe --headless "${process.execPath}" "${workerPath()}"`;
    execFileSync('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/TR', tr, '/RL', 'LIMITED', '/F'], { stdio: 'inherit' });
    try { execFileSync('schtasks', ['/End', '/TN', TASK], { stdio: 'ignore' }); } catch {}
    execFileSync('schtasks', ['/Run', '/TN', TASK], { stdio: 'inherit' });
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
    execFileSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { stdio: 'inherit' });
  } else if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['unload', plistPath()], { stdio: 'inherit' }); } catch {}
    try { fs.unlinkSync(plistPath()); } catch {}
  } else throw new Error('unsupported platform');
}
