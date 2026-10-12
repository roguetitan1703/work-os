import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken, checkToken } from '@/lib/auth';
import { createMcpServer } from '@/lib/mcp/server';

// MCP endpoint (Streamable HTTP, stateless). Authenticated with MCP_TOKEN, given either as
//   Authorization: Bearer <token>        → POST /api/mcp
//   a path segment (for clients that can't set headers, e.g. claude.ai custom connectors)
//                                        → POST /api/mcp/<token>

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ key?: string[] }> };

async function authorized(req: Request, ctx: Ctx): Promise<boolean> {
  const { key } = await ctx.params;
  if (key && key.length > 1) return false;
  return checkToken(key?.[0] ?? bearerToken(req));
}

function baseUrl(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  if (!(await authorized(req, ctx))) {
    return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }, { status: 401 });
  }
  const server = createMcpServer({ baseUrl: baseUrl(req) });
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
