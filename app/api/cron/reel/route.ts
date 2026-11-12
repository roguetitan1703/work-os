import { NextResponse } from 'next/server';
import { publishReel } from '@/lib/instagram';

// Publishes a prepared Instagram reel at its slot (lib/instagram.ts), called by the server's one-shot systemd timers.
//   POST /api/cron/reel   Authorization: Bearer <CRON_SECRET>   (the header only: a secret in the URL ends up in logs)
//   body { post: "A-Za-z0-9_-" 1-48 chars, container: 5-30 digits, slot: epoch seconds }
//   → { published: true, permalink } or { error }
// Waits for the whole run (a processing video can take 5 minutes, retries 40 s more), so the caller waits too.
// Excluded from proxy.ts with the rest of /api/cron; the secret is the only way in.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 480;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 });
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const b = await req.json().catch(() => null);
  const o = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  const post = o?.post;
  const container = o?.container;
  const slot = o?.slot;
  if (typeof post !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(post)) return NextResponse.json({ error: 'post: 1-48 letters, digits, - or _' }, { status: 400 });
  if (typeof container !== 'string' || !/^\d{5,30}$/.test(container)) return NextResponse.json({ error: 'container: 5-30 digits' }, { status: 400 });
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1_000_000_000 || slot > 10_000_000_000) return NextResponse.json({ error: 'slot: epoch seconds' }, { status: 400 });
  const r = await publishReel({ post, container, slot });
  return r.ok ? NextResponse.json({ published: true, permalink: r.permalink, ...(r.alertError ? { alertError: r.alertError } : {}) }) : NextResponse.json({ error: r.error, ...(r.alertError ? { alertError: r.alertError } : {}) }, { status: r.status });
}
