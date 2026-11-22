#!/usr/bin/env node
// The worker release key (docs/ops/launcher.md "Self-update"). A downloaded worker updates itself only to a release signed
// with a key listed in worker/release-keys.mjs. The private key stays on Om's PC, protected by the system (Windows DPAPI
// for his user account; the login Keychain on macOS), and is never printed, committed, copied to the server, or readable
// by a build. Run this with the system's own node (Windows node, not WSL), from a checkout you trust.
//
//   node scripts/worker-signing-key.mjs new [--label TEXT]     make the key (once): stores it protected and adds its
//                                                              public half to worker/release-keys.mjs
//   node scripts/worker-signing-key.mjs backup --out FILE      write the key to FILE (a new file) for an offline copy
//   node scripts/worker-signing-key.mjs sign [--ref REF] [--out FILE | --out-dir DIR]
//                                                              sign the worker of a commit (default HEAD). --out-dir writes
//                                                              DIR/worker-signature-<commit12>.json, which
//                                                              scripts/build-artifact.sh picks up; without either, writes
//                                                              worker/bundle/signature.json (for a GitHub Actions build)
//   node scripts/worker-signing-key.mjs check [--ref REF | --dir DIR] [--sig FILE]   does the signature fit that worker?
//   --repo DIR: the git repo to read (default: the one this script is in).
//
// Signing reads the release from git blobs of the commit (no checkout, no CRLF, no npm, no build) and imports no code
// from the repo: the bundle format, the version and the signed message are written out below, and release-keys.mjs is
// read as text. So nothing in a release can reach the key while it is in memory. Before signing it prints the worker files
// changed since the last release it signed. The version is the commit's time as YYYYMMDD.HHMMSS UTC, set here, never by a
// person; one not above the last signed release is refused (the same release again is fine). The last release is kept
// beside the key (last-release.json).
//
// WORKER_SIGNING_KEY=<a PEM file> replaces the protected store (tests). Never point it at a file a build can read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const die = (m) => { console.error(m); process.exit(1); };
const ROOT = () => path.resolve(arg('--repo') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

// ---- The release format. These copy worker/release.mjs and worker/bundle/build.mjs, so that signing imports no code
// from the tree it signs; the worker tests check that both give the same bytes.
export const VERSION_RE = /^\d{1,9}(\.\d{1,9}){0,3}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;
export const SKILL_RE = /^skills\/[a-z0-9][a-z0-9-]{0,39}\/SKILL\.md$/;
const CODE_RE = /^[A-Za-z0-9._-]+\.mjs$/;

export function releaseVersionAt(unixSeconds) {
  const d = new Date(Math.floor(Number(unixSeconds)) * 1000);
  if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 2000) throw new Error('bad release time');
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
export function releaseMessage(version, sha256) {
  if (!VERSION_RE.test(version) || !SHA_RE.test(sha256)) throw new Error('bad release');
  return Buffer.from(`work-os-worker release\n${version}\n${sha256}\n`, 'utf8');
}
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y ? 1 : -1; }
  return 0;
}
export function bundleFrom(files, loader, version) {
  if (!VERSION_RE.test(version)) throw new Error('bad version');
  const sorted = {};
  for (const f of Object.keys(files).filter((n) => CODE_RE.test(n) || SKILL_RE.test(n)).sort()) sorted[f] = files[f];
  const body = loader.replace('/*FILES*/ {}', () => JSON.stringify(sorted, null, 1)).replace("/*RELEASE*/ ''", () => JSON.stringify(version));
  return { body, sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'), version, bytes: Buffer.byteLength(body), files: Object.keys(sorted) };
}
const publicKeyText = (key) => (key.type === 'public' ? key : crypto.createPublicKey(key)).export({ format: 'der', type: 'spki' }).toString('base64');
function verify({ version, sha256, signature }, keys) {
  let msg;
  try { msg = releaseMessage(version, sha256); } catch { return false; }
  for (const k of keys) {
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (pub.asymmetricKeyType === 'ed25519' && crypto.verify(null, msg, pub, Buffer.from(String(signature), 'base64'))) return true;
    } catch { /* not a key */ }
  }
  return false;
}
/** The keys listed in a release-keys.mjs text (the quoted base64 strings inside RELEASE_KEYS), read as data. */
export function keysIn(text) {
  const m = /RELEASE_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(text);
  return m ? [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((x) => x[1]) : [];
}

// ---- The worker of a commit, or of a folder: plain text, nothing run.
const git = (...a) => execFileSync('git', ['-C', ROOT(), ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
function fromRef(ref) {
  let sha;
  try { sha = git('rev-parse', '--verify', `${ref}^{commit}`).trim(); } catch { die(`${ref} is not a commit in ${ROOT()}`); }
  const files = {};
  for (const n of git('ls-tree', '-r', '--name-only', sha, 'worker/').split('\n').map((s) => s.trim())) {
    const rel = n.slice('worker/'.length);
    if (n.startsWith('worker/') && (CODE_RE.test(rel) || SKILL_RE.test(rel))) files[rel] = git('cat-file', 'blob', `${sha}:${n}`);
  }
  return { sha, files, loader: git('cat-file', 'blob', `${sha}:worker/bundle/loader.mjs`), keys: keysIn(files['release-keys.mjs'] ?? ''), at: Number(git('log', '-1', '--format=%ct', sha).trim()) };
}
function fromDir(dir) {
  const files = {};
  for (const f of fs.readdirSync(dir).filter((n) => CODE_RE.test(n))) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  let skills = [];
  try { skills = fs.readdirSync(path.join(dir, 'skills')); } catch { /* none */ }
  for (const s of skills) { const k = `skills/${s}/SKILL.md`; if (SKILL_RE.test(k)) try { files[k] = fs.readFileSync(path.join(dir, 'skills', s, 'SKILL.md'), 'utf8'); } catch { /* no SKILL.md */ } }
  return { sha: null, files, loader: fs.readFileSync(path.join(dir, 'bundle', 'loader.mjs'), 'utf8'), keys: keysIn(files['release-keys.mjs'] ?? ''), at: null };
}

// ---- The key store.
const POWERSHELL = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const KEYCHAIN = { service: 'work-os-release', account: 'worker-signing' };
/** Where the key lives: { kind: 'file' | 'dpapi' | 'keychain', file?, dir } (dir: where last-release.json is kept). */
export function keyStore(env = process.env, platform = process.platform) {
  if (env.WORKER_SIGNING_KEY) return { kind: 'file', file: env.WORKER_SIGNING_KEY, dir: path.dirname(env.WORKER_SIGNING_KEY), last: `${env.WORKER_SIGNING_KEY}.last.json` };
  if (platform === 'win32') {
    const dir = path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'work-os-release');
    return { kind: 'dpapi', file: path.join(dir, 'worker-signing.key.dpapi'), dir, last: path.join(dir, 'last-release.json') };
  }
  if (platform === 'darwin') { const dir = path.join(os.homedir(), 'Library', 'Application Support', 'work-os-release'); return { kind: 'keychain', dir, last: path.join(dir, 'last-release.json') }; }
  return null;
}
const describe = (st) => (st.kind === 'keychain' ? `the login Keychain (${KEYCHAIN.service})` : st.kind === 'dpapi' ? `${st.file} (DPAPI, this Windows account only)` : st.file);

function storeKey(st, der) {
  const b64 = der.toString('base64');
  fs.mkdirSync(st.dir, { recursive: true });
  if (st.kind === 'file') return fs.writeFileSync(st.file, crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  if (st.kind === 'dpapi') {
    const script = '$t=[Console]::In.ReadLine(); ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path $env:WOS_KEY_FILE -Encoding ascii';
    const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { input: b64 + '\n', env: { ...process.env, WOS_KEY_FILE: st.file }, encoding: 'utf8', cwd: st.dir, windowsHide: true });
    if (r.status !== 0) die('could not store the key with DPAPI');
    return;
  }
  const r = spawnSync('/usr/bin/security', ['-i'], { input: `add-generic-password -s ${KEYCHAIN.service} -a ${KEYCHAIN.account} -w ${b64}\n`, encoding: 'utf8' });
  if (r.status !== 0) die('could not store the key in the Keychain');
}
function hasKey(st) {
  if (st.kind !== 'keychain') return fs.existsSync(st.file);
  return spawnSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account], { stdio: 'ignore' }).status === 0;
}
function readKey(st) {
  let key;
  if (st.kind === 'file') {
    let pem;
    try { pem = fs.readFileSync(st.file, 'utf8'); } catch (e) { die(`no signing key at ${st.file} (${e.code || e.message})`); }
    try { key = crypto.createPrivateKey(pem); } catch { die(`${st.file} is not a private key`); }
  } else {
    if (!hasKey(st)) die(`no signing key in ${describe(st)}; make one with: node scripts/worker-signing-key.mjs new`);
    const r = st.kind === 'dpapi'
      ? spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Content -Path $env:WOS_KEY_FILE | ConvertTo-SecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }'], { env: { ...process.env, WOS_KEY_FILE: st.file }, encoding: 'utf8', timeout: 15000, cwd: st.dir, windowsHide: true })
      : spawnSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], { encoding: 'utf8' });
    const b64 = (r.stdout || '').trim();
    if (r.status !== 0 || !/^[A-Za-z0-9+/=]{40,200}$/.test(b64)) die(`could not read the signing key from ${describe(st)} (another Windows account or Mac user cannot)`);
    try { key = crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' }); } catch { die('the stored signing key is damaged'); }
  }
  if (key.asymmetricKeyType !== 'ed25519') die('the signing key is not an Ed25519 key');
  return key;
}

const readJson = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && VERSION_RE.test(String(j.version)) && SHA_RE.test(String(j.sha256)) ? j : null; } catch { return null; } };

/** The worker files changed from the last signed release's commit to this one (tests left out), as lines to print. */
function changedSince(last, sha) {
  if (!last?.commit || !/^[0-9a-f]{40}$/.test(last.commit)) return null;
  try { git('cat-file', '-e', `${last.commit}^{commit}`); } catch { return null; }
  return git('diff', '--name-status', last.commit, sha, '--', 'worker/', ':(exclude)worker/test/').split('\n').filter(Boolean);
}

async function main(cmd) {
  const st = keyStore();
  if (['new', 'backup', 'sign'].includes(cmd) && !st) die('no protected key store on this system (Windows DPAPI or the macOS Keychain): sign on Om\'s Windows PC');
  if (cmd === 'new') {
    if (hasKey(st)) die(`a key already exists in ${describe(st)}; it is not replaced (rotate by adding a second key: see docs/ops/launcher.md)`);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    storeKey(st, privateKey.export({ format: 'der', type: 'pkcs8' }));
    const pub = publicKeyText(publicKey);
    if (publicKeyText(readKey(st)) !== pub) die('the stored key does not read back; nothing was added to release-keys.mjs');
    const keysFile = path.join(ROOT(), 'worker', 'release-keys.mjs');
    const label = (arg('--label') || 'release key').replace(/[^\w .,:-]/g, '').slice(0, 60);
    const text = fs.readFileSync(keysFile, 'utf8');
    const i = text.lastIndexOf('];');
    if (i < 0) die(`${keysFile} has no RELEASE_KEYS list; add this public key by hand: ${pub}`);
    fs.writeFileSync(keysFile, text.slice(0, i) + `  '${pub}', // ${label}, made ${new Date().toISOString().slice(0, 10)}\n` + text.slice(i));
    console.log(`private key stored in ${describe(st)}`);
    console.log(`public key added to worker/release-keys.mjs: ${pub}`);
    console.log('commit worker/release-keys.mjs; workers installed from then on accept releases signed with this key');
    console.log('then make an offline copy (a USB stick kept apart): node scripts/worker-signing-key.mjs backup --out <file on it>');
    return;
  }
  if (cmd === 'backup') {
    const out = arg('--out');
    if (!out) die('backup needs --out FILE (a new file, ideally on a removable drive)');
    const key = readKey(st);
    fs.writeFileSync(out, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    console.log(`key written to ${out}: keep it offline, not on this PC (if this Windows account is ever lost, sign from the drive with WORKER_SIGNING_KEY=<that file>)`);
    return;
  }
  if (cmd === 'sign') {
    const src = fromRef(arg('--ref') || 'HEAD');
    const version = releaseVersionAt(src.at);
    const bundle = bundleFrom(src.files, src.loader, version);
    const out = arg('--out') || (arg('--out-dir') ? path.join(path.resolve(arg('--out-dir')), `worker-signature-${src.sha.slice(0, 12)}.json`) : path.join(ROOT(), 'worker', 'bundle', 'signature.json'));
    const last = readJson(st.last);
    console.log(`worker of ${src.sha.slice(0, 12)}: release ${version}, bundle ${bundle.sha256.slice(0, 12)}, ${bundle.files.length} files`);
    const changed = changedSince(last, src.sha);
    if (changed) console.log(changed.length ? `worker files changed since the last signed release ${last.version} (${last.commit.slice(0, 12)}):\n${changed.map((l) => '  ' + l.replace(/\t/g, ' ')).join('\n')}` : `no worker file changed since the last signed release ${last.version}`);
    else console.log(`no earlier signed release known here${last ? ` (last: ${last.version}, commit not in this repo)` : ''}: every worker file is new to signing:\n${bundle.files.map((f) => '  ' + f).join('\n')}`);
    // Never below or equal to a release signed before (the same release again is fine): workers refuse those anyway.
    for (const prev of [last, readJson(out)]) {
      if (!prev) continue;
      const c = compareVersions(version, prev.version);
      if (c < 0 || (c === 0 && prev.sha256 !== bundle.sha256)) die(`version ${version} is not above the last signed release ${prev.version}: sign a newer commit`);
    }
    const key = readKey(st);
    const pub = publicKeyText(key);
    if (!src.keys.includes(pub)) die('this key is not in that commit\'s worker/release-keys.mjs: add it (and commit) first, or workers would refuse the release');
    const signature = crypto.sign(null, releaseMessage(version, bundle.sha256), key).toString('base64');
    if (!verify({ version, sha256: bundle.sha256, signature }, src.keys)) die('the signature does not verify');
    const record = { version, sha256: bundle.sha256, signature, commit: src.sha, key: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 16), signedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    if (!last || compareVersions(version, last.version) > 0) { fs.mkdirSync(path.dirname(st.last), { recursive: true }); fs.writeFileSync(st.last, JSON.stringify({ version, sha256: bundle.sha256, commit: src.sha }) + '\n'); }
    console.log(`signed worker release ${version} (bundle ${bundle.sha256.slice(0, 12)}): ${out}`);
    return;
  }
  if (cmd === 'check') {
    const src = arg('--dir') ? fromDir(path.resolve(arg('--dir'))) : fromRef(arg('--ref') || 'HEAD');
    const file = arg('--sig') || path.join(ROOT(), 'worker', 'bundle', 'signature.json');
    const rec = readJson(file);
    if (!rec) die(`no signature at ${file}`);
    const bundle = bundleFrom(src.files, src.loader, rec.version);
    if (rec.sha256 !== bundle.sha256) die(`the signature is for another bundle (${rec.sha256.slice(0, 12)}); this worker at release ${rec.version} is ${bundle.sha256.slice(0, 12)}: sign it again`);
    if (!verify(rec, src.keys)) die('bad signature: no key in that worker\'s release-keys.mjs made it');
    console.log(`good: worker release ${rec.version} (bundle ${bundle.sha256.slice(0, 12)}) is signed`);
    return;
  }
  die('usage: node scripts/worker-signing-key.mjs new [--label TEXT] | backup --out FILE | sign [--ref REF] [--out FILE | --out-dir DIR] | check [--ref REF | --dir DIR] [--sig FILE]   (any: --repo DIR)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(args[0]);
