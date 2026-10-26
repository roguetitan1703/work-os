// Leak audit (docs/multi-user.md "Leak audit"): every entry point of the app, read from the code (entry-points.mjs),
// called as each persona, with canaries planted in every kind of private and other-organization document.
//
// Personas: A owns the first organization (control: what A can do must work), T is a member there (a teammate, aimed
// at A's private things), X owns a second organization (aimed at the first organization's shared work), R was a member
// removed by the owner, after which the removal's clean-up is undone (session, keys, computer; the Discord link
// stays): only the missing membership keeps R out. N has no credentials. And each kind of key where it does not belong.
//
// What fails the suite:
//   - an entry point with no audit entry below ("unaudited entry point: X"), or an audit entry for one that is gone;
//   - a response (body, Discord reply or DM, push event) that holds a canary its persona may not read;
//   - a write to a document its persona may not write (every collection is read before and after each persona's
//     probes; Better Auth's own collections included);
//   - "exists but not yours" answered differently from "does not exist" (every aimed probe also runs with a made-up
//     id, ref or name of the same shape, and the two answers must match once the id itself is taken out);
//   - a control call by the owner that does not work (so a refusal elsewhere is not just a broken probe);
//   - an aimed call that was refused by a server error, or a kind of entry point none of whose refusals reads as an
//     access check ("not found", a sign-in redirect, 401/403/404).
// Runs with the stub Discord (server mode discord). Seed profile: none. LEAK_AUDIT_LIST=1 prints every refusal.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { B, CRON, EMAIL, ME, MCP, PW, check, finish, makeUser, mkKey, rawDb, setOrgGuild, setProfile, setSchedule, sha } from './lib.mjs';
import { entryPoints, unlistedBuilt } from './entry-points.mjs';

const T0 = Date.now();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => randomBytes(n).toString('hex');
const oid = () => new ObjectId().toHexString();
const leaks = [];
// The made-up twin is passed as `o`; probes that pick their own made-up value compare against it.
const FAKE_REF = { v: null, key: new ObjectId().toHexString() };
const P_SUB2_TITLE = { v: '' };
const leak = (what, x = '') => { leaks.push(what); check(`LEAK ${what}`, false, x); };

// ── canaries ────────────────────────────────────────────────────────────────
// A canary is a unique string planted in one document; `allow` says which personas may read it. Any response to any
// other persona that contains it is a leak. Keys and tokens are canaries nobody may read back.
const CANARIES = [];
function can(tag, allow) {
  const s = `lkq${tag}${hex(4)}`;
  CANARIES.push({ s, tag, allow: new Set(allow) });
  return s;
}
const secret = (tag, s) => (CANARIES.push({ s, tag, allow: new Set() }), s);
const digits = (tag, allow) => { const s = '7' + String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'); CANARIES.push({ s, tag, allow: new Set(allow) }); return s; };
const scanned = { n: 0 };
/** Every response goes through here: a canary the persona may not read is a leak. */
function scan(persona, label, text) {
  scanned.n++;
  if (!text) return;
  const t = String(text);
  for (const c of CANARIES) if (t.includes(c.s) && !c.allow.has(persona)) leak(`${persona} read ${c.tag} via ${label}`, (t.match(new RegExp(`.{0,60}${c.s}.{0,60}`, 's')) ?? [''])[0]);
}

// ── calls ───────────────────────────────────────────────────────────────────
let rid = 0;
async function mcpCall(key, name, args = {}, headers = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text();
  let b = null;
  try { const line = raw.split('\n').find(l => l.startsWith('data:')); b = JSON.parse(line ? line.slice(5) : raw); } catch { /* not JSON */ }
  const text = b?.result?.content?.[0]?.text ?? JSON.stringify(b?.error ?? raw);
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { status: r.status, ok: r.status === 200 && !!b?.result && !b.result.isError, text, raw, json };
}
const mustMcp = async (key, name, args) => {
  const r = await mcpCall(key, name, args);
  if (!r.ok) throw new Error(`${name}: ${r.text.slice(0, 300)}`);
  return r.json;
};
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}

// Server actions: the build's manifest gives each export its id and a page that serves it; a call is what the
// browser sends (Next-Action header, the arguments as JSON). The result row is parsed from the RSC answer.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
const ACTIONS = {};
for (const [id, v] of Object.entries(MANIFEST)) {
  const workers = Object.keys(v.workers);
  const w = v.exportedName ? v : v.workers[workers[0]]; // Next 16.4 names the export on the entry, 16.2 on each worker
  const page = workers.map(p => '/' + p.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(s => !/^\(.*\)$/.test(s)).join('/')).sort((a, b) => (/\[/.test(a) - /\[/.test(b)) || (a === '/menu' ? -1 : b === '/menu' ? 1 : a.length - b.length))[0];
  ACTIONS[`${w.filename}#${w.exportedName}`] = { id, page: page.replace(/\[[^\]]+\]/g, 'x') || '/' };
}
function rsc(text) {
  const rows = new Map();
  for (const line of text.split('\n')) { const m = line.match(/^([0-9a-f]+):(.*)$/); if (m) rows.set(m[1], m[2]); }
  let head = null;
  try { head = JSON.parse(rows.get('0') ?? 'null'); } catch { /* not a result */ }
  const a = head?.a;
  if (typeof a === 'string' && a.startsWith('$@')) {
    const row = rows.get(a.slice(2)) ?? '';
    if (row.startsWith('E')) return { error: true, value: null };
    try { return { value: JSON.parse(row) }; } catch { return { value: row }; }
  }
  return { value: a === undefined ? null : a, error: head === null };
}
async function action(name, args, { cookie = '', headers = {} } = {}) {
  const a = ACTIONS[name];
  if (!a) return { status: 0, text: 'not in the build', missing: true };
  const r = await fetch(B + a.page, { method: 'POST', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component', ...headers }, body: JSON.stringify(args) });
  const text = await r.text();
  const p = r.headers.get('content-type')?.includes('text/x-component') ? rsc(text) : { error: true, value: null };
  return { status: r.status, text, value: p.value, error: p.error, redirect: r.headers.get('x-action-redirect') ?? r.headers.get('location') };
}
/** A form post the way a browser without JavaScript sends a form action. */
async function formAction(name, pagePath, fields, cookie = '') {
  const a = ACTIONS[name];
  if (!a) return { status: 0, text: 'not in the build', missing: true };
  const fd = new FormData();
  fd.append(`$ACTION_ID_${a.id}`, '');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(B + pagePath, { method: 'POST', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), origin: B }, body: fd });
  return { status: r.status, text: await r.text(), redirect: r.headers.get('x-action-redirect') ?? r.headers.get('location') };
}
/**
 * A form post of an action with bound arguments, as a <form action={fn.bind(null, ...args)}> sends it without
 * JavaScript: `$ACTION_REF_1` names the field prefix, `$ACTION_1:0` the id and bound promise, `$ACTION_1:1` the arguments.
 * No Next-Action header. The answer is the page's HTML, so callers check the database.
 */
async function formBound(name, args, cookie = '') {
  const a = ACTIONS[name];
  if (!a) return { status: 0, text: 'not in the build', missing: true };
  const fd = new FormData();
  fd.append('$ACTION_REF_1', '');
  fd.append('$ACTION_1:0', JSON.stringify({ id: a.id, bound: '$@1' }));
  fd.append('$ACTION_1:1', JSON.stringify(args));
  const r = await fetch(B + a.page, { method: 'POST', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), origin: B }, body: fd });
  return { status: r.status, text: await r.text() };
}
async function req(method, p, { cookie = '', bearer = '', headers = {}, body } = {}) {
  const r = await fetch(B + p, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), origin: B, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = method === 'HEAD' ? '' : await r.text();
  return { status: r.status, text, location: r.headers.get('location') };
}
/** A stream (SSE): read for a moment, then close. */
async function streamPeek(p, headers, ms = 600) {
  const ac = new AbortController();
  let status = 0;
  let text = '';
  try {
    const r = await fetch(B + p, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal, redirect: 'manual' });
    status = r.status;
    if (r.ok && r.body) {
      const timer = setTimeout(() => ac.abort(), ms);
      try { for await (const c of r.body) text += Buffer.from(c).toString('utf8'); } catch { /* aborted */ }
      clearTimeout(timer);
    } else text = await r.text();
  } catch { /* refused */ }
  return { status, text };
}
function sse(p, headers) {
  const s = { events: [], status: 0, text: '' };
  const ac = new AbortController();
  s.ready = fetch(B + p, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal }).then(async r => {
    s.status = r.status;
    if (!r.ok || !r.body) return;
    try {
      for await (const c of r.body) {
        s.text += Buffer.from(c).toString('utf8');
        for (const m of s.text.matchAll(/event: ?(\w+)/g)) void m;
      }
    } catch { /* closed */ }
  }, () => {});
  s.close = () => ac.abort();
  s.hints = () => [...s.text.matchAll(/event: ?(\w+)\ndata: ?(.*)/g)].filter(m => m[1] !== 'hello').map(m => m[1] + ' ' + m[2]);
  return s;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ── stub Discord: two servers ───────────────────────────────────────────────
const G1 = '445000000000000001';
const G2 = '445000000000000002';
const BOT = '999000000000000009';
const VIEW = 1 << 10;
const HIST = 1 << 16;
const DA = '111000000000000001', DT = '111000000000000002', DX = '111000000000000003', DR = '111000000000000004', DU = '111000000000000005';
const R_A = '555000000000000001', R_BOT = '555000000000000009';
const GEN1 = '666000000000000001', SEC1 = '666000000000000002', GEN2 = '666000000000000021';
const edits = new Map(); // interaction token -> reply text
const dms = []; // { to, content }
const msgs = {}; // channel -> messages (filled after the canaries exist)
const chans = {
  [G1]: [
    { id: GEN1, type: 0, name: 'general', guild_id: G1, parent_id: null, position: 0, permission_overwrites: [] },
    { id: SEC1, type: 0, name: 'secret', guild_id: G1, parent_id: null, position: 1, permission_overwrites: [{ id: G1, type: 0, allow: '0', deny: String(VIEW) }, { id: R_A, type: 0, allow: String(VIEW), deny: '0' }, { id: R_BOT, type: 0, allow: String(VIEW), deny: '0' }] },
  ],
  [G2]: [{ id: GEN2, type: 0, name: 'general', guild_id: G2, parent_id: null, position: 0, permission_overwrites: [] }],
};
const members = { [G1]: { [DA]: [R_A], [DT]: [], [DR]: [], [DU]: [], [DX]: [], [BOT]: [R_BOT] }, [G2]: { [DX]: [], [BOT]: [R_BOT] } };
const jsonOut = (s, code, body) => { s.statusCode = code; s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(body)); };
const stub = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => (b += d));
  q.on('end', () => {
    const u = q.url.split('?')[0];
    let m;
    if (u === '/users/@me') return jsonOut(s, 200, { id: BOT, username: 'bot' });
    if (u === '/applications/@me') return jsonOut(s, 200, { flags: 1 << 19 });
    if (u === '/users/@me/channels' && q.method === 'POST') return jsonOut(s, 200, { id: 'dm-' + JSON.parse(b).recipient_id });
    if ((m = u.match(/^\/channels\/dm-(\d+)\/messages$/)) && q.method === 'POST') { dms.push({ to: m[1], content: JSON.parse(b).content }); return jsonOut(s, 200, { id: '1' }); }
    if ((m = u.match(/^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/))) { edits.set(m[1], JSON.stringify(JSON.parse(b))); return jsonOut(s, 200, {}); }
    if ((m = u.match(/^\/guilds\/(\d+)$/)) && chans[m[1]]) return jsonOut(s, 200, { id: m[1], owner_id: '1' });
    if ((m = u.match(/^\/guilds\/(\d+)\/channels$/)) && chans[m[1]]) return jsonOut(s, 200, chans[m[1]]);
    if ((m = u.match(/^\/guilds\/(\d+)\/threads\/active$/)) && chans[m[1]]) return jsonOut(s, 200, { threads: [] });
    if ((m = u.match(/^\/guilds\/(\d+)\/roles$/)) && chans[m[1]]) return jsonOut(s, 200, [{ id: m[1], name: '@everyone', permissions: String(VIEW | HIST) }, { id: R_A, name: 'owners', permissions: '0' }, { id: R_BOT, name: 'bot', permissions: '0', tags: { bot_id: BOT } }]);
    if ((m = u.match(/^\/guilds\/(\d+)\/members\/(\d+)$/))) { const r = members[m[1]]?.[m[2]]; return r ? jsonOut(s, 200, { roles: r, user: { id: m[2], username: 'u' + m[2].slice(-2) } }) : jsonOut(s, 404, { message: 'Unknown Member' }); }
    if ((m = u.match(/^\/guilds\/\d+\/commands$/)) || (m = u.match(/^\/applications\/\d+\/guilds\/\d+\/commands$/))) return jsonOut(s, 200, []);
    if ((m = u.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) { const x = (msgs[m[1]] ?? []).find(y => y.id === m[2]); return x ? jsonOut(s, 200, x) : jsonOut(s, 404, { message: 'Unknown Message' }); }
    if ((m = u.match(/^\/channels\/(\d+)\/messages$/))) return jsonOut(s, 200, msgs[m[1]] ?? []);
    if ((m = u.match(/^\/channels\/(\d+)$/))) { const c = Object.values(chans).flat().find(x => x.id === m[1]); return c ? jsonOut(s, 200, c) : jsonOut(s, 404, { message: 'Unknown Channel' }); }
    jsonOut(s, 404, { message: 'not stubbed' });
  });
}).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');
const dkey = createPrivateKey({ key: Buffer.from(process.env.E2E_DISCORD_PRIV || '', 'base64'), format: 'der', type: 'pkcs8' });
let dn = 0;
async function interact(guild, user, type, data, extra = {}) {
  const token = `lktok${++dn}${hex(3)}`;
  const body = JSON.stringify({ id: String(dn), application_id: '222222222222222222', type, token, guild_id: guild, channel_id: guild === G1 ? GEN1 : GEN2, member: { user: { id: user } }, data, ...extra });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + body), dkey).toString('hex');
  const r = await fetch(`${B}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body });
  const j = await r.text();
  // a deferred reply is written into the original response a moment later (after()): wait for it
  let reply = '';
  const t0 = Date.now();
  if (/"type":\s*[56]\b/.test(j)) for (let i = 0; i < 200 && !edits.has(token); i++) await sleep(100);
  if (process.env.LEAK_AUDIT_LIST) console.log(`(discord ${user} ${data?.name ?? data?.custom_id}: reply after ${Date.now() - t0} ms ${edits.has(token)})`);
  reply = edits.get(token) ?? '';
  return { status: r.status, text: j + '\n' + reply, body: j, reply };
}

// ── snapshots: who may write what ───────────────────────────────────────────
const SKIP_COLS = new Set(['requestStats', 'policyEvents', 'rateLimit', 'authLimits', 'mailLog', 'verification']);
const SHARED = new Set(['projects', 'tasks', 'activity', 'notes', 'claudeItems', 'trash']);
const OWNED = new Set(['reviews', 'ritualLogs', 'devices', 'workerFolders', 'workerJobs', 'workerSessions']);
const RECIP = new Set(['notifications', 'pushSubs', 'alertLog', 'alertQueue']);
let WHO = {}; // user id -> persona
let ORG = {}; // org id -> { members: [personas], admins: [personas] }
const pOf = id => WHO[String(id)] ?? `user:${id}`;
/** Personas allowed to write this document (the same rules the door applies, and Better Auth's own). */
function writers(col, d) {
  const org = ORG[String(d.orgId ?? d.organizationId ?? '')] ?? { members: [], admins: [] };
  if (SHARED.has(col)) return d.visibility === 'org' ? org.members : org.members.includes(pOf(d.ownerId)) ? [pOf(d.ownerId)] : [];
  if (OWNED.has(col)) return org.members.includes(pOf(d.ownerId)) ? [pOf(d.ownerId)] : [];
  if (RECIP.has(col)) return org.members.includes(pOf(d.userId)) ? [pOf(d.userId)] : [];
  if (col === 'counters') return org.members;
  if (col === 'settings') {
    if (d.userId) return org.members.includes(pOf(d.userId)) ? [pOf(d.userId)] : [];
    return org.admins; // discord:<org>, modes:<org>, authMigration
  }
  if (col === 'user') return [pOf(d._id)];
  if (['session', 'account', 'twoFactor', 'passkey'].includes(col)) return [pOf(d.userId)];
  if (col === 'apikey') return [pOf(d.referenceId ?? d.userId)];
  // OAuth sign-in (docs/auth.md): registration is open to anyone (an app client and its resource link, the resource row is made on demand);
  // an approval and its tokens belong to the person who gave them.
  if (['oauthClient', 'oauthClientResource', 'oauthResource'].includes(col)) return ['A', 'T', 'X', 'R', 'N'];
  if (['oauthConsent', 'oauthAccessToken', 'oauthRefreshToken'].includes(col)) return [pOf(d.userId)];
  if (col === 'member' || col === 'invitation') return org.admins;
  return [];
}
async function snapshot() {
  const out = new Map();
  for (const { name } of await rawDb.listCollections({}, { nameOnly: true }).toArray()) {
    if (SKIP_COLS.has(name) || name.startsWith('system.')) continue;
    for (const d of await rawDb.collection(name).find({}).toArray()) out.set(`${name}/${String(d._id)}`, { col: name, d, j: JSON.stringify(d) });
  }
  return out;
}
// Writes that are fine whoever makes them: a key's and a session's own bookkeeping (a session's expiry moves when any
// request of its owner refreshes it, such as X's open stream), a computer's lastSeenAt. A session's token and re-auth
// time may change only in the owner's own calls: anyone else changing them is a write.
const VOLATILE = { apikey: ['lastRequest', 'requestCount', 'remaining', 'lastRefillAt', 'updatedAt'], session: ['updatedAt', 'expiresAt'], devices: ['lastSeenAt', 'worker', 'activity', 'claudeSessions'], settings: ['lastSeen', 'mcpAt', 'discordAt', 'at'] };
const OWNER_VOLATILE = { session: ['token', 'reauthAt'] };
function same(col, a, b, persona) {
  const own = persona && pOf(a.userId) === persona && pOf(b.userId) === persona;
  const drop = [...(VOLATILE[col] ?? []), ...(own ? OWNER_VOLATILE[col] ?? [] : [])];
  const strip = d => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => !drop.includes(k))));
  return strip(a) === strip(b);
}
function diff(persona, before, after, allowed = () => false) {
  const bad = [];
  for (const [k, v] of after) {
    const old = before.get(k);
    if (old && old.j === v.j) continue;
    if (old && same(v.col, old.d, v.d, persona)) continue;
    const w = new Set([...(old ? writers(old.col, old.d) : []), ...writers(v.col, v.d)]);
    const ok = old ? writers(old.col, old.d).includes(persona) && writers(v.col, v.d).includes(persona) : writers(v.col, v.d).includes(persona);
    if (!ok && !allowed(v.col, old?.d, v.d)) bad.push(`${old ? 'changed' : 'added'} ${k} (writers ${[...w].join(',') || 'nobody'})`);
  }
  for (const [k, v] of before) if (!after.has(k) && !writers(v.col, v.d).includes(persona) && !allowed(v.col, v.d, null)) bad.push(`deleted ${k}`);
  return bad;
}

// ── normalising answers for the "exists but not yours" check ────────────────
function norm(text, real, fake) {
  let t = String(text);
  for (const [r, f] of [[real, fake]].flat().length ? zipVals(real, fake) : []) {
    for (const v of [r, f]) if (v !== undefined && v !== null && !/^\d+$/.test(String(v)) && String(v).length >= 2) t = t.split(String(v)).join('<ID>');
  }
  return t
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{24}\b/g, '<oid>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
    .replace(/"b":"[^"]+"/g, '')
    .replace(/lktok\w+/g, '<tok>')
    .replace(/\d+/g, 'N');
}
function zipVals(real, fake) {
  const r = typeof real === 'object' && real ? Object.values(real) : [real];
  const f = typeof fake === 'object' && fake ? Object.values(fake) : [fake];
  return r.map((x, i) => [x, f[i]]);
}

// ══════════════════════════════════════════════════════════════════════════════
const results = { probes: 0, aimed: 0, controls: 0 };
// Next answers notFound() with 200 and a 404 digest in the stream; any other digest is a server error in a page.
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;
// An empty digest is a client-only part (Next 16.4 bails out with ReactDOM.browser, no BAILOUT_TO_CLIENT_SIDE_RENDERING).
const PAGE_ERROR = /(E\{\\?"digest\\?":\\?"|data-dgst=")(?!NEXT_HTTP_ERROR_FALLBACK;404|NEXT_REDIRECT|BAILOUT_TO_CLIENT_SIDE_RENDERING|\\?")/;
/** What a page answered: a redirect (a header, or redirect() inside the stream), not found, an error, or a page. */
function pageState(r) {
  if (r.location) return `redirect ${r.location}`;
  const streamed = String(r.text).match(/NEXT_REDIRECT;[a-z]+;([^;"\\]+);/);
  if (streamed) return `redirect ${streamed[1]}`;
  return NOT_FOUND.test(r.text) ? 'not found' : PAGE_ERROR.test(r.text) ? 'error' : 'page';
}
/** What an access check's refusal reads like: not found, not yours, sign in, 401/403/404. */
const ACCESS = /not found|no such|not yours|not allowed|not linked|sign(%N| )in|not signed in|redirect \/login|^30[237] .*\/login\?|^40[134] /i;
/** An answer for a failure message: an action's result, else the text. */
const said = r => (r.value !== undefined && r.value !== null ? JSON.stringify(r.value) : String(r.text));
let A, T, X, R;
try {
  // ── coverage first: every entry point in the code has an audit entry ──
  const eps = entryPoints();
  // (AUDIT is defined at the bottom of this file; hoisted function)
  const audit = AUDIT();
  for (const e of eps) if (!audit[e.id]) check(`unaudited entry point: ${e.id}`, false, e.where);
  for (const id of Object.keys(audit)) if (!eps.some(e => e.id === id)) check(`audit entry for an entry point that is gone: ${id}`, false);
  check(`coverage: ${eps.length} entry points, each with an audit entry`, eps.every(e => audit[e.id]));
  const builtActions = new Set(Object.keys(ACTIONS));
  const sourceActions = new Set(eps.filter(e => e.kind === 'action').map(e => e.id.slice(7)));
  const strayBuilt = [...builtActions].filter(a => !sourceActions.has(a));
  check('actions: every action in the build is an enumerated export', strayBuilt.length === 0, strayBuilt.join(', '));
  const unlisted = unlistedBuilt(eps);
  check('routes: every route and page in the build is enumerated', unlisted !== null && unlisted.length === 0, unlisted === null ? 'no app-paths-manifest.json' : unlisted.join(', '));

  // ── people ──
  A = { name: 'A', userId: ME.userId, orgId: ME.orgId, email: EMAIL };
  const tEmail = `lkqtmail${hex(3)}@example.test`;
  const xEmail = `lkqxmail${hex(3)}@example.test`;
  const rEmail = `lkqrmail${hex(3)}@example.test`;
  T = { name: 'T', email: tEmail, ...(await makeUser({ email: tEmail, name: can('tname', ['A', 'T']), orgId: A.orgId, role: 'member' })) };
  X = { name: 'X', email: xEmail, ...(await makeUser({ email: xEmail, name: can('xname', ['X']), orgName: can('xorg', ['X']) })) };
  R = { name: 'R', email: rEmail, ...(await makeUser({ email: rEmail, name: 'Gone Member', orgId: A.orgId, role: 'member' })) };
  CANARIES.push({ s: tEmail, tag: 'temail', allow: new Set(['A', 'T']) }, { s: xEmail, tag: 'xemail', allow: new Set(['X']) });
  WHO = { [A.userId]: 'A', [T.userId]: 'T', [X.userId]: 'X', [R.userId]: 'R' };
  ORG = { [A.orgId]: { members: ['A', 'T'], admins: ['A'] }, [X.orgId]: { members: ['X'], admins: ['X'] } };
  // org1's name is a canary too
  const org1Name = can('aorg', ['A', 'T']);
  await rawDb.collection('organization').updateOne({ _id: new ObjectId(A.orgId) }, { $set: { name: org1Name } });
  for (const p of [A, T, X, R]) {
    p.chat = p === A ? MCP : await mkKey({ agent: 'claude', userId: p.userId, orgId: p.orgId, name: can(`${p.name.toLowerCase()}keyname`, [p.name]) });
    p.code = await mkKey({ agent: 'claude-code', userId: p.userId, orgId: p.orgId, name: can(`${p.name.toLowerCase()}codekey`, [p.name]) });
    secret(`${p.name} chat key`, p.chat);
    secret(`${p.name} code key`, p.code);
    const dk = 'wkr_' + randomBytes(32).toString('base64url');
    const devId = randomUUID();
    await rawDb.collection('devices').insertOne({ _id: devId, name: can(`${p.name.toLowerCase()}dev`, [p.name]), ownerId: p.userId, orgId: p.orgId, hash: sha(dk), prefix: dk.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
    p.wkr = dk;
    p.dev = devId;
    secret(`${p.name} device key`, dk);
  }
  // Each person's own week, timezone, Discord link and settings
  for (const p of [A, T, X, R]) {
    const allow = p === R ? [] : [p.name];
    const block = can(`${p.name.toLowerCase()}block`, allow);
    await setSchedule(p, { blocks: [{ start: '00:00', end: '23:59', block, modes: { mon: 'Growth', tue: 'Growth', wed: 'Growth', thu: 'Growth', fri: 'Growth' }, notes: can(`${p.name.toLowerCase()}blocknote`, allow) }], colors: {}, taskModes: {}, routine: { name: can(`${p.name.toLowerCase()}routine`, allow), start: '09:00', end: '10:00', color: '#888888', counts: 'bids', question: can(`${p.name.toLowerCase()}routineq`, allow) }, review: [{ key: 'q1', label: can(`${p.name.toLowerCase()}reviewq`, allow) }], help: [{ title: can(`${p.name.toLowerCase()}help`, allow), body: 'x' }] });
    p.discord = { A: DA, T: DT, X: DX, R: DR }[p.name];
    await setProfile(p, { timezone: 'Asia/Kolkata', quietStart: 0, quietEnd: 0, discordId: p.discord });
  }
  await setOrgGuild(A.orgId, G1);
  await setOrgGuild(X.orgId, G2);
  await rawDb.collection('settings').updateOne({ _id: `discord:${X.orgId}` }, { $set: { blockedIds: [digits('xblocked', ['X'])] } });
  await rawDb.collection('settings').updateOne({ _id: `modes:${X.orgId}` }, { $set: { area: 'modes', orgId: X.orgId, modes: [{ name: can('xmode', ['X']), description: can('xmodedesc', ['X']) }] } }, { upsert: true });

  // ── A's work: shared (S), private (P) ──
  const P = {}; const S = {}; const XO = {}; const TP = {};
  P.projectName = can('pvproj', ['A']);
  P.remote = `lkqpvremote${hex(3)}/repo`; CANARIES.push({ s: P.remote, tag: 'pvremote', allow: new Set(['A']) });
  await mustMcp(A.chat, 'add_project', { name: P.projectName, visibility: 'private', description: can('pvprojdesc', ['A']), code: [{ remote: P.remote }] });
  S.projectName = can('shproj', ['A', 'T']);
  await mustMcp(A.chat, 'add_project', { name: S.projectName, description: can('shprojdesc', ['A', 'T']) });
  const projs = await rawDb.collection('projects').find({ orgId: A.orgId }).toArray();
  P.project = projs.find(p => p.name === P.projectName)._id;
  S.project = projs.find(p => p.name === S.projectName)._id;
  CANARIES.find(c => c.s === P.projectName).alsoId = P.project;
  const mkTask = async (key, args) => (await mustMcp(key, 'add_task', args)).created.ref;
  P.taskRef = await mkTask(A.chat, { title: can('pvtask', ['A']), project: P.projectName, description: can('pvtaskdesc', ['A']), checklist: [can('pvcheck', ['A'])], links: [`https://example.test/${can('pvlink', ['A'])}`], tags: [can('pvtag', ['A'])] });
  P.looseRef = await mkTask(A.chat, { title: can('pvloose', ['A']) });
  P.trashRef = await mkTask(A.chat, { title: can('pvtrash', ['A']), project: P.projectName });
  // one trashed task per owner call that restores or purges (each control needs its own)
  for (const k of ['trashRef2', 'trashRef3', 'trashRef4']) P[k] = await mkTask(A.chat, { title: can('pvtrash', ['A']), project: P.projectName });
  P.archRef = await mkTask(A.chat, { title: can('pvarch', ['A']), project: P.projectName });
  P.giveRef = await mkTask(A.chat, { title: can('pvgive', ['A']), project: P.projectName });
  S.taskRef = await mkTask(A.chat, { title: can('shtask', ['A', 'T']), project: S.projectName, description: can('shtaskdesc', ['A', 'T']) });
  S.trashRef = await mkTask(A.chat, { title: can('shtrash', ['A', 'T']), project: S.projectName });
  await mustMcp(A.chat, 'add_comment', { task: P.taskRef, note: can('pvcomment', ['A']) });
  await mustMcp(A.chat, 'add_comment', { task: P.taskRef, note: can('pvcomment', ['A']) });
  await mustMcp(A.chat, 'add_comment', { task: S.taskRef, note: can('shcomment', ['A', 'T']) });
  P.noteId = (await mustMcp(A.chat, 'write_note', { task: P.looseRef, body: can('pvnote', ['A']) })).created?.id;
  P.projNoteTitle = can('pvmemo', ['A']);
  P.projNote = (await mustMcp(A.chat, 'write_note', { project: P.projectName, title: P.projNoteTitle, body: can('pvmemobody', ['A']) })).created?.id;
  P.subNote = (await mustMcp(A.chat, 'write_note', { parent_id: P.projNote, title: can('pvsub', ['A']), body: can('pvsubbody', ['A']) })).created?.id;
  P.subNote2 = (await mustMcp(A.chat, 'write_note', { parent_id: P.projNote, title: (P_SUB2_TITLE.v = can('pvsub', ['A'])), body: can('pvsubbody', ['A']) })).created?.id;
  // the dispatcher's rules note (MCP may not change it, so it is not the note the other probes write)
  P.boiler = (await mustMcp(A.chat, 'write_note', { project: P.projectName, title: can('pvboiler', ['A']), body: can('pvboilerbody', ['A']) })).created?.id;
  S.noteTitle = can('shmemo', ['A', 'T']);
  S.note = (await mustMcp(A.chat, 'write_note', { project: S.projectName, title: S.noteTitle, body: can('shmemobody', ['A', 'T']) })).created?.id;
  const why = 'Fixture for the leak audit on the throwaway app; nothing real happens with this item at all.';
  await mustMcp(A.chat, 'update_claude_items', { ops: [{ op: 'add', project: P.projectName, kind: 'feature', title: can('pvitem', ['A']) + ' item for the audit', why: can('pvitemwhy', ['A']) + ' ' + why, done_when: can('pvitemdone', ['A']), waiting_on_om: can('pvitemwait', ['A']) }] });
  await mustMcp(A.chat, 'update_claude_items', { ops: [{ op: 'add', project: S.projectName, kind: 'feature', title: can('shitem', ['A', 'T']) + ' item for the audit', why: can('shitemwhy', ['A', 'T']) + ' ' + why, done_when: 'The audit passes for this one.' }] });
  for (const k of ['trashRef', 'trashRef2', 'trashRef3', 'trashRef4']) await mustMcp(A.chat, 'delete_task', { task: P[k], title: 'lkqpvtrash' });
  await mustMcp(A.chat, 'delete_task', { task: S.trashRef, title: CANARIES.find(c => c.tag === 'shtrash').s });
  await mustMcp(A.chat, 'apply_changes', { ops: [{ op: 'archive_task', task: P.archRef }] });
  const tdoc = ref => rawDb.collection('tasks').findOne({ orgId: A.orgId, ref });
  P.task = (await tdoc(P.taskRef))._id; P.loose = (await tdoc(P.looseRef))._id; S.task = (await tdoc(S.taskRef))._id;
  [P.comment, P.comment2] = (await rawDb.collection('activity').find({ taskId: P.task, type: 'comment' }).toArray()).map(d => d._id);
  S.comment = (await rawDb.collection('activity').findOne({ taskId: S.task, type: 'comment' }))._id;
  P.item = (await rawDb.collection('claudeItems').findOne({ orgId: A.orgId, projectId: P.project }));
  S.item = (await rawDb.collection('claudeItems').findOne({ orgId: A.orgId, projectId: S.project, small: { $ne: true } }));
  P.itemRef = `C${P.item.ref}`; S.itemRef = `C${S.item.ref}`;

  // T's private task (A must not read it either), X's organization, R's private task. X's numbers start far above the
  // first organization's (numbers are per organization: X's own #5 is not the first organization's #5).
  for (const k of ['task', 'claudeItems']) await rawDb.collection('counters').updateOne({ _id: `${k}:${X.orgId}` }, { $set: { seq: 50000, orgId: X.orgId } }, { upsert: true });
  TP.ref = await mkTask(T.chat, { title: can('tptask', ['T']) });
  XO.projectName = can('xproj', ['X']);
  X.ownProject = XO.projectName;
  await mustMcp(X.chat, 'add_project', { name: XO.projectName });
  XO.taskRef = await mkTask(X.chat, { title: can('xtask', ['X']), project: XO.projectName });
  XO.note = (await mustMcp(X.chat, 'write_note', { project: XO.projectName, title: can('xmemo', ['X']), body: can('xmemobody', ['X']) })).created?.id;
  await mustMcp(X.chat, 'add_comment', { task: XO.taskRef, note: can('xcomment', ['X']) });
  await mustMcp(X.chat, 'update_claude_items', { ops: [{ op: 'add', project: XO.projectName, kind: 'feature', title: can('xitem', ['X']) + ' item for the audit', why, done_when: 'The audit passes for this one.' }] });
  await mkTask(R.chat, { title: can('rptask', []) });

  // Personal documents of A (and one of X): inbox, push devices, alerts, reviews, routine logs, computers' folders,
  // sessions and jobs, a passkey, the dispatcher's note.
  const now = new Date();
  for (const p of [A, X]) {
    const al = [p.name];
    await rawDb.collection('notifications').insertOne({ _id: randomUUID(), orgId: p.orgId, userId: p.userId, kind: 'test', title: can(`${p.name.toLowerCase()}inbox`, al), body: can(`${p.name.toLowerCase()}inboxbody`, al), url: '/notifications', createdAt: now, readAt: null });
    p.push = `https://push.example.test/${can(`${p.name.toLowerCase()}push`, al)}`;
    await rawDb.collection('pushSubs').insertOne({ _id: p.push, orgId: p.orgId, userId: p.userId, keys: { p256dh: secret('push key', 'lkqpushkey' + hex(6)), auth: 'x' }, device: can(`${p.name.toLowerCase()}pushdev`, al), createdAt: now, updatedAt: now });
    await rawDb.collection('alertQueue').insertOne({ _id: `unblocked:${randomUUID()}`, orgId: p.orgId, userId: p.userId, kind: 'unblocked', taskId: 'none', byTaskId: 'none', createdAt: now, sentAt: now, detail: can(`${p.name.toLowerCase()}queue`, al) });
    await rawDb.collection('alertLog').insertOne({ _id: `overdue:${can(`${p.name.toLowerCase()}alertlog`, al)}:2026-01-01`, orgId: p.orgId, userId: p.userId, kind: 'overdue', sentAt: now });
    p.review = randomUUID();
    await rawDb.collection('reviews').insertOne({ _id: p.review, orgId: p.orgId, ownerId: p.userId, weekOf: '2026-01-05', answers: { q1: can(`${p.name.toLowerCase()}review`, al) } });
    await rawDb.collection('ritualLogs').insertOne({ _id: randomUUID(), orgId: p.orgId, ownerId: p.userId, date: '2026-01-05', count: 3, notes: can(`${p.name.toLowerCase()}ritual`, al) });
    p.folder = `${p.dev}:lkqf0001`;
    await rawDb.collection('workerFolders').insertOne({ _id: p.folder, deviceId: p.dev, folderId: 'lkqf0001', name: can(`${p.name.toLowerCase()}folder`, al), path: `C:/${can(`${p.name.toLowerCase()}path`, al)}`, git: true, remote: `${can(`${p.name.toLowerCase()}fremote`, al)}/x`, projectId: p === A ? P.project : null, linkedAt: now, seenAt: now, missing: false, orgId: p.orgId, ownerId: p.userId });
    p.session = randomUUID();
    await rawDb.collection('workerSessions').insertOne({ _id: p.session, orgId: p.orgId, ownerId: p.userId, deviceId: p.dev, folderId: 'lkqf0001', projectId: p === A ? P.project : 'none', state: 'running', startedAt: now, updatedAt: now });
    p.job = `j_${randomUUID()}`;
    await rawDb.collection('workerJobs').insertOne({ _id: p.job, orgId: p.orgId, ownerId: p.userId, deviceId: p.dev, kind: 'start', sessionId: p.session, folderId: 'lkqf0001', projectId: 'none', prompt: can(`${p.name.toLowerCase()}prompt`, al), createdAt: now, takenAt: null, doneAt: null });
  }
  const memberDoc = await rawDb.collection('member').findOne({ organizationId: { $in: [A.orgId, new ObjectId(A.orgId)] } });
  const uid = id => (memberDoc.userId instanceof ObjectId ? new ObjectId(id) : id);
  A.passkey = new ObjectId();
  // An app the owner approved (OAuth, docs/auth.md): the others' Revoke must not reach it.
  A.oauthClientId = 'lkqoauthclient' + hex(6);
  await rawDb.collection('oauthClient').insertOne({ clientId: A.oauthClientId, name: can('aoauthapp', ['A']), redirectUris: ['https://claude.ai/api/mcp/auth_callback'], disabled: false, scopes: ['workos', 'offline_access'], grantTypes: ['authorization_code', 'refresh_token'], tokenEndpointAuthMethod: 'none', createdAt: now, updatedAt: now });
  await rawDb.collection('oauthConsent').insertOne({ clientId: A.oauthClientId, userId: A.userId, referenceId: A.orgId, scopes: ['workos'], resources: [], createdAt: now, updatedAt: now });
  await rawDb.collection('passkey').insertOne({ _id: A.passkey, name: can('apasskey', ['A']), publicKey: 'x', userId: uid(A.userId), credentialID: 'lkqcred' + hex(6), counter: 0, deviceType: 'singleDevice', backedUp: false, transports: 'internal', createdAt: now });
  await rawDb.collection('settings').updateOne({ _id: `dispatcher:${A.userId}` }, { $set: { area: 'dispatcher', orgId: A.orgId, userId: A.userId, enabled: false, maxConcurrent: 1, boilerplateNoteId: P.boiler } }, { upsert: true });

  // Discord messages: the first organization's #general (A and T), its #secret (A only), the second's (X)
  const mid = n => '8880000000000000' + String(n).padStart(2, '0');
  msgs[GEN1] = [{ id: mid(1), channel_id: GEN1, content: can('dgen1', ['A', 'T']), author: { id: DU, username: 'u' }, timestamp: now.toISOString(), mentions: [], mention_roles: [], mention_everyone: false, embeds: [], attachments: [], type: 0 }];
  msgs[SEC1] = [{ id: mid(2), channel_id: SEC1, content: can('dsec1', ['A']), author: { id: DU, username: 'u' }, timestamp: now.toISOString(), mentions: [], mention_roles: [], mention_everyone: false, embeds: [], attachments: [], type: 0 }];
  msgs[GEN2] = [{ id: mid(3), channel_id: GEN2, content: can('dgen2', ['X']), author: { id: DU, username: 'u' }, timestamp: now.toISOString(), mentions: [], mention_roles: [], mention_everyone: false, embeds: [], attachments: [], type: 0 }];

  // Invitations: one pending in each organization (made through the app, as an owner does)
  for (const p of [A, X]) p.cookie = await signIn(p.email);
  T.cookie = await signIn(T.email);
  R.cookie = await signIn(R.email);
  for (const p of [A, X]) {
    const inv = await action('app/(app)/settings/members-actions.ts#inviteMemberAction', [can(`${p.name.toLowerCase()}invite`, [p.name]) + '@example.test', 'member'], { cookie: p.cookie });
    const link = inv.value?.data?.link;
    if (!link) throw new Error(`invite as ${p.name}: ${inv.text.slice(0, 300)}`);
    p.invite = link.match(/accept-invitation\/([^?]+)/)[1];
    p.inviteToken = secret(`${p.name} invitation token`, new URL(link).searchParams.get('t'));
  }
  {
    const inv = await action('app/(app)/settings/members-actions.ts#inviteMemberAction', [can('ainvite', ['A']) + '@example.test', 'member'], { cookie: A.cookie });
    A.invite2 = inv.value.data.link.match(/accept-invitation\/([^?]+)/)[1];
    secret('A invitation token', new URL(inv.value.data.link).searchParams.get('t'));
  }
  // Session tokens are secrets nobody may read back
  // (each person's own session token comes back to them from get-session and list-sessions, by Better Auth's design)
  for (const p of [A, T, X, R]) CANARIES.push({ s: decodeURIComponent((p.cookie.match(/session_token=([^;]+)/) ?? [])[1] ?? '').split('.')[0] || 'none-none-none', tag: `${p.name} session token`, allow: new Set([p.name]) });
  A.sessionToken = decodeURIComponent((A.cookie.match(/session_token=([^;]+)/) ?? [])[1] ?? '').split('.')[0];

  // R: removed the way an owner removes someone (Settings › Members, which also clears the role caches), then what the
  // removal took away is put back, as if it had failed half-way: the cookie's session, both keys and the computer. Only
  // the missing membership stands between R and the first organization (the worst case of a removal).
  const rUid = { $in: [R.userId, uid(R.userId)] };
  const left = { session: await rawDb.collection('session').find({ userId: rUid }).toArray(), apikey: await rawDb.collection('apikey').find({ referenceId: rUid }).toArray() };
  const rm = await action('app/(app)/settings/members-actions.ts#removeMemberAction', [R.userId], { cookie: A.cookie });
  if (!rm.value?.ok) throw new Error(`remove R: ${rm.text.slice(0, 300)}`);
  if (await rawDb.collection('member').countDocuments({ userId: rUid })) throw new Error('remove R: the membership is still there');
  for (const [col, docs] of Object.entries(left)) for (const d of docs) await rawDb.collection(col).replaceOne({ _id: d._id }, d, { upsert: true });
  await rawDb.collection('devices').updateOne({ _id: R.dev }, { $set: { revokedAt: null } });
  check('setup: personas, canaries and documents in place', true, `${CANARIES.length} canaries in ${((Date.now() - T0) / 1000).toFixed(1)} s`);

  // Targets: what each attacker aims at, and a made-up twin of the same shape (for the existence check)
  const fakeUuid = () => randomUUID();
  // Always with a letter: an all-digit made-up id (short note ids, about 4% of runs) would be normalised as a number, not an id.
  const mutate = s => String(s).slice(0, -6) + 'f' + hex(3).slice(1);
  const TARGET = {
    // T aims at A's private things
    T: { task: P.task, ref: P.taskRef, looseRef: P.looseRef, trashRef: P.trashRef, archRef: P.archRef, project: P.project, projectName: P.projectName, note: P.projNote, noteTitle: P.projNoteTitle, taskNote: P.noteId, sub: P.subNote, comment: P.comment, item: P.itemRef, itemProject: P.project, device: A.dev, folder: A.folder, session: A.session, job: A.job, review: A.review, push: A.push, passkey: String(A.passkey), invite: A.invite, member: A.userId, remote: P.remote },
    // X and R aim at the first organization's shared work (and A's things that only A may touch)
    X: { task: S.task, ref: S.taskRef, looseRef: P.looseRef, trashRef: S.trashRef, archRef: P.archRef, project: S.project, projectName: S.projectName, note: S.note, noteTitle: S.noteTitle, taskNote: P.noteId, sub: P.subNote, comment: S.comment, item: S.itemRef, itemProject: S.project, device: A.dev, folder: A.folder, session: A.session, job: A.job, review: A.review, push: A.push, passkey: String(A.passkey), invite: A.invite, member: A.userId, remote: P.remote },
  };
  TARGET.R = TARGET.X;
  const FAKE = { task: fakeUuid(), ref: 90000 + Math.floor(Math.random() * 9000), looseRef: 91000, trashRef: 92000, archRef: 93000, project: mutate(P.project), projectName: `lkqnoproj${hex(4)}`, note: mutate(P.projNote), noteTitle: 'lkqnonote', taskNote: mutate(P.noteId), sub: mutate(P.subNote), comment: fakeUuid(), item: 'C9999', itemProject: mutate(P.project), device: fakeUuid(), folder: `${fakeUuid()}:f1`, session: fakeUuid(), job: `j_${fakeUuid()}`, review: fakeUuid(), push: `https://push.example.test/lkqnopush${hex(4)}`, passkey: oid(), invite: oid(), member: oid(), remote: `lkqnoremote${hex(3)}/repo` };
  // A second target for owner calls that destroy one (each control needs its own; the attackers aim at the same one)
  Object.assign(TARGET.T, { trashRef2: P.trashRef, trashRef3: P.trashRef, trashRef4: P.trashRef, comment2: P.comment, sub2: P.subNote, invite2: A.invite, boiler: P.projNote, give: P.giveRef });
  Object.assign(TARGET.X, { trashRef2: S.trashRef, trashRef3: S.trashRef, trashRef4: S.trashRef, comment2: S.comment, sub2: P.subNote, invite2: A.invite, boiler: S.note, give: S.taskRef });
  Object.assign(FAKE, { trashRef2: 92001, trashRef3: 92002, trashRef4: 92003, comment2: fakeUuid(), sub2: mutate(P.subNote2), invite2: oid(), boiler: mutate(P.boiler), give: 94000 });
  // A's own (the control calls)
  FAKE_REF.v = FAKE;
  const OWN = { task: P.task, ref: P.taskRef, looseRef: P.looseRef, trashRef: P.trashRef, archRef: P.archRef, project: P.project, projectName: P.projectName, note: P.projNote, noteTitle: P.projNoteTitle, taskNote: P.noteId, sub: P.subNote, comment: P.comment, item: P.itemRef, itemProject: P.project, device: A.dev, folder: A.folder, session: A.session, job: A.job, review: A.review, push: A.push, passkey: String(A.passkey), invite: A.invite, member: R.userId, remote: P.remote, trashRef2: P.trashRef2, trashRef3: P.trashRef3, trashRef4: P.trashRef4, comment2: P.comment2, sub2: P.subNote2, invite2: A.invite2, boiler: P.boiler, give: P.giveRef };

  // ── the probes ──
  const ctx = { A, T, X, R, P, S, XO, TP, G1, G2, GEN1, SEC1, GEN2, DA, DT, DX, DR, DU, mid };
  const probes = [];
  for (const [id, spec] of Object.entries(audit)) {
    if (spec.skip) { console.log(`(audited without a call: ${id} - ${spec.skip})`); continue; }
    for (const pr of [].concat(spec.probes ?? [])) probes.push({ id, ...pr });
  }
  // A persona's credentials for a probe of kind k
  const ECHO_IDS = ['project', 'itemProject', 'task', 'note', 'taskNote', 'sub', 'comment', 'device', 'folder', 'session', 'job', 'review', 'push', 'passkey', 'invite', 'member', 'comment2', 'sub2', 'invite2', 'boiler'];
  const credOf = (p, k) => (k === 'mcp' ? p.chat : k === 'mcp-code' ? p.code : k === 'worker' ? p.wkr : p.cookie);
  /** Run one probe as persona `who` aimed at `o` (target or fake). */
  async function runProbe(pr, who, o) {
    const p = { A, T, X, R, N: { name: 'N', chat: '', code: '', wkr: '', cookie: '' } }[who];
    const res = await pr.call({ p, o, ctx, cred: credOf(p, pr.kind) });
    // An id the caller sent may come back (a sign-in redirect's next=, an echo); a project id starts with its name's
    // slug, so it holds the name's canary. Ids are taken out; names, titles and remotes are not.
    let text = String(res.text ?? '');
    for (const k of ECHO_IDS) if (o[k]) text = text.split(String(o[k])).join('<id>');
    for (const v of [...(pr.echo?.() ?? []), ...(pr.aimKeys ?? []).map(k => o[k]).filter(v => typeof v === 'string' && v.length > 3)]) text = text.split(v).join('<sent>');
    // Making or moving a task into a project by a name it cannot see makes the caller a project of that name (by design:
    // real and made-up names behave alike). That project is the caller's own; its name and id are taken out too. It
    // exists before any answer that shows it, so reading the caller's projects now is enough.
    if (p.userId && /lkq/.test(text)) {
      const own = await rawDb.collection('projects').find({ ownerId: p.userId }, { projection: { name: 1 } }).toArray();
      for (const v of own.flatMap(d => [String(d._id), String(d.name)]).sort((x, y) => y.length - x.length)) text = text.split(v).join('<own>');
    }
    scan(who, pr.id + (pr.label ? ` (${pr.label})` : ''), text);
    return res;
  }

  const outcome = { refusedWrong: [], existence: [], controls: [] };
  const refusals = []; // every aimed call that was refused: { kind, tag, said }
  const tag = (who, pr) => `${who} ${pr.id}${pr.label ? ` (${pr.label})` : ''}`;
  // What an answer says, for the "exists but not yours" comparison: a page is found, not found, an error or a redirect;
  // an action is its result (not the page it re-renders); anything else is its text. Ids the probe sent are taken out.
  function shape(pr, res, tgt) {
    const keysOf = pr.aimKeys ?? [];
    const n = t => norm(t, Object.fromEntries(keysOf.map(k => [k, tgt[k]])), Object.fromEntries(keysOf.map(k => [k, FAKE[k]])));
    if (pr.shape) return pr.shape(res);
    if (pr.kind === 'page') return `${res.status} ${n(pageState(res))}`;
    if (pr.kind === 'action' && !res.missing && res.value !== undefined) return `${res.status} ${res.error ? 'error' : ''} ${res.redirect ? n(res.redirect) : ''} ${n(JSON.stringify(res.value))}`;
    return `${res.status} ${n(res.redirect ?? res.location ?? '')} ${n(res.text)}`;
  }
  // Making or moving something into a project by a name the caller cannot see makes the caller a project of that name
  // (by design, and alike for a real and a made-up name). Those projects, and what went into them, are removed after
  // each call so the next probe does not find the caller's own project under the target's name or id.
  async function dropMadeUp(p) {
    if (!p.userId) return;
    const names = [...new Set([...Object.values(TARGET[p.name] ?? {}), ...Object.values(FAKE)].filter(v => typeof v === 'string'))];
    const ids = (await rawDb.collection('projects').find({ ownerId: p.userId, name: { $in: names } }, { projection: { _id: 1 } }).toArray()).map(d => d._id);
    if (!ids.length) return;
    for (const c of ['tasks', 'notes', 'claudeItems', 'activity']) await rawDb.collection(c).deleteMany({ projectId: { $in: ids }, ownerId: p.userId });
    await rawDb.collection('projects').deleteMany({ _id: { $in: ids } });
  }
  async function attack(who, pr) {
    results.probes++;
    const p = { A, T, X, R, N: {} }[who];
    const tgt = TARGET[who] ?? TARGET.X;
    const real = await runProbe(pr, who, tgt);
    const refused = !pr.ok(real, who);
    if (pr.aim) {
      results.aimed++;
      if (!refused && !pr.mayWork?.(who)) outcome.refusedWrong.push(`${tag(who, pr)}: ${said(real).slice(0, 300)}`);
      await dropMadeUp(p);
      const fake = await runProbe(pr, who, FAKE);
      const a = shape(pr, real, tgt);
      const b = shape(pr, fake, tgt);
      const thrown = !!pr.throws && (who === 'R' || who === 'N');
      if (refused) refusals.push({ kind: pr.kind, tag: tag(who, pr), said: a, thrown });
      // With no owner control to prove the probe reaches the check, its refusal must read as the access check itself
      // (a validation error would refuse it too and prove nothing), or the probe's own `refusal`.
      const reads = t => ACCESS.test(t) || !!pr.refusal?.test(t);
      if (refused && pr.control === false && !pr.mayWork?.(who) && !thrown && !reads(a) && !reads(`${real.status} ${said(real)}`)) {
        outcome.refusedWrong.push(`${tag(who, pr)}: refused, but not by the access check: ${a.slice(0, 200)}`);
      }
      if (a !== b && !pr.existenceOk) outcome.existence.push(`${tag(who, pr)}: real ${a.slice(0, 200)} | made-up ${b.slice(0, 200)}`);
    } else if ((who === 'R' || who === 'N') && !refused && !pr.public && !(who === 'R' && pr.ownAccount)) outcome.refusedWrong.push(`${tag(who, pr)} answered: ${String(real.text).slice(0, 200)}`);
    await dropMadeUp(p);
  }
  async function phase(who, list) {
    const before = await snapshot();
    // pages only read: they run side by side; everything else one at a time (a write must not meet another probe's)
    await pool(list.filter(pr => pr.kind === 'page'), 6, pr => attack(who, pr));
    for (const pr of list.filter(pr => pr.kind !== 'page')) await attack(who, pr);
    for (const b of diff(who, before, await snapshot())) leak(`${who} wrote ${b}`);
  }

  // Streams open during the attacks and the owner's phase: X and T must hear nothing of A's private writes
  const sX = sse('/api/stream', { cookie: X.cookie });
  const xOwn = []; // the hints X's stream got while X's own probes ran
  const wT = sse('/api/worker/stream', { authorization: `Bearer ${T.wkr}` });
  const wX = sse('/api/worker/stream', { authorization: `Bearer ${X.wkr}` });

  // The MCP tools the server lists for the owner are exactly the enumerated ones (a tool registered some other way
  // would have no audit entry).
  {
    const r = await req('POST', '/api/mcp', { bearer: A.chat, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    let listed = null;
    try { const line = r.text.split('\n').find(l => l.startsWith('data:')); listed = JSON.parse(line ? line.slice(5) : r.text).result.tools.map(t => t.name); } catch { /* not a list */ }
    const enumerated = new Set(eps.filter(e => e.kind === 'mcp').map(e => e.id.slice(4)));
    const extra = (listed ?? []).filter(n => !enumerated.has(n));
    const gone = [...enumerated].filter(n => listed && !listed.includes(n));
    check(`mcp: tools/list as the owner names exactly the ${enumerated.size} enumerated tools`, !!listed && !extra.length && !gone.length, listed ? `not enumerated: ${extra.join(', ') || '-'}; not listed: ${gone.join(', ') || '-'}` : `${r.status} ${r.text.slice(0, 200)}`);
  }
  const aimedOrScan = probes.filter(pr => !pr.ownerOnly);
  for (const who of ['T', 'X', 'R', 'N']) {
    const t = Date.now();
    const from = sX.hints().length;
    await phase(who, aimedOrScan.filter(pr => !pr.only || pr.only.includes(who)));
    if (who === 'X') xOwn.push([from, sX.hints().length]);
    console.log(`(phase ${who}: ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
  // Misuse: each kind of credential where it does not belong
  {
    const t = Date.now();
    const before = await snapshot();
    for (const m of MISUSE({ A, T, X, R })) {
      const r = await m.call();
      scan('N', `misuse ${m.label}`, r.text);
      check(`key kinds: ${m.label} is refused`, m.refused(r), `${r.status} ${String(r.text).slice(0, 160)}`);
    }
    for (const b of diff('N', before, await snapshot())) leak(`misuse wrote ${b}`);
    console.log(`(misuse: ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }

  // The owner: every probe that should work for them (control), aimed at their own things; destructive ones last
  {
    const t = Date.now();
    const before = await snapshot();
    const ctl = probes.filter(pr => pr.control !== false);
    const control = async pr => {
      results.controls++;
      const res = await runProbe(pr, 'A', OWN);
      // An action the client never imports is not in the build: nobody can call it (the coverage check above lists it).
      if (res.missing) { notBuilt.add(pr.id); return; }
      // A page error shows from its digest on (the HTML before it is only the head).
      const errAt = String(res.text).search(PAGE_ERROR);
      if (!(pr.controlOk ?? pr.ok)(res, 'A')) outcome.controls.push(`${pr.id}${pr.label ? ` (${pr.label})` : ''}: ${res.status} ${(errAt >= 0 ? String(res.text).slice(errAt) : said(res)).slice(0, 300)}`);
    };
    const notBuilt = new Set();
    for (const stage of [0, 1, 2]) {
      const here = ctl.filter(pr => (pr.stage ?? 0) === stage);
      await pool(here.filter(pr => pr.kind === 'page'), 6, control);
      for (const pr of here.filter(pr => pr.kind !== 'page')) await control(pr);
    }
    if (notBuilt.size) console.log(`(not in the build, so not callable: ${[...notBuilt].join(', ')})`);
    for (const b of diff('A', before, await snapshot())) leak(`A wrote ${b}`);
    console.log(`(owner: ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
  await sleep(500);
  for (const s of [sX, wT, wX]) s.close();
  // (X's own probes make hints marked as X's own, s:1; anything else came from someone else's write)
  const heard = sX.hints().filter((h, i) => !xOwn.some(([a, b]) => i >= a && i < b));
  check('push: X\'s page stream heard nothing while the first organization worked', sX.status === 200 && heard.length === 0, `${sX.status} ${heard.join(' | ')}`);
  check('push: T\'s and X\'s computers got no job of A\'s', wT.status === 200 && wX.status === 200 && !/event: ?jobs/.test(wT.text + wX.text), `${wT.status} ${wX.status} ${(wT.text + wX.text).slice(0, 200)}`);
  scan('T', 'worker stream', wT.text); scan('X', 'worker stream', wX.text + sX.text);
  // Alert DMs: each went to its recipient's own account
  for (const d of dms) scan({ [DA]: 'A', [DT]: 'T', [DX]: 'X', [DR]: 'R' }[d.to] ?? 'N', `Discord DM to ${d.to}`, d.content);

  // The refusals are the app's access checks, not broken probes: no aimed call ended in a server error, and each kind
  // of entry point has refusals that read as one ("not found", a sign-in redirect, 401/403/404).
  if (process.env.LEAK_AUDIT_LIST) for (const r of refusals) console.log(`(refused) ${r.tag}: ${r.said.slice(0, 160)}`);
  // (an action with no result type refuses someone signed out by throwing, which Next answers with 500)
  const crashed = refusals.filter(r => !r.thrown).filter(r => /^5\d\d /.test(r.said) || /Internal error|Something went wrong| error$/.test(r.said));
  check('refusals: none is a server error', crashed.length === 0, crashed.map(r => `${r.tag}: ${r.said.slice(0, 120)}`).join(' | '));
  for (const kind of [...new Set(refusals.map(r => r.kind))].sort()) {
    const mine = refusals.filter(r => r.kind === kind);
    const real = mine.filter(r => ACCESS.test(r.said));
    check(`refusals: ${kind} — ${real.length} of ${mine.length} refusals read as an access check`, real.length > 0, mine.slice(0, 3).map(r => `${r.tag}: ${r.said.slice(0, 100)}`).join(' | '));
  }

  for (const x of outcome.refusedWrong) check(`refused: ${x}`, false);
  for (const x of outcome.existence) check(`existence: ${x}`, false);
  for (const x of outcome.controls) check(`control (the owner): ${x}`, false);
  check(`refusals: every aimed call was refused (${results.aimed} aimed, ${results.probes} calls in all)`, outcome.refusedWrong.length === 0);
  check('existence: "not yours" answered like "does not exist" everywhere', outcome.existence.length === 0);
  check(`controls: the owner's ${results.controls} calls work`, outcome.controls.length === 0);
  check(`leaks: no canary read by a persona who may not read it (${scanned.n} answers scanned, ${CANARIES.length} canaries)`, leaks.filter(l => / read /.test(l)).length === 0);
  check('writes: no document changed by a persona who may not write it', leaks.filter(l => / wrote /.test(l)).length === 0);
} catch (e) {
  check('leak-audit (error)', false, e?.stack || String(e));
}
stub.close();
console.log(`(leak audit: ${((Date.now() - T0) / 1000).toFixed(1)} s)`);
await finish();

// ══════════════════════════════════════════════════════════════════════════════
// The audit table: one entry per entry point (entry-points.mjs ids). Each entry has probes, or `skip` with the reason
// it needs no call. A probe:
//   kind     'mcp' | 'mcp-code' | 'action' | 'page' | 'route' | 'worker' | 'auth' | 'discord' (which credential it uses)
//   call     ({p, o, ctx, cred}) => {status, text}: p the persona, o its target (or the made-up twin, or A's own)
//   ok       (res, who) => did it work?  (aimed probes must not; controls must)
//   aim      true: aimed at someone else's document (refusal and the existence check apply), with aimKeys the target
//            fields it uses (taken out before comparing the two answers)
//   public   works for anyone by design (no refusal expected from R or N)
//   control  false: no owner control call (with the reason in a comment); controlOk: the owner's success test
//   stage    1/2: owner calls that destroy or change who is who run after the rest, one at a time
//   only     the personas that make this call (a call that would break the persona's later probes, such as signing out)
//   mayWork  (who) => true when it may work for that persona (their own server, their own organization)
//   ownAccount  works for R too: R still has an account, only the membership is gone
//   existenceOk  the reason a "not yours" vs "does not exist" difference is accepted (docs/multi-user.md "Leak audit")
//   echo     () => strings the call sends that may come back (taken out before the canary scan)
//   shape    (res) => what the existence check compares, when the whole answer is not the point
//   refusal  aimed with control false: its refusal must read as ACCESS or match this regex (the entry point's own
//            wording of its access check)
//   throws   an action with no result type: refusing someone signed out is a thrown error (500), not a crash
// Non-page calls run one at a time; pages side by side.
// ══════════════════════════════════════════════════════════════════════════════
function AUDIT() {
  // Refusals that are the access check of their entry point, worded its own way (see `refusal` above):
  const KEY_GONE = /already revoked or does not exist/; // a key id not among the caller's own keys, as for a made-up id
  const NOT_THEIRS_MEMBER = /Only an owner or admin can do that|not a member of this organization/; // role, then membership
  const BAD_LINK = /invitation(%N| )link(%N| )is(%N| )invalid/; // the invitation secret is the access check
  const mcpOk = r => r.ok;
  const actOk = r => r.status === 200 && !r.error && r.value != null && r.value.ok !== false && !r.value.error;
  const pageOk = r => r.status === 200 && pageState(r) === 'page';
  const two = s => s >= 200 && s < 300;
  const M = (tool, args, o = {}) => ({ kind: 'mcp', ok: mcpOk, call: ({ cred, o: t, ctx }) => mcpCall(cred, tool, typeof args === 'function' ? args(t, ctx) : args), ...o });
  const Mc = (tool, args, o = {}) => ({ ...M(tool, args, o), kind: 'mcp-code' });
  const aim = (keys, o = {}) => ({ aim: true, aimKeys: keys, ...o });
  const act = (name, args, o = {}) => ({ kind: 'action', ok: actOk, call: ({ p, o: t, ctx }) => action(name, typeof args === 'function' ? args(t, ctx, p) : args, { cookie: p.cookie }), ...o });
  const page = (url, o = {}) => ({ kind: 'page', ok: pageOk, call: async ({ p, o: t, ctx }) => req('GET', typeof url === 'function' ? url(t, ctx) : url, { cookie: p.cookie }), ...o });
  const route = (method, url, o = {}) => ({ kind: 'route', ok: r => two(r.status), call: async ({ p, o: t, ctx }) => req(method, typeof url === 'function' ? url(t, ctx) : url, { cookie: p.cookie, ...(o.useKey ? { bearer: p.chat } : {}), body: typeof o.body === 'function' ? o.body(t, ctx) : o.body }), ...o });
  const worker = (method, url, body, o = {}) => ({ kind: 'worker', ok: r => two(r.status), call: async ({ p, o: t, ctx }) => req(method, url, { bearer: p.wkr, body: typeof body === 'function' ? body(t, ctx) : body }), ...o });
  const authEp = (method, sub, body, o = {}) => ({ kind: 'auth', ok: r => two(r.status), call: async ({ p, o: t, ctx }) => req(method, '/api/auth' + (typeof sub === 'function' ? sub(t, ctx) : sub), { cookie: p.cookie, body: typeof body === 'function' ? body(t, ctx, p) : body }), ...o });
  const linkedDiscord = p => ({ A: DA, T: DT, X: DX, R: DR, N: DU })[p.name];
  const guildOf = p => (p.name === 'X' ? G2 : G1);
  const disc = (type, data, o = {}) => ({ kind: 'discord', ok: r => !/not linked|Not available|not found|Unknown|cannot|can't|Invalid|refused|Something went wrong|\"choices\":\[\]/i.test(r.text), call: async ({ p, o: t, ctx }) => interact(guildOf(p), linkedDiscord(p), type, typeof data === 'function' ? data(t, ctx, p) : data, o.extra ? o.extra(t, ctx, p) : {}), ...o });

  const items = {};
  const add = (id, ...probes) => (items[id] = { probes });
  const skip = (id, why) => (items[id] = { skip: why }); // an entry point that needs no call, with the reason (none today)
  void skip;

  // ── MCP tools (chat key; the read tools again with a Claude Code key) ──
  add('mcp list_tasks', M('list_tasks', { include_closed: true }), Mc('list_tasks', { include_closed: true, archived: true }, { label: 'code key, archived' }), M('list_tasks', t => ({ project: t.projectName, include_closed: true }), aim(['projectName'], { label: 'by project', ok: r => r.ok && r.json?.total > 0 })), M('list_tasks', { query: 'lkq', include_closed: true }, { label: 'search' }));
  add('mcp get_task', M('get_task', t => ({ task: t.task }), aim(['task'])), M('get_task', t => ({ task: `#${t.ref}` }), aim(['ref'], { label: 'by ref' })), M('get_task', { task: 'constructor' }, { label: 'prototype key', aim: true, aimKeys: [], control: false }), Mc('get_task', t => ({ task: t.ref }), aim(['ref'], { label: 'code key' })));
  add('mcp add_task', M('add_task', t => ({ title: 'lkq probe task', depends_on: [t.ref] }), aim(['ref'], { label: 'waits on' })), M('add_task', t => ({ title: 'lkq probe in project', project: t.project }), { label: 'into a project id', controlOk: r => r.ok, ok: r => r.ok && !/"project":\s*"lkqpvproj|"project":\s*"lkqshproj/.test(r.text) }));
  add('mcp update_task', M('update_task', t => ({ task: t.task, title: 'lkq hacked' }), aim(['task'])), M('update_task', t => ({ task: t.ref, assignee: 'me' }), aim(['ref'], { label: 'assign to me' })));
  add('mcp log_progress', M('log_progress', t => ({ task: t.ref, progress: 40 }), aim(['ref'])));
  add('mcp complete_task', M('complete_task', t => ({ task: t.task }), aim(['task'], { stage: 1 })));
  add('mcp add_comment', M('add_comment', t => ({ task: t.ref, note: 'lkq probe comment' }), aim(['ref'])));
  add('mcp update_checklist', M('update_checklist', t => ({ task: t.task, add: ['lkq probe item'] }), aim(['task'])));
  add('mcp list_projects', M('list_projects', { include_inactive: true }), Mc('list_projects', { include_inactive: true }, { label: 'code key' }));
  add('mcp add_project', M('add_project', t => ({ name: t.projectName }), { label: 'a name someone else uses', ok: r => r.ok, control: false /* the owner gets "already exists" by design */ }));
  add('mcp update_project', M('update_project', t => ({ project: t.project, description: 'lkq hacked' }), aim(['project'])), M('update_project', t => ({ project: t.projectName, visibility: 'org' }), aim(['projectName'], { label: 'by name, make shared', control: false })));
  add('mcp daily_summary', M('daily_summary', { since: '30d' }), Mc('daily_summary', { since: '30d' }, { label: 'code key' }));
  add('mcp recent_activity', M('recent_activity', { since: '30d', limit: 300 }), M('recent_activity', t => ({ since: '30d', project: t.project }), aim(['project'], { label: 'by project', ok: r => r.ok && r.json?.count > 0 })));
  add('mcp apply_changes',
    M('apply_changes', t => ({ ops: [{ op: 'create_task', title: 'lkq batch own' }, { op: 'update_task', task: t.task, priority: 'P1' }] }), aim(['task'], { label: 'mixed: own create + their task' })),
    M('apply_changes', t => ({ dry_run: true, ops: [{ op: 'update_task', task: t.ref, title: 'lkq dry' }] }), aim(['ref'], { label: 'dry run' })),
    M('apply_changes', t => ({ ops: [{ op: 'edit_comment', comment_id: t.comment, text: 'lkq edited' }] }), aim(['comment'], { label: 'edit_comment' })),
    M('apply_changes', t => ({ ops: [{ op: 'delete_comment', comment_id: t.comment2 }] }), aim(['comment2'], { label: 'delete_comment', stage: 2 })),
    M('apply_changes', t => ({ ops: [{ op: 'archive_task', task: t.ref, archived: true }] }), aim(['ref'], { label: 'archive_task' })),
    M('apply_changes', t => ({ ops: [{ op: 'restore_task', task: t.trashRef2 }] }), aim(['trashRef2'], { label: 'restore_task', stage: 1 })),
    M('apply_changes', t => ({ ops: [{ op: 'write_note', note_id: t.note, append: 'lkq appended' }] }), aim(['note'], { label: 'write_note' })),
    M('apply_changes', t => ({ ops: [{ op: 'update_project', project: t.project, description: 'lkq batch' }] }), aim(['project'], { label: 'update_project' })),
    M('apply_changes', t => ({ ops: [{ op: 'create_task', title: 'lkq dep', depends_on: [t.ref] }] }), aim(['ref'], { label: 'create waiting on theirs' })),
    M('apply_changes', t => ({ ops: [{ op: 'update_checklist', task: t.task, add: ['lkq'] }, { op: 'log_progress', task: t.task, progress: 10 }] }), aim(['task'], { label: 'checklist + progress' })),
    M('apply_changes', t => ({ ops: [{ op: 'delete_note', note_id: t.sub, title: 'lkq' }] }), aim(['sub'], { label: 'delete_note (wrong title)', control: false })),
    M('apply_changes', { ops: [{ op: 'update_task', task: 'constructor', title: 'x' }, { op: 'update_task', task: '__proto__', title: 'x' }] }, { label: 'prototype keys', aim: true, aimKeys: [], control: false }),
  );
  add('mcp get_project', M('get_project', t => ({ project: t.project, depth: 'full' }), aim(['project'])), M('get_project', t => ({ project: t.projectName }), aim(['projectName'], { label: 'by name' })), M('get_project', t => ({ remote: t.remote }), { label: 'by remote', ok: r => r.ok && !r.json?.unmatched, aim: true, aimKeys: ['remote'] }), M('get_project', { project: 'constructor' }, { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add('mcp update_claude_items',
    M('update_claude_items', t => ({ ops: [{ op: 'note', item: t.item, text: 'lkq note' }] }), aim(['item'])),
    M('update_claude_items', t => ({ ops: [{ op: 'edit', item: t.item, title: 'lkq edited title of the item' }] }), aim(['item'], { label: 'edit' })),
    M('update_claude_items', t => ({ ops: [{ op: 'add', project: t.project, kind: 'idea', title: 'lkq idea into someone else project', why: 'Probe of the leak audit on the throwaway app; nothing real happens with this idea at all.' }] }), aim(['project'], { label: 'add into their project' })),
    { ...M('update_claude_items', []), label: 'blocked_by theirs', aim: true, aimKeys: ['item'], control: false, call: ({ cred, o: t, p }) => mcpCall(cred, 'update_claude_items', { ops: [{ op: 'add', project: p.ownProject ?? 'lkq none', kind: 'idea', title: 'lkq idea blocked by theirs here', why: 'Probe of the leak audit on the throwaway app; nothing real happens with this idea at all.', blocked_by: t.item }] }) },
  );
  add('mcp delete_task', M('delete_task', t => ({ task: t.ref, title: 'lkq' }), aim(['ref'], { label: 'wrong title', control: false })), M('delete_task', t => ({ task: t.looseRef, title: 'lkqpvloose' }), aim(['looseRef'], { label: 'title start', stage: 2 })));
  add('mcp restore_task', M('restore_task', t => ({ task: t.trashRef }), aim(['trashRef'], { stage: 1 })));
  add('mcp list_trash', M('list_trash', {}));
  add('mcp write_note', M('write_note', t => ({ note_id: t.note, append: 'lkq append' }), aim(['note'])), M('write_note', t => ({ parent_id: t.note, title: 'lkq sub' }), aim(['note'], { label: 'sub-page' })), M('write_note', t => ({ task: t.ref, append: 'lkq' }), aim(['ref'], { label: 'task note' })), M('write_note', t => ({ project: t.project, title: 'lkq new memo' }), aim(['project'], { label: 'new project note' })));
  add('mcp read_note', M('read_note', t => ({ note_id: t.note }), aim(['note'])), M('read_note', t => ({ note_id: t.taskNote }), aim(['taskNote'], { label: 'task note by id' })), M('read_note', t => ({ task: t.looseRef }), aim(['looseRef'], { label: 'by task' })));
  add('mcp list_notes', M('list_notes', { state: 'all' }), M('list_notes', t => ({ project: t.project, state: 'all' }), aim(['project'], { label: 'by project', ok: r => r.ok && r.json?.total > 0 })));
  add('mcp delete_note', M('delete_note', t => ({ note_id: t.sub, title: 'lkq wrong' }), aim(['sub'], { label: 'wrong title', control: false })), M('delete_note', t => ({ note_id: t.sub2, title: P_SUB2_TITLE.v }), aim(['sub2'], { label: 'right title', stage: 2 })));
  const dOk = r => r.ok;
  add('mcp discord_list_channels', M('discord_list_channels', {}, { ok: dOk }));
  add('mcp discord_needs_attention', M('discord_needs_attention', { since: '3d' }, { ok: dOk }));
  add('mcp discord_read_messages',
    M('discord_read_messages', { channel: GEN1, since: '3d' }, { label: 'first org #general', ok: dOk }),
    M('discord_read_messages', { channel: SEC1, since: '3d' }, { label: 'first org #secret', ok: dOk, aim: true, aimKeys: [], only: ['T', 'X', 'R', 'N'] }),
    M('discord_read_messages', { channel: GEN2, since: '3d' }, { label: 'second org channel by id', ok: dOk, aim: true, aimKeys: [], only: ['T', 'R', 'N'], control: false }),
    M('discord_read_messages', { channel: `https://discord.com/channels/${G2}/${GEN2}`, since: '3d' }, { label: 'second org channel by link', ok: dOk, aim: true, aimKeys: [], only: ['T', 'R', 'N'], control: false }),
  );
  add('mcp discord_message_to_task',
    M('discord_message_to_task', { message_link: `https://discord.com/channels/${G2}/${GEN2}/8880000000000000${'03'}` }, { label: 'second org message', aim: true, aimKeys: [], only: ['T', 'R', 'N'], control: false }),
    M('discord_message_to_task', { message_link: `https://discord.com/channels/${G1}/${SEC1}/8880000000000000${'02'}` }, { label: '#secret message', aim: true, aimKeys: [], only: ['T', 'X', 'R', 'N'] }),
  );

  // ── server actions (session cookie) ──
  const A_ = 'app/actions.ts#';
  add(`action ${A_}createTaskAction`, act(A_ + 'createTaskAction', t => [{ title: 'lkq action task', project: t.project, dependsOn: [t.ref] }], aim(['project', 'ref'], { controlOk: actOk })));
  add(`action ${A_}bulkCreateTasksAction`, act(A_ + 'bulkCreateTasksAction', t => [[{ title: 'lkq import one' }, { title: 'lkq import two', dependsOn: [t.ref] }]], aim(['ref'], { label: 'import waiting on theirs' })));
  add(`action ${A_}updateTaskAction`, act(A_ + 'updateTaskAction', t => [t.task, { title: 'lkq hacked' }], aim(['task'])), act(A_ + 'updateTaskAction', t => [String(t.ref), { priority: 'P1' }], aim(['ref'], { label: 'by ref' })), act(A_ + 'updateTaskAction', ['constructor', { title: 'x' }], { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add(`action ${A_}logProgressAction`, act(A_ + 'logProgressAction', t => [t.task, 30], aim(['task'])));
  add(`action ${A_}completeTaskAction`, act(A_ + 'completeTaskAction', t => [t.task], aim(['task'], { stage: 1 })));
  add(`action ${A_}addCommentAction`, act(A_ + 'addCommentAction', t => [t.task, 'lkq probe comment'], aim(['task'])));
  add(`action ${A_}setArchivedAction`, act(A_ + 'setArchivedAction', t => [t.task, true], aim(['task'], { stage: 1 })));
  add(`action ${A_}checklistAction`, act(A_ + 'checklistAction', t => [t.task, { add: ['lkq'] }], aim(['task'])));
  add(`action ${A_}deleteTaskAction`, act(A_ + 'deleteTaskAction', t => [t.archRef, 'lkq'], aim(['archRef'], { stage: 2 })));
  add(`action ${A_}restoreTaskAction`, act(A_ + 'restoreTaskAction', t => [t.trashRef3], aim(['trashRef3'], { stage: 1 })));
  add(`action ${A_}purgeTrashItemAction`, act(A_ + 'purgeTrashItemAction', t => [t.trashRef4], aim(['trashRef4'], { stage: 2 })));
  add(`action ${A_}editCommentAction`, act(A_ + 'editCommentAction', t => [t.comment, 'lkq edited'], aim(['comment'])));
  add(`action ${A_}deleteCommentAction`, act(A_ + 'deleteCommentAction', t => [t.comment], aim(['comment'], { stage: 2 })));
  add(`action ${A_}createProjectAction`, act(A_ + 'createProjectAction', [{ name: `lkq own project ${hex(3)}`, visibility: 'private' }]));
  add(`action ${A_}updateProjectAction`, act(A_ + 'updateProjectAction', t => [t.project, { description: 'lkq hacked' }], aim(['project'])), act(A_ + 'updateProjectAction', ['constructor', { description: 'x' }], { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add(`action ${A_}projectSharingImpactAction`, act(A_ + 'projectSharingImpactAction', t => [t.project], aim(['project'])));
  add(`action ${A_}logoutAction`, act(A_ + 'logoutAction', [], { ok: r => !!r.redirect && /login/.test(r.redirect), public: true, only: ['N'], control: false /* it would sign the persona out for the rest of its probes; the misuse checks sign out a spare session */ }));
  const D_ = 'app/(app)/claude/dispatcher-actions.ts#';
  add(`action ${D_}markOptionsAction`, act(D_ + 'markOptionsAction', t => [t.task], aim(['task'])));
  add(`action ${D_}giveToClaudeAction`, act(D_ + 'giveToClaudeAction', t => [String(t.give), t.folder], aim(['give', 'folder'])));
  add(`action ${D_}takeBackFromClaudeAction`, act(D_ + 'takeBackFromClaudeAction', t => [t.task, true], aim(['task'], { controlOk: r => actOk(r) || /not given|isn.t|not with/i.test(r.text) })));
  add(`action ${D_}dispatcherSettingsAction`, act(D_ + 'dispatcherSettingsAction', t => [{ boilerplateNoteId: t.boiler }], aim(['boiler'], { label: 'their note as my boilerplate' })));
  add(`action ${D_}dispatcherSetupAction`, act(D_ + 'dispatcherSetupAction', []));
  // Set up: switch the caller's OWN switch on once (their own setting and computers only), and hide or show their own checklist.
  add(`action ${D_}autoEnableDispatcherAction`, act(D_ + 'autoEnableDispatcherAction', []));
  const CK_ = 'app/(app)/today/checklist-actions.ts#';
  add(`action ${CK_}hideChecklistAction`, act(CK_ + 'hideChecklistAction', []));
  add(`action ${CK_}showChecklistAction`, act(CK_ + 'showChecklistAction', []));
  const K_ = 'app/(app)/claude/setup-actions.ts#';
  add(`action ${K_}listApiKeysAction`, act(K_ + 'listApiKeysAction', ['claude']), act(K_ + 'listApiKeysAction', ['claude-code'], { label: 'code keys' }));
  add(`action ${K_}createApiKeyAction`, act(K_ + 'createApiKeyAction', ['lkq probe key', 'claude-code'], { ok: r => actOk(r), controlOk: r => actOk(r) }));
  add(`action ${K_}rotateApiKeyAction`, act(K_ + 'rotateApiKeyAction', (t, c) => [c.keyIdOf?.(t) ?? 'none'], { control: false, label: 'their key id', aim: true, aimKeys: [], refusal: KEY_GONE, call: async ({ p, o }) => action(K_ + 'rotateApiKeyAction', [o === FAKE_REF.v ? FAKE_REF.key : await keyIdOf('A')], { cookie: p.cookie }) }));
  const AP_ = 'app/(app)/claude/apps-actions.ts#';
  add(`action ${AP_}revokeAppAction`, act(AP_ + 'revokeAppAction', [], { control: false, label: 'their approved app', aim: true, aimKeys: [], refusal: KEY_GONE, call: async ({ p, o }) => action(AP_ + 'revokeAppAction', [o === FAKE_REF.v ? 'lkqnoclient' + hex(6) : A.oauthClientId], { cookie: p.cookie }) }));
  add(`action ${K_}revokeApiKeyAction`, act(K_ + 'revokeApiKeyAction', [], { control: false, label: 'their key id', aim: true, aimKeys: [], refusal: KEY_GONE, call: async ({ p, o }) => action(K_ + 'revokeApiKeyAction', [o === FAKE_REF.v ? FAKE_REF.key : await keyIdOf('A'), 'claude-code'], { cookie: p.cookie }) }));
  add(`action ${K_}listDevicesAction`, act(K_ + 'listDevicesAction', []));
  add(`action ${K_}workerInstallInfoAction`, act(K_ + 'workerInstallInfoAction', []));
  add(`action ${K_}createDeviceAction`, act(K_ + 'createDeviceAction', ['lkq probe pc'], { controlOk: r => actOk(r) }));
  add(`action ${K_}replaceDeviceKeyAction`, act(K_ + 'replaceDeviceKeyAction', t => [t.device], aim(['device'], { stage: 2 })));
  add(`action ${K_}revokeDeviceAction`, act(K_ + 'revokeDeviceAction', t => [t.device], aim(['device'], { stage: 2 })));
  const N_ = 'app/(app)/notes/actions.ts#';
  add(`action ${N_}createNoteAction`, act(N_ + 'createNoteAction', t => [{ task: t.ref, title: 'lkq' }], aim(['ref'], { ok: r => actOk(r) && !!r.value?.id, controlOk: r => actOk(r) || /already/i.test(r.text) })), act(N_ + 'createNoteAction', t => [{ project: t.project, title: 'lkq memo' }], aim(['project'], { label: 'project note', ok: r => actOk(r) && !!r.value?.id })));
  add(`action ${N_}createSubPageAction`, act(N_ + 'createSubPageAction', t => [t.note, 'lkq sub'], aim(['note'], { ok: r => actOk(r) && !!r.value?.id })));
  add(`action ${N_}saveNoteAction`, act(N_ + 'saveNoteAction', t => [t.note, { title: 'lkq hacked' }], aim(['note'])), act(N_ + 'saveNoteAction', t => [t.taskNote, { archived: true }], aim(['taskNote'], { label: 'archive a task note' })));
  add(`action ${N_}deleteNoteAction`, act(N_ + 'deleteNoteAction', t => [t.sub], aim(['sub'], { stage: 1 })));
  add(`action ${N_}restoreNoteAction`, act(N_ + 'restoreNoteAction', t => [t.sub], aim(['sub'], { stage: 2 })));
  add(`action ${N_}searchMentionsAction`, act(N_ + 'searchMentionsAction', ['lkq'], { ok: r => r.status === 200 && !r.error && Array.isArray(r.value) }));
  const CI = 'app/(app)/projects/[id]/claude-items-actions.ts#';
  add(`action ${CI}updateClaudeItemAction`, act(CI + 'updateClaudeItemAction', t => [t.itemProject, t.item, { note: 'lkq hacked' }], aim(['itemProject', 'item'])));
  add(`action ${CI}moveClaudeItemAction`, act(CI + 'moveClaudeItemAction', t => [t.itemProject, t.item, 'top'], aim(['itemProject', 'item'])));
  const L_ = 'app/(app)/projects/[id]/launcher-actions.ts#';
  add(`action ${L_}searchFoldersAction`, act(L_ + 'searchFoldersAction', t => [t.device, ''], aim(['device'], { ok: r => actOk(r) && r.value.data?.length > 0 })));
  add(`action ${L_}folderPickerAction`, act(L_ + 'folderPickerAction', t => [t.device, ''], aim(['device', 'project'], { ok: r => actOk(r) && r.value.data?.folders?.length > 0 })));
  add(`action ${L_}relinkFolderAction`, act(L_ + 'relinkFolderAction', t => [t.folder, t.project], aim(['project', 'folder'], { stage: 2 })));
  add(`action ${L_}linkFolderAction`, act(L_ + 'linkFolderAction', t => [t.project, t.folder], aim(['project', 'folder'])));
  add(`action ${L_}unlinkFolderAction`, act(L_ + 'unlinkFolderAction', t => [t.project, t.folder], aim(['project', 'folder'], { stage: 2 })));
  add(`action ${L_}startSessionAction`, act(L_ + 'startSessionAction', t => [t.project, t.folder, 'lkq prompt'], aim(['project', 'folder'], { stage: 1 })));
  add(`action ${L_}resumeSessionAction`, act(L_ + 'resumeSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 1, controlOk: r => actOk(r) || /running|already/i.test(r.text) })));
  add(`action ${L_}stopSessionAction`, act(L_ + 'stopSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 1 })));
  add(`action ${L_}removeSessionAction`, act(L_ + 'removeSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 2, controlOk: r => actOk(r) || /running|stop it/i.test(r.text) })));
  add(`action ${L_}unhideSessionAction`, act(L_ + 'unhideSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 2 })));
  add(`action ${L_}startProjectsAction`, act(L_ + 'startProjectsAction', []));
  add(`action ${L_}startOptionsAction`, act(L_ + 'startOptionsAction', t => [t.project], aim(['project'], { ok: r => actOk(r) && (r.value.data?.folders?.length > 0 || r.value.data?.suggestions?.length > 0) })));
  add(`action ${L_}linkAndStartAction`, act(L_ + 'linkAndStartAction', t => [t.project, t.folder, 'lkq'], aim(['project', 'folder'], { stage: 1 })));
  add('action app/(app)/search-action.ts#searchAction', act('app/(app)/search-action.ts#searchAction', ['lkq'], { ok: r => r.status === 200 && !r.error && r.value != null }), { ...act('app/(app)/search-action.ts#searchAction', []), label: 'by ref', aim: true, aimKeys: ['ref'], call: async ({ p, o }) => ({ ...(await action('app/(app)/search-action.ts#searchAction', [`#${o.ref}`], { cookie: p.cookie })), ref: o.ref }), ok: r => r.status === 200 && !!r.value?.tasks?.some(x => x.href === `/tasks/${r.ref}`), shape: r => `${r.status} ${r.value?.tasks?.some(x => x.href === `/tasks/${r.ref}`) ? 'found' : 'none'}` /* "#1" also matches #10 and other text */ });
  const ST = 'app/(app)/settings/actions.ts#';
  add(`action ${ST}subscribePushAction`, act(ST + 'subscribePushAction', () => [{ endpoint: `https://push.example.test/lkqown${hex(6)}`, keys: { p256dh: 'x', auth: 'y' } }, 'lkq probe']));
  add(`action ${ST}listPushDevicesAction`, act(ST + 'listPushDevicesAction', t => [t.push], { controlOk: r => actOk(r) }));
  add(`action ${ST}removePushDeviceAction`, act(ST + 'removePushDeviceAction', t => [createHash('sha256').update(t.push).digest('hex').slice(0, 24)], aim(['push'], { mayWork: () => true, stage: 2 })));
  add(`action ${ST}unsubscribePushAction`, act(ST + 'unsubscribePushAction', t => [t.push], aim(['push'], { mayWork: () => true /* answers ok either way; the write check catches a removal */, stage: 2 })));
  add(`action ${ST}saveNotifySettingsAction`, act(ST + 'saveNotifySettingsAction', [{ channels: { push: true, discord: true }, kinds: {} }]));
  add(`action ${ST}testNotificationAction`, act(ST + 'testNotificationAction', []));
  add(`action ${ST}markAllReadAction`, act(ST + 'markAllReadAction', [], { ok: r => r.status === 200 && !r.error }));
  add('action app/(app)/settings/blocked-actions.ts#saveBlockedChannels', act('app/(app)/settings/blocked-actions.ts#saveBlockedChannels', [[]], { ok: r => r.status === 200 && !r.error, controlOk: r => r.status === 200 && !r.error, mayWork: w => w === 'X' /* X saves X's own server's list */ }));
  const MB = 'app/(app)/settings/members-actions.ts#';
  add(`action ${MB}inviteMemberAction`, act(MB + 'inviteMemberAction', [`lkq${hex(3)}@example.test`, 'owner'], { mayWork: w => w === 'X' /* X invites to X's own organization */ }));
  add(`action ${MB}cancelInvitationAction`, act(MB + 'cancelInvitationAction', t => [t.invite], aim(['invite'], { stage: 2 })));
  add(`action ${MB}changeRoleAction`, act(MB + 'changeRoleAction', t => [t.member, 'member'], aim(['member'], { control: false /* the team suite */, refusal: NOT_THEIRS_MEMBER })), act(MB + 'changeRoleAction', (t, c, p) => [p.userId, 'owner'], { label: 'promote myself', mayWork: w => w === 'X' /* already the owner */, control: false }));
  add(`action ${MB}removeMemberAction`, act(MB + 'removeMemberAction', t => [t.member], aim(['member'], { control: false /* the team suite */, refusal: NOT_THEIRS_MEMBER })));
  const PR = 'app/(app)/settings/profile-actions.ts#';
  add(`action ${PR}saveTimeSettingsAction`, act(PR + 'saveTimeSettingsAction', [{ timezone: 'Asia/Kolkata', quietStart: 0, quietEnd: 0 }]));
  add(`action ${PR}discordLinkCodeAction`, act(PR + 'discordLinkCodeAction', []));
  add(`action ${PR}unlinkDiscordAction`, act(PR + 'unlinkDiscordAction', [], { only: ['R', 'N'], control: false /* T and X would unlink their own Discord account before their Discord probes run; the owner's for the rest of the run */ }));
  add(`action ${PR}saveDiscordServerAction`, act(PR + 'saveDiscordServerAction', [G2], { label: 'claim the second org\'s server', control: false }), act(PR + 'saveDiscordServerAction', [G1], { label: 'own server again', controlOk: actOk, only: ['R', 'N'] }));
  const SE = 'app/(app)/settings/security-actions.ts#';
  add(`action ${SE}sendTestEmailAction`, act(SE + 'sendTestEmailAction', [], { controlOk: r => actOk(r) || /not set up/i.test(r.text) }));
  add(`action ${SE}dismissMigrationNoticeAction`, act(SE + 'dismissMigrationNoticeAction', [], { mayWork: w => w === 'X' }));
  add('action app/(app)/timetable/actions.ts#saveScheduleAction', act('app/(app)/timetable/actions.ts#saveScheduleAction', [[{ start: '09:00', end: '10:00', block: 'lkq own block', modes: { mon: 'Growth' }, notes: '' }], null], { control: false /* would replace the owner's canary week */ }));
  const IV = 'app/accept-invitation/actions.ts#';
  const accept = (name, fields) => ({ kind: 'action', ok: r => !!r.redirect && /\/today/.test(r.redirect), public: true, call: async ({ p, o: t }) => formAction(name, `/accept-invitation/${t.invite}`, fields(t, p), p.cookie) });
  add(`action ${IV}acceptNewAction`, { ...accept(IV + 'acceptNewAction', t => ({ id: t.invite, t: 'x'.repeat(43), name: 'lkq', password: 'lkq-password-1', again: 'lkq-password-1' })), aim: true, aimKeys: ['invite'], control: false, label: 'without the secret', refusal: BAD_LINK });
  add(`action ${IV}acceptSignedInAction`, { ...accept(IV + 'acceptSignedInAction', t => ({ id: t.invite, t: 'x'.repeat(43) })), aim: true, aimKeys: ['invite'], control: false, label: 'without the secret', refusal: BAD_LINK });
  add('action app/reauth-actions.ts#confirmPasswordAction', act('app/reauth-actions.ts#confirmPasswordAction', ['wrong-password-1'], { label: 'wrong password', control: false }));

  // ── pages (session cookie) ──
  const pg = (u, o) => page(u, o);
  add('page /', pg('/', { ok: r => r.status === 307 || r.status === 308 || r.status === 200, public: true }));
  add('page /today', pg('/today'));
  add('page /tasks', pg('/tasks'), pg(t => `/tasks?project=${t.project}`, { label: 'filtered by project' }), pg('/tasks?q=lkq', { label: 'search' }));
  add('page /tasks/[id]', pg(t => `/tasks/${t.ref}`, aim(['ref'])), pg(t => `/tasks/${t.task}`, aim(['task'], { label: 'by id' })), pg(t => `/tasks/${t.trashRef}`, aim(['trashRef'], { label: 'in the trash', control: false })), pg('/tasks/constructor', { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add('page /projects', pg('/projects'));
  add('page /projects/[id]', pg(t => `/projects/${t.project}`, aim(['project'])), pg(t => `/projects/${t.project}?tab=claude`, aim(['project'], { label: 'claude tab' })), pg(t => `/projects/${t.project}?tab=sessions`, aim(['project'], { label: 'sessions tab' })), pg('/projects/constructor', { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add('page /notes', pg('/notes?state=all'), pg(t => `/notes?project=${t.project}&state=all`, { label: 'filtered by project' }));
  add('page /notes/[id]', pg(t => `/notes/${t.note}`, aim(['note'])), pg(t => `/notes/${t.sub}`, aim(['sub'], { label: 'sub-page' })), pg(t => `/notes/${t.taskNote}`, aim(['taskNote'], { label: 'task note' })));
  add('page /modes/[mode]', pg('/modes/growth', { ok: r => /^redirect \/tasks\?mode=/.test(pageState(r)) }), pg(() => `/modes/${CANARIES.find(c => c.tag === 'xmode').s}`, { label: 'the second org\'s mode', echo: () => [CANARIES.find(c => c.tag === 'xmode').s], ok: r => /^redirect \/tasks\?mode=/.test(pageState(r)), aim: true, aimKeys: [], control: false }));
  add('page /notifications', pg('/notifications'));
  add('page /review', ...['done', 'activity', 'weekly', 'stale', 'archive', 'trash'].map(v => pg(`/review?view=${v}`, { label: v })));
  add('page /settings', ...['account', 'notifications', 'connections', 'started', 'team', 'server'].map(v => pg(`/settings?section=${v}`, { label: v })));
  add('page /claude', ...['now', 'queue', 'setup'].map(v => pg(`/claude?tab=${v}`, { label: v })));
  add('page /menu', pg('/menu'));
  add('page /timetable', pg('/timetable'), pg('/timetable?edit=1', { label: 'editor' }));
  add('page /accept-invitation/[id]', pg(t => `/accept-invitation/${t.invite}?t=${'x'.repeat(43)}`, { ...aim(['invite']), public: true, label: 'without the secret', ok: r => r.status === 200 && /join|accept|create your account/i.test(r.text) && !/invalid|expired|no longer/i.test(r.text), control: false }));
  add('page /login', pg('/login', { public: true }));
  add('page /login/reset', pg('/login/reset?token=lkqnotatoken', { public: true }));
  // The consent screen of the OAuth sign-in: with no (or a forged) signed request it shows nothing to approve, whoever opens it; a signed-out or removed person is sent to /login by the proxy.
  add('page /oauth/consent', pg('/oauth/consent', { ok: r => r.status === 200 && /can.t be used/.test(r.text) && !/data-consent="allow"/.test(r.text) }), pg('/oauth/consent?client_id=lkqnone&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&sig=lkq&ba_param=client_id&ba_param=sig', { label: 'forged request', ok: r => r.status === 200 && /can.t be used/.test(r.text) && !/data-consent="allow"/.test(r.text) }));

  // ── route handlers ──
  add('route GET /api/admin/health', route('GET', '/api/admin/health'), route('GET', '/api/admin/health', { label: 'chat key', useKey: true }));
  add('route GET /api/admin/discord/register', route('GET', t => `/api/admin/discord/register?org=${t === undefined ? '' : ''}`), route('GET', `/api/admin/discord/register?org=${''}`, { label: 'chat key', useKey: true }));
  add('route POST /api/admin/discord/register', route('POST', '/api/admin/discord/register', { stage: 1 }));
  add('route GET /api/auth/[...all]', { kind: 'route', public: true, ok: r => r.status === 404, call: ({ p }) => req('GET', '/api/auth/api-key/list', { cookie: p.cookie }), label: 'a Better Auth endpoint that is not served', controlOk: r => r.status === 404 });
  add('route POST /api/auth/[...all]', { kind: 'route', public: true, ok: r => r.status === 404, call: ({ p }) => req('POST', '/api/auth/organization/invite-member', { cookie: p.cookie, body: { email: 'lkq@example.test', role: 'owner', organizationId: A.orgId } }), label: 'invite through Better Auth (not served)', controlOk: r => r.status === 404 });
  const cronProbe = m => ({ kind: 'route', ok: r => two(r.status), call: ({ p }) => req(m, '/api/cron/alerts?dry=1', { cookie: p.cookie, bearer: p.chat }), control: false /* the CRON_SECRET holder is the server timer; the alert suites run it */ });
  add('route GET /api/cron/alerts', cronProbe('GET'));
  add('route POST /api/cron/alerts', cronProbe('POST'));
  add('route POST /api/discord/interactions', { kind: 'route', ok: r => two(r.status), call: () => req('POST', '/api/discord/interactions', { body: '{"type":1}', headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': String(Math.floor(Date.now() / 1000)) } }), label: 'unsigned', control: false });
  add('route GET /worker/work-os-worker.mjs', route('GET', '/worker/work-os-worker.mjs', { public: true }));
  add('route GET /worker/latest.json', route('GET', '/worker/latest.json', { public: true }));
  add('route GET /api/live', route('GET', '/api/live', { public: true }));
  add('route HEAD /api/live', route('HEAD', '/api/live', { public: true }));
  const mcpRoute = m => ({ kind: 'mcp', ok: r => two(r.status) && !/Unauthorized/.test(r.text), call: ({ cred }) => req(m, '/api/mcp', { bearer: cred, headers: { accept: 'application/json, text/event-stream' }, body: m === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : undefined }), controlOk: r => (m === 'POST' ? two(r.status) : r.status !== 401) });
  add('route POST /api/mcp/[[...key]]', mcpRoute('POST'), { kind: 'route', label: 'key in the URL (off)', ok: r => two(r.status), call: ({ p }) => req('POST', `/api/mcp/${p.chat || 'wos_none'}`, { headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), control: false });
  add('route GET /api/mcp/[[...key]]', { ...mcpRoute('GET'), ok: r => two(r.status) && /lkq/.test(r.text) });
  add('route DELETE /api/mcp/[[...key]]', { ...mcpRoute('DELETE'), ok: r => two(r.status) && /lkq/.test(r.text) });
  add('route GET /api/notes/file', route('GET', t => `/api/notes/file?p=${encodeURIComponent(`notes/${A.orgId}/${t.note}/x.png`)}`, aim(['note'], { ok: r => r.status === 503, controlOk: r => r.status === 503 })));
  add('route POST /api/notes/upload', route('POST', '/api/notes/upload', aim(['note'], { body: t => ({ type: 'blob.generate-client-token', payload: { pathname: `notes/${A.orgId}/${t.note}/x.png`, callbackUrl: B, clientPayload: null, multipart: false } }), ok: r => r.status === 503, controlOk: r => r.status === 503 })));
  add('route GET /api/stream', { kind: 'route', ok: r => r.status === 200, call: ({ p }) => streamPeek('/api/stream', p.cookie ? { cookie: p.cookie } : {}) });
  add('route GET /api/timetable/today', route('GET', '/api/timetable/today'), route('GET', '/api/timetable/today', { label: 'chat key', useKey: true }));
  add('route POST /api/worker/folders', worker('POST', '/api/worker/folders', () => ({ folders: [{ id: 'lkqf0001', name: 'lkq probe folder', path: 'C:/lkq', git: false }] }), { label: 'own scan' }));
  add('route GET /api/worker/jobs', worker('GET', '/api/worker/jobs'));
  add('route POST /api/worker/status', worker('POST', '/api/worker/status', t => ({ worker: { version: '0.1.0', os: 'win32', allowPrompts: false }, jobs: [{ id: t.job, ok: false, error: 'lkq' }], sessions: [{ sessionId: t.session, state: 'dead' }] }), { label: 'their job and session ids', controlOk: r => two(r.status), stage: 1 }));
  add('route GET /api/worker/stream', { kind: 'worker', ok: r => r.status === 200, call: ({ p }) => streamPeek('/api/worker/stream', p.wkr ? { authorization: `Bearer ${p.wkr}` } : {}) });
  add('route GET /icons/[size]', route('GET', '/icons/192', { public: true }));
  // OAuth discovery documents (RFC 9728, RFC 8414): public by design, the same for everyone, nothing about any organization.
  for (const [name, has] of [['oauth-protected-resource', /authorization_servers/], ['oauth-authorization-server', /code_challenge_methods_supported/]]) {
    add(`route GET /.well-known/${name}/[[...path]]`, route('GET', `/.well-known/${name}`, { public: true, ok: r => two(r.status) && has.test(r.text) }));
    add(`route OPTIONS /.well-known/${name}/[[...path]]`, route('OPTIONS', `/.well-known/${name}`, { public: true, ok: r => two(r.status) }));
  }
  add('route GET /favicon.ico', route('GET', '/favicon.ico', { public: true }));
  add('route GET /manifest.webmanifest', route('GET', '/manifest.webmanifest', { public: true }));

  // ── Better Auth endpoints the auth route serves ──
  add('auth /ok', authEp('GET', '/ok', undefined, { public: true }));
  add('auth /error', authEp('GET', '/error', undefined, { public: true, ok: r => r.status < 500 }));
  // ownAccount: R is still a person with an account; only the membership is gone, so their own account endpoints work.
  add('auth /get-session', authEp('GET', '/get-session', undefined, { ok: r => two(r.status) && r.text !== 'null', ownAccount: true }));
  add('auth /sign-in/email', { kind: 'auth', public: true, aim: true, aimKeys: [], ok: r => two(r.status), label: 'their email, wrong password vs no such account', call: ({ o }) => req('POST', '/api/auth/sign-in/email', { body: { email: o === FAKE_REF.v ? `lkqnobody${hex(2)}@example.test` : EMAIL, password: 'wrong-password-1' } }), control: false });
  add('auth /sign-out', authEp('POST', '/sign-out', {}, { public: true, control: false, only: ['N'] }));
  add('auth /request-password-reset', { kind: 'auth', public: true, aim: true, aimKeys: [], ok: () => false, mayWork: () => true, label: 'their email vs no such account', call: ({ o }) => req('POST', '/api/auth/request-password-reset', { body: { email: o === FAKE_REF.v ? `lkqnobody${hex(2)}@example.test` : EMAIL, redirectTo: '/login/reset' } }), control: false });
  add('auth /reset-password', authEp('POST', '/reset-password', { newPassword: 'lkq-password-2', token: 'lkqnotatoken' }, { public: true, control: false }));
  add('auth /reset-password/<token>', authEp('GET', '/reset-password/lkqnotatoken?callbackURL=/login/reset', undefined, { public: true, ok: r => r.status < 400, control: false }));
  add('auth /change-password', authEp('POST', '/change-password', { currentPassword: 'wrong-password-1', newPassword: 'lkq-password-3' }, { control: false }));
  add('auth /list-sessions', authEp('GET', '/list-sessions', undefined, { ownAccount: true }));
  add('auth /revoke-session', authEp('POST', '/revoke-session', () => ({ token: A.sessionToken }), { label: 'their session token', aim: true, aimKeys: [], ok: () => false, mayWork: () => true, control: false, only: ['T', 'X', 'R'] }));
  add('auth /revoke-other-sessions', authEp('POST', '/revoke-other-sessions', {}, { control: false, only: ['N'] }));
  for (const [ep, method, body] of [['/two-factor/enable', 'POST', { password: 'wrong-password-1' }], ['/two-factor/disable', 'POST', { password: 'wrong-password-1' }], ['/two-factor/get-totp-uri', 'POST', { password: 'wrong-password-1' }], ['/two-factor/verify-totp', 'POST', { code: '000000' }], ['/two-factor/verify-backup-code', 'POST', { code: 'lkqbackup0' }], ['/two-factor/generate-backup-codes', 'POST', { password: 'wrong-password-1' }]]) add(`auth ${ep}`, authEp(method, ep, body, { control: false, label: 'wrong password or code' }));
  add('auth /passkey/generate-register-options', authEp('GET', '/passkey/generate-register-options', undefined, { ownAccount: true }));
  add('auth /passkey/verify-registration', authEp('POST', '/passkey/verify-registration', { response: {} }, { control: false }));
  add('auth /passkey/generate-authenticate-options', authEp('GET', '/passkey/generate-authenticate-options', undefined, { public: true }));
  add('auth /passkey/verify-authentication', authEp('POST', '/passkey/verify-authentication', { response: { id: 'lkqcred' } }, { control: false }));
  add('auth /passkey/list-user-passkeys', authEp('GET', '/passkey/list-user-passkeys', undefined, { ownAccount: true }));
  add('auth /passkey/delete-passkey', authEp('POST', '/passkey/delete-passkey', t => ({ id: t.passkey }), aim(['passkey'], { stage: 2, existenceOk: 'Better Auth answers 401 for a passkey that is someone else\'s and 404 for none; ids are random' })));
  add('auth /passkey/update-passkey', authEp('POST', '/passkey/update-passkey', t => ({ id: t.passkey, name: 'lkq renamed' }), aim(['passkey'], { existenceOk: 'Better Auth answers 401 for a passkey that is someone else\'s and 404 for none; ids are random' })));
  add('auth /organization/list', authEp('GET', '/organization/list', undefined, { ownAccount: true }));
  add('auth /organization/set-active', authEp('POST', '/organization/set-active', () => ({ organizationId: A.orgId }), { label: 'the first organization', aim: true, aimKeys: [], only: ['X', 'R', 'N'], controlOk: r => two(r.status) }));
  add('auth /organization/get-full-organization', authEp('GET', () => `/organization/get-full-organization?organizationId=${A.orgId}`, undefined, { label: 'the first organization', mayWork: w => w === 'T' }));
  add('auth /organization/list-members', authEp('GET', () => `/organization/list-members?organizationId=${A.orgId}`, undefined, { label: 'the first organization', mayWork: w => w === 'T' }));
  add('auth /organization/get-active-member', authEp('GET', () => `/organization/get-active-member?organizationId=${A.orgId}`, undefined, { label: 'the first organization', mayWork: w => w === 'T' || w === 'X' /* X's own active membership */ }));
  add('auth /organization/get-active-member-role', authEp('GET', () => `/organization/get-active-member-role?organizationId=${A.orgId}`, undefined, { label: 'the first organization', mayWork: w => w === 'T' || w === 'X' }));

  // OAuth sign-in for MCP clients: every call is public or checks its own credential (the signed request, the code, the token); none reads organization data.
  const oauthEp = (method, sub, body, o = {}) => authEp(method, sub, body, { public: true, control: false, ok: r => r.status < 500, ...o });
  add('auth /oauth2/authorize', oauthEp('GET', '/oauth2/authorize?response_type=code&client_id=lkqnone&redirect_uri=https%3A%2F%2Fclaude.ai%2Fx&code_challenge=x&code_challenge_method=S256'));
  add('auth /oauth2/consent', oauthEp('POST', '/oauth2/consent', { accept: true, oauth_query: 'client_id=lkqnone&sig=lkq' }, { ok: r => r.status >= 400 && r.status < 500 }));
  add('auth /oauth2/token', oauthEp('POST', '/oauth2/token', { grant_type: 'authorization_code', code: 'lkqnocode', client_id: 'lkqnone', redirect_uri: 'https://claude.ai/x', code_verifier: 'x'.repeat(50) }, { ok: r => r.status >= 400 && r.status < 500 }));
  add('auth /oauth2/revoke', oauthEp('POST', '/oauth2/revoke', { token: 'lkqnotatoken', client_id: 'lkqnone' }));
  add('auth /oauth2/register', oauthEp('POST', '/oauth2/register', { client_name: 'lkq app', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }, { ok: r => two(r.status) }));

  // ── Discord (signed interactions as each person's linked account, against the stub) ──
  add('discord command link', disc(2, { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: 'LKQWRONG' }] }, { label: 'a wrong code', ok: r => /^Linked/m.test(r.text) && !/unknown or expired/i.test(r.text), public: true, control: false }));
  add('discord command task', disc(2, t => ({ name: 'task', type: 1, options: [{ name: 'title', type: 3, value: 'lkq discord task' }, { name: 'project', type: 3, value: t.projectName }] }), { label: 'into their project by name', ok: r => /Added/.test(r.text), mayWork: () => true }));
  add('discord command today', disc(2, { name: 'today', type: 1 }, { ok: r => /Overdue|Due today|In progress|Open P1|Nothing overdue/.test(r.text) }));
  add('discord command done', disc(2, t => ({ name: 'done', type: 1, options: [{ name: 'ref', type: 3, value: String(t.ref) }] }), aim(['ref'], { stage: 1, ok: r => /Done \[/.test(r.text) })));
  add('discord command progress', disc(2, t => ({ name: 'progress', type: 1, options: [{ name: 'ref', type: 3, value: String(t.ref) }, { name: 'percent', type: 4, value: 50 }] }), aim(['ref'], { ok: r => /→ \d+%/.test(r.text) })));
  add('discord command Add to Work OS',
    disc(2, () => ({ name: 'Add to Work OS', type: 3, target_id: '888000000000000003', resolved: { messages: { '888000000000000003': { id: '888000000000000003', channel_id: GEN2, content: 'lkq second org message', author: { id: DU, username: 'u' }, timestamp: new Date().toISOString(), mentions: [], mention_roles: [], mention_everyone: false, embeds: [], attachments: [], type: 0 } } } }), { label: 'a message from the second org\'s channel', ok: r => /Added|Already tracked/.test(r.text), aim: true, aimKeys: [], only: ['T', 'R'], control: false }),
    disc(2, () => ({ name: 'Add to Work OS', type: 3, target_id: '888000000000000002', resolved: { messages: { '888000000000000002': { id: '888000000000000002', channel_id: SEC1, content: 'lkq secret message', author: { id: DU, username: 'u' }, timestamp: new Date().toISOString(), mentions: [], mention_roles: [], mention_everyone: false, embeds: [], attachments: [], type: 0 } } } }), { label: 'a #secret message', ok: r => /Added|Already tracked/.test(r.text), aim: true, aimKeys: [], only: ['T', 'R'] }),
  );
  add('discord autocomplete ref', disc(4, { name: 'done', type: 1, options: [{ name: 'ref', type: 3, value: '', focused: true }] }, { ok: r => /"choices":\[\{/.test(r.text) }));
  add('discord autocomplete project', disc(4, { name: 'task', type: 1, options: [{ name: 'title', type: 3, value: 'x' }, { name: 'project', type: 3, value: '', focused: true }] }, { ok: r => /"choices":\[\{/.test(r.text) }));
  add('discord component pri', disc(3, t => ({ custom_id: `wo:pri:${t.ref}`, component_type: 3, values: ['P1'] }), aim(['ref'], { ok: r => /Added \[/.test(r.text), extra: () => ({ message: { id: '1', content: 'Added' } }) })));
  add('discord component due', disc(3, t => ({ custom_id: `wo:due:${t.ref}:tomorrow`, component_type: 2 }), aim(['ref'], { ok: r => /Added \[/.test(r.text) })));
  add('discord component edit', disc(3, t => ({ custom_id: `wo:edit:${t.ref}`, component_type: 2 }), { ok: r => /"type":\s*9/.test(r.text), public: true, label: 'opens a modal (no read)', extra: () => ({ message: { id: '1', content: 'Added [#1](<x>): lkq shown title (p, P2)' } }) }));
  add('discord component editmodal', disc(5, t => ({ custom_id: `wo:editmodal:${t.ref}`, components: [{ type: 1, components: [{ type: 4, custom_id: 'title', value: 'lkq hacked title' }] }] }), aim(['ref'], { ok: r => /Added \[/.test(r.text) })));
  // Actions with no result type (void or a bare value) refuse someone signed out by throwing.
  for (const id of [`action ${N_}searchMentionsAction`, `action ${ST}markAllReadAction`, 'action app/(app)/settings/blocked-actions.ts#saveBlockedChannels', 'action app/(app)/search-action.ts#searchAction']) for (const pr of items[id].probes) pr.throws = true;
  return items;
}

async function keyIdOf(name) {
  const p = { A, T, X, R }[name];
  const k = await rawDb.collection('apikey').findOne({ referenceId: { $in: [p.userId, new ObjectId(p.userId)] }, name: { $regex: 'codekey' } });
  return String(k?._id ?? 'none');
}

/** Each kind of credential where it does not belong: all must be refused. */
function MISUSE({ A, T, X, R }) {
  const no = r => r.status === 401 || r.status === 403 || r.status === 404 || (r.status === 200 && /Unauthorized|unauthorized/.test(r.text));
  const toLogin = r => (r.status === 307 || r.status === 302 || r.status === 303) && /\/login/.test(r.location ?? '');
  const actNo = r => r.status !== 200 || r.error || r.value == null || r.value?.ok === false || !!r.value?.error;
  const list = [];
  const L = (label, call, refused = no) => list.push({ label, call, refused });
  const tl = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const mh = { accept: 'application/json, text/event-stream' };
  L('a wkr_ key on /api/mcp', () => req('POST', '/api/mcp', { bearer: A.wkr, headers: mh, body: tl }));
  L('a session cookie on /api/mcp', () => req('POST', '/api/mcp', { cookie: A.cookie, headers: mh, body: tl }));
  // A copy of a cookie kept after sign-out: its signed cookie cache is still valid for a while, but actions read the
  // session from the database, called by fetch (Next-Action header) or by a form post ($ACTION_REF_ fields, no header).
  // Before sign-out the copy must hold the cache and open a page, and the form post must make the task.
  // (the control's task, its history line and its number are taken back, so the misuse snapshot sees no write)
  const made = async title => {
    const d = await rawDb.collection('tasks').findOne({ title });
    if (!d) return false;
    await rawDb.collection('tasks').deleteOne({ _id: d._id });
    await rawDb.collection('activity').deleteMany({ taskId: d._id });
    await rawDb.collection('counters').updateOne({ _id: `task:${ME.orgId}` }, { $inc: { seq: -1 } });
    return true;
  };
  L('a server action with a session cookie that signed out (fetch and form post)', async () => {
    const c = await signIn(EMAIL);
    if (!/session_data=/.test(c)) return { status: 0, text: `the cookie holds no session_data: ${c.replace(/=[^;]+/g, '=…')}` };
    const page = await req('GET', '/today', { cookie: c });
    if (pageState(page) !== 'page') return { status: 0, text: `before sign-out /today is ${page.status} ${pageState(page)}` };
    const ctl = `lkq form before sign-out ${hex(3)}`;
    await formBound('app/actions.ts#createTaskAction', [{ title: ctl }], c);
    if (!(await made(ctl))) return { status: 0, text: 'the form post made no task before sign-out (the probe does not reach the action)' };
    await action('app/actions.ts#logoutAction', [], { cookie: c });
    const viaFetch = await action('app/actions.ts#createTaskAction', [{ title: 'lkq after sign-out' }], { cookie: c });
    if (!actNo(viaFetch)) return { status: 0, text: `fetch action after sign-out worked: ${said(viaFetch).slice(0, 120)}` };
    const t = `lkq form after sign-out ${hex(3)}`;
    const viaForm = await formBound('app/actions.ts#createTaskAction', [{ title: t }], c);
    return { ...viaForm, made: await made(t) };
  }, r => r.made === false);
  L('a removed member\'s chat key on /api/mcp', () => req('POST', '/api/mcp', { bearer: R.chat, headers: mh, body: tl }));
  L('a removed member\'s Claude Code key on /api/mcp', () => req('POST', '/api/mcp', { bearer: R.code, headers: mh, body: tl }));
  L('a made-up OAuth access token on /api/mcp', () => req('POST', '/api/mcp', { bearer: 'wosat_' + 'a'.repeat(43), headers: mh, body: tl }));
  L('Better Auth OAuth introspection (not served)', () => req('POST', '/api/auth/oauth2/introspect', { body: { token: 'x', client_id: 'x' } }), r => r.status === 404);
  L('Better Auth OAuth client creation (not served)', () => req('POST', '/api/auth/oauth2/create-client', { cookie: A.cookie, body: { redirect_uris: ['https://evil.example/cb'] } }), r => r.status === 404);
  L('Better Auth OAuth consent list (not served)', () => req('GET', '/api/auth/oauth2/get-consents', { cookie: A.cookie }), r => r.status === 404);
  L('a made-up wos_ key on /api/mcp', () => req('POST', '/api/mcp', { bearer: 'wos_' + 'a'.repeat(48), headers: mh, body: tl }));
  L('a chat key in the URL (MCP_ALLOW_URL_TOKEN off)', () => req('POST', `/api/mcp/${A.chat}`, { headers: mh, body: tl }));
  L('a chat key in X-API-Key on a page', () => req('GET', '/today', { headers: { 'x-api-key': A.chat } }), r => toLogin(r) || no(r));
  L('a chat key as Bearer on a page', () => req('GET', '/tasks', { bearer: A.chat }), r => toLogin(r) || no(r));
  L('a wkr_ key on a page', () => req('GET', '/today', { bearer: A.wkr }), r => toLogin(r) || no(r));
  for (const [label, h] of [['Bearer chat key', { authorization: `Bearer ${A.chat}` }], ['X-API-Key chat key', { 'x-api-key': A.chat }], ['Bearer Claude Code key', { authorization: `Bearer ${A.code}` }], ['Bearer wkr_ key', { authorization: `Bearer ${A.wkr}` }]]) {
    L(`a server action with a ${label}`, () => action('app/(app)/search-action.ts#searchAction', ['lkq'], { headers: h }), r => toLogin({ ...r, location: r.redirect }) || actNo(r) || r.status === 401);
    L(`a writing server action with a ${label}`, () => action('app/actions.ts#createTaskAction', [{ title: 'lkq by key' }], { headers: h }), r => toLogin({ ...r, location: r.redirect }) || actNo(r) || r.status === 401);
  }
  for (const [label, bearer, cookie] of [['a chat key', A.chat, ''], ['a Claude Code key', A.code, ''], ['a session cookie', '', A.cookie], ['another person\'s chat key as a device key', T.chat, ''], ['a removed member\'s computer', R.wkr, '']]) {
    L(`${label} on /api/worker/jobs`, () => req('GET', '/api/worker/jobs', { bearer, cookie }));
    L(`${label} on /api/worker/status`, () => req('POST', '/api/worker/status', { bearer, cookie, body: { jobs: [] } }));
    L(`${label} on /api/worker/folders`, () => req('POST', '/api/worker/folders', { bearer, cookie, body: { folders: [] } }));
    L(`${label} on /api/worker/stream`, () => streamPeek('/api/worker/stream', { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) }));
  }
  for (const [label, bearer] of [['a Claude Code key', A.code], ['a wkr_ key', A.wkr], ['a removed member\'s chat key', R.chat]]) {
    L(`${label} on /api/admin/health`, () => req('GET', '/api/admin/health', { bearer }));
    L(`${label} on /api/admin/discord/register`, () => req('GET', '/api/admin/discord/register', { bearer }));
    L(`${label} on /api/timetable/today`, () => req('GET', '/api/timetable/today', { bearer }));
    L(`${label} on /api/notes/file`, () => req('GET', `/api/notes/file?p=notes/${A.orgId}/x/x.png`, { bearer }));
    L(`${label} on /api/notes/upload`, () => req('POST', '/api/notes/upload', { bearer, body: { type: 'blob.generate-client-token', payload: { pathname: `notes/${A.orgId}/x/x.png` } } }));
    L(`${label} on /api/stream`, () => streamPeek('/api/stream', { authorization: `Bearer ${bearer}` }));
  }
  L('a chat key on /api/stream', () => streamPeek('/api/stream', { authorization: `Bearer ${A.chat}` }));
  L('a member\'s chat key on /api/admin/health (not the operator)', () => req('GET', '/api/admin/health', { bearer: T.chat }));
  L('another org\'s owner on /api/admin/discord/register?org=<first org>', () => req('POST', `/api/admin/discord/register?org=${A.orgId}`, { bearer: X.chat }));
  L('a chat key on /api/cron/alerts', () => req('GET', '/api/cron/alerts?dry=1', { bearer: A.chat }));
  L('the cron secret in the query', () => req('GET', `/api/cron/alerts?dry=1&key=${CRON}`));
  L('a session cookie on /api/cron/alerts', () => req('GET', '/api/cron/alerts?dry=1', { cookie: A.cookie }));
  L('a chat key on /api/discord/interactions', () => req('POST', '/api/discord/interactions', { bearer: A.chat, body: { type: 2, data: { name: 'today' } } }));
  L('Better Auth API key endpoints (not served)', () => req('POST', '/api/auth/api-key/create', { cookie: A.cookie, body: { name: 'lkq' } }));
  L('Better Auth sign-up (closed)', () => req('POST', '/api/auth/sign-up/email', { body: { email: 'lkqsignup@example.test', password: 'lkq-password-9', name: 'x' } }));
  L('Better Auth organization create (not served)', () => req('POST', '/api/auth/organization/create', { cookie: X.cookie, body: { name: 'lkq', slug: 'lkq' } }));
  // cancelled through the Members action only (the endpoint answered "Member not found" for another organization's invitation)
  L('Better Auth cancel-invitation (not served)', () => req('POST', '/api/auth/organization/cancel-invitation', { cookie: X.cookie, body: { invitationId: A.invite } }), r => r.status === 404);
  return list;
}
