'use client';

import { createAuthClient } from 'better-auth/react';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

// Browser side of Better Auth (docs/auth.md): sign-in, two-factor, passkeys, password reset and change. It talks to
// /api/auth/* on this site (app/api/auth/[...all]/route.ts serves an allowlist of endpoints).
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [twoFactorClient(), passkeyClient(), organizationClient()],
});

/** A short message for a failed call; Better Auth's own message when it has one. */
export function authError(e: { message?: string; status?: number } | null | undefined, fallback = 'Something went wrong. Try again.'): string {
  if (e?.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
  return e?.message || fallback;
}
