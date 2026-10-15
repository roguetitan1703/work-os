import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken, checkToken, urlTokenAllowed } from '@/lib/auth';
import { after } from 'next/server';
import { createMcpServer } from '@/lib/mcp/server';
import type { Caller } from '@/lib/mcp/policy';
import { flushQueuedAlerts } from '@/lib/alerts';
import { markSeen } from '@/lib/notify';
import { verifyApiKey } from '@/lib/api-keys';
import { repoHeader, runWithRequestContext, sessionHeader, type RequestContext } from '@/lib/request-context';

// MCP endpoint (Streamable HTTP, stateless). Two kinds of credential, sent in a header:
//   Authorization: Bearer <key>   or   X-API-Key: <key>        → POST /api/mcp
//   - MCP_TOKEN: the claude.ai connector, actor "claude"
//   - a Claude Code key (wos_…, created in Claude › Setup): actor "claude-code", with the rules in
//     lib/mcp/policy.ts. These keys are accepted HERE ONLY: proxy.ts and every other route use
//     checkToken() (MCP_TOKEN only). Optional headers X-Work-OS-Session / X-Work-OS-Repo are
//     stored on the history entries the request writes.
// Optional fallback for clients that can't send headers, only when MCP_ALLOW_URL_TOKEN=1 (MCP_TOKEN only):
//                                                             → POST /api/mcp/<key>

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ key?: string[] }> };

async function authorize(req: Request, ctx: Ctx): Promise<Caller | null> {
  const { key } = await ctx.params;
  if (key?.length) return key.length === 1 && urlTokenAllowed() && (await checkToken(key[0])) ? { actor: 'claude' } : null;
  const token = bearerToken(req);
  if (await checkToken(token)) return { actor: 'claude' };
  const k = await verifyApiKey(token);
  return k ? { actor: 'claude-code', keyId: k.id, keyName: k.name } : null;
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
  const server = createMcpServer({ baseUrl: base, caller });
  after(() => Promise.all([flushQueuedAlerts(base), caller.actor === 'claude' ? markSeen('mcp') : undefined]));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const rc: RequestContext =
    caller.actor === 'claude-code' ? { session: sessionHeader(req.headers.get('x-work-os-session')), repo: repoHeader(req.headers.get('x-work-os-repo')) } : {};
  try {
    return await runWithRequestContext(rc, () => transport.handleRequest(req));
  } finally {
    // JSON responses are fully materialised, so the per-request server can go.
    void server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
