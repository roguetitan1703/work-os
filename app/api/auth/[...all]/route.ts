import { getAuth } from '@/lib/auth-server';

// Better Auth's HTTP endpoints, for the browser client (lib/auth-client.ts): sign-in, two-factor, passkeys, password
// reset and change, sessions, and reading the organization. Only the paths below are served; everything else answers
// 404. Accounts, invitations, organizations and API keys are created only by Work OS's own server code
// (lib/members.ts, lib/api-keys.ts, scripts/migrate-auth.mjs), which calls auth.api directly.
// proxy.ts lets /api/auth/* through without a session: each endpoint checks its own.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = new Set([
  '/ok',
  '/error',
  '/get-session',
  '/sign-in/email',
  '/sign-out',
  '/request-password-reset',
  '/reset-password',
  '/change-password',
  '/list-sessions',
  '/revoke-session',
  '/revoke-other-sessions',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/generate-backup-codes',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  '/organization/list',
  '/organization/set-active',
  '/organization/get-full-organization',
  '/organization/list-members',
  '/organization/list-invitations',
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/cancel-invitation',
]);

function allowed(pathname: string): boolean {
  const sub = pathname.replace(/^\/api\/auth/, '').replace(/\/+$/, '');
  // The link in a reset email: /reset-password/<token> (redirects to /login/reset?token=…).
  return ALLOWED.has(sub) || /^\/reset-password\/[A-Za-z0-9_-]{1,200}$/.test(sub);
}

async function handle(req: Request): Promise<Response> {
  if (!allowed(new URL(req.url).pathname)) return new Response('Not Found', { status: 404 });
  return (await getAuth()).handler(req);
}

export { handle as GET, handle as POST };
