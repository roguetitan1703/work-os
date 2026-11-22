import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { bundleFrom, readWorkerFiles } from '../worker/bundle/build.mjs';

// The worker (worker/*.mjs, Node built-ins only) as one downloadable file, so a teammate without the repository can
// install it (docs/ops/launcher.md "Installing without the repo"). Built from the release's own files and kept: a release
// never changes, so the bytes and the sha256 never do. No secrets: only the worker's source.
//
// Signed releases (docs/ops/launcher.md "Self-update"): the signing step on Om's PC picks the release version (the commit
// time), builds the bundle with it and signs version + sha256. Its record sits in .next/worker-signature.json (made by
// scripts/build-artifact.sh) or worker/bundle/signature.json (committed). When a record's version gives exactly the
// signed sha256 from this release's files, that bundle and its signature are served; otherwise the unsigned bundle (code
// version) is. The server never holds the private key and does not judge the signature: each worker checks it.

export type WorkerBundle = { body: string; sha256: string; version: string; bytes: number };
type Built = WorkerBundle & { files: string[] };

let source: ReturnType<typeof readWorkerFiles> | null = null;
const built = new Map<string, Built>();
function bundleAt(release?: string): Built {
  source ??= readWorkerFiles(path.join(process.cwd(), 'worker'));
  const k = release ?? '';
  let b = built.get(k);
  if (!b) built.set(k, (b = bundleFrom(source.files, source.loader, release)));
  return b;
}

const SIGNATURE_FILES = [path.join('.next', 'worker-signature.json'), path.join('worker', 'bundle', 'signature.json')];
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;
const VERSION_RE = /^\d{1,9}(\.\d{1,9}){0,3}$/;

/** The release this server serves: the signed one when a signature fits these files, else the unsigned bundle. The record files are re-read on each call (small). */
export function workerRelease(): { bundle: WorkerBundle; signature: string | null } {
  for (const f of SIGNATURE_FILES) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), f), 'utf8')) as { version?: unknown; sha256?: unknown; signature?: unknown };
      if (typeof j.version !== 'string' || !VERSION_RE.test(j.version) || typeof j.signature !== 'string' || !SIG_RE.test(j.signature)) continue;
      const b = bundleAt(j.version);
      if (b.sha256 === j.sha256) return { bundle: b, signature: j.signature };
    } catch {
      /* missing or unreadable: try the next */
    }
  }
  return { bundle: bundleAt(), signature: null };
}

export function workerBundle(): WorkerBundle {
  return workerRelease().bundle;
}
