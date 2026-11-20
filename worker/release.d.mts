export const VERSION_RE: RegExp;
export const SHA_RE: RegExp;
export function releaseMessage(version: string, sha256: string): Buffer;
export function publicKeyText(key: unknown): string;
export function signRelease(release: { version: string; sha256: string }, privateKey: unknown): string;
export function verifyRelease(release: { version: unknown; sha256: unknown; signature: unknown }, keys: readonly string[]): boolean;
export function compareVersions(a: string, b: string): number;
