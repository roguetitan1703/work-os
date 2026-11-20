export type Bundle = { body: string; sha256: string; version: string; bytes: number; files: string[] };
export function bundleFrom(files: Record<string, string>, loader: string, release?: string): Bundle;
export function readWorkerFiles(workerDir: string): { files: Record<string, string>; loader: string };
export function buildBundle(workerDir: string, release?: string): Bundle;
export const SKILL_RE: RegExp;
