import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { buildBundle } from '../worker/bundle/build.mjs';

// The worker (worker/*.mjs, Node built-ins only) as one downloadable file, so a teammate without the repository can
// install it (docs/launcher.md "Installing without the repo"). Built from the release's own files on first request and
// kept: a release never changes, so the bytes and the sha256 never do. No secrets: only the worker's source.

export type WorkerBundle = { body: string; sha256: string; version: string; bytes: number };
let cached: WorkerBundle | null = null;

export function workerBundle(): WorkerBundle {
  return (cached ??= buildBundle(path.join(process.cwd(), 'worker')));
}

// Where a release signature can come from (docs/launcher.md "Self-update"): the build made on Om's PC puts one into
// .next (scripts/build-artifact.sh), and a signature made with `node scripts/worker-signing-key.mjs sign` is committed
// as worker/bundle/signature.json. Only one made for this very bundle (version and sha256) is served. The server never
// holds the private key and does not judge the signature: each worker checks it against the keys in its own code.
const SIGNATURE_FILES = [path.join('.next', 'worker-signature.json'), path.join('worker', 'bundle', 'signature.json')];
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

/** The release signature of the served bundle (base64), or null when this release is not signed. Read on each call: it is a small file. */
export function workerSignature(b: WorkerBundle = workerBundle()): string | null {
  for (const f of SIGNATURE_FILES) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), f), 'utf8')) as { version?: unknown; sha256?: unknown; signature?: unknown };
      if (j.version === b.version && j.sha256 === b.sha256 && typeof j.signature === 'string' && SIG_RE.test(j.signature)) return j.signature;
    } catch {
      /* missing or unreadable: try the next */
    }
  }
  return null;
}
