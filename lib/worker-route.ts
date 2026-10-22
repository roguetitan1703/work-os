import 'server-only';
import { NextResponse } from 'next/server';
import { bearerToken } from './auth';
import { verifyDeviceKey } from './devices';
import { roleOf } from './caller';
import type { Scope } from './scope';
import { InputError, NotFoundError } from './data/errors';
import { runWithRequestContext } from './request-context';
import { timezoneOf } from './profile';

// Shared wrapper for /api/worker/* (docs/launcher.md): device keys only (wkr_…; Work OS API keys
// are refused), body size cap, per-device rate limit, JSON errors.

const MAX_BODY = 1_000_000;
const PER_MINUTE = 60;

// Counted in memory per process (a poll must not cost two database operations just to be rate limited).
const hits = new Map<string, number[]>();

function overLimit(deviceId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(deviceId) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= PER_MINUTE) {
    hits.set(deviceId, recent); // already over: do not record more
    return true;
  }
  recent.push(now);
  hits.set(deviceId, recent);
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k);
  return false;
}

/** A verified computer and its owner's scope: everything a worker does is that person's (their folders, jobs, tasks). */
export type WorkerDevice = { id: string; name: string; s: Scope };

export function workerRoute(fn: (device: WorkerDevice, body: unknown) => Promise<unknown>, opts: { body?: boolean } = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const device = await verifyDeviceKey(bearerToken(req));
      // A computer from before sign-in by user has no owner: it acts for nobody, so it is refused (re-add it in Setup).
      if (!device?.ownerId || !device.orgId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      // Its owner must still be a member: removing someone revokes their computers, and this holds even if that failed.
      if (!(await roleOf(device.ownerId, device.orgId))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      if (overLimit(device.id)) return NextResponse.json({ error: 'too many requests' }, { status: 429 });
      let body: unknown;
      if (opts.body) {
        const text = await req.text();
        if (text.length > MAX_BODY) return NextResponse.json({ error: 'body too large' }, { status: 413 });
        try {
          body = JSON.parse(text);
        } catch {
          return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
        }
      }
      const s: Scope = { userId: device.ownerId, orgId: device.orgId };
      const tz = await timezoneOf(s);
      return NextResponse.json(await runWithRequestContext({ userId: device.ownerId, tz }, () => fn({ id: device.id, name: device.name, s }, body)));
    } catch (err) {
      if (err instanceof InputError || err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 400 });
      console.error('[worker]', err);
      return NextResponse.json({ error: 'internal error' }, { status: 500 });
    }
  };
}
