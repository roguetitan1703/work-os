#!/usr/bin/env node
// The worker release key (docs/launcher.md "Self-update"). A downloaded worker updates itself only to a release signed
// with a key listed in worker/release-keys.mjs. The private key lives in one file on Om's PC, outside every repo, and is
// never printed, committed or copied to the server.
//
//   node scripts/worker-signing-key.mjs new [--label TEXT]      make the key (once); adds its public key to worker/release-keys.mjs
//   node scripts/worker-signing-key.mjs sign [--ref REF]        sign the worker of a commit (default HEAD): writes worker/bundle/signature.json
//   node scripts/worker-signing-key.mjs sign --dir DIR --out F [--at UNIXSECONDS]   sign the worker files in DIR (scripts/build-artifact.sh)
//   node scripts/worker-signing-key.mjs check [--ref REF | --dir DIR] [--sig F]   does the signature fit that worker and a listed key?
//
// WORKER_SIGNING_KEY: the private key file. Default %APPDATA%/work-os-release/worker-signing.key on Windows,
// ~/.config/work-os-release/worker-signing.key elsewhere (from WSL pass the Windows file: /mnt/c/Users/<you>/AppData/...).
//
// The version is set here, never by a person: the commit time of the release commit (--ref; build-artifact.sh passes it
// as --at), else now, as YYYYMMDD.HHMMSS UTC (worker/release.mjs releaseVersionAt). It is written into the bundle
// (worker/bundle/build.mjs), and "work-os-worker release", the version and the bundle's sha256 are signed. A version not
// above the last one this key signed is refused (the same version and bundle again is fine): the last one is kept beside
// the key (<key file>.last.json) and in the signature file being replaced. Bundles are built from the committed files (LF
// line endings), never from a Windows working copy, so the sha256 is the one the server computes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleFrom, readWorkerFiles } from '../worker/bundle/build.mjs';
import { signRelease, verifyRelease, publicKeyText, compareVersions, releaseVersionAt, VERSION_RE, SHA_RE } from '../worker/release.mjs';

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

/** The worker files, release key list and commit time of a git ref, from the committed blobs (no checkout, no CRLF). */
function fromRef(ref) {
  const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const names = git('ls-tree', '--name-only', ref, 'worker/').split('\n').map((s) => s.trim()).filter((s) => /^worker\/[A-Za-z0-9._-]+\.mjs$/.test(s));
  const files = {};
  for (const n of names) files[n.slice('worker/'.length)] = git('cat-file', 'blob', `${ref}:${n}`);
  return { files, loader: git('cat-file', 'blob', `${ref}:worker/bundle/loader.mjs`), keys: keysIn(files['release-keys.mjs'] ?? ''), at: Number(git('log', '-1', '--format=%ct', ref).trim()) };
}
async function fromDir(dir) {
  const { files, loader } = readWorkerFiles(dir);
  const { RELEASE_KEYS } = await import(pathToFileURL(path.join(dir, 'release-keys.mjs')).href);
  return { files, loader, keys: RELEASE_KEYS, at: null };
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
const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && VERSION_RE.test(String(j.version)) && SHA_RE.test(String(j.sha256)) ? j : null; } catch { return null; } };

async function source() {
  const dir = arg('--dir');
  if (dir) return { ...(await fromDir(path.resolve(dir))), previousFile: path.join(path.resolve(dir), 'bundle', 'signature.json') };
  return { ...fromRef(arg('--ref') || 'HEAD'), previousFile: path.join(ROOT, 'worker', 'bundle', 'signature.json') };
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
    const keyFile = keyPath();
    const key = readKey(keyFile);
    const src = await source();
    const pub = publicKeyText(key);
    if (!src.keys.includes(pub)) die('this key is not in that worker\'s release-keys.mjs: add it (and commit) first, or workers would refuse the release');
    const atArg = arg('--at');
    const at = atArg !== null ? Number(atArg) : src.at ?? Math.floor(Date.now() / 1000);
    let version;
    try { version = releaseVersionAt(at); } catch { die(`--at must be a time in unix seconds (got ${atArg})`); }
    const bundle = bundleFrom(src.files, src.loader, version);
    // Never below or equal to a release signed before (the same release again is fine): workers refuse those anyway.
    const lastFile = `${keyFile}.last.json`;
    for (const prev of [readJson(lastFile), readJson(src.previousFile)]) {
      if (!prev) continue;
      const c = compareVersions(version, prev.version);
      if (c < 0 || (c === 0 && prev.sha256 !== bundle.sha256)) die(`version ${version} is not above the last signed release ${prev.version}: sign a newer commit`);
    }
    const signature = signRelease(bundle, key);
    if (!verifyRelease({ ...bundle, signature }, src.keys)) die('the signature does not verify');
    const out = arg('--out') || path.join(ROOT, 'worker', 'bundle', 'signature.json');
    const record = { version, sha256: bundle.sha256, signature, key: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16), signedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    const last = readJson(lastFile);
    if (!last || compareVersions(version, last.version) > 0) fs.writeFileSync(lastFile, JSON.stringify({ version, sha256: bundle.sha256 }) + '\n');
    console.log(`signed worker release ${version} (bundle ${bundle.sha256.slice(0, 12)}): ${path.relative(process.cwd(), out) || out}`);
    return;
  }
  if (cmd === 'check') {
    const src = await source();
    const file = arg('--sig') || path.join(ROOT, 'worker', 'bundle', 'signature.json');
    const rec = readJson(file);
    if (!rec) die(`no signature at ${file}`);
    const bundle = bundleFrom(src.files, src.loader, rec.version);
    if (rec.sha256 !== bundle.sha256) die(`the signature is for another bundle (${rec.sha256.slice(0, 12)}); this worker at release ${rec.version} is ${bundle.sha256.slice(0, 12)}: sign it again`);
    if (!verifyRelease(rec, src.keys)) die('bad signature: no key in that worker\'s release-keys.mjs made it');
    console.log(`good: worker release ${rec.version} (bundle ${bundle.sha256.slice(0, 12)}) is signed`);
    return;
  }
  die('usage: node scripts/worker-signing-key.mjs new [--label TEXT] | sign [--ref REF | --dir DIR --out FILE [--at UNIXSECONDS]] | check [--ref REF | --dir DIR] [--sig FILE]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(args[0]);
