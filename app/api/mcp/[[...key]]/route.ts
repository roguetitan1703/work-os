import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken, urlTokenAllowed } from '@/lib/auth';
import { after } from 'next/server';
import { acquireMcpServer } from '@/lib/mcp/pool';
import type { Caller } from '@/lib/mcp/policy';
import { flushQueuedAlerts } from '@/lib/alerts';
import { markSeen } from '@/lib/notify';
import { verifyKey } from '@/lib/caller';
import { repoHeader, runWithRequestContext, sessionHeader, type RequestContext } from '@/lib/request-context';

// MCP endpoint (Streamable HTTP, stateless). A Work OS API key (lib/api-keys.ts), sent in a header:
//   Authorization: Bearer <key>   or   X-API-Key: <key>        → POST /api/mcp
//   - a Claude chat key (agent "claude", Settings › Connections): actor "claude", as the old MCP_TOKEN was
//   - a Claude Code key (agent "claude-code", Claude › Setup): actor "claude-code", with the rules in
//     lib/mcp/policy.ts. Optional headers X-Work-OS-Session / X-Work-OS-Repo are stored on the history entries.
// Every key belongs to a user; the history entries the request writes record that user (actorUserId).
// Fallback for clients that can't send headers (the claude.ai connector), only when MCP_ALLOW_URL_TOKEN=1 and only
// for Claude chat keys:                                         → POST /api/mcp/<key>
// proxy.ts does not check these requests: this route does.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ key?: string[] }> };
type Authorized = Caller & { userId: string };

async function authorize(req: Request, ctx: Ctx): Promise<Authorized | null> {
  const { key } = await ctx.params;
  if (key?.length) {
    if (key.length !== 1 || !urlTokenAllowed()) return null;
    const c = await verifyKey(key[0]);
    return c?.key?.agent === 'claude' ? { actor: 'claude', keyId: c.key.id, keyName: c.key.name, userId: c.userId, orgId: c.orgId } : null;
  }
  const c = await verifyKey(bearerToken(req));
  if (!c?.key) return null;
  return { actor: c.key.agent, keyId: c.key.id, keyName: c.key.name, userId: c.userId, orgId: c.orgId };
}

function baseUrl(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const caller = await authorize(req, ctx);
  if (!caller) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, { status: 401 });
  }
  const base = baseUrl(req);
  const { server, release } = acquireMcpServer(base, caller);
  after(() => Promise.all([flushQueuedAlerts(base), caller.actor === 'claude' ? markSeen('mcp') : undefined]));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const rc: RequestContext =
    caller.actor === 'claude-code'
      ? { userId: caller.userId, session: sessionHeader(req.headers.get('x-work-os-session')), repo: repoHeader(req.headers.get('x-work-os-repo')) }
      : { userId: caller.userId };
  try {
    return await runWithRequestContext(rc, () => transport.handleRequest(req));
  } finally {
    // JSON responses are fully materialised: close the transport and keep the server for the next call.
    void release();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
