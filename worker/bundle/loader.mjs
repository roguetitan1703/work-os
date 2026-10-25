// Work OS worker, one file. Work OS serves this file at /worker/work-os-worker.mjs with the worker's code
// embedded below; the install command downloads it, checks its sha256 against the one shown on Claude › Setup,
// and runs `node work-os-worker.mjs setup`. It unpacks the code into a `worker` folder next to itself and then
// runs worker.mjs there with the same arguments. The autostart (`install`) runs from that folder.
// Run it again with a newer download to update: the supervisor restarts the worker when the unpacked code changes.
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
const self = fileURLToPath(import.meta.url);
const dir = path.join(path.dirname(self), 'worker');
const id = crypto.createHash('sha256').update(fs.readFileSync(self)).digest('hex');
const marker = path.join(dir, 'BUNDLE');

let current = '';
try { current = fs.readFileSync(marker, 'utf8').trim(); } catch {}
if (current !== id) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(FILES)) {
    if (!/^[A-Za-z0-9._-]+\.mjs$/.test(name)) continue;
    const tmp = path.join(dir, `.${name}.new`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dir, name));
  }
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.mjs') && !(f in FILES)) fs.rmSync(path.join(dir, f), { force: true }); // gone in this version
  fs.writeFileSync(marker, id + '\n');
  console.log(`worker unpacked: ${dir}`);
}

const r = spawnSync(process.execPath, [path.join(dir, 'worker.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
