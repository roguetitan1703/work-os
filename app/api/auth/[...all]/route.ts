import { CLIENT_IP_HEADER, clientIp, COOKIE_PREFIX, secureCookies } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { accountKey, accountLocked, ACCOUNT_LOCKED_MESSAGE, clearAccountFailures, recordAccountFailure } from '@/lib/auth-limits';
import { getDb } from '@/lib/db';
import { isFresh } from '@/lib/fresh';
import { REAUTH_CODE, REAUTH_MESSAGE } from '@/lib/reauth-shared';

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
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/cancel-invitation',
]);

function allowed(pathname: string): boolean {
  const p = sub(pathname);
  // The link in a reset email: /reset-password/<token> (redirects to /login/reset?token=…).
  return ALLOWED.has(p) || /^\/reset-password\/[A-Za-z0-9_-]{1,200}$/.test(p);
}

const sub = (pathname: string) => pathname.replace(/^\/api\/auth/, '').replace(/\/+$/, '');

// Adding a passkey makes a lasting credential: only from a fresh session (lib/fresh.ts).
const NEEDS_FRESH = new Set(['/passkey/generate-register-options', '/passkey/verify-registration']);
// Limited per account as well as per IP (lib/auth-limits.ts).
const PER_ACCOUNT = new Set(['/sign-in/email', '/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/** The user behind the two-factor cookie of a sign-in in progress (Better Auth stores identifier -> user id). */
async function twoFactorUser(req: Request): Promise<string | null> {
  const name = `${secureCookies() ? '__Secure-' : ''}${COOKIE_PREFIX}.two_factor`;
  const raw = (req.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(name + '='))?.slice(name.length + 1);
  if (!raw) return null;
  const signed = decodeURIComponent(raw);
  const identifier = signed.slice(0, signed.lastIndexOf('.'));
  if (!/^2fa-[A-Za-z0-9]{10,64}$/.test(identifier)) return null;
  const v = await (await getDb()).collection<{ identifier: string; value: string }>('verification').findOne({ identifier }); // scope-ok: Better Auth verification tokens (not organization data)
  return v?.value ? String(v.value) : null;
}

async function accountKeyFor(path: string, req: Request, body: string): Promise<string | null> {
  if (path === '/sign-in/email') {
    try {
      const email = (JSON.parse(body) as { email?: unknown }).email;
      return typeof email === 'string' && email.trim() ? accountKey('signin', email) : null;
    } catch {
      return null;
    }
  }
  const user = await twoFactorUser(req);
  return user ? accountKey('2fa', user) : null;
}

type FullOrg = { members?: { userId?: unknown; role?: unknown }[]; invitations?: Record<string, unknown>[] } | null;

/**
 * get-full-organization lists the organization's invitations: only owners and admins see them, and nobody sees an
 * invitation's tokenHash (lib/members.ts). Plain members get the organization and its members without invitations.
 */
async function trimFullOrganization(res: Response, h: Headers): Promise<Response> {
  if (!res.ok) return res;
  let org: FullOrg;
  try {
    org = (await res.clone().json()) as FullOrg;
  } catch {
    return res;
  }
  if (!org || !Array.isArray(org.invitations)) return res;
  const session = await (await getAuth()).api.getSession({ headers: h }).catch(() => null);
  const me = org.members?.find(m => session && String(m.userId) === String(session.user.id));
  const manages = me?.role === 'owner' || me?.role === 'admin';
  org.invitations = manages ? org.invitations.map(({ tokenHash: _drop, ...rest }) => rest) : [];
  const out = new Headers(res.headers);
  out.delete('content-length');
  out.delete('content-encoding');
  return new Response(JSON.stringify(org), { status: res.status, headers: out });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!allowed(url.pathname)) return new Response('Not Found', { status: 404 });
  const path = sub(url.pathname);

  if (NEEDS_FRESH.has(path) && !(await isFresh(req.headers))) {
    return Response.json({ code: REAUTH_CODE, message: REAUTH_MESSAGE }, { status: 403 });
  }

  // Better Auth reads the client address only from CLIENT_IP_HEADER: set here from clientIp() (TRUST_PROXY), after
  // dropping whatever the client sent under that name. No trusted address = Better Auth's single shared bucket.
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = clientIp(req.headers);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
  const forwarded = new Request(req.url, { method: req.method, headers, body });

  const key = req.method === 'POST' && PER_ACCOUNT.has(path) ? await accountKeyFor(path, req, body ?? '') : null;
  if (key && (await accountLocked(key))) {
    return Response.json({ code: 'TOO_MANY_ATTEMPTS', message: ACCOUNT_LOCKED_MESSAGE }, { status: 429 });
  }
  const res = await (await getAuth()).handler(forwarded);
  if (key) {
    if (res.ok) await clearAccountFailures(key).catch(() => {});
    else if (res.status === 400 || res.status === 401 || res.status === 403) await recordAccountFailure(key).catch(() => {});
  }
  return path === '/organization/get-full-organization' ? trimFullOrganization(res, req.headers) : res;
}

export { handle as GET, handle as POST };
