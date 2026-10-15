import 'server-only';
import { NextResponse } from 'next/server';
import { bearerToken } from './auth';
import { verifyDeviceKey, type VerifiedDevice } from './devices';
import { InputError, NotFoundError } from './data/errors';
import { collections } from './db';

// Shared wrapper for /api/worker/* (docs/launcher.md): device keys only (wkr_…; MCP_TOKEN and
// Claude Code keys are refused), body size cap, per-device rate limit, JSON errors.

const MAX_BODY = 1_000_000;
const PER_MINUTE = 60;

async function overLimit(deviceId: string): Promise<boolean> {
  const c = await collections();
  const since = new Date(Date.now() - 60_000);
  const recent = await c.policyEvents.countDocuments({ keyId: deviceId, kind: 'worker', at: { $gte: since } });
  if (recent >= PER_MINUTE) return true; // already over: do not add more rows
  await c.policyEvents.insertOne({ _id: `w_${deviceId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, keyId: deviceId, kind: 'worker', at: new Date() });
  return false;
}

export function workerRoute(fn: (device: VerifiedDevice, body: unknown) => Promise<unknown>, opts: { body?: boolean } = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const device = await verifyDeviceKey(bearerToken(req));
      if (!device) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      if (await overLimit(device.id)) return NextResponse.json({ error: 'too many requests' }, { status: 429 });
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
