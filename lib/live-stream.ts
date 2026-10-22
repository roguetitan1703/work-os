import 'server-only';
import { register } from './live';

// One push stream (Server-Sent Events) for a page or a worker: app/api/stream and app/api/worker/stream. The caller is
// checked by the route before this opens. Events:
//   hello  {ttl}     on open (the client resets its backoff)
//   hint   {t, s?}   pages: refresh topic t (s: 1 when the change was the person's own)
//   jobs   {}        workers: poll /api/worker/jobs now
//   bye    {r}       the server closes it: 'ttl' (reconnect at once, the check runs again), 'closed' (removed or revoked)
// A comment line every 25 s keeps proxies from timing it out. A stream lives at most STREAM_TTL_MS, so every
// connection is checked again (session, membership, device key) at least that often.

const PING_MS = 25_000;
export const STREAM_TTL_MS = 30 * 60_000;
/** Chunks waiting for a client that does not read: past this, the stream is closed (it reconnects). */
const MAX_QUEUED = 100;

export type StreamOwner = { kind: 'page' | 'worker'; orgId: string; userId: string; deviceId?: string };

export function liveResponse(req: Request, who: StreamOwner): Response {
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unregister = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;
  let ttl: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const finish = (bye?: 'ttl' | 'closed') => {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(ttl);
    unregister();
    try {
      if (bye) ctrl?.enqueue(enc.encode(`event: bye\ndata: {"r":"${bye}"}\n\n`));
      ctrl?.close();
    } catch {
      // already closed by the client
    }
  };
  const write = (chunk: string) => {
    if (done || !ctrl) return;
    if ((ctrl.desiredSize ?? 0) < -MAX_QUEUED) return finish();
    try {
      ctrl.enqueue(enc.encode(chunk));
    } catch {
      finish();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      unregister = register({ ...who, send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), close: () => finish('closed') });
      write(`retry: 5000\nevent: hello\ndata: {"ttl":${STREAM_TTL_MS}}\n\n`);
      ping = setInterval(() => write(': ping\n\n'), PING_MS);
      ttl = setTimeout(() => finish('ttl'), STREAM_TTL_MS);
    },
    cancel() {
      finish();
    },
  });
  req.signal?.addEventListener('abort', () => finish(), { once: true });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      // nginx: pass each event on at once (docs/hosting.md "Push").
      'X-Accel-Buffering': 'no',
    },
  });
}
