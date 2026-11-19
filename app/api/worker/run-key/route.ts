import { workerRoute } from '@/lib/worker-route';
import { mintRunKey } from '@/lib/run-keys';
import { InputError } from '@/lib/data/errors';

// Is this session a dispatched run, and if so its own Work OS key (lib/run-keys.ts, docs/dispatcher.md "Run keys"). The worker asks
// before it starts, resumes or reopens a session; a dispatched one is launched with only that key. Device key checked in workerRoute.
// Body: { sessionId } (the worker session id). 200 { dispatched: false } for a session that is no dispatched run of the person;
// 200 { key, expiresAt, ref } for this computer's dispatched run; 400 for a dispatched run that gets no key (the worker opens nothing).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = workerRoute(async (d, body) => {
  const sid = body && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined;
  if (typeof sid !== 'string' || !SID.test(sid)) throw new InputError('sessionId must be a session id');
  const r = await mintRunKey(d.s, d.id, sid.toLowerCase());
  if (!r) throw new InputError('a dispatched run that cannot be opened on this computer');
  if ('plain' in r) return { dispatched: false };
  return { key: r.key, expiresAt: r.expiresAt.toISOString(), ref: r.ref };
}, { body: true });
