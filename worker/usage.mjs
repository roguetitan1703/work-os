import fs from 'node:fs';
import path from 'node:path';
import { defaultProjectsRoot, readSessionMeta, rootsFilter } from './activity.mjs';

// Claude usage per session (Work OS note a289ffec58). From each `type: "assistant"` record of the transcripts
// (~/.claude/projects/<folder>/<sessionId>.jsonl and <sessionId>/subagents/agent-*.jsonl) only these are taken:
// message.usage (input, cache write, cache read, output tokens), message.model and the timestamp. Message text is
// never put into anything that is kept or sent. Totals are per session, part (the main conversation or one
// subagent), model and day (the person's timezone); a day's total is sent whole and the server replaces it.
// Incremental: each file's read offset is remembered, so a report carries only the days that changed.

export const BACKFILL_DAYS = 30;
export const MAX_ROWS = 300; // per report; days left over go in the next one
export const MAX_SESSIONS = 100;
export const SCAN_EVERY_MS = 5 * 60_000;
export const BYTES_PER_SCAN = 48 * 1024 * 1024; // a first run over a big history spreads over several scans
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 8 * 1024 * 1024;
const KEEP_KEYS = 64; // message keys remembered per file, to skip a block repeated across two reads
const MAX_FILES = 20000;
const SID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const num = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e12) : 0);
const oneLine = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

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
 * (add is called once per message at the end of the block). seen: Set of message keys already counted.
 */
export function parseUsage(text, seen, add, dayOf) {
  const found = new Map();
  for (const line of text.split('\n')) {
    if (line.length < 40 || line.length > MAX_LINE) continue;
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') continue;
    const u = o.message.usage;
    const model = o.message.model;
    if (!u || typeof u !== 'object' || typeof model !== 'string' || !model || model === '<synthetic>') continue;
    const day = typeof o.timestamp === 'string' ? dayOf(o.timestamp) : null;
    if (!day) continue;
    const id = o.message.id;
    const key = typeof id === 'string' && id ? `${id}|${typeof o.requestId === 'string' ? o.requestId : ''}` : null;
    const rec = { model: oneLine(model, 80), day, i: num(u.input_tokens), cw: num(u.cache_creation_input_tokens), cr: num(u.cache_read_input_tokens), o: num(u.output_tokens) };
    if (!key) { add(rec); continue; } // no id to dedupe by: counted as it stands
    if (seen.has(key)) continue;
    const prev = found.get(key);
    if (prev) { prev.i = Math.max(prev.i, rec.i); prev.cw = Math.max(prev.cw, rec.cw); prev.cr = Math.max(prev.cr, rec.cr); prev.o = Math.max(prev.o, rec.o); }
    else found.set(key, rec);
  }
  for (const [key, rec] of found) { seen.add(key); add(rec); }
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
 * Scans the transcripts and returns what changed: { rows, sessions, commit }. `st` is the remembered state (kept by the caller,
 * saved after commit): { files: {path: {off, keys}}, acc: {key: {...totals, dirty}}, meta: {sid: {...}} }. Nothing in `st` is changed until
 * commit() runs, which the caller does once the report was accepted.
 *   rows:     [{ sessionId, part, partName?, model, day, i, cw, cr, o }]  (a day's whole total for the part and model)
 *   sessions: [{ sessionId, title, folder, origin }] for the sessions in rows
 */
export function collectUsage({ st, root = defaultProjectsRoot(), tz, now = Date.now(), onlyRoots = null, maxRows = MAX_ROWS, bytes = BYTES_PER_SCAN }) {
  const dayOf = dayMaker(tz);
  const firstDay = dayOf(new Date(now - BACKFILL_DAYS * 86_400_000).toISOString());
  const files = listTranscripts(root, rootsFilter(onlyRoots), BACKFILL_DAYS * 86_400_000, now).sort((a, b) => b.mt - a.mt);
  const stFiles = st.files || {};
  const acc = {}; // changed totals, copied from st.acc on first touch
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
    parseUsage(r.text, seen, (rec) => {
      if (rec.day < firstDay) return;
      const k = `${f.sid}|${f.part}|${rec.model}|${rec.day}`;
      const a = acc[k] || (acc[k] = { ...(st.acc && st.acc[k] ? st.acc[k] : { i: 0, cw: 0, cr: 0, o: 0 }) });
      a.i += rec.i; a.cw += rec.cw; a.cr += rec.cr; a.o += rec.o; a.d = 1; a.f = f.file;
    }, dayOf);
    nextFiles[f.file] = { off: r.end, keys: [...seen].slice(-KEEP_KEYS) };
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
  return {
    rows,
    sessions,
    commit() {
      st.files = { ...stFiles, ...nextFiles };
      st.acc = st.acc || {};
      for (const k of Object.keys(acc)) st.acc[k] = acc[k];
      for (const k of sentKeys) { const a = st.acc[k]; if (a) delete a.d; }
      const cut = new Date(now - (BACKFILL_DAYS + 5) * 86_400_000).toISOString().slice(0, 10);
      for (const k of Object.keys(st.acc)) if (k.split('|')[3] < cut && !st.acc[k].d) delete st.acc[k];
      const listed = new Set(files.map((f) => f.file));
      for (const p of Object.keys(st.files)) if (!listed.has(p) && !fs.existsSync(p)) delete st.files[p];
    },
  };
}
