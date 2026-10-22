import 'server-only';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpServer } from './server';
import type { Caller } from './policy';
import { memberNames } from '../people';
import { getOrgModes } from '../org-modes';

// Building the MCP server registers ~60 tools and their schemas: real CPU on every call. The SDK allows
// one transport per server at a time (and a stateless transport serves one request), so concurrent calls
// need their own server. Idle ones wait here, one list per caller identity (user, organization, key) and base URL, and are
// reconnected to a fresh transport for the next call. Nothing request-specific lives in the server: the
// request context (session, repo) is read through AsyncLocalStorage when a tool runs.

const MAX_IDLE_PER_KEY = 3;
const MAX_KEYS = 20;
const IDLE_TTL_MS = 10 * 60_000;

type Idle = { server: McpServer; at: number };
const pool = new Map<string, Idle[]>();

// Every key belongs to a user in an organization (docs/auth.md): a server is never shared across users,
// organizations or keys, so nothing one caller's server holds can reach another's request.
// The instructions name the key's owner and list the organization's modes, so a rename or a new mode builds new servers.
function keyOf(baseUrl: string, caller: Caller, who: { name: string; modes: string[] }): string {
  return JSON.stringify([baseUrl, caller.agent, caller.userId, caller.orgId, caller.keyId, caller.keyName, who.name, who.modes]);
}

/** An idle server for this caller, or a new one. Give it back with release() once its transport is closed. */
export async function acquireMcpServer(baseUrl: string, caller: Caller): Promise<{ server: McpServer; release: () => Promise<void> }> {
  const [people, modes] = await Promise.all([memberNames(caller.orgId), getOrgModes(caller.orgId)]);
  const who = { name: people[caller.userId] ?? '', modes: modes.map(m => m.name) };
  const key = keyOf(baseUrl, caller, who);
  const list = pool.get(key);
  const now = Date.now();
  let server: McpServer | undefined;
  while (list?.length) {
    const i = list.pop()!;
    if (now - i.at < IDLE_TTL_MS) {
      server = i.server;
      break;
    }
  }
  server ??= createMcpServer({ baseUrl, caller, who });
  const s = server;
  return {
    server: s,
    release: async () => {
      try {
        await s.close(); // disconnects the transport so the server can take the next one
      } catch {
        return; // a server that failed to close is not reused
      }
      const l = pool.get(key) ?? [];
      if (l.length >= MAX_IDLE_PER_KEY) return;
      l.push({ server: s, at: Date.now() });
      pool.delete(key);
      pool.set(key, l); // most recently used last
      while (pool.size > MAX_KEYS) pool.delete(pool.keys().next().value!);
    },
  };
}
