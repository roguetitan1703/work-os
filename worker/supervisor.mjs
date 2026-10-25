#!/usr/bin/env node
// Keeps `worker.mjs run` running and restarts it when the worker's code changes, so an update never
// needs a reinstall. Autostart (install.mjs) runs this file. Output goes to worker.log next to the config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CHECK_MS = 5000;
export const STABLE_MS = 15000; // files must stop changing this long before a restart (no half-saved edits)
export const LOG_MAX = 1024 * 1024;

const codeFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();

// mtime + size of every .mjs in the worker folder (tests live in test/ and are not included).
export function signature(dir = DIR) {
  return codeFiles(dir).map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f}:${s.mtimeMs}:${s.size}`; }).join('|');
}

export function syntaxOk(dir = DIR, check = (f) => execFileSync(process.execPath, ['--check', f], { stdio: 'ignore', timeout: 15000 })) {
  try { for (const f of codeFiles(dir)) check(path.join(dir, f)); return true; } catch { return false; }
}

// Decides when to restart: the code differs from what is running, has been stable for STABLE_MS and parses.
export function createWatch({ running, now = Date.now, read = signature, ok = syntaxOk }) {
  let seen = running, since = now(), rejected = null;
  return {
    tick() {
      const cur = read();
      if (cur !== seen) { seen = cur; since = now(); return false; }
      if (cur === running || cur === rejected || now() - since < STABLE_MS) return false;
      if (!ok()) { rejected = cur; return 'bad'; }
      return true;
    },
    started(sig) { running = sig; },
  };
}

function logger() {
  const file = path.join(configDir(), 'worker.log');
  fs.mkdirSync(configDir(), { recursive: true });
  return (chunk) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, chunk);
    } catch {}
  };
}

// One supervisor per config folder: a second start (setup run again, logon plus a hand start) exits quietly.
// The pid file is created atomically (open 'wx'): of two starts at the same moment exactly one wins. When the file exists, it
// is a live lock only if its pid is alive (kill 0; right after a laptop sleep too, unlike a timestamp) and it was written
// after the last boot (a pid in a file from before a reboot may now belong to another program).
export function takeLock(
  file = path.join(configDir(), 'supervisor.pid'),
  pid = process.pid,
  alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  bootMs = Date.now() - os.uptime() * 1000,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let other = 0, written = 0;
    try { other = Number(fs.readFileSync(file, 'utf8')); written = fs.statSync(file).mtimeMs; } catch { continue; } // gone meanwhile: try to create it again
    if (other && other !== pid && alive(other) && written >= bootMs) return false;
    try { fs.rmSync(file, { force: true }); } catch {} // stale: replace it (a racing start is settled by 'wx' above)
  }
  return false;
}

async function main() {
  if (!takeLock()) return;
  const write = logger();
  const log = (m) => write(`${new Date().toISOString()} [supervisor] ${m}\n`);
  let child = null, backoff = 5000, stopping = false;
  const start = () => {
    const sig = signature();
    child = spawn(process.execPath, [path.join(DIR, 'worker.mjs'), 'run'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', write); child.stderr.on('data', write);
    const startedAt = Date.now();
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      if (Date.now() - startedAt > 60000) backoff = 5000;
      log(`worker exited (${code}); restarting in ${backoff / 1000}s`);
      setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    watch.started(sig);
    log('worker started');
  };
  const watch = createWatch({ running: signature() });
  start();
  setInterval(() => {
    try { fs.utimesSync(path.join(configDir(), 'supervisor.pid'), new Date(), new Date()); } catch {}
    const r = watch.tick();
    if (r === 'bad') log('worker code changed but does not parse; keeping the running version');
    if (r !== true || !child) return;
    log('worker code changed; restarting');
    stopping = true;
    child.once('exit', () => { stopping = false; backoff = 5000; start(); });
    child.kill();
  }, CHECK_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
