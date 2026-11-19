import { workerRoute } from '@/lib/worker-route';
import { isDispatchedRun, mintRunKey, releaseRunKey } from '@/lib/run-keys';
import { InputError } from '@/lib/data/errors';

// Is this session a dispatched run, and if so its own Work OS key (lib/run-keys.ts, docs/dispatcher.md "Run keys"). The worker asks
// before it starts, resumes or reopens a session; a dispatched one is launched with only that key. Device key checked in workerRoute.
// Bodies:
//   { sessionId }: 200 { dispatched: false } for a session that is no dispatched run of the person; 200 { key, expiresAt, ref } for
//     this computer's dispatched run; 400 for a dispatched run that gets no key (the worker opens nothing).
//   { sessionIds: [...] } (Reopen all, at most 20, one request): 200 { runs: [{ sessionId, ...one of the answers above, or
//     refused: reason }] }.
//   { sessionId, check: true } ("Open in VS Code"): 200 { dispatched: boolean }; mints nothing.
//   { sessionId, release: key }: the launch failed; the key dies and the row goes back (releaseRunKey). 200 { released }.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 20;
const REFUSED = 'a dispatched run that cannot be opened on this computer';

export const POST = workerRoute(async (d, body) => {
  const b = (body && typeof body === 'object' ? body : {}) as { sessionId?: unknown; sessionIds?: unknown; check?: unknown; release?: unknown };
  if (b.sessionIds !== undefined) {
    if (!Array.isArray(b.sessionIds) || !b.sessionIds.length || b.sessionIds.length > MAX_IDS || !b.sessionIds.every(x => typeof x === 'string' && SID.test(x))) throw new InputError(`sessionIds must be 1 to ${MAX_IDS} session ids`);
    const ids = [...new Set((b.sessionIds as string[]).map(x => x.toLowerCase()))];
    const runs = [];
    for (const sessionId of ids) {
      const r = await mintRunKey(d.s, d.id, sessionId);
      runs.push(!r ? { sessionId, refused: REFUSED } : 'plain' in r ? { sessionId, dispatched: false } : { sessionId, key: r.key, expiresAt: r.expiresAt.toISOString(), ref: r.ref });
    }
    return { runs };
  }
  const sid = b.sessionId;
  if (typeof sid !== 'string' || !SID.test(sid)) throw new InputError('sessionId must be a session id');
  if (b.check === true) return { dispatched: await isDispatchedRun(d.s, sid.toLowerCase()) };
  if (b.release !== undefined) {
    if (typeof b.release !== 'string') throw new InputError('release must be the run key');
    return { released: await releaseRunKey(d.s, d.id, sid.toLowerCase(), b.release) };
  }
  const r = await mintRunKey(d.s, d.id, sid.toLowerCase());
  if (!r) throw new InputError(REFUSED);
  if ('plain' in r) return { dispatched: false };
  return { key: r.key, expiresAt: r.expiresAt.toISOString(), ref: r.ref };
}, { body: true });
