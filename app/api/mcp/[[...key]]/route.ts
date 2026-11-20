import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken, urlTokenAllowed } from '@/lib/auth';
import { after } from 'next/server';
import { acquireMcpServer } from '@/lib/mcp/pool';
import { syncTestHiddenTool } from '@/lib/mcp/server';
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

// Claude Code reads a server's tool list once, when it connects, so a long-running session never saw tools added later (and
// kept removed ones). The server says tools can change (capability tools.listChanged), and a Claude Code session's start_work
// (also the one after a compaction) and get_state are answered as a short SSE stream: notifications/tools/list_changed first,
// then the result. Claude Code then reads tools/list again. Only for a Claude Code caller whose client made the MCP handshake
// (it sends Mcp-Protocol-Version) and not for the Work OS hook (X-Work-OS-Hook; installed hooks read the first data line as
// the answer). Every other request, the claude.ai connector's included, stays one JSON answer as before.
const RELIST_ON = new Set(['start_work', 'get_state']);
const PEEK_MAX = 64 * 1024;
const LIST_CHANGED = { jsonrpc: '2.0' as const, method: 'notifications/tools/list_changed' };

/** The JSON-RPC body, read from a copy of the request (the transport reads the original), or null past PEEK_MAX or unreadable. */
async function peekBody(req: Request): Promise<unknown> {
  const reader = req.clone().body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PEEK_MAX) {
        void reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return null;
  }
}

/** A Claude Code client after the MCP handshake, not the Work OS hook: its start_work and get_state may be answered as SSE. */
function mayRelist(req: Request, caller: Authorized): boolean {
  return caller.agent === 'claude-code' && !!req.headers.get('mcp-protocol-version') && !req.headers.get('x-work-os-hook');
}

/** The id of a tools/call of start_work or get_state (one message, not a batch), or null. */
function relistId(body: unknown): string | number | null {
  const m = body as { method?: unknown; id?: unknown; params?: { name?: unknown } } | null;
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.method !== 'tools/call' || typeof m.params?.name !== 'string' || !RELIST_ON.has(m.params.name)) return null;
  return typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
}

/** The SSE body, with release() once it is complete (the server goes back to the pool) or dropped by the client (closed, not kept). */
function releaseWhenDone(body: ReadableStream<Uint8Array>, release: (discard?: boolean) => Promise<void>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let done = false;
  const finish = (discard: boolean) => {
    if (done) return;
    done = true;
    void release(discard);
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const r = await reader.read();
        if (r.done) {
          c.close();
          finish(false);
        } else c.enqueue(r.value);
      } catch (err) {
        c.error(err);
        finish(true);
      }
    },
    cancel(reason) {
      finish(true);
      return reader.cancel(reason);
    },
  });
}

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const caller = await authorize(req, ctx);
  if (!caller) return unauthorized(req);
  const base = baseUrl(req);
  const trace = process.env.E2E_MCP_TRACE === '1'; // tests only: one log line per request (tests/e2e/mcp-relist.mjs)
  const eligible = mayRelist(req, caller);
  const body = eligible || trace ? await peekBody(req) : null;
  const relist = eligible ? relistId(body) : null;
  if (trace) {
    const m = body as { method?: string; params?: { name?: string } } | null;
    console.log(`[mcp trace] ${caller.agent} ${Array.isArray(m) ? 'batch' : (m?.method ?? '?')}${m?.params?.name ? ` ${m.params.name}` : ''} -> ${relist === null ? 'json' : 'sse+list_changed'}`);
  }
  const { server, release } = await acquireMcpServer(base, caller);
  syncTestHiddenTool(server);
  const scope = { userId: caller.userId, orgId: caller.orgId };
  after(() => Promise.all([flushQueuedAlerts(scope, base), caller.agent === 'claude' ? markSeen(scope, 'mcp') : undefined]));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: relist === null,
  });
  await server.connect(transport);
  if (relist !== null) {
    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      // Written to the request's stream before the call runs, so it always comes before the result. With no event store the
      // transport writes it synchronously; a client that ignores it still gets the result next.
      if ('method' in message && 'id' in message && message.id === relist) void transport.send(LIST_CHANGED, { relatedRequestId: relist }).catch(() => {});
      deliver?.(message, extra);
    };
  }
  const rc: RequestContext =
    caller.agent === 'claude-code'
      ? { userId: caller.userId, tz: caller.tz, session: sessionHeader(req.headers.get('x-work-os-session')), repo: repoHeader(req.headers.get('x-work-os-repo')), sid: sessionHeader(req.headers.get('x-work-os-session')), hook: hookHeader(req.headers.get('x-work-os-hook')), keyId: caller.keyId, ...(caller.dispatched ? { dispatched: { taskId: caller.dispatched.taskId, ref: caller.dispatched.ref } } : {}) }
      : { userId: caller.userId, tz: caller.tz, sid: sessionHeader(req.headers.get('x-work-os-session')), hook: hookHeader(req.headers.get('x-work-os-hook')), keyId: caller.keyId };
  let res: Response;
  try {
    res = await runWithRequestContext(rc, () => transport.handleRequest(req));
  } catch (err) {
    void release();
    throw err;
  }
  // JSON responses are fully materialised: close the transport and keep the server for the next call. The SSE answer
  // (start_work, get_state above) gives the server back once its stream has carried the result.
  if (relist === null || !res.body || !res.headers.get('content-type')?.startsWith('text/event-stream')) {
    void release();
    return res;
  }
  return new Response(releaseWhenDone(res.body, release), { status: res.status, headers: res.headers });
}

// No standalone SSE stream and no sessions (stateless; JSON responses, except the short per-request stream of start_work and
// get_state above): GET and DELETE are 405 with Allow: POST, with no
// database work. Handing GET a stream that closed at once made MCP clients reconnect about once a second, forever; the SDK
// client treats 405 on GET as "this server has no stream" and stops. A request with no credential at all still gets the 401
// challenge (OAuth discovery), which costs nothing either; POST is the only method that does the credential check.
async function notAllowed(req: Request, ctx: Ctx): Promise<Response> {
  const { key } = await ctx.params;
  if (!key?.length && !bearerToken(req)) return unauthorized(req);
  return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server answers POST only (no SSE stream, no sessions)' }, id: null }, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
}

export { notAllowed as GET, handle as POST, notAllowed as DELETE };
