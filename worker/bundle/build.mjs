// Builds the one-file worker download from worker/*.mjs (tests excluded) and loader.mjs. Used by the app
// (lib/worker-bundle.ts), by scripts/worker-signing-key.mjs and by the worker tests. Same input, same bytes: a
// release's bundle never changes.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** files: { 'worker.mjs': text, ... } (top-level worker/*.mjs); loader: the text of bundle/loader.mjs. */
export function bundleFrom(files, loader) {
  const sorted = {};
  for (const f of Object.keys(files).filter((n) => n.endsWith('.mjs')).sort()) sorted[f] = files[f];
  const body = loader.replace('/*FILES*/ {}', () => JSON.stringify(sorted, null, 1));
  const version = /VERSION\s*=\s*'([^']+)'/.exec(sorted['core.mjs'] ?? '')?.[1] ?? '0';
  return { body, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), version, bytes: Buffer.byteLength(body), files: Object.keys(sorted) };
}

export function buildBundle(workerDir) {
  const files = {};
  for (const f of readdirSync(workerDir).filter((n) => n.endsWith('.mjs'))) files[f] = readFileSync(path.join(workerDir, f), 'utf8');
  return bundleFrom(files, readFileSync(path.join(workerDir, 'bundle', 'loader.mjs'), 'utf8'));
}
