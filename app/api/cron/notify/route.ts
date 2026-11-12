import { NextResponse } from 'next/server';
import { sendDm } from '@/lib/alerts';
import { discordConfig } from '@/lib/discord/client';
import { addToInbox, getNotifySettings, pushConfigured, sendPush } from '@/lib/notify';
import { ownerScopes } from '@/lib/people';
import { getProfile } from '@/lib/profile';

// A script on this server (the reel publisher's systemd timer) alerts the owner through Work OS's alert channels.
//   POST /api/cron/notify   Authorization: Bearer <NOTIFY_SECRET>   (the header only: a secret in the URL ends up in logs)
//   body { title: 1-120 chars, body: 0-1000 chars, url?: "/path" or "https://..." }
// Goes to the owner(s) of the organization: inbox always, push and Discord DM when that person has them on and set up.
// Quiet hours are ignored on purpose: a failed or late publish is time-critical. Answers { sent, errors } (counts and
// channel names only); 502 when every channel failed; 429 past 20 a hour. Excluded from proxy.ts like /api/cron/alerts;
// NOTIFY_SECRET is separate from CRON_SECRET so the publisher's env file holds nothing that runs the alert check.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_PER_HOUR = 20;
const g = globalThis as unknown as { __workosNotifyHits?: number[] };
const hits = (g.__workosNotifyHits ??= []);

function authorized(req: Request): boolean {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret || secret.length < 32) return false;
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function validUrl(u: string): boolean {
  if (u.length > 500) return false;
  if (u.startsWith('/')) return !u.startsWith('//') && !u.includes('\\');
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret || secret.length < 32) return NextResponse.json({ error: 'NOTIFY_SECRET is not set (32+ characters)' }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let b: unknown;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  const o = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  const title = o?.title;
  const text = o?.body ?? '';
  const url = o?.url;
  if (typeof title !== 'string' || title.length < 1 || title.length > 120) return NextResponse.json({ error: 'title: 1-120 characters' }, { status: 400 });
  if (typeof text !== 'string' || text.length > 1000) return NextResponse.json({ error: 'body: up to 1000 characters' }, { status: 400 });
  if (url !== undefined && (typeof url !== 'string' || !validUrl(url))) return NextResponse.json({ error: 'url: a path starting with / or an https URL' }, { status: 400 });

  const now = Date.now();
  while (hits.length && now - hits[0] > 3_600_000) hits.shift();
  if (hits.length >= MAX_PER_HOUR) return NextResponse.json({ error: 'rate limit: 20 an hour' }, { status: 429 });
  hits.push(now);

  const link = (url as string | undefined) ?? '/notifications';
  const owners = await ownerScopes();
  const sent = { inbox: 0, push: 0, discord: 0 };
  const errors: string[] = [];
  if (!owners.length) errors.push('no owner');
  for (const s of owners) {
    try {
      await addToInbox(s, [{ kind: 'security', title, body: text, url: link }]);
      sent.inbox++;
    } catch {
      errors.push('inbox');
    }
    const settings = await getNotifySettings(s).catch(() => null);
    if (settings?.channels.push && pushConfigured()) {
      const r = await sendPush(s, { title, body: text, url: link, tag: 'notify' }).catch(e => ({ sent: 0, failed: 1, error: String(e) }));
      if (r.sent > 0) sent.push++;
      else if (r.failed > 0) errors.push('push');
    }
    const profile = await getProfile(s).catch(() => null);
    if (settings?.channels.discord && discordConfig() && profile?.discordId) {
      try {
        await sendDm(profile.discordId, `**${title}**${text ? `\n${text}` : ''}${url ? `\n${url.startsWith('/') ? (process.env.APP_URL ?? '').replace(/\/+$/, '') + url : url}` : ''}`);
        sent.discord++;
      } catch {
        errors.push('discord');
      }
    }
  }
  const delivered = sent.inbox + sent.push + sent.discord;
  return NextResponse.json({ sent, errors }, { status: delivered === 0 && errors.length ? 502 : 200 });
}
