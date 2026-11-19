import { workerRoute } from '@/lib/worker-route';
import { mintRunKey } from '@/lib/run-keys';
import { InputError } from '@/lib/data/errors';

// A dispatched run's own Work OS key (lib/run-keys.ts, docs/dispatcher.md "Run keys"). The worker asks for one just before it
// starts or resumes a dispatched session and launches Claude Code with only that key. Device key checked in workerRoute.
// Body: { sessionId } (the worker session id). 400 when it is not a dispatched session of this computer.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = workerRoute(async (d, body) => {
  const sid = body && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined;
  if (typeof sid !== 'string' || !SID.test(sid)) throw new InputError('sessionId must be a session id');
  const r = await mintRunKey(d.s, d.id, sid.toLowerCase());
  if (!r) throw new InputError('not a dispatched session of this computer');
  return { key: r.key, expiresAt: r.expiresAt.toISOString() };
}, { body: true });
