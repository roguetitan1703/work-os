import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken, checkToken, urlTokenAllowed } from '@/lib/auth';
import { after } from 'next/server';
import { createMcpServer } from '@/lib/mcp/server';
import { flushQueuedAlerts } from '@/lib/alerts';
import { markSeen } from '@/lib/notify';

// MCP endpoint (Streamable HTTP, stateless). Authenticated with the MCP_TOKEN API key in a header:
//   Authorization: Bearer <key>   or   X-API-Key: <key>        → POST /api/mcp
// Optional fallback for clients that can't send headers, only when MCP_ALLOW_URL_TOKEN=1:
//                                                             → POST /api/mcp/<key>

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ key?: string[] }> };

async function authorized(req: Request, ctx: Ctx): Promise<boolean> {
  const { key } = await ctx.params;
  if (key?.length) return key.length === 1 && urlTokenAllowed() && checkToken(key[0]);
  return checkToken(bearerToken(req));
}

function baseUrl(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (!(await authorized(req, ctx))) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, { status: 401 });
  }
  const base = baseUrl(req);
  const server = createMcpServer({ baseUrl: base });
  after(() => Promise.all([flushQueuedAlerts(base), markSeen('mcp')]));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON responses are fully materialised, so the per-request server can go.
    void server.close();
  }
}

export { handle as GET, handle as POST, handle as DELETE };
