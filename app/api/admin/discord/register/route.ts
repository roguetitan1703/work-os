import { NextResponse } from 'next/server';
import { bearerToken, checkToken } from '@/lib/auth';
import { api, discordConfig, DiscordError } from '@/lib/discord/client';
import { COMMANDS } from '@/lib/discord/commands';

// Registers the Discord commands in the configured guild (bulk overwrite), or lists what's registered.
// Authorization: Bearer <MCP_TOKEN>

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Registered = { id: string; name: string; type: number };

function route(): string | NextResponse {
  const cfg = discordConfig();
  if (!cfg || !cfg.appId) {
    return NextResponse.json(
      { error: 'Discord is not configured: set DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID and DISCORD_OWNER_ID.' },
      { status: 400 },
    );
  }
  return `/applications/${cfg.appId}/guilds/${cfg.guildId}/commands`;
}

function fail(err: unknown) {
  const status = err instanceof DiscordError && err.status >= 400 ? err.status : 500;
  return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status });
}

const summary = (cmds: Registered[]) => cmds.map(c => ({ name: c.name, type: c.type === 3 ? 'message' : c.type === 2 ? 'user' : 'slash', id: c.id }));

export async function POST(req: Request) {
  if (!(await checkToken(bearerToken(req)))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const r = route();
  if (typeof r !== 'string') return r;
  try {
    const cmds = await api<Registered[]>(r, { method: 'PUT', body: COMMANDS });
    return NextResponse.json({ ok: true, registered: summary(cmds) });
  } catch (err) {
    return fail(err);
  }
}

export async function GET(req: Request) {
  if (!(await checkToken(bearerToken(req)))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const r = route();
  if (typeof r !== 'string') return r;
  try {
    return NextResponse.json({ ok: true, registered: summary(await api<Registered[]>(r)) });
  } catch (err) {
    return fail(err);
  }
}
