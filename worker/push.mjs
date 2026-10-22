import { checkBaseUrl } from './config.mjs';

// Push from Work OS (docs/launcher.md "Push"): one long-lived GET /api/worker/stream with the device key. The server
// sends `jobs` when there is something to fetch (a start, resume or stop job, a task given to Claude, a folder
// linked); the worker then polls /api/worker/jobs at once. The events carry no job data.
// While the stream is up the worker polls only every few minutes (a fallback); while it is down it polls as before.
// Reconnects with backoff (1 s doubling to 60 s, jittered; 5 minutes after the key is refused).

const MAX_BACKOFF_MS = 60_000;
const REFUSED_MS = 5 * 60_000;
const NOT_OFFERED_MS = 30 * 60_000;
// The server sends a comment every 25 s; nothing for this long means the connection is dead (sleep, NAT, proxy).
const SILENT_MS = 70_000;

export function connectPush({ getCfg, getToken, onWake, onUp = () => {}, log = () => {}, fetchImpl = fetch, now = () => Date.now() }) {
  let up = false;
  let stopped = false;
  let attempt = 0;
  let ctrl = null;
  let timer = null;

  const setUp = (v) => {
    if (up === v) return;
    up = v;
    onUp(v);
  };

  async function once() {
    const token = getToken();
    if (!token) return { wait: REFUSED_MS };
    const base = checkBaseUrl(getCfg().baseUrl);
    const ac = (ctrl = new AbortController());
    let last = now();
    const watchdog = setInterval(() => { if (now() - last > SILENT_MS) ac.abort(); }, 10_000);
    try {
      const res = await fetchImpl(base + '/api/worker/stream', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ac.signal });
      if (res.status === 401 || res.status === 403) return { wait: REFUSED_MS, why: `push refused (HTTP ${res.status})` };
      // An older Work OS without push: try again rarely; polling carries on as before meanwhile.
      if (res.status === 404 || res.status === 405) return { wait: NOT_OFFERED_MS, why: 'push not offered by this server; polling' };
      if (!res.ok || !res.body) return { why: `push unavailable (HTTP ${res.status})` };
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        last = now();
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: ?(.*)$/m.exec(block)?.[1]?.trim();
          if (ev === 'hello') { attempt = 0; setUp(true); }
          else if (ev === 'jobs') onWake();
          else if (ev === 'bye') {
            if (/"ttl"/.test(block)) return { wait: 0 };
            // Another copy of this worker holds the computer's streams: stay on the poll a while.
            if (/"limit"/.test(block)) return { why: 'push closed: too many streams for this computer', wait: MAX_BACKOFF_MS };
            return { why: 'push closed by the server' };
          }
        }
        if (buf.length > 65_536) buf = '';
      }
      return { why: 'push stream ended' };
    } catch (e) {
      return { why: stopped ? null : `push: ${String((e && e.message) || e).slice(0, 120)}` };
    } finally {
      clearInterval(watchdog);
      ctrl = null;
      setUp(false);
    }
  }

  async function loop() {
    while (!stopped) {
      const r = await once();
      if (stopped) break;
      if (r.why) log(r.why);
      const wait = r.wait ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++) * (0.8 + Math.random() * 0.4);
      await new Promise((res) => { timer = setTimeout(res, wait); });
    }
  }

  loop();
  return {
    get up() { return up; },
    stop() { stopped = true; clearTimeout(timer); if (ctrl) ctrl.abort(); setUp(false); },
  };
}
