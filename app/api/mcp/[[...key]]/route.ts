import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken, urlTokenAllowed } from '@/lib/auth';
import { after } from 'next/server';
import { acquireMcpServer } from '@/lib/mcp/pool';
import type { Caller } from '@/lib/mcp/policy';
import { flushQueuedAlerts } from '@/lib/alerts';
import { markSeen } from '@/lib/notify';
import { roleOf, verifyKey } from '@/lib/caller';
import { RUN_KEY_PREFIX, verifyRunKey } from '@/lib/run-keys';
import { timezoneOf } from '@/lib/profile';
import { callerFromOAuthToken, OAUTH_ACCESS_PREFIX } from '@/lib/oauth';
import { mcpResource } from '@/lib/oauth-config';
import { hookHeader, repoHeader, runWithRequestContext, sessionHeader, type RequestContext } from '@/lib/request-context';

// MCP endpoint (Streamable HTTP, stateless). Signs in with OAuth (the MCP authorization flow: lib/oauth.ts, docs/auth.md) or a
// Work OS API key (lib/api-keys.ts, "Advanced: API keys"), sent in a header. A request without a valid token gets 401 and a
// WWW-Authenticate header pointing at /.well-known/oauth-protected-resource, which is how claude.ai finds the sign-in.
//   Authorization: Bearer wosat_…  an OAuth access token: acts as the person who approved it, in the organization they
//                                  approved; agent "claude" for claude.ai, "claude-code" for every other app
//   The API key forms:
//   Authorization: Bearer <key>   or   X-API-Key: <key>        → POST /api/mcp
//   - a Claude chat key (agent "claude", Settings › Connections): actor "claude", as the old MCP_TOKEN was
//   - a Claude Code key (agent "claude-code", Claude › Setup): actor "claude-code", with the rules in
//     lib/mcp/policy.ts. Optional headers X-Work-OS-Session / X-Work-OS-Repo are stored on the history entries.
//   - a run key (wdr_…, lib/run-keys.ts): a dispatched run's own key; a Claude Code caller with `dispatched` set
//     (Orders never writable, mail and Discord refused, its sessions marked, no other session's id)
// Every key belongs to a user in an organization; the server acts for them (their scope; history says "Claude · <them>").
// Fallback for clients that can't send headers (the claude.ai connector), only when MCP_ALLOW_URL_TOKEN=1 and only
// for Claude chat keys:                                         → POST /api/mcp/<key>
// proxy.ts does not check these requests: this route does.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ key?: string[] }> };
type Authorized = Caller & { userId: string; tz: string };

async function authorize(req: Request, ctx: Ctx): Promise<Authorized | null> {
  const { key } = await ctx.params;
  if (key?.length) {
    if (key.length !== 1 || !urlTokenAllowed()) return null;
    const c = await verifyKey(key[0]);
    return c?.key?.agent === 'claude' ? { agent: 'claude', keyId: c.key.id, keyName: c.key.name, userId: c.userId, orgId: c.orgId, tz: c.tz } : null;
  }
  const token = bearerToken(req);
  // A dispatched run's own key (lib/run-keys.ts): the person's Claude Code, marked dispatched on every call, whatever it sends.
  if (token?.startsWith(RUN_KEY_PREFIX)) {
    const r = await verifyRunKey(token);
    if (!r || !(await roleOf(r.userId, r.orgId))) return null;
    const tz = await timezoneOf({ userId: r.userId, orgId: r.orgId });
    return { agent: 'claude-code', keyId: `run_${r.sessionId}`, keyName: `Dispatched run #${r.ref}`, userId: r.userId, orgId: r.orgId, tz, dispatched: { taskId: r.taskId, ref: r.ref, sessionId: r.sessionId } };
  }
  const c = token?.startsWith(OAUTH_ACCESS_PREFIX) ? await callerFromOAuthToken(token) : await verifyKey(token);
  if (!c?.key) return null;
  return { agent: c.key.agent, keyId: c.key.id, keyName: c.key.name, userId: c.userId, orgId: c.orgId, tz: c.tz };
}

function baseUrl(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
}

function unauthorized(req: Request): Response {
  const sent = bearerToken(req);
  // RFC 9728 / RFC 6750: where the protected-resource metadata is, and (for a token that was sent) that it was no good.
  const challenge = `Bearer resource_metadata="${new URL(mcpResource()).origin}/.well-known/oauth-protected-resource/api/mcp", scope="workos"${sent ? ', error="invalid_token"' : ''}`;
  return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, { status: 401, headers: { 'WWW-Authenticate': challenge, 'Cache-Control': 'no-store' } });
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const caller = await authorize(req, ctx);
  if (!caller) return unauthorized(req);
  const base = baseUrl(req);
  const { server, release } = await acquireMcpServer(base, caller);
  const scope = { userId: caller.userId, orgId: caller.orgId };
  after(() => Promise.all([flushQueuedAlerts(scope, base), caller.agent === 'claude' ? markSeen(scope, 'mcp') : undefined]));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const rc: RequestContext =
    caller.agent === 'claude-code'
      ? { userId: caller.userId, tz: caller.tz, session: sessionHeader(req.headers.get('x-work-os-session')), repo: repoHeader(req.headers.get('x-work-os-repo')), sid: sessionHeader(req.headers.get('x-work-os-session')), hook: hookHeader(req.headers.get('x-work-os-hook')), keyId: caller.keyId, ...(caller.dispatched ? { dispatched: { taskId: caller.dispatched.taskId, ref: caller.dispatched.ref } } : {}) }
      : { userId: caller.userId, tz: caller.tz, sid: sessionHeader(req.headers.get('x-work-os-session')), hook: hookHeader(req.headers.get('x-work-os-hook')), keyId: caller.keyId };
  try {
    return await runWithRequestContext(rc, () => transport.handleRequest(req));
  } finally {
    // JSON responses are fully materialised: close the transport and keep the server for the next call.
    void release();
  }
}

// No standalone SSE stream and no sessions (stateless, JSON responses): GET and DELETE are 405 with Allow: POST, with no
// database work. Handing GET a stream that closed at once made MCP clients reconnect about once a second, forever; the SDK
// client treats 405 on GET as "this server has no stream" and stops. A request with no credential at all still gets the 401
// challenge (OAuth discovery), which costs nothing either; POST is the only method that does the credential check.
async function notAllowed(req: Request, ctx: Ctx): Promise<Response> {
  const { key } = await ctx.params;
  if (!key?.length && !bearerToken(req)) return unauthorized(req);
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server answers POST only (no SSE stream, no sessions)' }, id: null }, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
}

export { notAllowed as GET, handle as POST, notAllowed as DELETE };
