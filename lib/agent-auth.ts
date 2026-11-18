import 'server-only';
import { AGENT_TOKEN_PREFIX, verifyAgentToken } from '@/lib/agent-sessions';
import { roleOf } from '@/lib/caller';
import type { Scope } from '@/lib/scope';

// What the Work OS hook's routes (app/api/agent/start, app/api/agent/state) share: the Bearer credential, the capped body
// read, the answer headers, and the session-token check.

export const AGENT_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export const agentReply = (status: number, body: object, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...AGENT_HEADERS, ...extra } });
export const agentUnauthorized = () => agentReply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

/** Authorization: Bearer only (an X-API-Key or a cookie is not a credential on these routes). */
export function bearerOf(req: Request): string | null {
  const m = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

/** The body as text, or null when it is larger than `max` bytes (stops reading there). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export type AgentToken = { s: Scope; device: { id: string; name: string }; session: { id: string; projectId: string; expiresAt: Date } };

/**
 * A wst_ session token that is valid and whose owner is still a member of its organization; null for anything else (no
 * credential, a device key, a Work OS API key, an OAuth token). Rate limits are the route's own.
 */
export async function authAgentToken(cred: string | null): Promise<AgentToken | null> {
  if (!cred || !cred.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const t = await verifyAgentToken(cred);
  if (!t) return null;
  const s: Scope = { userId: t.ownerId, orgId: t.orgId };
  if (!(await roleOf(s.userId, s.orgId))) return null;
  return { s, device: { id: t.deviceId, name: t.deviceName }, session: { id: t.id, projectId: t.projectId, expiresAt: t.expiresAt } };
}
