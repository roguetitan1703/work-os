import { after, NextResponse } from 'next/server';
import { timingSafeEqual, createHash } from 'node:crypto';
import { discordConfig } from '@/lib/discord/client';
import { handleGatewayEvent, GATEWAY_EVENTS, type GatewayEvent } from '@/lib/discord/gateway';

// The live listener's relay (deploy/discord-gateway.mjs, work-os-discord.service): POST {event, data} with CRON_SECRET as the
// bearer. Excluded from proxy.ts like /api/cron; this secret is the only way in. The answer is immediate (202); the work runs
// in after(), because it calls Discord (the bot's reply) and must not hold the listener's queue. Discord's text is data.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY = 256 * 1024;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(secret));
}

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!discordConfig()) return NextResponse.json({ error: 'Discord is not configured' }, { status: 503 });
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) return NextResponse.json({ error: 'too large' }, { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: 'too large' }, { status: 413 });
  let body: { event?: unknown; data?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const event = body.event;
  if (typeof event !== 'string' || !(GATEWAY_EVENTS as readonly string[]).includes(event) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    return NextResponse.json({ error: 'bad event' }, { status: 400 });
  }
  after(async () => {
    try {
      await handleGatewayEvent(event as GatewayEvent, body.data as Record<string, unknown>, (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, ''));
    } catch (err) {
      console.error('[discord] gateway event failed:', event, err instanceof Error ? `${err.name}: ${err.message}` : err);
    }
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
