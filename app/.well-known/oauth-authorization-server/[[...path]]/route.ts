import { getAuth } from '@/lib/auth-server';

// Authorization server metadata (RFC 8414) for Better Auth's OAuth provider (lib/auth-server.ts). The issuer is
// <site>/api/auth, so the RFC's path form is /.well-known/oauth-authorization-server/api/auth; the plain
// /.well-known/oauth-authorization-server answers too, for clients that only try the root. Public by design.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const path = ((await ctx.params).path ?? []).join('/');
  if (path !== '' && path !== 'api/auth') return new Response('Not Found', { status: 404 });
  const config = (await (await getAuth()).api.getOAuthServerConfig()) as unknown as Record<string, unknown>;
  // Only what auth route serves (app/api/auth/[...all]/route.ts): no introspection, userinfo or end-session endpoint.
  for (const k of Object.keys(config)) if (/^(introspection_|userinfo_|end_session_|device_authorization_)/.test(k)) delete config[k];
  return Response.json(config, { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version' } });
}
