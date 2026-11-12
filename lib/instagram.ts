import 'server-only';
import { alertOwners } from './owner-alert';

// Publishes a prepared Instagram reel (a media container made earlier) at its slot and tells the owner how it went.
// Called by one-shot systemd timers through POST /api/cron/reel (CRON_SECRET). The Graph API token goes only in an
// Authorization header: never in a URL, a log, an error, an alert or a response (every reason passes through scrubber()).
// IG_GRAPH_BASE and IG_DELAY_SCALE exist for the e2e suite's mock Graph server only.

const LATE_AFTER_MS = 30 * 60_000;
const POLL_EVERY_MS = 30_000;
const POLL_FOR_MS = 5 * 60_000;
const RETRY_EVERY_MS = 20_000;
const RETRIES = 2;

export type ReelRequest = { post: string; container: string; slot: number };
export type ReelResult = { ok: true; published: true; permalink: string | null } | { ok: false; status: number; error: string };

const g = globalThis as unknown as { __workosReels?: Map<string, Promise<ReelResult> | ReelResult> };
const seen = (g.__workosReels ??= new Map()); // posts handled by this process: a repeated call never publishes twice

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms * (Number(process.env.IG_DELAY_SCALE) || 1)));

function base(): string {
  const o = (process.env.IG_GRAPH_BASE ?? '').replace(/\/+$/, '');
  if (o && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(o)) return o;
  return 'https://graph.facebook.com';
}

type Cfg = { account: string; token: string; version: string };
const scrubber = (token: string) => (s: string) => (token ? s.split(token).join('[token]') : s);

class Graph {
  constructor(private cfg: Cfg) {}
  /** One Graph call. Never throws: status 0 is a network error. The error text is scrubbed of the token. */
  async call(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const scrub = scrubber(this.cfg.token);
    const qs = method === 'GET' && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
    try {
      const res = await fetch(`${base()}/${this.cfg.version}/${path}${qs}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.token}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: new URLSearchParams(params).toString() } : {}),
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
      });
      const raw = await res.text();
      let json: Record<string, unknown> = {};
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') json = j;
      } catch {
        // not JSON
      }
      const err = json.error && typeof json.error === 'object' ? (json.error as { message?: unknown }).message : undefined;
      return { status: res.status, json, text: scrub(typeof err === 'string' ? err : raw.slice(0, 200)).slice(0, 300) };
    } catch (e) {
      return { status: 0, json: {}, text: scrub(e instanceof Error ? e.message : 'network error').slice(0, 300) };
    }
  }
}

async function run(req: ReelRequest, now: number): Promise<ReelResult> {
  const cfg: Cfg = { account: process.env.IG_ACCOUNT_ID ?? '', token: process.env.IG_PAGE_TOKEN ?? '', version: process.env.IG_GRAPH_VERSION || 'v23.0' };
  const fail = async (reason: string, status = 502): Promise<ReelResult> => {
    const clean = scrubber(cfg.token)(reason);
    await alertOwners({ title: `Reel ${req.post} was NOT posted`, body: `${clean}. Post it from your phone.` }).catch(() => {});
    return { ok: false, status, error: clean };
  };
  if (!/^\d{5,30}$/.test(cfg.account) || cfg.token.length < 10 || !/^v\d+\.\d+$/.test(cfg.version)) return fail('Instagram is not set up on the server (IG_ACCOUNT_ID, IG_PAGE_TOKEN)', 503);

  const lateBy = now - req.slot * 1000;
  if (lateBy > LATE_AFTER_MS) return fail(`it is ${Math.round(lateBy / 60_000)} minutes past its slot (the limit is 30)`);

  const api = new Graph(cfg);
  // 1. The container must be FINISHED; IN_PROGRESS is checked again every 30 s for up to 5 minutes.
  for (let waited = 0; ; waited += POLL_EVERY_MS) {
    const r = await api.call('GET', req.container, { fields: 'status_code,status' });
    if (r.status !== 200) return fail(`Instagram could not check the video (${r.status || 'no answer'}: ${r.text})`);
    const code = String(r.json.status_code ?? '');
    if (code === 'FINISHED') break;
    if (code !== 'IN_PROGRESS') return fail(`Instagram says the video is ${code || 'in an unknown state'}${r.json.status ? ` (${String(r.json.status).slice(0, 150)})` : ''}`);
    if (waited >= POLL_FOR_MS) return fail('Instagram was still processing the video after 5 minutes');
    await sleep(POLL_EVERY_MS);
  }

  // 2. Publish. A network error or a 5xx is tried again (twice, 20 s apart); a 4xx is an answer, so no retry.
  let media = '';
  let last = '';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(RETRY_EVERY_MS);
    const r = await api.call('POST', `${cfg.account}/media_publish`, { creation_id: req.container });
    if (r.status === 200 && typeof r.json.id === 'string' && r.json.id) {
      media = r.json.id;
      break;
    }
    last = `${r.status || 'no answer'}: ${r.text}`;
    if (r.status >= 400 && r.status < 500) return fail(`Instagram refused to publish (${last})`);
    if (r.status === 200) return fail('Instagram answered publish without a post id');
  }
  if (!media) return fail(`Instagram publish kept failing (${last})`);

  // 3. It is live. The link is nice to have: its failure never turns a published reel into a failure.
  const r = await api.call('GET', media, { fields: 'permalink,timestamp' });
  const link = r.status === 200 && typeof r.json.permalink === 'string' && /^https:\/\//.test(r.json.permalink) ? r.json.permalink : null;
  await alertOwners({ title: `Reel ${req.post} is live`, body: link ?? 'Published (Instagram gave no link).', ...(link ? { url: link } : {}) }).catch(() => {});
  return { ok: true, published: true, permalink: link };
}

/** Publish the reel and alert the owner(s). Never throws. */
export async function publishReel(req: ReelRequest, now = Date.now()): Promise<ReelResult> {
  const prior = seen.get(req.post);
  if (prior) return prior instanceof Promise ? { ok: false, status: 409, error: 'this post is already being published' } : prior;
  const p = run(req, now).catch((e): ReelResult => ({ ok: false, status: 500, error: e instanceof Error ? scrubber(process.env.IG_PAGE_TOKEN ?? '')(e.message).slice(0, 200) : 'failed' }));
  seen.set(req.post, p);
  const res = await p;
  if (res.ok) seen.set(req.post, res); // a failed one may be tried again by a later call
  else seen.delete(req.post);
  if (seen.size > 500) seen.clear();
  return res;
}
