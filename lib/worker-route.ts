import 'server-only';
import { NextResponse } from 'next/server';
import { bearerToken } from './auth';
import { verifyDeviceKey, type VerifiedDevice } from './devices';
import { InputError, NotFoundError } from './data/errors';

// Shared wrapper for /api/worker/* (docs/launcher.md): device keys only (wkr_…; MCP_TOKEN and
// Claude Code keys are refused), body size cap, per-device rate limit, JSON errors.

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

export function workerRoute(fn: (device: VerifiedDevice, body: unknown) => Promise<unknown>, opts: { body?: boolean } = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const device = await verifyDeviceKey(bearerToken(req));
      if (!device) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
      return NextResponse.json(await fn(device, body));
    } catch (err) {
      if (err instanceof InputError || err instanceof NotFoundError) return NextResponse.json({ error: err.message }, { status: 400 });
      console.error('[worker]', err);
      return NextResponse.json({ error: 'internal error' }, { status: 500 });
    }
  };
}
