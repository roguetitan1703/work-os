import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { nextCookies } from 'better-auth/next-js';
import { organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import { COOKIE_CACHE_SECONDS, COOKIE_PREFIX, appBaseUrl, authSecret, secureCookies } from './auth';
import { getClient, getDb } from './db';
import { mailErrorMessage, sendMail, takeMailSlot } from './mail';

// Better Auth (docs/auth.md): users, sessions, organizations, two-factor, passkeys and API keys, stored by its MongoDB
// adapter in its own collections of the app database (user, session, account, verification, organization, member,
// invitation, twoFactor, passkey, apikey, rateLimit). Its HTTP endpoints are served at /api/auth/* through an
// allowlist (app/api/auth/[...all]/route.ts); everything else calls `auth.api.*` on the server.
//
// scripts/lib/auth-admin.mjs builds a second instance for scripts and the e2e seed: keep the options that decide
// what is stored (organization schema, API key prefix and metadata) the same in both.

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 256;
export const RESET_MINUTES = 15;
export const INVITE_DAYS = 7;
export const SESSION_DAYS = 60;
/** Every Work OS API key starts with this; the kind (Claude chat or Claude Code) is in its metadata. */
export const API_KEY_PREFIX = 'wos_';
export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** `$in` over both forms a reference can be stored in (the adapter stores ObjectId; older or hand-made docs a string). */
export const idIn = (id: string) => ({ $in: ObjectId.isValid(id) && id.length === 24 ? [new ObjectId(id), id] : [id] }) as unknown as { $in: ObjectId[] };

/** The organization a new session opens in: the user's oldest membership. */
async function firstOrgId(db: Db, userId: string): Promise<string | null> {
  const m = await db.collection('member').find({ userId: idIn(userId) }).sort({ createdAt: 1 }).limit(1).next();
  return m ? String(m.organizationId) : null;
}

function build(db: Db, client: MongoClient) {
  const secret = authSecret();
  if (!secret) throw new Error('BETTER_AUTH_SECRET (or SESSION_SECRET) must be set to at least 32 characters.');
  const baseURL = appBaseUrl();
  if (!baseURL) throw new Error('APP_URL must be set (the site address, e.g. https://work.delpat.in).');
  const origin = new URL(baseURL).origin;
  const rateLimitOn = process.env.AUTH_RATE_LIMIT !== 'off';

  return betterAuth({
    appName: 'Work OS',
    baseURL,
    basePath: '/api/auth',
    secret,
    trustedOrigins: [origin],
    database: mongodbAdapter(db, { client }),
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // accounts come from invitations (app/accept-invitation) and scripts/migrate-auth.mjs
      minPasswordLength: MIN_PASSWORD,
      maxPasswordLength: MAX_PASSWORD,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_MINUTES * 60,
      // Not awaited: the answer must take the same time whether or not the address has an account.
      sendResetPassword: async ({ user, url }) => {
        void (async () => {
          if (!(await takeMailSlot('reset', user.email))) return;
          await sendMail({
            to: user.email,
            subject: 'Reset your Work OS password',
            text: `Someone asked to reset the Work OS password for ${user.email}.\n\nOpen this link within ${RESET_MINUTES} minutes to choose a new password (it works once):\n${url}\n\nIf it wasn't you, ignore this email; your password stays the same.`,
          });
        })().catch(e => console.error('reset email failed:', mailErrorMessage(e)));
      },
      onPasswordReset: async ({ user }) => {
        try {
          if (await takeMailSlot('changed', user.email)) {
            await sendMail({
              to: user.email,
              subject: 'Your Work OS password was changed',
              text: `The Work OS password for ${user.email} was just reset and every device was signed out.\n\nIf this wasn't you, reset it again now and check Settings › Security.`,
            });
          }
        } catch (e) {
          console.error('password-changed email failed:', mailErrorMessage(e));
        }
      },
    },
    session: {
      expiresIn: SESSION_DAYS * 86_400,
      updateAge: 86_400,
      // proxy.ts and getCaller() trust this signed copy for COOKIE_CACHE_SECONDS before reading the session again.
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_SECONDS },
    },
    // Reset links are stored only as a hash, so a copy of the database can't be used to take over an account.
    verification: { storeIdentifier: { default: 'plain', overrides: { 'reset-password:': 'hashed' } } },
    rateLimit: {
      enabled: rateLimitOn,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 300, max: 10 },
        '/two-factor/verify-totp': { window: 300, max: 10 },
        '/two-factor/verify-backup-code': { window: 300, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/reset-password': { window: 900, max: 10 },
        '/change-password': { window: 300, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: secureCookies(),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] },
    },
    databaseHooks: {
      session: {
        create: {
          before: async session => {
            const s = session as { userId: string; activeOrganizationId?: string | null };
            if (s.activeOrganizationId) return;
            const orgId = await firstOrgId(db, s.userId);
            return orgId ? { data: { ...session, activeOrganizationId: orgId } } : undefined;
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITE_DAYS * 86_400,
        cancelPendingInvitationsOnReInvite: true,
        schema: {
          invitation: {
            additionalFields: {
              // SHA-256 of the secret in the emailed link (lib/members.ts). The invitation id alone is not enough.
              tokenHash: { type: 'string', required: false, input: false },
            },
          },
        },
      }),
      twoFactor({ issuer: 'Work OS', backupCodeOptions: { amount: 10, length: 10 } }),
      passkey({ rpID: new URL(baseURL).hostname, rpName: 'Work OS', origin }),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        defaultKeyLength: 48,
        enableMetadata: true,
        requireName: true,
        maximumNameLength: 60,
        // Work OS applies its own limits (lib/mcp/policy.ts); the plugin's would also cap the claude.ai connector.
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: null },
      }),
      nextCookies(), // last: lets server actions that call auth.api set cookies
    ],
  });
}

export type Auth = ReturnType<typeof build>;

const g = globalThis as unknown as { __workosAuth?: Promise<Auth> };

/** The Better Auth instance (one per process). */
export function getAuth(): Promise<Auth> {
  g.__workosAuth ??= (async () => build(await getDb(), await getClient()))().catch(err => {
    g.__workosAuth = undefined;
    throw err;
  });
  return g.__workosAuth;
}

// ── Invitation links ────────────────────────────────────────────────────────

export const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
