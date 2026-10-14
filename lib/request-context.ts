import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request facts that the data layer needs without plumbing them through every call:
// the Claude Code session and repo headers, stamped on activity entries by logActivity().
// Set by the MCP route for API-key requests only; empty everywhere else.

export type RequestContext = { session?: string; repo?: string };

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
