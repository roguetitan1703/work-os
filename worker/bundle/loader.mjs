// Work OS worker, one file. Work OS serves this file at /worker/work-os-worker.mjs with the worker's code
// embedded below; the install command downloads it, checks its sha256 against the one shown on Claude › Setup,
// and runs `node work-os-worker.mjs setup`. It unpacks the code into a `worker` folder next to itself (built whole in a
// new folder, then swapped in, so the folder is always one release, never a mix) and then
// runs worker.mjs there with the same arguments. The autostart (`install`) runs from that folder.
// The worker updates itself (update.mjs): it checks a newer release's signature, writes it here and runs it with
// `unpack` (unpack only, nothing else runs); the supervisor restarts the worker when the unpacked code changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`The Work OS worker needs Node 22 or newer (this is ${process.versions.node}). Install it from https://nodejs.org/en/download and run the command again.`);
  process.exit(1);
}

const FILES = /*FILES*/ {};
const RELEASE = /*RELEASE*/ ''; // this bundle's version (bundle/build.mjs): what a self-update compares with
const self = fileURLToPath(import.meta.url);
const dir = path.join(path.dirname(self), 'worker');
const id = crypto.createHash('sha256').update(fs.readFileSync(self)).digest('hex');
const marker = path.join(dir, 'BUNDLE');

function renameSoon(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= 25 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

let current = '';
try { current = fs.readFileSync(marker, 'utf8').trim(); } catch {}
if (current !== id) {
  // The whole release goes into a new folder first, then takes the place of the old one: a failure at any point leaves
  // the old worker folder as it was, never half old and half new.
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const fresh = path.join(parent, `worker.new-${process.pid}`);
  const old = path.join(parent, `worker.old-${process.pid}`);
  for (const f of fs.readdirSync(parent)) if (/^worker\.(new|old)-\d+$/.test(f)) fs.rmSync(path.join(parent, f), { recursive: true, force: true }); // left by a stopped unpack
  try {
    fs.mkdirSync(fresh);
    for (const [name, text] of Object.entries(FILES)) {
      const skill = /^skills\/([a-z0-9][a-z0-9-]{0,39})\/SKILL\.md$/.exec(name); // the Work OS skills (hooks-install.mjs installs them)
      if (!skill && !/^[A-Za-z0-9._-]+\.mjs$/.test(name)) continue;
      const to = skill ? path.join(fresh, 'skills', skill[1], 'SKILL.md') : path.join(fresh, name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, text);
    }
    fs.writeFileSync(path.join(fresh, 'RELEASE'), RELEASE + '\n');
    fs.writeFileSync(path.join(fresh, 'BUNDLE'), id + '\n');
    // The swap: two renames. Windows refuses to rename a folder while a program has a file in it open (a virus scan, a
    // PowerShell started there for a moment): try again for a few seconds, then give up with the old folder in place.
    const had = fs.existsSync(dir);
    if (had) renameSoon(dir, old);
    try { renameSoon(fresh, dir); } catch (e) { if (had) fs.renameSync(old, dir); throw e; }
    if (had) try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* removed at the next unpack */ }
  } catch (e) {
    try { fs.rmSync(fresh, { recursive: true, force: true }); } catch {}
    console.error(`could not unpack the worker (${e.code || e.message}); the worker folder is unchanged`);
    process.exit(1);
  }
  console.log(`worker unpacked: ${dir}`);
}
if (process.argv[2] === 'unpack') process.exit(0);

const r = spawnSync(process.execPath, [path.join(dir, 'worker.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
