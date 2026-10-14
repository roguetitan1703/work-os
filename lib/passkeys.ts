import 'server-only';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { SafeError } from './auth';
import { collections, type AuthChallengeDoc } from './db';

// Passkeys (WebAuthn) for the single Work OS user.
//
// Relying party (see relyingParty): APP_URL, else Vercel's production URL; a
// localhost Host header is used only in dev or when neither is set. A passkey
// only works on the domain it was created on. User verification (biometric /
// PIN) is required, since passkey sign-in skips the TOTP step.
//
// Challenges live in the authChallenges collection for 5 minutes (TTL index)
// and are deleted the moment a response is checked against them (single-use).

const RP_NAME = 'Work OS';
const USER_ID = new TextEncoder().encode('work-os-owner');
const CHALLENGE_MS = 5 * 60_000;
const MAX_OPEN_LOGIN_CHALLENGES_PER_IP = 20;

export type RelyingParty = { rpID: string; origin: string };

export function relyingParty(h: Headers): RelyingParty {
  const prod = process.env.NODE_ENV === 'production';
  // The real Host header only; x-forwarded-host is ignored for this decision.
  const host = (h.get('host') ?? '').trim().toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  const isLocal = hostname === 'localhost' || hostname.endsWith('.localhost');
  const appUrl = process.env.APP_URL?.trim();
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim(); // Vercel system var, not spoofable
  const configured = appUrl || (vercelUrl ? `https://${vercelUrl}` : '');

  // Local testing: `npm run dev`, or `next start` on localhost with no site URL configured.
  if (isLocal && (!prod || !configured)) return { rpID: hostname, origin: `http://${host}` };
  if (configured) {
    const u = new URL(configured);
    return { rpID: u.hostname, origin: u.origin };
  }
  if (!prod && hostname) return { rpID: hostname, origin: `http://${host}` };
  throw new SafeError('Passkeys need the site address: set APP_URL (e.g. https://your-app.vercel.app).');
}

async function saveChallenge(challenge: string, kind: AuthChallengeDoc['kind'], ip: string): Promise<void> {
  const { authChallenges } = await collections();
  if (kind === 'login') {
    // Login options are requested before sign-in (every /login page load asks for one). Cap how many
    // one IP holds open by evicting that IP's oldest, so other IPs can't crowd out the owner's.
    const live = { ip, kind, expiresAt: { $gt: new Date() } };
    const open = await authChallenges.countDocuments(live);
    if (open >= MAX_OPEN_LOGIN_CHALLENGES_PER_IP) {
      const oldest = await authChallenges
        .find(live, { sort: { expiresAt: 1 }, limit: open - MAX_OPEN_LOGIN_CHALLENGES_PER_IP + 1, projection: { _id: 1 } })
        .toArray();
      await authChallenges.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
    }
  }
  await authChallenges.insertOne({ _id: challenge, kind, ip, expiresAt: new Date(Date.now() + CHALLENGE_MS) });
}

/** Deletes the challenge and reports whether it was valid (unexpired, right kind). */
function consumeChallenge(kind: AuthChallengeDoc['kind']) {
  return async (challenge: string): Promise<boolean> => {
    const { authChallenges } = await collections();
    const doc = await authChallenges.findOneAndDelete({ _id: challenge, kind });
    return !!doc && doc.expiresAt.getTime() > Date.now();
  };
}

const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

// ── Registration (signed-in only; callers must check) ───────────────────────

export async function registrationOptions(rp: RelyingParty, ip: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { passkeys } = await collections();
  const existing = await passkeys.find({}, { projection: { _id: 1, transports: 1 } }).toArray();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName: 'work-os',
    userDisplayName: 'Work OS',
    userID: USER_ID,
    attestationType: 'none',
    excludeCredentials: existing.map(p => ({ id: p._id, transports: p.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge(options.challenge, 'register', ip);
  return options;
}

export async function verifyRegistration(rp: RelyingParty, response: RegistrationResponseJSON, deviceName: string): Promise<void> {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: consumeChallenge('register'),
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  });
  if (!v.verified) throw new SafeError('Passkey could not be verified.');
  const c = v.registrationInfo.credential;
  const { passkeys } = await collections();
  await passkeys.insertOne({
    _id: c.id,
    publicKey: toB64(c.publicKey),
    counter: c.counter,
    transports: c.transports ?? [],
    deviceName: cleanName(deviceName),
    createdAt: new Date(),
    lastUsedAt: null,
  });
}

// ── Sign-in (unauthenticated) ───────────────────────────────────────────────

export async function authenticationOptions(rp: RelyingParty, ip: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // Empty allowCredentials: discoverable credentials, so the login page leaks nothing.
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
  await saveChallenge(options.challenge, 'login', ip);
  return options;
}

/** Verifies a passkey assertion. true = sign the user in. */
export async function verifyAuthentication(rp: RelyingParty, response: AuthenticationResponseJSON): Promise<boolean> {
  if (!response || typeof response.id !== 'string') return false;
  const { passkeys } = await collections();
  const pk = await passkeys.findOne({ _id: response.id });
  if (!pk) {
    // Burn the challenge anyway so it can't be retried.
    await consumeChallenge('login')(challengeOf(response) ?? '');
    return false;
  }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: consumeChallenge('login'),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: pk._id, publicKey: fromB64(pk.publicKey), counter: pk.counter, transports: pk.transports as AuthenticatorTransportFuture[] },
      requireUserVerification: true,
    });
  } catch {
    return false;
  }
  if (!v.verified) return false;
  await passkeys.updateOne({ _id: pk._id }, { $set: { counter: v.authenticationInfo.newCounter, lastUsedAt: new Date() } });
  return true;
}

function challengeOf(response: AuthenticationResponseJSON): string | null {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof data.challenge === 'string' ? data.challenge : null;
  } catch {
    return null;
  }
}

// ── Management ──────────────────────────────────────────────────────────────

export type PasskeyInfo = { id: string; deviceName: string; createdAt: string; lastUsedAt: string | null };

export async function listPasskeys(): Promise<PasskeyInfo[]> {
  const { passkeys } = await collections();
  const docs = await passkeys.find({}, { sort: { createdAt: 1 } }).toArray();
  return docs.map(d => ({ id: d._id, deviceName: d.deviceName, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt?.toISOString() ?? null }));
}

export async function removePasskey(id: string): Promise<void> {
  const { passkeys } = await collections();
  await passkeys.deleteOne({ _id: id });
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  const { passkeys } = await collections();
  await passkeys.updateOne({ _id: id }, { $set: { deviceName: cleanName(name) } });
}

function cleanName(name: string): string {
  return (typeof name === 'string' ? name : '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Passkey';
}
