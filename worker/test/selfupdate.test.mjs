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
import { bundleFrom, readWorkerFiles } from '../bundle/build.mjs';
import { bundleId, releaseVersion } from '../config.mjs';
import { selfUpdate, startSelfUpdate, updateReport, readUpdateStatus, MAX_BYTES } from '../update.mjs';
import { signRelease, verifyRelease, publicKeyText, compareVersions, releaseMessage, releaseVersionAt } from '../release.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(WORKER, '..', 'scripts', 'worker-signing-key.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wos-selfupdate-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// Throwaway keys, made for these tests only.
const good = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const KEYS = [publicKeyText(good.publicKey)];

const sourceFiles = () => readWorkerFiles(WORKER).files; // the .mjs files and the skills, as the server bundles them
const LOADER = fs.readFileSync(path.join(WORKER, 'bundle', 'loader.mjs'), 'utf8');
/** A release of this worker at `version` (as the signing step sets it); `change` edits its files (name → text). */
const release = (version, change = {}) => bundleFrom({ ...sourceFiles(), ...change }, LOADER, version);
const V0 = '20261120.100000', V1 = '20261120.110000';
const CURRENT = release(V0);

/** A computer with CURRENT installed the way the install command does it: the download, unpacked beside itself. */
function installed() {
  const d = tmp();
  const file = path.join(d, 'work-os-worker.mjs');
  fs.writeFileSync(file, CURRENT.body);
  const r = spawnSync(process.execPath, [file, 'unpack'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const workerDir = path.join(d, 'worker');
  assert.equal(bundleId(workerDir), CURRENT.sha256);
  assert.equal(releaseVersion(workerDir), V0, 'the loader leaves the release version beside the code');
  return { d, file, workerDir, status: path.join(d, 'cfg', 'self-update.json') };
}

/**
 * A fake Work OS: latest.json and the download, sent as a stream in 64 KB chunks. fail: 'all' (no network) or 'download'
 * (breaks off). length: the content-length header (default the body's; null: none). endless: the download never ends.
 */
function server({ latest, body, fail, length, endless }) {
  const calls = [];
  const sent = { bytes: 0, cancelled: false };
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (fail === 'all' || (fail === 'download' && url.endsWith('.mjs'))) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (url.endsWith('/worker/latest.json')) return { status: 200, json: async () => latest };
    if (url.endsWith('/worker/work-os-worker.mjs')) {
      const b = Buffer.from(body ?? '');
      let at = 0;
      const stream = new ReadableStream({
        pull(c) {
          if (opts.signal?.aborted) { sent.cancelled = true; return c.error(new Error('aborted')); }
          if (!endless && at >= b.length) return c.close();
          const chunk = endless ? new Uint8Array(65536).fill(120) : b.subarray(at, at + 65536);
          at += chunk.length; sent.bytes += chunk.length;
          c.enqueue(new Uint8Array(chunk));
        },
        cancel() { sent.cancelled = true; },
      }, { highWaterMark: 0 });
      const len = length === undefined ? String(b.length) : length === null ? null : String(length);
      return { status: 200, headers: { get: (h) => (h === 'content-length' ? len : null) }, body: stream };
    }
    return { status: 404 };
  };
  return { fetchImpl, calls, sent };
}
const signed = (rel, key = good.privateKey) => ({ version: rel.version, sha256: rel.sha256, bytes: rel.bytes, signature: signRelease(rel, key) });

/** Runs one check against the fake server; the worker's own version comes from its RELEASE file, as in real runs. */
const check = (inst, srv, extra = {}) => selfUpdate({ baseUrl: 'https://work.example', workerDir: inst.workerDir, keys: KEYS, fetchImpl: srv.fetchImpl, file: inst.status, log: (m) => (extra.logs ?? []).push(m), ...extra });

/** The old worker is untouched: same unpacked code, same download file. */
function unchanged(inst) {
  assert.equal(bundleId(inst.workerDir), CURRENT.sha256);
  assert.equal(releaseVersion(inst.workerDir), V0);
  assert.equal(fs.readFileSync(inst.file, 'utf8'), CURRENT.body);
  assert.deepEqual(fs.readdirSync(inst.d).filter((f) => f.endsWith('.new')), [], 'no temp file left');
}

test('release versions come from a time, only grow, and are above every code version', () => {
  assert.equal(releaseVersionAt(Date.UTC(2026, 10, 20, 14, 30, 5) / 1000), '20261120.143005');
  assert.equal(releaseVersionAt(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000), '20260102.030405');
  assert.equal(compareVersions(releaseVersionAt(1_800_000_001), releaseVersionAt(1_800_000_000)), 1);
  assert.equal(compareVersions(releaseVersionAt(1_800_000_000), '0.5.0'), 1);
  assert.equal(compareVersions('20261121.000000', '20261120.235959'), 1);
  assert.throws(() => releaseVersionAt('soon'));
  // The version is inside the bundle: the same files at another version are another bundle.
  assert.notEqual(release(V0).sha256, release(V1).sha256);
  assert.equal(release(V0).sha256, CURRENT.sha256, 'same files, same version, same bytes');
  assert.match(bundleFrom(sourceFiles(), LOADER).version, /^0\.\d+\.\d+$/, 'unsigned bundles carry the code version');
});

test('release signatures: bind version and sha256, Ed25519 only, malformed input is a plain no', () => {
  const rel = release(V1);
  const sig = signRelease(rel, good.privateKey);
  assert.equal(verifyRelease({ ...rel, signature: sig }, KEYS), true);
  assert.equal(verifyRelease({ ...rel, version: '20261120.110001', signature: sig }, KEYS), false, 'another version');
  assert.equal(verifyRelease({ ...rel, sha256: 'a'.repeat(64), signature: sig }, KEYS), false, 'another bundle');
  assert.equal(verifyRelease({ ...rel, signature: sig }, [publicKeyText(other.publicKey)]), false, 'another key');
  assert.equal(verifyRelease({ ...rel, signature: sig }, ['garbage', ...KEYS]), true, 'a broken entry does not stop the list');
  for (const bad of [undefined, '', 'x', sig.slice(0, -4), sig + 'AA']) assert.equal(verifyRelease({ ...rel, signature: bad }, KEYS), false);
  assert.equal(verifyRelease({ ...rel, signature: sig }, []), false, 'no keys, no update');
  assert.throws(() => releaseMessage('1.0\n9.9.9', rel.sha256));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signRelease(rel, rsa.privateKey), /Ed25519/);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.5', '0.5.0'), 0);
});

test('a good signed update is written beside the old one, unpacked, and reported', async () => {
  const inst = installed();
  try {
    const next = release(V1);
    const logs = [];
    const r = await check(inst, server({ latest: signed(next), body: next.body }), { logs });
    assert.deepEqual(r, { result: 'updated', version: V1 });
    assert.equal(fs.readFileSync(inst.file, 'utf8'), next.body, 'the download file is the new release');
    assert.equal(bundleId(inst.workerDir), next.sha256, 'the worker folder holds the new code');
    assert.equal(releaseVersion(inst.workerDir), V1, 'and the new release version');
    assert.deepEqual(fs.readdirSync(inst.d).filter((f) => f.endsWith('.new')), []);
    const s = readUpdateStatus(inst.status);
    assert.equal(s.from, V0); assert.equal(s.to, V1); assert.ok(Date.parse(s.updatedAt));
    assert.deepEqual(updateReport(inst.status, next.sha256), { on: true, updatedAt: s.updatedAt, from: V0 });
    assert.equal(logs.length, 1); assert.match(logs[0], /updated itself from 20261120\.100000 to 20261120\.110000/);
    // The next check: nothing to do.
    assert.equal((await check(inst, server({ latest: signed(next), body: next.body }))).result, 'current');
    // And the old release, still validly signed, is now a downgrade.
    const back = await check(inst, server({ latest: signed(CURRENT), body: CURRENT.body }));
    assert.deepEqual(back, { result: 'refused', reason: `version ${V0} is not newer than ${V1}`, version: V0 });
    assert.equal(bundleId(inst.workerDir), next.sha256);
  } finally { rm(inst.d); }
});

test('tampered bytes are refused: the download must match the signed sha256', async () => {
  const inst = installed();
  try {
    const next = release(V1);
    const evil = next.body.replace('worker unpacked', 'worker UNPACKED'); // same size: only the checksum can tell
    const r = await check(inst, server({ latest: signed(next), body: evil }));
    assert.equal(r.result, 'failed'); assert.match(r.reason, /does not match its signed checksum/);
    unchanged(inst);
    // The sha256 in latest.json swapped for the tampered file's: the signature no longer fits.
    const evilSha = crypto.createHash('sha256').update(evil).digest('hex');
    const r2 = await check(inst, server({ latest: { ...signed(next), sha256: evilSha }, body: evil }));
    assert.deepEqual(r2, { result: 'refused', reason: 'bad signature', version: V1 });
    unchanged(inst);
    // A higher version claimed for a signed bundle: the signature binds the version too.
    const r3 = await check(inst, server({ latest: { ...signed(next), version: '20991231.000000' }, body: next.body }));
    assert.deepEqual(r3, { result: 'refused', reason: 'bad signature', version: '20991231.000000' });
    unchanged(inst);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update refused: bad signature');
  } finally { rm(inst.d); }
});

test('a release signed with a key the worker does not carry is refused, and the refusal is reported', async () => {
  const inst = installed();
  try {
    const next = release(V1);
    const srv = server({ latest: signed(next, other.privateKey), body: next.body });
    const logs = [];
    const r = await check(inst, srv, { logs });
    assert.deepEqual(r, { result: 'refused', reason: 'bad signature', version: V1 });
    assert.ok(!srv.calls.some((u) => u.endsWith('.mjs')), 'nothing downloaded');
    unchanged(inst);
    assert.equal(logs.length, 1); assert.equal(logs[0], `update refused: bad signature (offered ${V1}); keeping worker ${V0}`);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update refused: bad signature');
    // A key list in the new release does not count: only the running worker's keys do.
    const withKey = release(V1, { 'release-keys.mjs': `export const RELEASE_KEYS = ['${publicKeyText(other.publicKey)}'];\n` });
    const r2 = await check(inst, server({ latest: signed(withKey, other.privateKey), body: withKey.body }));
    assert.equal(r2.result, 'refused');
    unchanged(inst);
  } finally { rm(inst.d); }
});

test('no downgrades: a valid signature on an older or the same version is refused', async () => {
  const inst = installed();
  try {
    for (const v of ['20261119.235959', V0, '0.9.9']) {
      const old = release(v, { 'loop.mjs': sourceFiles()['loop.mjs'] + `\n// ${v}\n` }); // a different bundle at that version
      const r = await check(inst, server({ latest: signed(old), body: old.body }));
      assert.deepEqual(r, { result: 'refused', reason: `version ${v} is not newer than ${V0}`, version: v });
      unchanged(inst);
    }
  } finally { rm(inst.d); }
});

test('a release without a signature is refused', async () => {
  const inst = installed();
  try {
    const next = release(V1);
    const { signature, ...unsigned } = signed(next);
    assert.ok(signature);
    const r = await check(inst, server({ latest: unsigned, body: next.body }));
    assert.deepEqual(r, { result: 'refused', reason: 'not signed', version: V1 });
    unchanged(inst);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update refused: not signed');
  } finally { rm(inst.d); }
});

test('a network error, a bad answer or a failed unpack leaves the old worker running', async () => {
  const inst = installed();
  try {
    const next = release(V1);
    let r = await check(inst, server({ latest: signed(next), body: next.body, fail: 'all' }));
    assert.equal(r.result, 'failed'); assert.match(r.reason, /could not reach Work OS \(ECONNREFUSED\)/);
    unchanged(inst);
    r = await check(inst, server({ latest: signed(next), body: next.body, fail: 'download' }));
    assert.equal(r.result, 'failed'); assert.match(r.reason, /the download broke off/);
    unchanged(inst);
    r = await check(inst, { fetchImpl: async () => ({ status: 503 }) });
    assert.deepEqual(r, { result: 'failed', reason: 'Work OS answered 503' });
    r = await check(inst, server({ latest: { version: '1; rm -rf', sha256: next.sha256 }, body: next.body }));
    assert.deepEqual(r, { result: 'failed', reason: 'latest.json is not valid' });
    unchanged(inst);
    assert.equal(updateReport(inst.status, CURRENT.sha256).problem, 'update failed: latest.json is not valid');
    // The unpack fails: the old code keeps running, the next check tries again.
    r = await check(inst, server({ latest: signed(next), body: next.body }), { unpack: () => false });
    assert.deepEqual(r, { result: 'failed', reason: 'the new worker did not unpack', version: V1 });
    assert.equal(bundleId(inst.workerDir), CURRENT.sha256);
    r = await check(inst, server({ latest: signed(next), body: next.body }));
    assert.equal(r.result, 'updated');
    assert.equal(updateReport(inst.status, next.sha256).problem, undefined, 'a good update clears the problem');
  } finally { rm(inst.d); }
});

/** Every file under a folder, with its text: what the worker folder holds. */
const tree = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort().map((f) => [f.split(path.sep).join('/'), fs.readFileSync(path.join(dir, f), 'utf8')]));

test('unpack builds the new release in a folder of its own and swaps it in: no old file stays, no mix on a failure', async () => {
  const inst = installed();
  try {
    const before = tree(inst.workerDir);
    // A release that drops a file and changes another: after the swap the folder is exactly the new release.
    const files = sourceFiles();
    delete files['vscode.mjs'];
    const next = bundleFrom({ ...files, 'loop.mjs': files['loop.mjs'] + '\n// next\n' }, LOADER, V1);
    fs.writeFileSync(inst.file, next.body);
    fs.mkdirSync(path.join(inst.d, 'worker.new-99999')); // left by an unpack that was stopped
    let r = spawnSync(process.execPath, [inst.file, 'unpack'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const after = tree(inst.workerDir);
    assert.equal(after['vscode.mjs'], undefined, 'a file the release dropped is gone');
    assert.match(after['loop.mjs'], /\/\/ next/);
    assert.equal(after.BUNDLE.trim(), next.sha256); assert.equal(after.RELEASE.trim(), V1);
    assert.deepEqual(Object.keys(after).filter((f) => !['BUNDLE', 'RELEASE'].includes(f)), next.files.slice().sort());
    assert.deepEqual(fs.readdirSync(inst.d).sort(), ['work-os-worker.mjs', 'worker'], 'no new or old folder left beside it');
    if (process.platform !== 'win32') return;
    // Windows: a program working inside the folder (its current folder there) blocks the swap. The old folder stays whole.
    fs.writeFileSync(inst.file, CURRENT.body);
    const hold = spawnSync(process.execPath, ['-e', `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 9000)'], { cwd: ${JSON.stringify(inst.workerDir)}, detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);`], { encoding: 'utf8' });
    const pid = Number(hold.stdout.trim());
    try {
      r = spawnSync(process.execPath, [inst.file, 'unpack'], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /could not unpack the worker .*the worker folder is unchanged/);
      assert.deepEqual(tree(inst.workerDir), after, 'the folder is the release it was, file for file');
      assert.deepEqual(fs.readdirSync(inst.d).sort(), ['work-os-worker.mjs', 'worker']);
    } finally { try { process.kill(pid); } catch {} }
    // Once free, the same unpack goes through (the next check tries again).
    for (let i = 0; i < 50 && spawnSync(process.execPath, [inst.file, 'unpack']).status !== 0; i++) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
    assert.deepEqual(tree(inst.workerDir), before);
  } finally { rm(inst.d); }
});

test('the download is read as a stream and cut off past the signed size or 8 MB, with or without a content-length', async () => {
  const inst = installed();
  try {
    const next = release(V1);
    // No content-length, and it never ends: stopped at 8 MB, never held whole.
    let srv = server({ latest: { ...signed(next), bytes: undefined }, endless: true, length: null });
    let r = await check(inst, srv);
    assert.deepEqual(r, { result: 'failed', reason: 'the download is too large', version: V1 });
    assert.ok(srv.sent.bytes <= MAX_BYTES + 2 * 65536, `read ${srv.sent.bytes} bytes`);
    assert.equal(srv.sent.cancelled, true, 'the request is aborted');
    unchanged(inst);
    // latest.json says how big the release is: one byte more is already too much (no content-length either).
    srv = server({ latest: signed(next), body: next.body + 'x'.repeat(200_000), length: null });
    r = await check(inst, srv);
    assert.equal(r.reason, 'the download is too large');
    assert.ok(srv.sent.bytes < next.bytes + 2 * 65536, `read ${srv.sent.bytes} bytes`);
    unchanged(inst);
    // A content-length over the signed size: refused before reading.
    srv = server({ latest: signed(next), body: next.body, length: next.bytes + 1 });
    assert.equal((await check(inst, srv)).reason, 'the download is too large');
    assert.equal(srv.sent.bytes, 0);
    // A lying small content-length does not help: the stream is counted.
    srv = server({ latest: signed(next), body: next.body + 'x'.repeat(200_000), length: 10 });
    assert.equal((await check(inst, srv)).reason, 'the download is too large');
    unchanged(inst);
    // The right size: fine.
    assert.equal((await check(inst, server({ latest: signed(next), body: next.body, length: null }))).result, 'updated');
  } finally { rm(inst.d); }
});

test('a worker run from the repo never updates itself and never asks', async () => {
  assert.equal(bundleId(WORKER), null, 'the repo has no BUNDLE marker');
  const next = release('20991231.000000');
  const srv = server({ latest: signed(next), body: next.body });
  const d = tmp();
  try {
    const r = await selfUpdate({ baseUrl: 'https://work.example', workerDir: WORKER, keys: KEYS, fetchImpl: srv.fetchImpl, file: path.join(d, 's.json') });
    assert.deepEqual(r, { result: 'repo' });
    assert.equal(srv.calls.length, 0);
    assert.equal(startSelfUpdate({ getBaseUrl: () => 'https://work.example', log: () => {}, workerDir: WORKER, fetchImpl: srv.fetchImpl }), null);
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
    const next = release(V1, { 'hook-lib.mjs': sourceFiles()['hook-lib.mjs'] + '\n// changed in this release\n' });
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
    assert.match(fs.readFileSync(path.join(inst.d, 'cfg', 'hooks', 'hook-lib.mjs'), 'utf8'), /changed in this release/);
  } finally { rm(inst.d); }
});

test('after an update with a newer skill the worker start refreshes it; an own skill folder stays', async () => {
  const inst = installed();
  const env = { ...process.env, WORK_OS_WORKER_DIR: path.join(inst.d, 'cfg'), CLAUDE_SETTINGS_PATH: path.join(inst.d, 'claude', 'settings.json') };
  delete env.WORK_OS_KEY; delete env.CLAUDE_SKILLS_DIR;
  const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', env });
  const skills = path.join(inst.d, 'claude', 'skills');
  try {
    assert.equal(node([path.join(inst.workerDir, 'worker.mjs'), 'hooks', 'install']).status, 0);
    fs.rmSync(path.join(skills, 'transfer', '.work-os-managed')); // now the person's own: no marker
    const text = sourceFiles()['skills/declutter/SKILL.md'] + '\nChanged in this release.\n';
    const next = release(V1, { 'skills/declutter/SKILL.md': text });
    assert.equal((await check(inst, server({ latest: signed(next), body: next.body }))).result, 'updated');
    const probe = `const m = await import(${JSON.stringify(new URL('file:///' + path.join(inst.workerDir, 'hooks-install.mjs').split(path.sep).join('/')).href)}); console.log(JSON.stringify(m.refreshSkills()));`;
    const r = node(['--input-type=module', '-e', probe]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['declutter']);
    assert.equal(fs.readFileSync(path.join(skills, 'declutter', 'SKILL.md'), 'utf8'), text);
    assert.equal(fs.existsSync(path.join(skills, 'transfer', '.work-os-managed')), false, 'the own folder is not taken over');
  } finally { rm(inst.d); }
});

/** A throwaway git repo holding this worker (and its skills) at a commit time T, as the release commit would. */
function releaseRepo(d, T) {
  const repo = path.join(d, 'repo');
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: `${T} +0000`, GIT_COMMITTER_DATE: `${T} +0000`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  fs.mkdirSync(path.join(repo, 'worker', 'bundle'), { recursive: true });
  for (const [f, text] of Object.entries(sourceFiles())) { fs.mkdirSync(path.dirname(path.join(repo, 'worker', f)), { recursive: true }); fs.writeFileSync(path.join(repo, 'worker', f), text); }
  fs.writeFileSync(path.join(repo, 'worker', 'bundle', 'loader.mjs'), LOADER);
  fs.mkdirSync(path.join(repo, 'worker', 'test'));
  fs.writeFileSync(path.join(repo, 'worker', 'test', 'x.test.mjs'), '// a test, never in a release\n');
  g('init', '-q'); g('config', 'core.autocrlf', 'false');
  const commit = (msg, at = T) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    spawnSync('git', ['-C', repo, 'add', '-A'], { env });
    const r = spawnSync('git', ['-C', repo, 'commit', '-q', '-m', msg], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  };
  return { repo, commit };
}

test('the signing script imports no repo code and builds the same bundle, version and message as the worker and the server', async () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const imports = [...text.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0 && imports.every((m) => m.startsWith('node:')), `only node built-ins: ${imports.join(', ')}`);
  assert.doesNotMatch(text, /await import\(/, 'no dynamic import of release code (release-keys.mjs is read as text)');
  const s = await import(new URL('file:///' + SCRIPT.split(path.sep).join('/')).href);
  for (const v of [V0, V1]) assert.equal(s.bundleFrom(sourceFiles(), LOADER, v).sha256, release(v).sha256);
  assert.equal(s.releaseVersionAt(1_800_000_123), releaseVersionAt(1_800_000_123));
  assert.deepEqual(s.releaseMessage(V1, CURRENT.sha256), releaseMessage(V1, CURRENT.sha256));
  assert.equal(s.compareVersions('20261121.000000', '20261120.235959'), 1);
  assert.deepEqual(s.keysIn(`export const RELEASE_KEYS = [\n  '${KEYS[0]}', // a\n  // 'commented', \n];\n`), KEYS);
  const build = fs.readFileSync(path.join(WORKER, '..', 'scripts', 'build-artifact.sh'), 'utf8');
  assert.doesNotMatch(build, /WORKER_SIGNING_KEY|worker-signing\.key|APPDATA/, 'the WSL build never looks for the key');
  const commands = build.split('\n').filter((l) => !/^\s*(#|echo )/.test(l)).join('\n');
  assert.doesNotMatch(commands, /worker-signing-key\.mjs (sign|new|backup)/, 'it only picks up the signature');
  assert.match(build, /worker-signing-key\.mjs check --dir "\$REL\/worker" --sig "\$SIG"/);
});

test('the signing script signs a commit from its git blobs, lists what changed since the last release, never goes back; the key is never printed', () => {
  const d = tmp();
  try {
    const keyFile = path.join(d, 'release', 'worker-signing.key');
    fs.mkdirSync(path.dirname(keyFile));
    const pem = good.privateKey.export({ format: 'pem', type: 'pkcs8' });
    fs.writeFileSync(keyFile, pem);
    const T = Date.UTC(2026, 10, 20, 14, 30, 5) / 1000;
    const { repo, commit } = releaseRepo(d, T);
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a, '--repo', repo], { encoding: 'utf8', env: { ...process.env, WORKER_SIGNING_KEY: keyFile } });
    const keysFile = path.join(repo, 'worker', 'release-keys.mjs');
    // Not in the commit's release-keys.mjs: refused.
    fs.writeFileSync(keysFile, 'export const RELEASE_KEYS = [\n];\n');
    let sha = commit('no key');
    const out = path.join(d, 'out');
    let r = run('sign', '--out-dir', out);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not in that commit's worker\/release-keys\.mjs/);
    // Listed (and only in the commit: the working tree does not count).
    fs.writeFileSync(keysFile, `export const RELEASE_KEYS = [\n  '${KEYS[0]}', // test\n];\n`);
    sha = commit('key listed');
    fs.writeFileSync(keysFile, 'export const RELEASE_KEYS = [\n];\n');
    r = run('sign', '--out-dir', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no earlier signed release known here: every worker file is new to signing:\n {2}bundle|  skills\/transfer\/SKILL\.md/);
    const sigFile = path.join(out, `worker-signature-${sha.slice(0, 12)}.json`);
    const rec = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    assert.equal(rec.version, '20261120.143005');
    assert.equal(rec.commit, sha);
    const files = { ...sourceFiles(), 'release-keys.mjs': `export const RELEASE_KEYS = [\n  '${KEYS[0]}', // test\n];\n` };
    assert.equal(rec.sha256, bundleFrom(files, LOADER, rec.version).sha256, 'the bundle the server builds from the same files');
    assert.ok(rec.sha256 !== bundleFrom({ ...files, 'test.mjs': 'x' }, LOADER, rec.version).sha256);
    assert.equal(verifyRelease(rec, KEYS), true);
    assert.ok(!(r.stdout + r.stderr).includes(pem.split('\n').slice(1, -2).join('')), 'the private key is not printed');
    assert.equal(JSON.parse(fs.readFileSync(`${keyFile}.last.json`, 'utf8')).commit, sha, 'the key remembers its last release and commit');
    // What the WSL build runs: check the signature against the release's own files, read as text (no key needed).
    fs.writeFileSync(keysFile, `export const RELEASE_KEYS = [\n  '${KEYS[0]}', // test\n];\n`);
    r = spawnSync(process.execPath, [SCRIPT, 'check', '--dir', path.join(repo, 'worker'), '--sig', sigFile], { encoding: 'utf8', env: { ...process.env, WORKER_SIGNING_KEY: '' } });
    assert.equal(r.status, 0, r.stderr);
    // The same release again (a rebuild of the same commit): fine.
    assert.equal(run('sign', '--out-dir', out).status, 0);
    // A later commit: the changed worker files are listed before signing (tests left out); signed at its own time.
    fs.appendFileSync(path.join(repo, 'worker', 'loop.mjs'), '\n// change\n');
    fs.appendFileSync(path.join(repo, 'worker', 'test', 'x.test.mjs'), '// more\n');
    fs.writeFileSync(path.join(repo, 'worker', 'skills', 'declutter', 'SKILL.md'), '---\nname: declutter\n---\nnew\n');
    const sha2 = commit('change', T + 60);
    r = run('sign', '--out-dir', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /worker files changed since the last signed release 20261120\.143005 \([0-9a-f]{12}\):\n {2}M worker\/loop\.mjs\n {2}M worker\/skills\/declutter\/SKILL\.md\n/);
    assert.doesNotMatch(r.stdout, /x\.test\.mjs/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, `worker-signature-${sha2.slice(0, 12)}.json`), 'utf8')).version, '20261120.143105');
    // The first commit again: below the last release, refused.
    r = run('sign', '--ref', sha, '--out', path.join(d, 'old.json'));
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not above the last signed release 20261120\.143105/);
    // A signature for another commit does not fit: the build leaves it out.
    r = spawnSync(process.execPath, [SCRIPT, 'check', '--dir', path.join(repo, 'worker'), '--sig', sigFile], { encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /sign it again/);
    // No key file: a plain message.
    r = spawnSync(process.execPath, [SCRIPT, 'sign', '--repo', repo, '--out', path.join(d, 'x.json')], { encoding: 'utf8', env: { ...process.env, WORKER_SIGNING_KEY: path.join(d, 'none.key') } });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no signing key at/);
  } finally { rm(d); }
});

test('the release key is kept with DPAPI (Windows): new stores it protected, sign reads it, backup writes an offline copy', { skip: process.platform !== 'win32' && 'DPAPI is Windows only' }, () => {
  const d = tmp();
  try {
    const T = Date.UTC(2026, 10, 20, 15, 0, 0) / 1000;
    const { repo, commit } = releaseRepo(d, T);
    fs.writeFileSync(path.join(repo, 'worker', 'release-keys.mjs'), 'export const RELEASE_KEYS = [\n];\n');
    commit('no key yet');
    const env = { ...process.env, APPDATA: path.join(d, 'appdata') };
    delete env.WORKER_SIGNING_KEY;
    const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a, '--repo', repo], { encoding: 'utf8', env });
    let r = run('new', '--label', 'test key');
    assert.equal(r.status, 0, r.stderr);
    const store = path.join(d, 'appdata', 'work-os-release');
    assert.deepEqual(fs.readdirSync(store), ['worker-signing.key.dpapi'], 'only the protected file, no plain key');
    const stored = fs.readFileSync(path.join(store, 'worker-signing.key.dpapi'), 'utf8');
    assert.doesNotMatch(stored, /PRIVATE KEY|^MC4CAQAw/, 'DPAPI ciphertext, not the key');
    const pub = /public key added to worker\/release-keys\.mjs: ([A-Za-z0-9+/=]+)/.exec(r.stdout)[1];
    assert.ok(fs.readFileSync(path.join(repo, 'worker', 'release-keys.mjs'), 'utf8').includes(`'${pub}', // test key`));
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/);
    assert.match(run('new').stderr, /already exists/);
    const sha = commit('key listed', T + 1);
    r = run('sign', '--out-dir', path.join(d, 'out'));
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(fs.readFileSync(path.join(d, 'out', `worker-signature-${sha.slice(0, 12)}.json`), 'utf8'));
    assert.equal(verifyRelease(rec, [pub]), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(store, 'last-release.json'), 'utf8')).commit, sha);
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE KEY/);
    // An offline copy: a new file only, a real key that matches.
    const backup = path.join(d, 'usb', 'key.pem');
    fs.mkdirSync(path.dirname(backup));
    r = run('backup', '--out', backup);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(publicKeyText(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(backup, 'utf8')))), pub);
    assert.notEqual(run('backup', '--out', backup).status, 0, 'never overwrites a file');
  } finally { rm(d); }
});
