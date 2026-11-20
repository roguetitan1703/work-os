#!/usr/bin/env node
// The worker release key (docs/launcher.md "Self-update"). A downloaded worker updates itself only to a release signed
// with a key listed in worker/release-keys.mjs. The private key lives in one file on Om's PC, outside every repo, and is
// never printed, committed or copied to the server.
//
//   node scripts/worker-signing-key.mjs new [--label TEXT]      make the key (once); adds its public key to worker/release-keys.mjs
//   node scripts/worker-signing-key.mjs sign [--ref REF]        sign the worker of a commit (default HEAD): writes worker/bundle/signature.json
//   node scripts/worker-signing-key.mjs sign --dir DIR --out F  sign the worker files in DIR (scripts/build-artifact.sh)
//   node scripts/worker-signing-key.mjs check [--ref REF | --dir DIR] [--sig F]   does the signature fit that worker and a listed key?
//
// WORKER_SIGNING_KEY: the private key file. Default %APPDATA%/work-os-release/worker-signing.key on Windows,
// ~/.config/work-os-release/worker-signing.key elsewhere (from WSL pass the Windows file: /mnt/c/Users/<you>/AppData/...).
// What is signed: "work-os-worker release", the worker VERSION (worker/core.mjs) and the sha256 of the bundle Work OS
// serves for that code (worker/bundle/build.mjs). Bundles are built from the committed files (LF line endings), never
// from a Windows working copy, so the sha256 is the one the server computes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleFrom, buildBundle } from '../worker/bundle/build.mjs';
import { signRelease, verifyRelease, publicKeyText, compareVersions } from '../worker/release.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = path.join(ROOT, 'worker', 'release-keys.mjs');
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const die = (m) => { console.error(m); process.exit(1); };

export function keyPath(env = process.env, platform = process.platform) {
  if (env.WORKER_SIGNING_KEY) return env.WORKER_SIGNING_KEY;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'work-os-release', 'worker-signing.key');
  return path.join(os.homedir(), '.config', 'work-os-release', 'worker-signing.key');
}

/** The bundle and the release key list of the worker at a git ref, from the committed blobs (no checkout, no CRLF). */
function fromRef(ref) {
  const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const names = git('ls-tree', '--name-only', ref, 'worker/').split('\n').map((s) => s.trim()).filter((s) => /^worker\/[A-Za-z0-9._-]+\.mjs$/.test(s));
  const files = {};
  for (const n of names) files[n.slice('worker/'.length)] = git('cat-file', 'blob', `${ref}:${n}`);
  const bundle = bundleFrom(files, git('cat-file', 'blob', `${ref}:worker/bundle/loader.mjs`));
  return { bundle, keys: keysIn(files['release-keys.mjs'] ?? '') };
}
async function fromDir(dir) {
  const bundle = buildBundle(dir);
  const { RELEASE_KEYS } = await import(pathToFileURL(path.join(dir, 'release-keys.mjs')).href);
  return { bundle, keys: RELEASE_KEYS };
}
/** The keys listed in a release-keys.mjs text (the quoted base64 strings inside RELEASE_KEYS). */
function keysIn(text) {
  const m = /RELEASE_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(text);
  return m ? [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((x) => x[1]) : [];
}

function readKey(file) {
  let pem;
  try { pem = fs.readFileSync(file, 'utf8'); } catch (e) { die(`no signing key at ${file} (${e.code || e.message}); set WORKER_SIGNING_KEY, or make one with: node scripts/worker-signing-key.mjs new`); }
  try { return crypto.createPrivateKey(pem); } catch { die(`${file} is not a private key`); }
}

async function source() {
  const dir = arg('--dir');
  if (dir) return { ...(await fromDir(path.resolve(dir))), previousFile: path.join(path.resolve(dir), 'bundle', 'signature.json') };
  const ref = arg('--ref') || 'HEAD';
  return { ...fromRef(ref), ref, previousFile: path.join(ROOT, 'worker', 'bundle', 'signature.json') };
}

async function main(cmd) {
  if (cmd === 'new') {
    const file = keyPath();
    if (fs.existsSync(file)) die(`a key already exists at ${file}; it is not replaced (rotate by adding a second key: see docs/launcher.md)`);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    const pub = publicKeyText(publicKey);
    const label = (arg('--label') || 'release key').replace(/[^\w .,:-]/g, '').slice(0, 60);
    const text = fs.readFileSync(KEYS_FILE, 'utf8');
    const i = text.lastIndexOf('];');
    if (i < 0) die(`${KEYS_FILE} has no RELEASE_KEYS list; add this public key by hand: ${pub}`);
    fs.writeFileSync(KEYS_FILE, text.slice(0, i) + `  '${pub}', // ${label}, made ${new Date().toISOString().slice(0, 10)}\n` + text.slice(i));
    console.log(`private key written to ${file} (keep a copy somewhere safe and offline: without it no update can be signed)`);
    console.log(`public key added to worker/release-keys.mjs: ${pub}`);
    console.log('commit worker/release-keys.mjs; workers installed from then on accept releases signed with this key');
    return;
  }
  if (cmd === 'sign') {
    const key = readKey(keyPath());
    const { bundle, keys, previousFile } = await source();
    const pub = publicKeyText(key);
    if (!keys.includes(pub)) die('this key is not in that worker\'s release-keys.mjs: add it (and commit) first, or workers would refuse the release');
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(previousFile, 'utf8')); } catch {}
    if (previous && previous.sha256 !== bundle.sha256 && compareVersions(bundle.version, String(previous.version)) <= 0) {
      die(`the worker changed but its VERSION (${bundle.version}) is not above the last signed one (${previous.version}): raise VERSION in worker/core.mjs`);
    }
    const signature = signRelease(bundle, key);
    if (!verifyRelease({ ...bundle, signature }, keys)) die('the signature does not verify');
    const out = arg('--out') || path.join(ROOT, 'worker', 'bundle', 'signature.json');
    const record = { version: bundle.version, sha256: bundle.sha256, signature, key: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16), signedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    console.log(`signed worker ${bundle.version} (bundle ${bundle.sha256.slice(0, 12)}): ${path.relative(process.cwd(), out) || out}`);
    return;
  }
  if (cmd === 'check') {
    const { bundle, keys } = await source();
    const file = arg('--sig') || path.join(ROOT, 'worker', 'bundle', 'signature.json');
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { die(`no signature at ${file}`); }
    if (rec.version !== bundle.version || rec.sha256 !== bundle.sha256) die(`the signature is for worker ${rec.version} (${String(rec.sha256).slice(0, 12)}), this worker is ${bundle.version} (${bundle.sha256.slice(0, 12)}): sign it again`);
    if (!verifyRelease(rec, keys)) die('bad signature: no key in that worker\'s release-keys.mjs made it');
    console.log(`good: worker ${bundle.version} (bundle ${bundle.sha256.slice(0, 12)}) is signed`);
    return;
  }
  die('usage: node scripts/worker-signing-key.mjs new [--label TEXT] | sign [--ref REF | --dir DIR] [--out FILE] | check [--ref REF | --dir DIR] [--sig FILE]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(args[0]);
