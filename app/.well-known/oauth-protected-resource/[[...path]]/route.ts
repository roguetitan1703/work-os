import { mcpResource, oauthIssuer, OAUTH_SCOPE } from '@/lib/oauth-config';

// Protected resource metadata (RFC 9728): tells an MCP client which authorization server signs people in for /api/mcp.
// Served at /.well-known/oauth-protected-resource and, as the RFC's path form, at /.well-known/oauth-protected-resource/api/mcp
// (the address the 401 from /api/mcp names). Public by design: no credentials, nothing about any organization.
// `resource` must equal the address the person types into Claude.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const path = ((await ctx.params).path ?? []).join('/');
  if (path !== '' && path !== 'api/mcp') return new Response('Not Found', { status: 404 });
  return Response.json(
    {
      resource: mcpResource(),
      authorization_servers: [oauthIssuer()],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Work OS',
    },
    { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version' } });
}
