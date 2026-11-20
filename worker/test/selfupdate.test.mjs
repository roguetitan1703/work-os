// Self-update (worker/update.mjs, docs/launcher.md "Self-update"): only a newer release signed with a key in the running
// worker's own list is installed; everything else leaves the old worker running and says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleFrom } from '../bundle/build.mjs';
import { bundleId } from '../config.mjs';
import { selfUpdate, startSelfUpdate, updateReport, readUpdateStatus } from '../update.mjs';
import { signRelease, verifyRelease, publicKeyText, compareVersions, releaseMessage } from '../release.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(WORKER, '..', 'scripts', 'worker-signing-key.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wos-selfupdate-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// Throwaway keys, made for these tests only.
const good = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const KEYS = [publicKeyText(good.publicKey)];

const sourceFiles = () => {
  const files = {};
  for (const f of fs.readdirSync(WORKER).filter((n) => n.endsWith('.mjs'))) files[f] = fs.readFileSync(path.join(WORKER, f), 'utf8');
  return files;
};
const LOADER = fs.readFileSync(path.join(WORKER, 'bundle', 'loader.mjs'), 'utf8');
/** A release of this worker at `version`; `change` edits its files (name → text). */
function release(version, change = {}) {
  const files = sourceFiles();
  files['core.mjs'] = files['core.mjs'].replace(/VERSION = '[^']+'/, `VERSION = '${version}'`);
  Object.assign(files, change);
  return bundleFrom(files, LOADER);
}
const CURRENT = release('0.5.0');

/** A computer with CURRENT installed the way the install command does it: the download, unpacked beside itself. */
function installed() {
  const d = tmp();
  const file = path.join(d, 'work-os-worker.mjs');
  fs.writeFileSync(file, CURRENT.body);
  const r = spawnSync(process.execPath, [file, 'unpack'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const workerDir = path.join(d, 'worker');
  assert.equal(bundleId(workerDir), CURRENT.sha256);
  return { d, file, workerDir, status: path.join(d, 'cfg', 'self-update.json') };
}

/** A fake Work OS: latest.json and the download. fail: 'all' (no network) or 'download' (breaks off). */
function server({ latest, body, fail }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (fail === 'all' || (fail === 'download' && url.endsWith('.mjs'))) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (url.endsWith('/worker/latest.json')) return { status: 200, json: async () => latest };
    if (url.endsWith('/worker/work-os-worker.mjs')) {
      const b = Buffer.from(body);
      return { status: 200, headers: { get: () => String(b.length) }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    }
    return { status: 404 };
  };
  return { fetchImpl, calls };
}
const signed = (rel, key = good.privateKey) => ({ version: rel.version, sha256: rel.sha256, bytes: rel.bytes, signature: signRelease(rel, key) });

/** Runs one check against the fake server. */
const check = (inst, srv, extra = {}) => selfUpdate({ baseUrl: 'https://work.example', version: '0.5.0', workerDir: inst.workerDir, keys: KEYS, fetchImpl: srv.fetchImpl, file: inst.status, log: (m) => (extra.logs ?? []).push(m), ...extra });

/** The old worker is untouched: same unpacked code, same download file. */
function unchanged(inst) {
  assert.equal(bundleId(inst.workerDir), CURRENT.sha256);
  assert.equal(fs.readFileSync(inst.file, 'utf8'), CURRENT.body);
  assert.match(fs.readFileSync(path.join(inst.workerDir, 'core.mjs'), 'utf8'), /VERSION = '0\.5\.0'/);
  assert.deepEqual(fs.readdirSync(inst.d).filter((f) => f.endsWith('.new')), [], 'no temp file left');
}

test('release signatures: bind version and sha256, Ed25519 only, malformed input is a plain no', () => {
  const rel = release('0.6.0');
  const sig = signRelease(rel, good.privateKey);
  assert.equal(verifyRelease({ ...rel, signature: sig }, KEYS), true);
  assert.equal(verifyRelease({ ...rel, version: '0.6.1', signature: sig }, KEYS), false, 'another version');
  assert.equal(verifyRelease({ ...rel, sha256: 'a'.repeat(64), signature: sig }, KEYS), false, 'another bundle');
  assert.equal(verifyRelease({ ...rel, signature: sig }, [publicKeyText(other.publicKey)]), false, 'another key');
  assert.equal(verifyRelease({ ...rel, signature: sig }, ['garbage', ...KEYS]), true, 'a broken entry does not stop the list');
  for (const bad of [undefined, '', 'x', sig.slice(0, -4), sig + 'AA']) assert.equal(verifyRelease({ ...rel, signature: bad }, KEYS), false);
  assert.equal(verifyRelease({ version: '0.6.0', sha256: rel.sha256, signature: sig }, []), false, 'no keys, no update');
  assert.throws(() => releaseMessage('1.0\n9.9.9', rel.sha256));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signRelease(rel, rsa.privateKey), /Ed25519/);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.5', '0.5.0'), 0);
  assert.equal(compareVersions('0.4.9', '0.5.0'), -1);
});

test('a good signed update is written beside the old one, unpacked, and reported', async () => {
  const inst = installed();
  try {
    const next = release('0.6.0');
    const logs = [];
    const r = await check(inst, server({ latest: signed(next), body: next.body }), { logs });
    assert.deepEqual(r, { result: 'updated', version: '0.6.0' });
    assert.equal(fs.readFileSync(inst.file, 'utf8'), next.body, 'the download file is the new release');
    assert.equal(bundleId(inst.workerDir), next.sha256, 'the worker folder holds the new code');
    assert.match(fs.readFileSync(path.join(inst.workerDir, 'core.mjs'), 'utf8'), /VERSION = '0\.6\.0'/);
    assert.deepEqual(fs.readdirSync(inst.d).filter((f) => f.endsWith('.new')), []);
    const s = readUpdateStatus(inst.status);
    assert.equal(s.from, '0.5.0'); assert.equal(s.to, '0.6.0'); assert.ok(Date.parse(s.updatedAt));
    assert.deepEqual(updateReport(inst.status, next.sha256), { on: true, updatedAt: s.updatedAt, from: '0.5.0' });
    assert.equal(logs.length, 1); assert.match(logs[0], /updated itself from 0\.5\.0 to 0\.6\.0/);
    // The next check: nothing to do, and an older problem is cleared.
    const again = await check(inst, server({ latest: signed(next), body: next.body }), { version: '0.6.0' });
    assert.equal(again.result, 'current');
  } finally { rm(inst.d); }
});

test('tampered bytes are refused: the download must match the signed sha256', async () => {
  const inst = installed();
  try {
    const next = release('0.6.0');
    const evil = next.body.replace('worker unpacked', 'worker unpacked (evil)');
    const r = await check(inst, server({ latest: signed(next), body: evil }));
    assert.equal(r.result, 'failed'); assert.match(r.reason, /does not match its signed checksum/);
    unchanged(inst);
    // The sha256 in latest.json swapped for the tampered file's: the signature no longer fits.
    const evilSha = crypto.createHash('sha256').update(evil).digest('hex');
    const r2 = await check(inst, server({ latest: { ...signed(next), sha256: evilSha }, body: evil }));
    assert.deepEqual(r2, { result: 'refused', reason: 'bad signature', version: '0.6.0' });
    unchanged(inst);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update refused: bad signature');
  } finally { rm(inst.d); }
});

test('a release signed with a key the worker does not carry is refused, and the refusal is reported', async () => {
  const inst = installed();
  try {
    const next = release('0.6.0');
    const srv = server({ latest: signed(next, other.privateKey), body: next.body });
    const logs = [];
    const r = await check(inst, srv, { logs });
    assert.deepEqual(r, { result: 'refused', reason: 'bad signature', version: '0.6.0' });
    assert.ok(!srv.calls.some((u) => u.endsWith('.mjs')), 'nothing downloaded');
    unchanged(inst);
    assert.equal(logs.length, 1); assert.match(logs[0], /^update refused: bad signature \(offered 0\.6\.0\); keeping worker 0\.5\.0$/);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update refused: bad signature');
    // A key list in the new release does not count: only the running worker's keys do.
    const withKey = release('0.6.0', { 'release-keys.mjs': `export const RELEASE_KEYS = ['${publicKeyText(other.publicKey)}'];\n` });
    const r2 = await check(inst, server({ latest: signed(withKey, other.privateKey), body: withKey.body }));
    assert.equal(r2.result, 'refused');
    unchanged(inst);
  } finally { rm(inst.d); }
});

test('no downgrades: a valid signature on an older or the same version is refused', async () => {
  const inst = installed();
  try {
    for (const v of ['0.4.0', '0.5.0', '0.4.99']) {
      const old = release(v, { 'loop.mjs': sourceFiles()['loop.mjs'] + `\n// ${v}\n` }); // a different bundle at that version
      const r = await check(inst, server({ latest: signed(old), body: old.body }));
      assert.deepEqual(r, { result: 'refused', reason: `version ${v} is not newer than 0.5.0`, version: v });
      unchanged(inst);
    }
  } finally { rm(inst.d); }
});

test('a release without a signature is refused', async () => {
  const inst = installed();
  try {
    const next = release('0.6.0');
    const { signature, ...unsigned } = signed(next);
    assert.ok(signature);
    const r = await check(inst, server({ latest: unsigned, body: next.body }));
    assert.deepEqual(r, { result: 'refused', reason: 'not signed', version: '0.6.0' });
    unchanged(inst);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update refused: not signed');
  } finally { rm(inst.d); }
});

test('a network error, a bad answer or a failed unpack leaves the old worker running', async () => {
  const inst = installed();
  try {
    const next = release('0.6.0');
    let r = await check(inst, server({ latest: signed(next), body: next.body, fail: 'all' }));
    assert.equal(r.result, 'failed'); assert.match(r.reason, /could not reach Work OS \(ECONNREFUSED\)/);
    unchanged(inst);
    r = await check(inst, server({ latest: signed(next), body: next.body, fail: 'download' }));
    assert.equal(r.result, 'failed'); assert.match(r.reason, /the download broke off/);
    unchanged(inst);
    r = await check(inst, { fetchImpl: async () => ({ status: 503 }) });
    assert.deepEqual(r, { result: 'failed', reason: 'Work OS answered 503' });
    r = await check(inst, server({ latest: { version: '0.6.0; rm -rf', sha256: next.sha256 }, body: next.body }));
    assert.deepEqual(r, { result: 'failed', reason: 'latest.json is not valid' });
    unchanged(inst);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update failed: latest.json is not valid');
    // The unpack fails: the old code keeps running, the next check tries again.
    r = await check(inst, server({ latest: signed(next), body: next.body }), { unpack: () => false });
    assert.deepEqual(r, { result: 'failed', reason: 'the new worker did not unpack', version: '0.6.0' });
    assert.equal(bundleId(inst.workerDir), CURRENT.sha256);
    r = await check(inst, server({ latest: signed(next), body: next.body }));
    assert.equal(r.result, 'updated');
    assert.equal(updateReport(inst.status, next.sha256).problem, undefined, 'a good update clears the problem');
  } finally { rm(inst.d); }
});

test('a worker run from the repo never updates itself and never asks', async () => {
  assert.equal(bundleId(WORKER), null, 'the repo has no BUNDLE marker');
  const next = release('9.0.0');
  const srv = server({ latest: signed(next), body: next.body });
  const d = tmp();
  try {
    const r = await selfUpdate({ baseUrl: 'https://work.example', version: '0.5.0', workerDir: WORKER, keys: KEYS, fetchImpl: srv.fetchImpl, file: path.join(d, 's.json') });
    assert.deepEqual(r, { result: 'repo' });
    assert.equal(srv.calls.length, 0);
    assert.equal(startSelfUpdate({ getBaseUrl: () => 'https://work.example', version: '0.5.0', log: () => {}, workerDir: WORKER, fetchImpl: srv.fetchImpl }), null);
    assert.equal(updateReport(path.join(d, 's.json'), null), null, 'a repo run reports no self-update');
    assert.equal(fs.existsSync(path.join(d, 's.json')), false);
  } finally { rm(d); }
});

test('after an update the new worker refreshes the installed hooks', async () => {
  const inst = installed();
  const env = { ...process.env, WORK_OS_WORKER_DIR: path.join(inst.d, 'cfg'), CLAUDE_SETTINGS_PATH: path.join(inst.d, 'claude', 'settings.json') };
  delete env.WORK_OS_KEY;
  const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', env });
  try {
    let r = node([path.join(inst.workerDir, 'worker.mjs'), 'hooks', 'install']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const vfile = path.join(inst.d, 'cfg', 'hooks', 'hooks.version');
    const before = fs.readFileSync(vfile, 'utf8').trim();
    const next = release('0.6.0', { 'hook-lib.mjs': sourceFiles()['hook-lib.mjs'] + '\n// changed in 0.6.0\n' });
    assert.equal((await check(inst, server({ latest: signed(next), body: next.body }))).result, 'updated');
    // What worker.mjs run does at its start, with the new code.
    const probe = `const m = await import(${JSON.stringify(new URL('file:///' + path.join(inst.workerDir, 'hooks-install.mjs').split(path.sep).join('/')).href)}); console.log(JSON.stringify({ stale: m.isStale(), refreshed: m.refreshIfStale(), current: m.hooksVersion() }));`;
    r = node(['--input-type=module', '-e', probe]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.stale, true);
    assert.notEqual(out.current, before);
    assert.equal(out.refreshed, out.current);
    assert.equal(fs.readFileSync(vfile, 'utf8').trim(), out.current);
    assert.match(fs.readFileSync(path.join(inst.d, 'cfg', 'hooks', 'hook-lib.mjs'), 'utf8'), /changed in 0\.6\.0/);
  } finally { rm(inst.d); }
});

test('the signing script signs a worker folder only with a listed key and a raised VERSION; the key is never printed', () => {
  const d = tmp();
  try {
    const keyFile = path.join(d, 'release', 'worker-signing.key');
    fs.mkdirSync(path.dirname(keyFile));
    const pem = good.privateKey.export({ format: 'pem', type: 'pkcs8' });
    fs.writeFileSync(keyFile, pem);
    const src = path.join(d, 'worker');
    fs.mkdirSync(path.join(src, 'bundle'), { recursive: true });
    for (const [f, text] of Object.entries(sourceFiles())) fs.writeFileSync(path.join(src, f), text);
    fs.writeFileSync(path.join(src, 'bundle', 'loader.mjs'), LOADER);
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', env: { ...process.env, WORKER_SIGNING_KEY: keyFile } });
    const out = path.join(d, 'sig.json');
    // Not in the folder's release-keys.mjs: refused.
    fs.writeFileSync(path.join(src, 'release-keys.mjs'), 'export const RELEASE_KEYS = [\n];\n');
    let r = run('sign', '--dir', src, '--out', out);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not in that worker's release-keys\.mjs/);
    // Listed: signed, and the signature fits the bundle the server builds from the same files.
    fs.writeFileSync(path.join(src, 'release-keys.mjs'), `export const RELEASE_KEYS = [\n  '${KEYS[0]}', // test\n];\n`);
    r = run('sign', '--dir', src, '--out', out);
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    const files = {}; for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.mjs'))) files[f] = fs.readFileSync(path.join(src, f), 'utf8');
    const b = bundleFrom(files, LOADER);
    assert.equal(rec.sha256, b.sha256); assert.equal(rec.version, b.version);
    assert.equal(verifyRelease(rec, KEYS), true);
    assert.equal(run('check', '--dir', src, '--sig', out).status, 0);
    const secret = pem.split('\n').slice(1, -2).join('');
    assert.ok(!(r.stdout + r.stderr).includes(secret), 'the private key is not printed');
    // The code changes but VERSION does not: refused against the last signed release.
    fs.copyFileSync(out, path.join(src, 'bundle', 'signature.json'));
    fs.appendFileSync(path.join(src, 'loop.mjs'), '\n// change\n');
    r = run('sign', '--dir', src, '--out', out);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /raise VERSION in worker\/core\.mjs/);
    r = run('check', '--dir', src, '--sig', out);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /sign it again/);
    // No key file: a plain message.
    r = spawnSync(process.execPath, [SCRIPT, 'sign', '--dir', src, '--out', out], { encoding: 'utf8', env: { ...process.env, WORKER_SIGNING_KEY: path.join(d, 'none.key') } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no signing key at/);
  } finally { rm(d); }
});
