import 'server-only';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { SafeError, appBaseUrl, authSecret } from './auth';
import type { Caller } from './caller';
import { collections } from './db';
import * as projects from './data/projects';
import type { Project, ProjectStatus, Visibility } from './types';

// Work OS as an OAuth CLIENT of Delpat OS (docs/auth.md "Linking Delpat OS"): each person links their own Delpat OS
// account once (authorization code + PKCE S256 + state, client_secret_post, scope `mcp`), and Work OS then reads that
// person's projects through Delpat OS's MCP as them, to import one into Work OS. Hidden unless DELPAT_OS_CLIENT_ID and
// DELPAT_OS_CLIENT_SECRET are set.
//
// Security notes:
//  - A link belongs to one person in one organization (_id `<orgId>:<userId>`, taken from the Caller, never from input).
//  - Tokens are stored sealed (AES-256-GCM, key from DELPAT_OS_TOKEN_KEY or derived from BETTER_AUTH_SECRET; the
//    ciphertext is bound to the person and organization), never hashed (a refresh token must be readable to use) and
//    never logged, nor are the secret or any response body from Delpat OS.
//  - The state is random, single use, bound to the person's session, expires in 10 minutes. The PKCE verifier never
//    leaves the server (stored sealed next to the state).
//  - Endpoints come from the issuer's metadata (cached 5 minutes) but must be on the issuer's own origin and https
//    (http only for localhost, for tests). Requests do not follow redirects and time out after 10 seconds.
//  - Delpat OS answers are untrusted text: trimmed, length-limited and used as plain strings only.

export const DELPAT_OS_SCOPE = 'mcp';
const DEFAULT_ISSUER = 'https://os.delpat.in';
const AUTH_MINUTES = 10;
const META_TTL_MS = 300_000;
const TIMEOUT_MS = 10_000;

export class DelpatOsError extends SafeError {}
/** The person has no usable link (never linked, or Delpat OS refused the refresh token). */
export class NotLinked extends DelpatOsError {
  constructor(msg = 'Link your Delpat OS account first (Settings › Connections).') {
    super(msg);
  }
}

// ── Configuration ──────────────────────────────────────────────────────────

type Config = { issuer: string; clientId: string; clientSecret: string };

function isLocal(u: URL) {
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/** null (feature off) unless the client id and secret are both set and the issuer is a usable address. */
export function delpatOsConfig(): Config | null {
  const clientId = process.env.DELPAT_OS_CLIENT_ID?.trim();
  const clientSecret = process.env.DELPAT_OS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const issuer = (process.env.DELPAT_OS_ISSUER?.trim() || DEFAULT_ISSUER).replace(/\/+$/, '');
  try {
    const u = new URL(issuer);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal(u))) return null;
  } catch {
    return null;
  }
  return { issuer, clientId, clientSecret };
}

export const delpatOsEnabled = () => delpatOsConfig() !== null && !!appBaseUrl();

const need = (): Config => {
  const c = delpatOsConfig();
  if (!c || !appBaseUrl()) throw new DelpatOsError('Delpat OS is not set up on this Work OS.');
  return c;
};

/** The exact redirect address registered at Delpat OS. */
export const redirectUri = () => `${appBaseUrl()}/api/delpat-os/callback`;

// ── Sealing tokens ─────────────────────────────────────────────────────────

function sealKey(): Buffer {
  const ikm = process.env.DELPAT_OS_TOKEN_KEY?.trim() || authSecret();
  if (!ikm) throw new DelpatOsError('Delpat OS is not set up on this Work OS.');
  return Buffer.from(hkdfSync('sha256', ikm, 'work-os', 'delpat-os-tokens-v1', 32));
}

export function seal(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function unseal(sealed: string, aad: string): string | null {
  try {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The only two collections this file touches: a person's Delpat OS link and their pending links, always keyed by organization and person. */
async function stores() {
  const c = await collections(); // scope-ok: delpatOsLinks and delpatOsAuth only, keyed by the caller's organization and user
  return { links: c.delpatOsLinks, pending: c.delpatOsAuth };
}

const linkId = (c: { orgId: string; userId: string }) => `${c.orgId}:${c.userId}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Talking to Delpat OS ───────────────────────────────────────────────────

const MAX_BODY = 1_000_000;

/** The body as text, read as a stream and refused beyond ~1 MB (a hostile or broken Delpat OS cannot fill memory). */
async function bodyText(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new DelpatOsError('Delpat OS sent too much data.');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done || !value) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      void reader.cancel().catch(() => {});
      throw new DelpatOsError('Delpat OS sent too much data.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function bodyJson(res: Response): Promise<unknown> {
  const text = await bodyText(res);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function http(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new DelpatOsError('Delpat OS did not answer. Try again in a moment.');
  }
}

type Meta = { authorize: string; token: string; mcp: string; revoke: string | null; issParam: boolean };
let metaCache: { key: string; at: number; meta: Meta } | null = null;

/** Fetches (cached 5 minutes) and checks the issuer's metadata document. */
export async function delpatOsMetadata(): Promise<Meta> {
  const cfg = need();
  if (metaCache && metaCache.key === cfg.issuer && Date.now() - metaCache.at < META_TTL_MS) return metaCache.meta;
  const res = await http(`${cfg.issuer}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } });
  if (!res.ok) void res.body?.cancel().catch(() => {});
  const doc = res.ok ? ((await bodyJson(res)) as Record<string, unknown> | null) : null;
  if (!doc || typeof doc !== 'object') throw new DelpatOsError('Delpat OS did not describe itself. Try again later.');
  const origin = new URL(cfg.issuer).origin;
  const same = (v: unknown): string => {
    if (typeof v !== 'string') throw new DelpatOsError('Delpat OS sent an unusable address.');
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new DelpatOsError('Delpat OS sent an unusable address.');
    }
    if (u.origin !== origin || u.username || u.password) throw new DelpatOsError('Delpat OS sent an address outside its own site.');
    return u.toString();
  };
  if (typeof doc.issuer === 'string' && doc.issuer.replace(/\/+$/, '') !== cfg.issuer) throw new DelpatOsError('Delpat OS described a different site.');
  const methods = doc.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) throw new DelpatOsError('Delpat OS does not support S256 sign-in.');
  const meta: Meta = {
    authorize: same(doc.authorization_endpoint),
    token: same(doc.token_endpoint),
    mcp: doc.mcp_endpoint !== undefined ? same(doc.mcp_endpoint) : `${cfg.issuer}/api/mcp`,
    revoke: doc.revocation_endpoint !== undefined ? same(doc.revocation_endpoint) : null,
    issParam: doc.authorization_response_iss_parameter_supported === true,
  };
  metaCache = { key: cfg.issuer, at: Date.now(), meta };
  return meta;
}

/** For tests: forget the cached metadata. */
export function forgetDelpatOsMetadata() {
  metaCache = null;
}

type TokenReply = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };

async function tokenCall(params: Record<string, string>): Promise<{ ok: true; t: TokenReply } | { ok: false; status: number }> {
  const cfg = need();
  const meta = await delpatOsMetadata();
  const body = new URLSearchParams({ ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret });
  const res = await http(meta.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status };
  }
  const t = (await bodyJson(res)) as TokenReply | null;
  if (!t || typeof t.access_token !== 'string' || !t.access_token) return { ok: false, status: 502 };
  return { ok: true, t };
}

/**
 * Tells Delpat OS to revoke a refresh token (RFC 7009) when its metadata offers a revocation_endpoint. Best effort and
 * never waited for: a failure or a missing endpoint changes nothing (the link is deleted here either way).
 * Delpat OS offers none today, so unlinking in Work OS does not revoke at Delpat OS (docs/auth.md).
 */
function revokeUpstream(sealedRefresh: string | undefined, lid: string): void {
  if (!sealedRefresh) return;
  void (async () => {
    const cfg = delpatOsConfig();
    if (!cfg) return;
    const token = unseal(sealedRefresh, `refresh:${lid}`);
    const meta = await delpatOsMetadata();
    if (!token || !meta.revoke) return;
    const body = new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret });
    await fetch(meta.revoke, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
  })().catch(() => {});
}

// ── Linking ────────────────────────────────────────────────────────────────

const b64u = (b: Buffer) => b.toString('base64url');

/** Starts a link for the caller: the address of Delpat OS's authorize page (state and PKCE challenge in it). */
export async function startLink(c: Caller): Promise<string> {
  const cfg = need();
  const meta = await delpatOsMetadata();
  const state = b64u(randomBytes(32));
  const verifier = b64u(randomBytes(48));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const id = sha(state);
  const db = await stores();
  await db.pending.deleteMany({ orgId: c.orgId, userId: c.userId });
  await db.pending.insertOne({ _id: id, orgId: c.orgId, userId: c.userId, verifier: seal(verifier, `auth:${id}:${linkId(c)}`), expiresAt: new Date(Date.now() + AUTH_MINUTES * 60_000) });
  const u = new URL(meta.authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', DELPAT_OS_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/**
 * The callback: checks the state (single use, this person's, not expired), trades the code for tokens with the PKCE
 * verifier and the client secret, and stores them sealed. Anything wrong throws without contacting Delpat OS's token
 * endpoint (a wrong state) and without saying more than needed.
 */
export async function completeLink(c: Caller, q: { code: string | null; state: string | null; error: string | null; iss?: string | null }): Promise<void> {
  const cfg = need();
  const state = q.state ?? '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state)) throw new DelpatOsError('That sign-in link is not valid. Start again from Settings.');
  const id = sha(state);
  const db = await stores();
  const row = await db.pending.findOneAndDelete({ _id: id }); // single use, whatever happens next
  if (!row || row.userId !== c.userId || row.orgId !== c.orgId || row.expiresAt.getTime() < Date.now()) throw new DelpatOsError('That sign-in link expired or is not yours. Start again from Settings.');
  // RFC 9207: when Delpat OS says it sends its issuer back, the answer must name it (mix-up defence).
  if ((await delpatOsMetadata()).issParam && q.iss !== cfg.issuer) throw new DelpatOsError('That answer did not come from Delpat OS. Start again from Settings.');
  if (q.error) throw new DelpatOsError('Delpat OS did not allow the link.');
  const code = q.code ?? '';
  if (!code || code.length > 2000) throw new DelpatOsError('Delpat OS sent no code. Start again from Settings.');
  const verifier = unseal(row.verifier, `auth:${id}:${linkId(c)}`);
  if (!verifier) throw new DelpatOsError('Could not finish the link. Start again from Settings.');
  const r = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
  if (!r.ok) throw new DelpatOsError('Delpat OS refused the sign-in. Start again from Settings.');
  if (typeof r.t.refresh_token !== 'string' || !r.t.refresh_token) throw new DelpatOsError('Delpat OS gave no long-lived access. Try again.');
  const now = new Date();
  const lid = linkId(c);
  await db.links.updateOne(
    { _id: lid },
    {
      $set: { orgId: c.orgId, userId: c.userId, refresh: seal(r.t.refresh_token, `refresh:${lid}`), ...accessFields(r.t, lid), updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

function accessFields(t: TokenReply, lid: string): { access: string; accessExpiresAt: Date } {
  const secs = typeof t.expires_in === 'number' && t.expires_in > 0 ? Math.min(t.expires_in, 86_400) : 3600;
  return { access: seal(String(t.access_token), `access:${lid}`), accessExpiresAt: new Date(Date.now() + secs * 1000) };
}

export async function unlink(c: Caller): Promise<void> {
  const db = await stores();
  const row = await db.links.findOneAndDelete({ _id: linkId(c) });
  revokeUpstream(row?.refresh, linkId(c));
  await db.pending.deleteMany({ orgId: c.orgId, userId: c.userId });
}

/** Drops a person's links (and pending links): in one organization (they left it) or everywhere (password reset or change). */
export async function dropLinks(userId: string, orgId: string | null): Promise<void> {
  const db = await stores();
  const where = orgId ? { userId, orgId } : { userId };
  const rows = await db.links.find(where).toArray();
  await db.links.deleteMany(where);
  await db.pending.deleteMany(where);
  for (const r of rows) revokeUpstream(r.refresh, r._id);
}

export type LinkStatus = { enabled: boolean; linked: boolean; since: string | null };

export async function linkStatus(c: Caller): Promise<LinkStatus> {
  if (!delpatOsEnabled()) return { enabled: false, linked: false, since: null };
  const row = await (await stores()).links.findOne({ _id: linkId(c) }, { projection: { createdAt: 1 } });
  return { enabled: true, linked: !!row, since: row ? row.createdAt.toISOString() : null };
}

// ── Access tokens ──────────────────────────────────────────────────────────

const refreshing = new Map<string, Promise<string>>();

const fresh = (row: { access: string | null; accessExpiresAt: Date | null }) => !!row.access && !!row.accessExpiresAt && row.accessExpiresAt.getTime() - Date.now() > 60_000;
const LEASE_MS = 15_000;

/**
 * A valid access token for this person (refreshing when it ran out). The refresh token rotates, so a refresh must happen
 * once: one at a time per person in this process (the row is read again inside it, and a fresh token is just used), and
 * across processes under a lease on the row (`refreshingUntil`, 15 s): only the process that sets it calls the token
 * endpoint, the others poll until the lease clears or the tokens change and use the result. The winner clears the lease
 * when it saves or fails. A refusal deletes the link only if the refresh token we used is still the stored one.
 * `rejected` is an access token Delpat OS just refused (401): it counts as expired, so a new one is fetched.
 */
async function accessToken(c: Caller, rejected?: string): Promise<string> {
  const lid = linkId(c);
  const db = await stores();
  const usable = (row: { access: string | null; accessExpiresAt: Date | null }) => {
    if (!fresh(row)) return null;
    const t = unseal(row.access!, `access:${lid}`);
    return t && t !== rejected ? t : null;
  };
  const row = await db.links.findOne({ _id: lid });
  if (!row || row.userId !== c.userId || row.orgId !== c.orgId) throw new NotLinked();
  const ready = usable(row);
  if (ready) return ready;
  // (E2E_NO_SINGLE_FLIGHT: the tests switch the in-process queue off to stand in for two server processes.)
  const flight = process.env.E2E_NO_SINGLE_FLIGHT === '1' ? undefined : refreshing.get(lid);
  if (flight) return flight;
  const p = (async () => {
    for (let tries = 0; tries < 45; tries++) {
      const cur = await db.links.findOne({ _id: lid });
      if (!cur || cur.userId !== c.userId || cur.orgId !== c.orgId) throw new NotLinked();
      const ok = usable(cur);
      if (ok) return ok;
      const refresh = unseal(cur.refresh, `refresh:${lid}`);
      if (!refresh) {
        await db.links.deleteOne({ _id: lid, refresh: cur.refresh });
        throw new NotLinked('Your Delpat OS link could not be read. Link it again.');
      }
      // The lease: taken only when none is held (or it ran out) and the refresh token is still the one we read.
      const now = new Date();
      const claim = await db.links.updateOne(
        { _id: lid, refresh: cur.refresh, $or: [{ refreshingUntil: null }, { refreshingUntil: { $exists: false } }, { refreshingUntil: { $lt: now } }] },
        { $set: { refreshingUntil: new Date(now.getTime() + LEASE_MS) } },
      );
      if (claim.modifiedCount !== 1) {
        await new Promise(r => setTimeout(r, 400));
        continue;
      }
      try {
        const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh });
        if (!r.ok) {
          if (r.status === 400 || r.status === 401) {
            const gone = await db.links.deleteOne({ _id: lid, refresh: cur.refresh });
            if (gone.deletedCount === 1) throw new NotLinked('Delpat OS no longer accepts your link. Link it again (Settings › Connections).');
            continue; // the tokens changed under us: read the new ones
          }
          throw new DelpatOsError('Delpat OS did not answer. Try again in a moment.');
        }
        const next = typeof r.t.refresh_token === 'string' && r.t.refresh_token ? r.t.refresh_token : refresh;
        const saved = await db.links.updateOne({ _id: lid, refresh: cur.refresh }, { $set: { refresh: seal(next, `refresh:${lid}`), ...accessFields(r.t, lid), updatedAt: new Date(), refreshingUntil: null } });
        if (saved.modifiedCount !== 1) throw new NotLinked(); // unlinked while we refreshed
        return String(r.t.access_token);
      } finally {
        await db.links.updateOne({ _id: lid, refresh: cur.refresh }, { $set: { refreshingUntil: null } }).catch(() => {}); // no-op after a save (the refresh token changed)
      }
    }
    throw new DelpatOsError('Delpat OS is busy. Try again in a moment.');
  })().finally(() => refreshing.delete(lid));
  if (process.env.E2E_NO_SINGLE_FLIGHT !== '1') refreshing.set(lid, p);
  return p;
}

/** Deletes the link after Delpat OS refused this access token, unless the stored one has changed meanwhile. */
async function dropIfStill(c: Caller, token: string): Promise<void> {
  const lid = linkId(c);
  const db = await stores();
  const row = await db.links.findOne({ _id: lid });
  if (!row || !row.access || unseal(row.access, `access:${lid}`) !== token) return;
  const gone = await db.links.findOneAndDelete({ _id: lid, access: row.access });
  revokeUpstream(gone?.refresh, lid);
}

// ── MCP ────────────────────────────────────────────────────────────────────

let rpcId = 0;
async function rpc(c: Caller, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const meta = await delpatOsMetadata();
  let token = await accessToken(c);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await http(meta.mcp, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
    });
    if (res.status === 401) {
      void res.body?.cancel().catch(() => {});
      // Refused: get a new access token once and try again. Only if that is refused too, with the tokens unchanged, is the link gone.
      if (attempt === 0) {
        token = await accessToken(c, token);
        continue;
      }
      await dropIfStill(c, token);
      throw new NotLinked('Delpat OS no longer accepts your link. Link it again (Settings › Connections).');
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new DelpatOsError('Delpat OS could not do that right now.');
    }
    const text = await bodyText(res);
    const line = text.split('\n').find(l => l.startsWith('data:'));
    let body: { result?: unknown; error?: unknown } | null = null;
    try {
      body = JSON.parse(line ? line.slice(5) : text);
    } catch {
      body = null;
    }
    if (!body || body.error || body.result === undefined) throw new DelpatOsError('Delpat OS could not do that right now.');
    return body.result;
  }
  throw new DelpatOsError('Delpat OS could not do that right now.');
}

/** tools/list fresh each time (schemas are not cached), then the call. */
async function callTool(c: Caller, name: string, args: Record<string, unknown>): Promise<unknown> {
  const list = (await rpc(c, 'tools/list')) as { tools?: { name?: unknown }[] };
  if (!Array.isArray(list?.tools) || !list.tools.some(t => t?.name === name)) throw new DelpatOsError('Delpat OS does not offer project reading to Work OS.');
  const out = (await rpc(c, 'tools/call', { name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] };
  if (out?.isError) throw new DelpatOsError('Delpat OS could not read that project.');
  if (out?.structuredContent && typeof out.structuredContent === 'object') return out.structuredContent;
  const text = out?.content?.find(x => x?.type === 'text')?.text;
  try {
    return JSON.parse(text ?? '');
  } catch {
    throw new DelpatOsError('Delpat OS sent an answer Work OS cannot read.');
  }
}

// ── Projects ───────────────────────────────────────────────────────────────

export type DelpatProject = { id: string; title: string; client: string | null; status: string; role: string; focus: string; updatedAt: string | null };
type Phase = { name: string; status: string; startDate: string | null; endDate: string | null };

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const strOrNull = (v: unknown, max: number): string | null => str(v, max) || null;

function toProject(r: unknown): DelpatProject | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const id = typeof o.id === 'string' || typeof o.id === 'number' ? str(String(o.id), 200) : '';
  const title = str(o.title ?? o.name, 120);
  if (!id || !title) return null;
  return { id, title, client: strOrNull(o.client, 120), status: str(o.status, 40), role: str(o.myRole, 40), focus: str(o.focus, 2000), updatedAt: strOrNull(o.updatedAt, 40) };
}

/** The caller's recent Delpat OS projects (newest first, as Delpat OS caps them), each marked with the Work OS project it already became. */
export async function listDelpatProjects(c: Caller): Promise<(DelpatProject & { workOsId: string | null })[]> {
  const out = (await callTool(c, 'list_projects', {})) as unknown;
  const rows = Array.isArray(out) ? out : Array.isArray((out as { projects?: unknown })?.projects) ? (out as { projects: unknown[] }).projects : [];
  const list = rows.map(toProject).filter((p): p is DelpatProject => !!p).slice(0, 200);
  const have = await projects.importedProjects({ userId: c.userId, orgId: c.orgId }, list.map(p => p.id));
  return list.map(p => ({ ...p, workOsId: have[p.id] ?? null }));
}

/** completed -> done, archived -> archived, on_track, revision and anything else -> active. */
export function mapStatus(s: string): ProjectStatus {
  return s === 'completed' ? 'done' : s === 'archived' ? 'archived' : 'active';
}

function describe(p: DelpatProject, phases: Phase[]): string {
  const parts: string[] = [];
  if (p.focus) parts.push(p.focus);
  if (phases.length) {
    const line = (ph: Phase) => {
      const dates = ph.startDate || ph.endDate ? `${ph.startDate ?? '?'} to ${ph.endDate ?? '?'}` : '';
      const detail = [ph.status, dates].filter(Boolean).join(', ');
      return `- ${ph.name}${detail ? ` (${detail})` : ''}`;
    };
    parts.push(['Phases:', ...phases.map(line)].join(String.fromCharCode(10)));
  }
  return parts.join('\n\n').slice(0, 5000);
}

/** Imports one of the caller's Delpat OS projects. Shared by default. */
export async function importDelpatProject(c: Caller, id: string, visibility: Visibility = 'org'): Promise<{ project: Project; created: boolean }> {
  const key = str(id, 200);
  if (!key) throw new DelpatOsError('Pick a project to import.');
  const out = (await callTool(c, 'get_project', { id: key })) as unknown;
  const raw = (out && typeof out === 'object' && 'project' in (out as object) ? (out as { project: unknown }).project : out) as Record<string, unknown> | null;
  const p = toProject(raw);
  if (!p) throw new DelpatOsError('Delpat OS did not return that project.');
  const phases: Phase[] = (Array.isArray(raw?.phases) ? (raw!.phases as unknown[]) : [])
    .slice(0, 50)
    .map(x => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => !!x && !!str(x.name, 100))
    .map(x => ({ name: str(x.name, 100), status: str(x.status, 40), startDate: strOrNull(x.startDate, 40), endDate: strOrNull(x.endDate, 40) }));
  // The project's identity is the id we asked for (the person's own reading of Delpat OS), not what the answer claims.
  return projects.createImportedProject(
    { userId: c.userId, orgId: c.orgId },
    { delpatOsId: key, name: p.title, client: p.client ?? '', description: describe(p, phases), status: mapStatus(p.status), visibility },
  );
}
