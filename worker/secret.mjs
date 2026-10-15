import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configDir } from './config.mjs';

export const TOKEN_RE = /^wkr_[A-Za-z0-9_-]{43}$/;
const SERVICE = 'work-os-worker';
const tokenFile = () => path.join(configDir(), 'token.dpapi');

export function setToken(token) {
  if (!TOKEN_RE.test(token)) throw new Error('token must look like wkr_ followed by 43 characters');
  fs.mkdirSync(configDir(), { recursive: true });
  if (process.platform === 'win32') {
    const script = '$t=[Console]::In.ReadLine(); ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path $env:WOS_TOKEN_FILE -Encoding ascii';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { input: token + '\n', env: { ...process.env, WOS_TOKEN_FILE: tokenFile() }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('could not store token (DPAPI)');
  } else if (process.platform === 'darwin') {
    // `security -i` reads the command from stdin so the token is not in argv.
    const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${SERVICE} -w ${token}\n`, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('could not store token (Keychain)');
  } else throw new Error('unsupported platform');
}

export function getToken() {
  try {
    if (process.platform === 'win32') {
      const script = 'Get-Content -Path $env:WOS_TOKEN_FILE | ConvertTo-SecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }';
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, WOS_TOKEN_FILE: tokenFile() }, encoding: 'utf8' });
      const t = (r.stdout || '').trim();
      return r.status === 0 && TOKEN_RE.test(t) ? t : null;
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-w'], { encoding: 'utf8' });
      const t = (r.stdout || '').trim();
      return r.status === 0 && TOKEN_RE.test(t) ? t : null;
    }
  } catch {}
  return null;
}

export function readSecretFromStdin() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (buf += d));
      stdin.on('end', () => resolve(buf.trim()));
      return;
    }
    process.stderr.write('Paste device key (input hidden), then Enter: ');
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(buf.trim());
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on('data', onData);
  });
}
