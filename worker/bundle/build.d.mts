export type Bundle = { body: string; sha256: string; version: string; bytes: number; files: string[] };
export function bundleFrom(files: Record<string, string>, loader: string): Bundle;
export function buildBundle(workerDir: string): Bundle;
