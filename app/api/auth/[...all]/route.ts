import { CLIENT_IP_HEADER, clientIp, COOKIE_PREFIX, secureCookies } from '@/lib/auth';
import { getAuth } from '@/lib/auth-server';
import { accountKey, accountLocked, ACCOUNT_LOCKED_MESSAGE, clearAccountFailures, recordAccountFailure } from '@/lib/auth-limits';
import { getDb } from '@/lib/db';
import { isFresh } from '@/lib/fresh';
import { REAUTH_CODE, REAUTH_MESSAGE } from '@/lib/reauth-shared';
import { dropOAuth, ensureResource, pruneUnusedClients } from '@/lib/oauth';
import { OAUTH_SCOPES } from '@/lib/oauth-config';

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
  // OAuth sign-in for MCP clients (lib/auth-server.ts oauthProvider; docs/auth.md). Not served: introspect, userinfo, end-session,
  // client create/update/delete, consent management, resource admin, continue: apps register only through /oauth2/register (trimmed below).
  '/oauth2/authorize',
  '/oauth2/consent',
  '/oauth2/token',
  '/oauth2/revoke',
  '/oauth2/register',
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

// ── Dynamic client registration (RFC 7591) ─────────────────────────────────
// Open to anyone (claude.ai registers itself), so the request is cut down to what Work OS uses before Better Auth sees it:
// - redirect addresses: https, or http on the loopback host for desktop and command-line apps; no fragment, no credentials
//   (the plugin then matches them exactly at authorize, except a loopback port, as RFC 8252 asks)
// - a public client only (no secret), authorization code and refresh grants, our scopes
// - fields that make the server fetch an address (jwks_uri, logo, backchannel logout, software statement) are dropped
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function validRedirectUri(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 500 || u.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function trimRegistration(raw: string): { body: string } | { error: string } {
  if (raw.length > 8192) return { error: 'invalid_client_metadata' };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: 'invalid_client_metadata' };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'invalid_client_metadata' };
  const uris = j.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirectUri)) return { error: 'invalid_redirect_uri' };
  const grants = Array.isArray(j.grant_types) ? j.grant_types.filter(g => g === 'authorization_code' || g === 'refresh_token') : ['authorization_code', 'refresh_token'];
  const scope = typeof j.scope === 'string' ? j.scope.split(/\s+/).filter(x => (OAUTH_SCOPES as readonly string[]).includes(x)).join(' ') : '';
  const name = typeof j.client_name === 'string' ? j.client_name.slice(0, 100) : undefined;
  const out: Record<string, unknown> = {
    redirect_uris: uris,
    client_name: name,
    grant_types: grants.length ? grants : ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(scope ? { scope } : {}),
    ...(j.application_type === 'web' || j.application_type === 'native' ? { application_type: j.application_type } : {}),
  };
  return { body: JSON.stringify(out) };
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
  let body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
  if (path === '/oauth2/register') {
    if (req.method !== 'POST') return new Response('Not Found', { status: 404 });
    const t = trimRegistration(body ?? '');
    if ('error' in t) return Response.json({ error: t.error }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    body = t.body;
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    void pruneUnusedClients().catch(() => {});
  }
  if (path === '/oauth2/register' || path === '/oauth2/authorize' || path === '/oauth2/token') await ensureResource();
  const forwarded = new Request(req.url, { method: req.method, headers, body });

  const key = req.method === 'POST' && PER_ACCOUNT.has(path) ? await accountKeyFor(path, req, body ?? '') : null;
  if (key && (await accountLocked(key))) {
    return Response.json({ code: 'TOO_MANY_ATTEMPTS', message: ACCOUNT_LOCKED_MESSAGE }, { status: 429 });
  }
  // A password change or turning two-step sign-in off says the account may have been taken: the apps approved (OAuth) lose access too.
  const dropFor = req.method === 'POST' && (path === '/change-password' || path === '/two-factor/disable') ? (await (await getAuth()).api.getSession({ headers: req.headers }).catch(() => null))?.user?.id : null;
  const res = await (await getAuth()).handler(forwarded);
  if (dropFor && res.ok) await dropOAuth(String(dropFor), null).catch(e => console.error('revoking OAuth tokens failed:', e instanceof Error ? e.message : e));
  if (key) {
    if (res.ok) await clearAccountFailures(key).catch(() => {});
    else if (res.status === 400 || res.status === 401 || res.status === 403) await recordAccountFailure(key).catch(() => {});
  }
  return path === '/organization/get-full-organization' ? trimFullOrganization(res, req.headers) : res;
}

export { handle as GET, handle as POST };
