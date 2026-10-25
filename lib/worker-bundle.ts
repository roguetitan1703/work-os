import 'server-only';
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
