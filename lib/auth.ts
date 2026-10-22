// Small auth helpers with no database and no Better Auth import, so proxy.ts and client-safe code can use them.
// Sign-in itself is Better Auth (lib/auth-server.ts); who is calling is lib/caller.ts. docs/auth.md has the whole picture.
//
//   BETTER_AUTH_SECRET  signs session cookies, the cookie cache and the MCP confirm tokens; encrypts TOTP secrets.
//                       At least 32 characters. SESSION_SECRET is read when it is not set (the old name).
//   APP_URL             the site's public address: Better Auth's base URL, passkey origin, links in emails.

export function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export const MIN_SECRET = 32;

/** The auth secret, or null when it is missing or too short (callers fail closed). */
export function authSecret(): string | null {
  const s = process.env.BETTER_AUTH_SECRET || process.env.SESSION_SECRET || '';
  return s.length >= MIN_SECRET ? s : null;
}

/** The site's public base URL without a trailing slash. Production needs APP_URL (or Vercel's production URL). */
export function appBaseUrl(): string | null {
  const u = process.env.APP_URL?.trim() || process.env.BETTER_AUTH_URL?.trim();
  if (u) return u.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return isDev() ? 'http://localhost:3000' : null;
}

/** Secure (`__Secure-`) cookies when the site is served over https. proxy.ts and Better Auth must agree on this. */
export function secureCookies(): boolean {
  return (appBaseUrl() ?? '').startsWith('https://');
}

/** Better Auth cookie names start with this (`workos.session_token`, `workos.session_data`, …). */
export const COOKIE_PREFIX = 'workos';
/** How long a signed session copy in a cookie is trusted without reading the database (proxy.ts, getCaller). */
export const COOKIE_CACHE_SECONDS = 120;

/** An error whose message is safe to show the user. Anything else gets a generic message. */
export class SafeError extends Error {}

/** Client IP for rate limits: first x-forwarded-for entry, else x-real-ip. */
export function clientIp(h: Headers): string {
  const xff = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (xff || h.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}

/** API key from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export function bearerToken(req: Request | { headers: Headers }): string | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers.get('x-api-key')?.trim() || null;
}

/** Key-in-URL (/api/mcp/<key>) is off unless MCP_ALLOW_URL_TOKEN=1, for clients that can't send headers. */
export function urlTokenAllowed(): boolean {
  return process.env.MCP_ALLOW_URL_TOKEN === '1' || process.env.MCP_ALLOW_URL_TOKEN === 'true';
}
