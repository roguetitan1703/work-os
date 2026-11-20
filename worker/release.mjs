// Signed worker releases (docs/launcher.md "Self-update"). Node built-ins only: the worker (update.mjs), the server
// (lib/worker-bundle.ts) and scripts/worker-signing-key.mjs share it.
import crypto from 'node:crypto';

export const VERSION_RE = /^\d{1,9}(\.\d{1,9}){0,3}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes, base64

/**
 * The version of a signed release, set by the signing step and never by a person: the time of the release commit (or
 * of the build), UTC, as YYYYMMDD.HHMMSS. It only grows with time, and any such version is above the code version of an
 * unsigned bundle (worker/core.mjs VERSION, 0.x).
 */
export function releaseVersionAt(unixSeconds) {
  const d = new Date(Math.floor(Number(unixSeconds)) * 1000);
  if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 2000) throw new Error('bad release time');
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** What a release key signs: the worker version and the bundle's sha256, so one signature fits one bundle at one version. */
export function releaseMessage(version, sha256) {
  if (typeof version !== 'string' || !VERSION_RE.test(version) || typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new Error('bad release');
  return Buffer.from(`work-os-worker release\n${version}\n${sha256}\n`, 'utf8');
}

/** An Ed25519 public key in the form RELEASE_KEYS holds (base64 SPKI DER). */
export function publicKeyText(key) {
  const pub = key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
  return pub.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** Signs a release with an Ed25519 private key (KeyObject or PEM). Returns the base64 signature. */
export function signRelease({ version, sha256 }, privateKey) {
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.type !== 'private') throw new Error('the signing key is not a private key');
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not an Ed25519 key');
  return crypto.sign(null, releaseMessage(version, sha256), key).toString('base64');
}

/** True when one of `keys` (base64 SPKI DER, Ed25519) signed this version and sha256. Never throws. */
export function verifyRelease({ version, sha256, signature }, keys) {
  if (typeof signature !== 'string' || !SIG_RE.test(signature) || !Array.isArray(keys)) return false;
  let msg;
  try { msg = releaseMessage(version, sha256); } catch { return false; }
  const sig = Buffer.from(signature, 'base64');
  for (const k of keys) {
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(String(k), 'base64'), format: 'der', type: 'spki' });
      if (pub.asymmetricKeyType === 'ed25519' && crypto.verify(null, msg, pub, sig)) return true;
    } catch { /* a malformed key in the list counts as no match */ }
  }
  return false;
}

/** Compares dotted numeric versions ('0.10.0' > '0.9.2'; missing parts are 0). Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
