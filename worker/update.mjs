// Self-update (docs/launcher.md "Self-update"). A worker installed from the download asks Work OS for the latest release
// at start and every 6 hours. It installs one only when the version is newer than its own and the release is signed by
// one of the keys in its own release-keys.mjs: whoever controls the server can serve any file, but cannot sign one. It
// writes the verified file beside the current one (temp file, then a rename), lets that file unpack itself into the
// `worker` folder, and the supervisor restarts the worker on the code change; the new worker refreshes the hooks. On any
// failure the old code keeps running, worker.log gets one line and the status (Claude, Setup, Computers) says why.
// A worker run from the repo never updates itself.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundleId, releaseVersion, checkBaseUrl, configDir } from './config.mjs';
import { RELEASE_KEYS } from './release-keys.mjs';
import { VERSION_RE, SHA_RE, verifyRelease, compareVersions } from './release.mjs';

export const EVERY_MS = 6 * 3600_000;
export const MAX_BYTES = 8 * 1024 * 1024;
export const BUNDLE_FILE = 'work-os-worker.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const statusFile = () => path.join(configDir(), 'self-update.json');

/** What the last self-update did: { updatedAt, from, to } of the last one installed, { problem, problemAt } of the last failure. */
export function readUpdateStatus(file = statusFile()) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
function writeUpdateStatus(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* the status is a report only */ }
}

/** The status block the worker sends (core.mjs), or null for a repo run. */
export function updateReport(file = statusFile(), current = bundleId()) {
  if (!current) return null;
  const s = readUpdateStatus(file);
  return {
    on: true,
    ...(typeof s.updatedAt === 'string' ? { updatedAt: s.updatedAt } : {}),
    ...(typeof s.from === 'string' ? { from: s.from } : {}),
    ...(typeof s.problem === 'string' ? { problem: s.problem } : {}),
  };
}

// Runs the verified file once with `unpack`: its loader writes the code into the `worker` folder beside it and exits.
function unpackWith(file) {
  const r = spawnSync(process.execPath, [file, 'unpack'], { stdio: 'ignore', timeout: 60_000, windowsHide: true });
  return r.status === 0;
}

const short = (e) => String(e?.code || e?.message || e).split('\n')[0].slice(0, 60);

/**
 * One check. Returns { result: 'repo' | 'current' | 'updated' | 'refused' | 'failed', reason?, version? }.
 * workerDir: the unpacked `worker` folder (the download sits in its parent). version: the installed release's version
 * (worker/RELEASE, set by the signing step and carried in the bundle); a bundle without one counts as 0, below every release.
 */
export async function selfUpdate({ baseUrl, workerDir = HERE, version = releaseVersion(workerDir) ?? '0', current = bundleId(workerDir), keys = RELEASE_KEYS, fetchImpl = fetch, unpack = unpackWith, file = statusFile(), now = () => new Date(), log = () => {} }) {
  if (!current) return { result: 'repo' };
  const prior = readUpdateStatus(file);
  const done = (result, reason, offered) => {
    if (result === 'current' || result === 'updated') {
      const next = { ...prior };
      delete next.problem; delete next.problemAt; delete next.offered;
      if (result === 'updated') Object.assign(next, { updatedAt: now().toISOString(), from: version, to: offered });
      writeUpdateStatus(file, next);
      if (result === 'updated') log(`worker updated itself from ${version} to ${offered}; it restarts on the new code`);
    } else {
      const problem = `update ${result}: ${reason}`;
      writeUpdateStatus(file, { ...prior, problem, problemAt: now().toISOString(), ...(offered ? { offered } : {}) });
      log(`${problem}${offered ? ` (offered ${offered})` : ''}; keeping worker ${version}`);
    }
    return { result, ...(reason ? { reason } : {}), ...(offered ? { version: offered } : {}) };
  };

  let base, latest;
  try {
    base = checkBaseUrl(baseUrl);
    const res = await fetchImpl(base + '/worker/latest.json', { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    if (res.status !== 200) return done('failed', `Work OS answered ${res.status}`);
    latest = await res.json();
  } catch (e) { return done('failed', `could not reach Work OS (${short(e)})`); }
  if (!latest || typeof latest.version !== 'string' || !VERSION_RE.test(latest.version) || typeof latest.sha256 !== 'string' || !SHA_RE.test(latest.sha256)) return done('failed', 'latest.json is not valid');
  if (latest.sha256 === current) return done('current');
  const offered = latest.version;
  if (typeof latest.signature !== 'string' || !latest.signature) return done('refused', 'not signed', offered);
  if (!verifyRelease(latest, keys)) return done('refused', 'bad signature', offered);
  if (compareVersions(offered, version) <= 0) return done('refused', `version ${offered} is not newer than ${version}`, offered); // no downgrades

  let bytes;
  try {
    const res = await fetchImpl(base + '/worker/' + BUNDLE_FILE, { signal: AbortSignal.timeout(120_000), cache: 'no-store' });
    if (res.status !== 200) return done('failed', `the download answered ${res.status}`, offered);
    if (Number(res.headers?.get?.('content-length')) > MAX_BYTES) return done('failed', 'the download is too large', offered);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) { return done('failed', `the download broke off (${short(e)})`, offered); }
  if (bytes.length > MAX_BYTES) return done('failed', 'the download is too large', offered);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== latest.sha256) return done('failed', 'the download does not match its signed checksum', offered);

  const dir = path.dirname(workerDir);
  const target = path.join(dir, BUNDLE_FILE);
  const tmp = path.join(dir, `.${BUNDLE_FILE}.${process.pid}.new`);
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return done('failed', `could not write the new worker (${short(e)})`, offered);
  }
  if (!unpack(target) || bundleId(workerDir) !== latest.sha256) return done('failed', 'the new worker did not unpack', offered);
  return done('updated', null, offered);
}

/** At start and every 6 hours (downloaded bundles only). */
export function startSelfUpdate({ getBaseUrl, log, every = EVERY_MS, ...rest }) {
  if (!(rest.current ?? bundleId(rest.workerDir ?? HERE))) return null;
  let running = false;
  const once = async () => {
    if (running) return;
    running = true;
    try { await selfUpdate({ baseUrl: getBaseUrl(), log, ...rest }); } catch (e) { log(`update failed: ${short(e)}`); } finally { running = false; }
  };
  once();
  const t = setInterval(once, every);
  t.unref?.();
  return t;
}
