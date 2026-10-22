import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request facts that the data layer needs without plumbing them through every call, stamped on activity
// entries by logActivity():
//   userId          the signed-in user, or the API key's owner (lib/caller.ts); set by every server action wrapper
//                   and the MCP route. Stored as `actorUserId` next to `actor` until phase 2's actor model.
//   session, repo   the Claude Code session and repo headers (MCP route, Claude Code keys only).

export type RequestContext = { userId?: string; session?: string; repo?: string };

const store = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function requestContext(): RequestContext {
  return store.getStore() ?? {};
}

/** `X-Work-OS-Session`: up to 64 chars of [A-Za-z0-9-]. Anything else is ignored. */
export function sessionHeader(v: string | null): string | undefined {
  const s = v?.trim();
  return s && /^[A-Za-z0-9-]{1,64}$/.test(s) ? s : undefined;
}

/** `X-Work-OS-Repo`: up to 80 chars of [A-Za-z0-9._/-] (e.g. "roguetitan1703/work-os"). Anything else is ignored. */
export function repoHeader(v: string | null): string | undefined {
  const s = v?.trim();
  return s && /^[A-Za-z0-9._/-]{1,80}$/.test(s) ? s : undefined;
}
