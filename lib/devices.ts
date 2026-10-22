import 'server-only';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { collections, type DeviceDoc } from './db';
import { SafeError } from './auth';
import type { Caller } from './caller';

// Device keys for the session launcher's worker (docs/launcher.md). A separate kind of credential from Work OS API
// keys (wos_…, lib/api-keys.ts): accepted ONLY by /api/worker/*, and those routes accept nothing else. Only the
// SHA-256 is stored; the key is shown once. A device is created by a signed-in user and records them (ownerId) and
// their organization (orgId); devices from before sign-in by user have neither and must be re-linked (docs/auth.md).
//
// Format: "wkr_" + 32 random bytes, base64url (47 chars).

export const DEVICE_KEY_PREFIX = 'wkr_';
const SEEN_EVERY_MS = 60_000;
const MAX_DEVICES = 10;

export type DeviceInfo = { id: string; name: string; prefix: string; createdAt: string; lastSeenAt: string | null; os: string | null; version: string | null };
export type VerifiedDevice = { id: string; name: string; ownerId?: string; orgId?: string };

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function toInfo(d: DeviceDoc): DeviceInfo {
  return { id: d._id, name: d.name, prefix: d.prefix, createdAt: d.createdAt.toISOString(), lastSeenAt: d.lastSeenAt?.toISOString() ?? null, os: d.worker?.os ?? null, version: d.worker?.version ?? null };
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const docs = await (await collections()).devices.find({ revokedAt: null }).sort({ createdAt: 1 }).toArray();
  return docs.map(toInfo);
}

/** Creates a device and returns its key in full. This is the only time the plaintext exists. */
export async function createDevice(caller: Caller, name: string): Promise<{ key: string; info: DeviceInfo }> {
  const n = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!n) throw new SafeError('Give the device a name, e.g. Om-PC.');
  if (caller.via !== 'session') throw new SafeError('Computers are added by a signed-in person.');
  const c = await collections();
  if ((await c.devices.countDocuments({ revokedAt: null })) >= MAX_DEVICES) throw new SafeError(`At most ${MAX_DEVICES} devices. Revoke one first.`);
  if (await c.devices.findOne({ revokedAt: null, name: n })) throw new SafeError('A device with that name already exists.');
  const key = DEVICE_KEY_PREFIX + randomBytes(32).toString('base64url');
  const doc: DeviceDoc = { _id: randomUUID(), name: n, ownerId: caller.userId, orgId: caller.orgId, hash: sha256(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null };
  await c.devices.insertOne(doc);
  return { key, info: toInfo(doc) };
}

/** Revoking also cancels the device's pending jobs. Its folders and session history stay. */
export async function revokeDevice(id: string): Promise<void> {
  const c = await collections();
  const r = await c.devices.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!r.matchedCount) throw new SafeError('That device is already revoked or does not exist.');
  await c.workerJobs.updateMany({ deviceId: id, doneAt: null }, { $set: { doneAt: new Date(), ok: false, error: 'device revoked' } });
}

/** The device for a presented key, or null. Hash lookup, then constant-time compare. */
export async function verifyDeviceKey(token: string | null | undefined): Promise<VerifiedDevice | null> {
  if (!token || !token.startsWith(DEVICE_KEY_PREFIX) || token.length < 40 || token.length > 80) return null;
  const hash = sha256(token);
  const c = await collections();
  const doc = await c.devices.findOne({ hash });
  if (!doc || doc.revokedAt) return null;
  const a = Buffer.from(doc.hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const now = Date.now();
  if (!doc.lastSeenAt || now - doc.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    c.devices.updateOne({ _id: doc._id }, { $set: { lastSeenAt: new Date(now) } }).catch(() => {});
  }
  return { id: doc._id, name: doc.name, ownerId: doc.ownerId, orgId: doc.orgId };
}
