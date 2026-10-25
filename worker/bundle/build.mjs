// Builds the one-file worker download from worker/*.mjs (tests excluded) and loader.mjs. Used by the app
// (lib/worker-bundle.ts) and by the worker tests. Same input, same bytes: a release's bundle never changes.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function buildBundle(workerDir) {
  const files = {};
  for (const f of readdirSync(workerDir).filter((n) => n.endsWith('.mjs')).sort()) files[f] = readFileSync(path.join(workerDir, f), 'utf8');
  const loader = readFileSync(path.join(workerDir, 'bundle', 'loader.mjs'), 'utf8');
  const body = loader.replace('/*FILES*/ {}', () => JSON.stringify(files, null, 1));
  const version = /VERSION\s*=\s*'([^']+)'/.exec(files['core.mjs'] ?? '')?.[1] ?? '0';
  return { body, sha256: createHash('sha256').update(body, 'utf8').digest('hex'), version, bytes: Buffer.byteLength(body), files: Object.keys(files) };
}
