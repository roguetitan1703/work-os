import { after, NextResponse } from 'next/server';
import { discordConfig } from '@/lib/discord/client';
import { flushQueuedAlerts } from '@/lib/alerts';
import { markSeen } from '@/lib/notify';
import { discordUser, timezoneOf } from '@/lib/profile';
import { runWithRequestContext } from '@/lib/request-context';
import { editOriginal, errorText, handleInteraction, InteractionType, linkAccount, NOT_LINKED, notAvailable, type Interaction } from '@/lib/discord/commands';

// Discord HTTP interactions endpoint (set as "Interactions Endpoint URL" in the Developer Portal).
// Authenticated by Discord's Ed25519 signature, not by the app's proxy. The server it came from picks the organization
// (discord:<orgId>.guildId); the sender must have linked their Discord account there (/link, lib/profile.ts) and still
// be a member, and everything then acts as them, in their timezone. Anyone else gets "not linked". Work runs in after()
// and edits the deferred response.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_SKEW_S = 300;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

let keyCache: { hex: string; key: CryptoKey } | undefined;

async function publicKey(hex: string): Promise<CryptoKey | null> {
  if (keyCache?.hex === hex) return keyCache.key;
  const raw = hexToBytes(hex);
  if (!raw || raw.length !== 32) return null;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  keyCache = { hex, key };
  return key;
}

async function verify(req: Request, body: string): Promise<boolean> {
  const sig = req.headers.get('x-signature-ed25519');
  const ts = req.headers.get('x-signature-timestamp');
  const hex = process.env.DISCORD_PUBLIC_KEY?.trim();
  if (!sig || !ts || !hex || !/^\d+$/.test(ts)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) return false;
  const sigBytes = hexToBytes(sig);
  if (!sigBytes || sigBytes.length !== 64) return false;
  try {
    const key = await publicKey(hex);
    if (!key) return false;
    return await crypto.subtle.verify('Ed25519', key, sigBytes, new TextEncoder().encode(ts + body));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const body = await req.text();
  if (!(await verify(req, body))) return new NextResponse('invalid request signature', { status: 401 });

  let i: Interaction;
  try {
    i = JSON.parse(body) as Interaction;
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }
  if (i.type === InteractionType.PING) return NextResponse.json({ type: 1 });

  const cfg = discordConfig();
  const guildId = i.guild_id;
  const discordId = i.member?.user?.id; // only in a server (commands are registered per server)
  if (!cfg || !guildId || !discordId) return NextResponse.json(notAvailable(i));
  if (i.type === InteractionType.COMMAND && i.data?.name === 'link') return NextResponse.json(await linkAccount(i));

  // The Work OS person this Discord account is linked to, in the organization that owns the server.
  const s = await discordUser(guildId, discordId);
  if (!s) return NextResponse.json(notAvailable(i, NOT_LINKED));
  const ctx = { userId: s.userId, tz: await timezoneOf(s) };
  const baseUrl = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
  const plan = await runWithRequestContext(ctx, () => handleInteraction(i, { baseUrl, s, link: { orgId: s.orgId, guildId, discordId } }));

  if (plan.work) {
    const work = plan.work;
    const appId = cfg.appId || i.application_id;
    after(() => runWithRequestContext(ctx, async () => {
      let reply;
      try {
        reply = await work();
      } catch (err) {
        reply = { content: errorText(err) };
      }
      try {
        await editOriginal(appId, i.token, reply);
        await flushQueuedAlerts(s, baseUrl);
        await markSeen(s, 'discord');
      } catch (err) {
        console.error('[discord] edit original failed:', err instanceof Error ? err.message : String(err));
      }
    }));
  }
  return NextResponse.json(plan.response);
}
