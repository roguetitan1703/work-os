import { NextResponse } from 'next/server';
import { callerFromRequest } from '@/lib/caller';
import { isOperator } from '@/lib/operator';
import { api, discordConfig, DiscordError, orgGuildId } from '@/lib/discord/client';
import { commandsFor } from '@/lib/discord/commands';
import { getOrgModes } from '@/lib/org-modes';

// Registers the Discord commands in an organization's server (bulk overwrite), or lists what's registered there.
// ?org=<organization id>, default the caller's own. The mode choices are that organization's modes, so register again
// after they change. The operator (OPERATOR_EMAILS): signed in, or an API key of theirs (Authorization: Bearer wos_…).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The organization to act on, or the response that refuses. */
async function target(req: Request): Promise<{ orgId: string } | NextResponse> {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // About the deployment's bot, not one organization's data: the operator only (lib/operator.ts OPERATOR_EMAILS).
  if (!isOperator(caller)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return { orgId: new URL(req.url).searchParams.get('org')?.trim() || caller.orgId };
}

type Registered = { id: string; name: string; type: number };

async function route(orgId: string): Promise<string | NextResponse> {
  const cfg = discordConfig();
  if (!cfg || !cfg.appId) {
    return NextResponse.json({ error: 'Discord is not configured: set DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY.' }, { status: 400 });
  }
  const guildId = await orgGuildId(orgId);
  if (!guildId) return NextResponse.json({ error: 'That organization has no Discord server set (Settings › Connections).' }, { status: 400 });
  return `/applications/${cfg.appId}/guilds/${guildId}/commands`;
}

function fail(err: unknown) {
  const status = err instanceof DiscordError && err.status >= 400 ? err.status : 500;
  return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status });
}

const summary = (cmds: Registered[]) => cmds.map(c => ({ name: c.name, type: c.type === 3 ? 'message' : c.type === 2 ? 'user' : 'slash', id: c.id }));

export async function POST(req: Request) {
  const t = await target(req);
  if (t instanceof NextResponse) return t;
  const r = await route(t.orgId);
  if (typeof r !== 'string') return r;
  try {
    const modes = (await getOrgModes(t.orgId)).map(m => m.name);
    const cmds = await api<Registered[]>(r, { method: 'PUT', body: commandsFor(modes) });
    return NextResponse.json({ ok: true, registered: summary(cmds) });
  } catch (err) {
    return fail(err);
  }
}

export async function GET(req: Request) {
  const t = await target(req);
  if (t instanceof NextResponse) return t;
  const r = await route(t.orgId);
  if (typeof r !== 'string') return r;
  try {
    return NextResponse.json({ ok: true, registered: summary(await api<Registered[]>(r)) });
  } catch (err) {
    return fail(err);
  }
}
