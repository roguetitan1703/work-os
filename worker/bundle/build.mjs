// Builds the one-file worker download from worker/*.mjs (tests excluded) and loader.mjs. Used by the app
// (lib/worker-bundle.ts), by scripts/worker-signing-key.mjs and by the worker tests. Same input, same bytes: a
// release's bundle never changes.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const VERSION_RE = /^\d{1,9}(\.\d{1,9}){0,3}$/; // as worker/release.mjs
/** The Work OS skills the worker installs (worker/skills/<name>/SKILL.md, hooks-install.mjs); the loader unpacks the same names. */
export const SKILL_RE = /^skills\/[a-z0-9][a-z0-9-]{0,39}\/SKILL\.md$/;

/**
 * files: { 'worker.mjs': text, ..., 'skills/<name>/SKILL.md': text } (top-level worker/*.mjs and the skills); loader: the
 * text of bundle/loader.mjs.
 * release: the version of a signed release (YYYYMMDD.HHMMSS, set by the signing step); without one the bundle carries the
 * code version (core.mjs VERSION). The version is written into the bundle, so the sha256 covers it, and the loader
 * leaves it in worker/RELEASE: that is the version the installed worker compares an update with.
 */
export function bundleFrom(files, loader, release) {
  const sorted = {};
  for (const f of Object.keys(files).filter((n) => /^[A-Za-z0-9._-]+\.mjs$/.test(n) || SKILL_RE.test(n)).sort()) sorted[f] = files[f];
  const version = release ?? /VERSION\s*=\s*'([^']+)'/.exec(sorted['core.mjs'] ?? '')?.[1] ?? '0';
  if (!VERSION_RE.test(version)) throw new Error(`bad worker version ${String(version).slice(0, 30)}`);
  const body = loader.replace('/*FILES*/ {}', () => JSON.stringify(sorted, null, 1)).replace("/*RELEASE*/ ''", () => JSON.stringify(version));
  return { body, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), version, bytes: Buffer.byteLength(body), files: Object.keys(sorted) };
}

/** The files bundleFrom takes, read from a worker folder. */
export function readWorkerFiles(workerDir) {
  const files = {};
  for (const f of readdirSync(workerDir).filter((n) => n.endsWith('.mjs'))) files[f] = readFileSync(path.join(workerDir, f), 'utf8');
  let skills = [];
  try { skills = readdirSync(path.join(workerDir, 'skills')); } catch { /* none */ }
  for (const s of skills) {
    const key = `skills/${s}/SKILL.md`;
    if (!SKILL_RE.test(key)) continue;
    try { files[key] = readFileSync(path.join(workerDir, 'skills', s, 'SKILL.md'), 'utf8'); } catch { /* a folder without SKILL.md */ }
  }
  return { files, loader: readFileSync(path.join(workerDir, 'bundle', 'loader.mjs'), 'utf8') };
}

export function buildBundle(workerDir, release) {
  const { files, loader } = readWorkerFiles(workerDir);
  return bundleFrom(files, loader, release);
}
