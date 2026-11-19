import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cache } from 'react';
import { registerTzSource } from './dates';

// Per-request facts that the data layer needs without plumbing them through every call, stamped on activity
// entries by logActivity():
//   userId          the signed-in user, or the API key's owner (lib/caller.ts); set by every server action wrapper
//                   and the MCP route. Stored as `actorUserId` next to `actor` until phase 2's actor model.
//   session, repo   the Claude Code session and repo headers (MCP route, Claude Code keys only).
//   tz              that person's timezone (lib/profile.ts): what "today" means for lib/dates.ts.

export type RequestContext = {
  userId?: string;
  session?: string;
  repo?: string;
  tz?: string;
  /** X-Work-OS-Session from any kind of MCP client: the session a call belongs to for presence and the "for you" line (lib/mcp/for-you.ts). Not stamped on history. */
  sid?: string;
  /** The session id, else the key id, of the MCP call: stamped on what it creates (tasks, State lines) so the "for you" line can skip a session's own items. */
  src?: string;
  /** X-Work-OS-Hook: the Work OS hook's protocol version (1 to 9), sent by new hooks on every call. Absent from old hooks and other clients. */
  hook?: number;
  /** The API key or OAuth client behind an MCP call (rate limits are per key). */
  keyId?: string;
  /** Set by the MCP handler when a call was refused: what kind of refusal (lib/mcp/refusals.ts). */
  failKind?: 'policy' | 'input' | 'not_found' | 'internal';
};

const store = new AsyncLocalStorage<RequestContext>();

// Pages render outside any run() below, so getCaller() (cached per render) also writes the caller's timezone into a
// cell React keeps per request. Outside a render (actions, routes) cache() does not memoise: the cell is a fresh
// object each time and stays empty, so only the store above counts there.
const renderCell = cache((): { tz?: string } => ({}));

registerTzSource(() => {
  const fromRun = store.getStore()?.tz;
  if (fromRun) return fromRun;
  try {
    return renderCell().tz;
  } catch {
    return undefined;
  }
});

/** getCaller(): remember the caller's timezone for the rest of this page render. */
export function setRenderTz(tz: string): void {
  try {
    renderCell().tz = tz;
  } catch {
    // not in a render
  }
}

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

/** `X-Work-OS-Hook`: a whole number from 1 to 9. Anything else is ignored. */
export function hookHeader(v: string | null): number | undefined {
  const s = v?.trim();
  return s && /^[1-9]$/.test(s) ? Number(s) : undefined;
}

/** `X-Work-OS-Repo`: up to 80 chars of [A-Za-z0-9._/-] (e.g. "roguetitan1703/work-os"). Anything else is ignored. */
export function repoHeader(v: string | null): string | undefined {
  const s = v?.trim();
  return s && /^[A-Za-z0-9._/-]{1,80}$/.test(s) ? s : undefined;
}
