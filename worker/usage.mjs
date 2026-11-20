import fs from 'node:fs';
import path from 'node:path';
import { hashAccount, readAccount } from './claude-account.mjs';
import { defaultProjectsRoot, readSessionMeta, rootsFilter } from './activity.mjs';

// Claude usage per session (Work OS note a289ffec58). From each `type: "assistant"` record of the transcripts
// (~/.claude/projects/<folder>/<sessionId>.jsonl and <sessionId>/subagents/agent-*.jsonl) only these are taken:
// message.usage (input, cache write, cache read, output tokens), message.model and the timestamp. Message text is
// never put into anything that is kept or sent. Totals are per session, part (the main conversation or one
// subagent), model and day (the person's timezone); a day's total is sent whole and the server replaces it. The same counts
// also go in 5-minute buckets (last 7 days). Besides the counts, only these are taken: a limit hit (its kind and the reset
// time read from the notice) and a compaction (the token counts around it), each once; and the Claude account as a hash id
// plus the email's part before @ (readAccount reads ~/.claude.json, never writes it, sends no uuid and no full email).
// No message text is kept or sent. Incremental: each file's read offset is remembered, so a report carries only what changed.

export const BACKFILL_DAYS = 30;
export const MAX_ROWS = 300; // per report; days left over go in the next one
export const MAX_SESSIONS = 100;
export const MAX_BUCKETS = 1000; // per report; the rest wait for the next one
export const MAX_EVENTS = 200;
export const BUCKET_DAYS = 7;
const BUCKET_MS = 5 * 60_000;
export const SCAN_EVERY_MS = 5 * 60_000;
export const BYTES_PER_SCAN = 48 * 1024 * 1024; // a first run over a big history spreads over several scans
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 8 * 1024 * 1024;
const KEEP_KEYS = 64; // message keys remembered per file, to skip a block repeated across two reads
const MAX_FILES = 20000;
const SID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const num = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e12) : 0);
export { readAccount };
const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/** The instant (ms) at which the wall clock of `tz` (the local zone when missing or wrong) shows y-m-d h:min. */
function wallInstant(y, mo, d, h, min, tz) {
  let fmt = null;
  if (tz) { try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); } catch { fmt = null; } }
  if (!fmt) return new Date(y, mo - 1, d, h, min).getTime();
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const guess = Date.UTC(y, mo - 1, d, h, min);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/** The first "resets 4:30pm" time after `atMs`, as an ISO string (the notice's wall time in `tz`), or null. */
function resetTime(text, atMs, tz, dayOf) {
  const epoch = /\|(\d{10})\b/.exec(text); // "limit reached|1763650000": the instant itself, in seconds
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const m = /resets? ([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  const named = /^\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\)/.exec(text.slice(m.index + m[0].length));
  if (named) { try { new Intl.DateTimeFormat('en-US', { timeZone: named[1] }); tz = named[1]; dayOf = dayMaker(tz); } catch { /* the person's zone */ } }
  const hh = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (hh < 1 || hh > 12 || min > 59) return null;
  const h = (hh % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  const day = dayOf(new Date(atMs).toISOString());
  if (!day) return null;
  const [y, mo, d] = day.split('-').map(Number);
  let t = wallInstant(y, mo, d, h, min, tz);
  if (t <= atMs) { const n = new Date(Date.UTC(y, mo - 1, d + 1)); t = wallInstant(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), h, min, tz); }
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ') : '');

/** A function that turns a timestamp into YYYY-MM-DD in `tz` (the local zone when tz is missing or wrong). */
export function dayMaker(tz) {
  let fmt = null;
  if (tz) { try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { fmt = null; } }
  const cache = new Map();
  return (ts) => {
    const key = String(ts).slice(0, 16); // a minute: a zone's day changes on a minute boundary
    const hit = cache.get(key);
    if (hit) return hit;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    let day;
    if (fmt) day = fmt.format(d);
    else { const p = (n) => String(n).padStart(2, '0'); day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
    if (cache.size > 5000) cache.clear();
    cache.set(key, day);
    return day;
  };
}

/**
 * Parses a block of transcript text (whole lines). For each assistant record with usage it calls add(rec). Records of one
 * message repeat per content block with the same message.id and requestId: the largest value of each count is kept
 * (add(rec, extra) is called once per message at the end of the block; extra = { at: the timestamp, cw1h }). seen: Set of message
 * keys already counted. hooks (optional): { tz, bridge(accountId) for a bridge-session record's account, event(ev) for a limit hit or
 * a compaction: { kind, id, at, ... } without the session, part and account (the caller adds them) }.
 */
export function parseUsage(text, seen, add, dayOf, hooks = {}) {
  const found = new Map();
  for (const line of text.split('\n')) {
    if (line.length < 40 || line.length > MAX_LINE) continue;
    const usageLine = line.includes('"assistant"') && (line.includes('"usage"') || line.includes('<synthetic>'));
    if (!usageLine && !line.includes('"compact_boundary"') && !line.includes('"bridge-session"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'bridge-session') {
      if (hooks.bridge && typeof o.ownerAccountUuid === 'string' && o.ownerAccountUuid) hooks.bridge(hashAccount(o.ownerAccountUuid));
      continue;
    }
    const atMs = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      if (hooks.event && typeof o.uuid === 'string' && o.uuid && !Number.isNaN(atMs)) {
        const cm = o.compactMetadata && typeof o.compactMetadata === 'object' ? o.compactMetadata : {};
        hooks.event({ kind: 'compact', id: o.uuid, at: new Date(atMs).toISOString(), trigger: cm.trigger === 'auto' || cm.trigger === 'manual' ? cm.trigger : 'other', pre: num(cm.preTokens), post: num(cm.postTokens) });
      }
      continue;
    }
    if (o.type !== 'assistant' || !o.message || typeof o.message !== 'object') continue;
    if (o.message.model === '<synthetic>') {
      // A limit notice. Only its kind and reset time leave this function, never the text.
      if (hooks.event && typeof o.uuid === 'string' && o.uuid && !Number.isNaN(atMs)) {
        const t = textOf(o.message.content);
        if (!/^\s*API Error/.test(t) && /(usage limit|limit reached|hit your limit)/i.test(t)) {
          const which = /week/i.test(t) ? 'weekly' : /5-hour|5 hour|session limit/i.test(t) ? '5h' : 'other';
          hooks.event({ kind: 'limit', id: o.uuid, at: new Date(atMs).toISOString(), which, resetAt: resetTime(t, atMs, hooks.tz, dayOf) });
        }
      }
      continue;
    }
    const u = o.message.usage;
    const model = o.message.model;
    if (!u || typeof u !== 'object' || typeof model !== 'string' || !model) continue;
    const day = typeof o.timestamp === 'string' ? dayOf(o.timestamp) : null;
    if (!day) continue;
    const id = o.message.id;
    const key = typeof id === 'string' && id ? `${id}|${typeof o.requestId === 'string' ? o.requestId : ''}` : null;
    const rec = { model: oneLine(model, 80), day, i: num(u.input_tokens), cw: num(u.cache_creation_input_tokens), cr: num(u.cache_read_input_tokens), o: num(u.output_tokens) };
    const extra = { at: o.timestamp, cw1h: num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) };
    if (!key) { add(rec, extra); continue; } // no id to dedupe by: counted as it stands
    if (seen.has(key)) continue;
    const prev = found.get(key);
    if (prev) { prev.rec.i = Math.max(prev.rec.i, rec.i); prev.rec.cw = Math.max(prev.rec.cw, rec.cw); prev.rec.cr = Math.max(prev.rec.cr, rec.cr); prev.rec.o = Math.max(prev.rec.o, rec.o); prev.extra.cw1h = Math.max(prev.extra.cw1h, extra.cw1h); }
    else found.set(key, { rec, extra });
  }
  for (const [key, v] of found) { seen.add(key); add(v.rec, v.extra); }
  return found.size;
}

function readNewLines(file, from, budget) {
  // Returns { text, end } for whole lines between `from` and the end of the file (at most `budget` bytes), or null.
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    if (len <= from) return { text: '', end: len, size: len };
    const want = Math.min(len - from, budget, CHUNK * 4);
    const buf = Buffer.alloc(want);
    const n = fs.readSync(fd, buf, 0, want, from);
    let cut = buf.lastIndexOf(10, n - 1);
    if (cut < 0) cut = len - from <= want && n < MAX_LINE ? -1 : n - 1; // no newline yet: a line still being written waits
    if (cut < 0) return { text: '', end: from, size: len };
    return { text: buf.subarray(0, cut + 1).toString('utf8'), end: from + cut + 1, size: len };
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function listTranscripts(root, keep, cutoffMs, now) {
  const out = []; // { file, sid, part: 'main' | agent file id, mt, size }
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  let stats = 0;
  const take = (file, sid, part) => {
    if (++stats > MAX_FILES) return;
    let st; try { st = fs.statSync(file); } catch { return; }
    if (now - st.mtimeMs > cutoffMs) return;
    out.push({ file, sid, part, mt: st.mtimeMs, size: st.size });
  };
  for (const proj of projects) {
    if (!proj.isDirectory() || (keep && !keep(proj.name))) continue;
    const pdir = path.join(root, proj.name);
    let entries; try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const m = e.isFile() && SID_FILE.exec(e.name);
      if (m) { take(path.join(pdir, e.name), m[1].toLowerCase(), 'main'); continue; }
      if (e.isDirectory() && /^[0-9a-f-]{36}$/i.test(e.name)) {
        const sub = path.join(pdir, e.name, 'subagents');
        let files; try { files = fs.readdirSync(sub); } catch { continue; }
        for (const f of files) {
          const a = /^(agent-[A-Za-z0-9_-]{1,60})\.jsonl$/.exec(f);
          if (a) take(path.join(sub, f), e.name.toLowerCase(), a[1]);
        }
      }
    }
  }
  return out;
}

/**
 * Scans the transcripts and returns what changed: { rows, sessions, buckets, events, accounts, commit }. `st` is the remembered state
 * (kept by the caller, saved after commit): { files: {path: {off, keys, acct?}}, acc: {key: {...totals, dirty}}, bk: {key: {...}}, ev: [pending events] }.
 * Nothing in `st` is changed until commit() runs, which the caller does once the report was accepted.
 *   rows:     [{ sessionId, part, partName?, model, day, i, cw, cr, o, acct? }]  (a day's whole total for the part and model)
 *   sessions: [{ sessionId, title, folder, origin }] for the sessions in rows
 *   buckets:  [{ sessionId, part, model, at, acct, i, cw, cw1h, cr, o, n }]  (a 5-minute bucket's whole total; the last 7 days; acct the latest account that added to it)
 *   events:   [{ kind: 'limit' | 'compact', id, sessionId, part, at, acct, ... }]  (each sent once)
 *   accounts: [{ id, label }] the accounts named in the above
 * accountFile: where readAccount reads (tests give a fixture; never the real file).
 */
export function collectUsage({ st, root = defaultProjectsRoot(), tz, now = Date.now(), onlyRoots = null, maxRows = MAX_ROWS, bytes = BYTES_PER_SCAN, accountFile }) {
  const fresh = readAccount(accountFile);
  const own = fresh || (st.lastAcct && st.lastAcct.id ? st.lastAcct : null); // a failed read uses the last good one
  const dayOf = dayMaker(tz);
  const firstDay = dayOf(new Date(now - BACKFILL_DAYS * 86_400_000).toISOString());
  const files = listTranscripts(root, rootsFilter(onlyRoots), BACKFILL_DAYS * 86_400_000, now).sort((a, b) => b.mt - a.mt);
  const stFiles = st.files || {};
  const acc = {}; // changed totals, copied from st.acc on first touch
  const bk = {}; // changed buckets, the same
  const evNew = [];
  const firstBucket = now - BUCKET_DAYS * 86_400_000;
  const nextFiles = {};
  let left = bytes;
  const dirtyNow = () => Object.keys(st.acc || {}).filter((k) => st.acc[k].d).length;
  for (const f of files) {
    const prev = stFiles[f.file];
    const off = prev ? prev.off : 0;
    if (f.size < off) { nextFiles[f.file] = { off: f.size, keys: [] }; continue; } // the file shrank: start after what is there
    if (f.size === off) continue;
    if (left <= 0 || dirtyNow() + Object.keys(acc).length >= maxRows) break;
    const r = readNewLines(f.file, off, left);
    if (!r) continue;
    left -= Math.max(0, r.end - off);
    const seen = new Set(prev ? prev.keys : []);
    // The file's account: a bridge-session record's (the latest in this block, else the one remembered), else this computer's.
    let bridge = prev && prev.acct ? prev.acct : null;
    const evs = [];
    const adds = [];
    parseUsage(r.text, seen, (rec, extra) => adds.push([rec, extra]), dayOf, { tz, bridge: (id) => { bridge = id; }, event: (e) => evs.push(e) });
    const acct = bridge || (own ? own.id : '');
    for (const [rec, extra] of adds) {
      if (rec.day < firstDay) continue;
      const k = `${f.sid}|${f.part}|${rec.model}|${rec.day}`;
      const a = acc[k] || (acc[k] = { ...(st.acc && st.acc[k] ? st.acc[k] : { i: 0, cw: 0, cr: 0, o: 0 }) });
      a.i += rec.i; a.cw += rec.cw; a.cr += rec.cr; a.o += rec.o; a.d = 1; a.f = f.file;
      if (acct) a.acct = acct;
      const t = Date.parse(extra.at);
      if (t >= firstBucket) {
        const bk0 = new Date(Math.floor(t / BUCKET_MS) * BUCKET_MS).toISOString();
        const bkey = `${f.sid}|${f.part}|${rec.model}|${bk0}`;
        const b = bk[bkey] || (bk[bkey] = { ...(st.bk && st.bk[bkey] ? st.bk[bkey] : { i: 0, cw: 0, cw1h: 0, cr: 0, o: 0, n: 0, pk: 0 }) });
        b.pk = Math.max(b.pk || 0, rec.i + rec.cw + rec.cr); // the largest context one call carried (the context warning, note 3e92845ac0)
        b.i += rec.i; b.cw += rec.cw; b.cw1h += extra.cw1h; b.cr += rec.cr; b.o += rec.o; b.n += 1; b.d = 1; b.acct = acct; // the latest account wins
      }
    }
    for (const e of evs) {
      const dd = dayOf(e.at);
      if (dd && dd >= firstDay) evNew.push({ ...e, sessionId: f.sid, part: f.part, acct });
    }
    nextFiles[f.file] = { off: r.end, keys: [...seen].slice(-KEEP_KEYS), ...(bridge ? { acct: bridge } : {}) };
  }
  const keys = Object.keys({ ...(st.acc || {}), ...acc }).filter((k) => (acc[k] || st.acc[k]).d);
  // Newest days first, so a first run fills today before last month.
  keys.sort((a, b) => b.split('|')[3].localeCompare(a.split('|')[3]) || (a < b ? -1 : 1));
  const send = keys.slice(0, maxRows);
  const sids = [];
  const rows = [];
  for (const k of send) {
    const [sessionId, part, model, day] = k.split('|');
    const a = acc[k] || st.acc[k];
    if (!sids.includes(sessionId)) { if (sids.length >= MAX_SESSIONS) continue; sids.push(sessionId); }
    const row = { sessionId, part, model, day, i: a.i, cw: a.cw, cr: a.cr, o: a.o };
    if (a.acct) row.acct = a.acct;
    if (part !== 'main') {
      const title = readSessionMeta(a.f || '').title;
      row.partName = title ? oneLine(title, 80) : part;
    }
    rows.push(row);
  }
  const sessions = sids.map((sid) => {
    const file = [...files].find((f) => f.sid === sid && f.part === 'main');
    const m = file ? readSessionMeta(file.file) : { title: '', folder: '', origin: 'other' };
    return { sessionId: sid, title: m.title || m.folder || '', folder: m.folder || 'unknown', origin: m.origin };
  });
  const sentKeys = rows.map((r) => `${r.sessionId}|${r.part}|${r.model}|${r.day}`);
  // Buckets: newest first, at most MAX_BUCKETS; the rest stay dirty for the next report.
  const bKeys = Object.keys({ ...(st.bk || {}), ...bk }).filter((k) => (bk[k] || st.bk[k]).d);
  bKeys.sort((a, b) => b.split('|')[3].localeCompare(a.split('|')[3]) || (a < b ? -1 : 1));
  const bSend = bKeys.slice(0, MAX_BUCKETS);
  const buckets = bSend.map((k) => {
    const [sessionId, part, model, at] = k.split('|');
    const b = bk[k] || st.bk[k];
    return { sessionId, part, model, at, acct: b.acct || '', i: b.i, cw: b.cw, cw1h: b.cw1h, cr: b.cr, o: b.o, n: b.n, peakCtx: b.pk || 0 };
  });
  // Events: sent once; those over the limit of one report wait in st.ev.
  const evAll = [...(st.ev || []), ...evNew];
  const events = evAll.slice(0, MAX_EVENTS);
  const used = new Map();
  for (const x of [...rows, ...buckets, ...events]) if (x.acct) used.set(x.acct, { id: x.acct, label: own && own.id === x.acct ? own.label : '' });
  return {
    rows,
    sessions,
    buckets,
    events,
    accounts: [...used.values()],
    commit() {
      st.files = { ...stFiles, ...nextFiles };
      st.acc = st.acc || {};
      for (const k of Object.keys(acc)) st.acc[k] = acc[k];
      for (const k of sentKeys) { const a = st.acc[k]; if (a) delete a.d; }
      if (fresh) st.lastAcct = { id: fresh.id, label: fresh.label };
      st.bk = st.bk || {};
      for (const k of Object.keys(bk)) st.bk[k] = bk[k];
      for (const k of bSend) { const b = st.bk[k]; if (b) delete b.d; }
      const bCut = new Date(now - (BUCKET_DAYS + 1) * 86_400_000).toISOString();
      for (const k of Object.keys(st.bk)) if (k.split('|')[3] < bCut) delete st.bk[k];
      st.ev = evAll.slice(events.length);
      const cut = new Date(now - (BACKFILL_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
      for (const k of Object.keys(st.acc)) if (k.split('|')[3] < cut && !st.acc[k].d) delete st.acc[k];
      const listed = new Set(files.map((f) => f.file));
      for (const p of Object.keys(st.files)) if (!listed.has(p) && !fs.existsSync(p)) delete st.files[p];
    },
  };
}
