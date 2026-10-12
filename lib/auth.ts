// Single-user auth. Uses Web Crypto only so it runs in proxy.ts as well as in
// route handlers and server actions.
//
//   APP_PASSWORD    password for the web UI
//   SESSION_SECRET  HMAC key for the session cookie (long random string)
//   MCP_TOKEN       API key for the MCP endpoint and the JSON API (sent as a header)
//
// In development, leaving APP_PASSWORD unset disables UI auth. In production,
// missing secrets fail closed.

export const SESSION_COOKIE = 'workos_session';
export const SESSION_DAYS = 60;

const enc = new TextEncoder();

export function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

export function uiAuthConfigured(): boolean {
  return !!process.env.APP_PASSWORD && !!process.env.SESSION_SECRET;
}

/** true when UI auth is intentionally off (local dev without APP_PASSWORD). */
export function uiAuthDisabled(): boolean {
  return isDev() && !process.env.APP_PASSWORD;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

async function sha256(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Constant-time comparison (hashes first so lengths never leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function createSessionValue(): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const sig = await hmac(process.env.SESSION_SECRET!, `v1.${exp}`);
  return `v1.${exp}.${sig}`;
}

export async function verifySessionValue(value: string | undefined): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  if (!value || !secret) return false;
  const [v, exp, sig] = value.split('.');
  if (v !== 'v1' || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, `v1.${exp}`));
}

export async function checkPassword(input: string): Promise<boolean> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return false;
  return safeEqual(input, pw);
}

/** Valid MCP/API token? Accepts the raw token (from URL path, query, or header). */
export async function checkToken(token: string | null | undefined): Promise<boolean> {
  const expected = process.env.MCP_TOKEN;
  if (!expected || expected.length < 24 || !token) return false;
  return safeEqual(token, expected);
}

/** API key from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization');
  const m = h?.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers.get('x-api-key')?.trim() || null;
}

/** Token-in-URL (/api/mcp/<key>) is off unless MCP_ALLOW_URL_TOKEN=1, for clients that can't send headers. */
export function urlTokenAllowed(): boolean {
  return process.env.MCP_ALLOW_URL_TOKEN === '1' || process.env.MCP_ALLOW_URL_TOKEN === 'true';
}
