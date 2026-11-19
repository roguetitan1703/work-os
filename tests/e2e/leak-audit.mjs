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
  // guild null: a direct message (no server, no member, only `user`), as a press on a DM button arrives
  const where = guild ? { guild_id: guild, channel_id: guild === G1 ? GEN1 : GEN2, member: { user: { id: user } } } : { channel_id: '999000000000000001', user: { id: user } };
  const body = JSON.stringify({ id: String(dn), application_id: '222222222222222222', type, token, ...where, data, ...extra });
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
for (const c of ['states', 'presence', 'messages']) SHARED.add(c); // slice 1: a project's State and the sessions present on it carry the project's placement
SHARED.add('needs'); // slice 4: a Need follows its project's placement like a task
const OWNED = new Set(['reviews', 'ritualLogs', 'devices', 'workerFolders', 'workerJobs', 'workerSessions', 'agentSessions']); // agentSessions: the hook's session tokens (hash only), its computer owner's
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
  if (col === 'slots') return org.members.includes(pOf(d.ownerId)) ? [pOf(d.ownerId)] : []; // slice 7: heavy-slot leases, written only by the machine's person (the display read keeps the org rule)
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
const VOLATILE = { apikey: ['lastRequest', 'requestCount', 'remaining', 'lastRefillAt', 'updatedAt'], session: ['updatedAt', 'expiresAt'], devices: ['lastSeenAt', 'worker', 'activity', 'claudeSessions', 'reopen'], settings: ['lastSeen', 'mcpAt', 'discordAt', 'at'] };
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
    // A pair of numbers (task refs) is left to the number rule below; an id that happens to be all digits (a short note
    // id, about 4% of runs) beside a made-up one with a letter is still an id.
    const numbers = [r, f].every(v => /^\d+$/.test(String(v)));
    for (const v of [r, f]) if (v !== undefined && v !== null && !numbers && String(v).length >= 2) t = t.split(String(v)).join('<ID>');
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
  // Subtasks (docs/subtasks.md): one under the private task, one under the shared one; each copies its parent's title.
  P.subRef = await mkTask(A.chat, { title: can('pvsubtask', ['A']), parent: P.taskRef });
  S.subRef = await mkTask(A.chat, { title: can('shsubtask', ['A', 'T']), parent: S.taskRef });
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
  // Needs (slice 4): asks to A, in the private project (only A reads them) and the shared one (A and T read them, only A may answer).
  // Two per project: one for the answer control and one for the withdraw control (each destroys its Need).
  {
    const ask = (project, text, o = {}) => mustMcp(A.chat, 'ask', { project, to: 'me', kind: 'approve', ask: text, ...o });
    P.needAns = (await ask(P.projectName, can('pvneed', ['A']) + ' may I?')).need.id;
    P.needWd = (await ask(P.projectName, can('pvneed', ['A']) + ' withdraw this one', { kind: 'do' })).need.id;
    S.needAns = (await ask(S.projectName, can('shneed', ['A', 'T']) + ' may I?')).need.id;
    S.needWd = (await ask(S.projectName, can('shneed', ['A', 'T']) + ' withdraw this one', { kind: 'do' })).need.id;
    // A real OAuth caller for A (word 'chat'): static keys, chat-type included, are all 'agent', so Needs asked with it do not count against the five open Needs the code key may have with A.
    { const raw = randomBytes(24).toString('base64url'); const t0 = new Date(); const cid = 'lkqchatclient' + hex(6);
      await rawDb.collection('oauthClient').insertOne({ clientId: cid, name: 'lkq chat app', redirectUris: ['https://claude.ai/api/mcp/auth_callback'], disabled: false, scopes: ['workos', 'offline_access'], grantTypes: ['authorization_code', 'refresh_token'], tokenEndpointAuthMethod: 'none', createdAt: t0, updatedAt: t0 });
      await rawDb.collection('oauthAccessToken').insertOne({ token: createHash('sha256').update(raw, 'utf8').digest('base64url'), clientId: cid, userId: A.userId, referenceId: A.orgId, scopes: ['workos'], resources: [`${B}/api/mcp`], createdAt: t0, expiresAt: new Date(Date.now() + 7_200_000), revoked: null }); A.oauthTok = 'wosat_' + raw; }
    // for the Discord DM button (flow DC1): one per project, each answered by the control press
    // asked with the other key (another asker word) so they do not count against the five open Needs the code key may have with A
    const askChat = (project, text) => mustMcp(A.oauthTok, 'ask', { project, to: 'me', kind: 'approve', ask: text });
    P.needDc = (await askChat(P.projectName, can('pvneed', ['A']) + ' dm button?')).need.id;
    S.needDc = (await askChat(S.projectName, can('shneed', ['A', 'T']) + ' dm button?')).need.id;
  }
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
  // Slice 1 (docs/flows/step-1.md): a State, a present session and an Orders page on the private and on the shared project
  for (const [o, tg, allow] of [[P, 'pv', ['A']], [S, 'sh', ['A', 'T']]]) {
    o.stateNext = can(`${tg}statenext`, allow);
    await mustMcp(A.chat, 'save_state', { project: o.projectName, base_version: 0, ops: [{ op: 'set_now', text: can(`${tg}statenow`, allow) }, { op: 'add_next', text: o.stateNext }, { op: 'add_later', text: can(`${tg}statelater`, allow), waits_on: can(`${tg}statewait`, allow) }, { op: 'add_decision', text: can(`${tg}statedecision`, allow) }, { op: 'set_where', machine: can(`${tg}statemach`, allow), branch: can(`${tg}statebranch`, allow) }] });
    await mustMcp(A.chat, 'start_work', { project: o.projectName, machine: can(`${tg}presmach`, allow), label: can(`${tg}preslabel`, allow) });
  }
  for (const [o, tg, allow] of [[P, 'pv', ['A']], [S, 'sh', ['A', 'T']]]) {
    o.msg = (await mustMcp(A.chat, 'send_message', { project: o.projectName, kind: 'fyi', body: can(`${tg}msgbody`, allow) })).id;
    o.msgReq = (await mustMcp(A.chat, 'send_message', { project: o.projectName, kind: 'request', body: can(`${tg}msgreq`, allow) })).id;
  }
  P.ordersNote = (await mustMcp(A.chat, 'write_note', { project: P.projectName, title: can('pvorders', ['A']), body: can('pvordersbody', ['A']) })).created?.id;
  S.ordersNote = (await mustMcp(A.chat, 'write_note', { project: S.projectName, title: can('shorders', ['A', 'T']), body: can('shordersbody', ['A', 'T']) })).created?.id;
  await rawDb.collection('notes').updateOne({ _id: S.ordersNote }, { $set: { orders: 'org', ordersBy: A.userId } }); // the flag is set in the app only; the suite sets it directly

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
    // The computer's own report of sessions and of what was open before a restart (sent as the worker sends it, with
    // extra fields that must not be kept), so Open in VS Code / Reopen all have something real to act on.
    {
      const rep = await fetch(B + '/api/worker/status', { method: 'POST', headers: { authorization: `Bearer ${p.wkr}`, 'content-type': 'application/json' }, body: JSON.stringify({
        claudeSessions: [{ sessionId: p.session, folder: 'lkqfolder', title: 'lkq', lastActiveAt: Date.now() - 1000, subagentsActive: 0, startedByWorkOs: false, running: true, origin: 'vscode' }],
        reopen: [{ sessionId: p.session, origin: 'vscode', title: 'lkq', folder: 'lkqfolder', path: 'C:/lkq-secret-path', cwd: 'C:/lkq-secret-cwd', text: 'lkq-secret-text' }],
      }) });
      const dv = await rawDb.collection('devices').findOne({ _id: p.dev });
      check(`reopen: ${p.name}'s report is accepted and keeps only id, origin, title and folder name`, rep.status === 200 && dv.reopen?.items.length === 1 && Object.keys(dv.reopen.items[0]).sort().join() === 'folder,origin,sessionId,title' && !/lkq-secret/.test(JSON.stringify(dv.reopen)), `${rep.status} ${JSON.stringify(dv.reopen)}`);
    }
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
  Object.assign(TARGET.T, { ordersNote: P.ordersNote, msg: P.msg, msgReq: P.msgReq });
  Object.assign(TARGET.X, { ordersNote: S.ordersNote, msg: S.msg, msgReq: S.msgReq });
  Object.assign(FAKE, { trashRef2: 92001, trashRef3: 92002, trashRef4: 92003, comment2: fakeUuid(), sub2: mutate(P.subNote2), invite2: oid(), boiler: mutate(P.boiler), give: 94000 });
  // Needs: T aims at A's private ones (and at the shared ones it can read but may not answer or withdraw); X and R at the shared ones.
  Object.assign(TARGET.T, { needAns: P.needAns, needAnsS: S.needAns, needWd: P.needWd, needWdS: S.needWd });
  Object.assign(TARGET.X, { needAns: S.needAns, needAnsS: S.needAns, needWd: S.needWd, needWdS: S.needWd });
  Object.assign(FAKE, { needAns: fakeUuid(), needAnsS: fakeUuid(), needWd: fakeUuid(), needWdS: fakeUuid() });
  Object.assign(TARGET.T, { needDc: P.needDc, needDcS: S.needDc });
  Object.assign(TARGET.X, { needDc: S.needDc, needDcS: S.needDc });
  Object.assign(FAKE, { needDc: fakeUuid(), needDcS: fakeUuid() });
  // A's own (the control calls)
  FAKE_REF.v = FAKE;
  const OWN = { task: P.task, ref: P.taskRef, looseRef: P.looseRef, trashRef: P.trashRef, archRef: P.archRef, project: P.project, projectName: P.projectName, note: P.projNote, noteTitle: P.projNoteTitle, taskNote: P.noteId, sub: P.subNote, comment: P.comment, item: P.itemRef, itemProject: P.project, device: A.dev, folder: A.folder, session: A.session, job: A.job, review: A.review, push: A.push, passkey: String(A.passkey), invite: A.invite, member: R.userId, remote: P.remote, trashRef2: P.trashRef2, trashRef3: P.trashRef3, trashRef4: P.trashRef4, comment2: P.comment2, sub2: P.subNote2, invite2: A.invite2, boiler: P.boiler, give: P.giveRef };

  OWN.ordersNote = P.ordersNote;
  FAKE.ordersNote = mutate(P.ordersNote);
  OWN.msg = P.msg;
  OWN.msgReq = P.msgReq;
  FAKE.msg = mutate(P.msg);
  FAKE.msgReq = mutate(P.msgReq);
  Object.assign(OWN, { needAns: P.needAns, needAnsS: S.needAns, needWd: P.needWd, needWdS: S.needWd });
  Object.assign(OWN, { needDc: P.needDc, needDcS: S.needDc });

  // ── the probes ──
  const ctx = { A, T, X, R, P, S, XO, TP, G1, G2, GEN1, SEC1, GEN2, DA, DT, DX, DR, DU, mid };
  const probes = [];
  for (const [id, spec] of Object.entries(audit)) {
    if (spec.skip) { console.log(`(audited without a call: ${id} - ${spec.skip})`); continue; }
    for (const pr of [].concat(spec.probes ?? [])) probes.push({ id, ...pr });
  }
  // A persona's credentials for a probe of kind k
  const ECHO_IDS_MORE = ['ordersNote', 'msg', 'msgReq'];
  const ECHO_IDS = ['project', 'itemProject', 'task', 'note', 'taskNote', 'sub', 'comment', 'device', 'folder', 'session', 'job', 'review', 'push', 'passkey', 'invite', 'member', 'comment2', 'sub2', 'invite2', 'boiler'];
  const credOf = (p, k) => (k === 'mcp' ? p.chat : k === 'mcp-code' ? p.code : k === 'worker' ? p.wkr : p.cookie);
  /** Run one probe as persona `who` aimed at `o` (target or fake). */
  async function runProbe(pr, who, o) {
    const p = { A, T, X, R, N: { name: 'N', chat: '', code: '', wkr: '', cookie: '' } }[who];
    const res = await pr.call({ p, o, ctx, cred: credOf(p, pr.kind) });
    // An id the caller sent may come back (a sign-in redirect's next=, an echo); a project id starts with its name's
    // slug, so it holds the name's canary. Ids are taken out; names, titles and remotes are not.
    let text = String(res.text ?? '');
    for (const k of [...ECHO_IDS, ...ECHO_IDS_MORE]) if (o[k]) text = text.split(String(o[k])).join('<id>');
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
  // Needs (slice 4): no MCP path answers a Need, for any key (no tool, no batch op), and a project made private takes its
  // Needs along (a member who read them before cannot read, answer or ask on them after).
  {
    const status = async id => (await rawDb.collection('needs').findOne({ _id: id }))?.status;
    const before = await status(P.needAns);
    const names = ['answer_need', 'answer', 'respond_need', 'approve_need', 'resolve_need', 'reply_need', 'complete_need', 'answer_needs'];
    const worked = [];
    for (const [who, key] of [['A chat', A.chat], ['A code', A.code], ['T chat', T.chat], ['T code', T.code]]) {
      for (const n of names) if ((await mcpCall(key, n, { id: P.needAns, need: P.needAns, option: 'yes' })).ok) worked.push(`${who} ${n}`);
      if ((await mcpCall(key, 'apply_changes', { ops: [{ op: 'answer_need', need: P.needAns, option: 'yes' }] })).ok) worked.push(`${who} apply_changes answer_need`);
    }
    for (const [who, key] of [['A chat', A.chat], ['A code', A.code]]) {
      const r = await mcpCall(key, 'ask', { project: P.projectName, to: 'me', kind: 'approve', ask: 'lkq has this a way to answer', option: 'yes', answer: 'yes' });
      if (r.ok && /"answer"/.test(r.text)) worked.push(`${who} ask returned an answer`);
      await mcpCall(key, 'withdraw_need', { id: r.json?.need?.id ?? 'none' });
    }
    check('needs: no MCP tool or batch op answers a Need, for any key', before === 'open' && (await status(P.needAns)) === 'open' && worked.length === 0, JSON.stringify(worked));
    const lr = await req('POST', '/api/mcp', { bearer: A.code, headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    let listed = [];
    try { const line = lr.text.split('\n').find(l => l.startsWith('data:')); listed = JSON.parse(line ? line.slice(5) : lr.text).result.tools.map(t => t.name); } catch { /* not a list */ }
    check('needs: the tool list holds ask, needs and withdraw_need and nothing that answers', ['ask', 'needs', 'withdraw_need'].every(n => listed.includes(n)) && !listed.some(n => /answer|respond|resolve|approve_need/i.test(n)), listed.filter(n => /need|answer/i.test(n)).join(','));

    const marker = `lkqmv${hex(4)}`;
    const q = `lkqneedmove${hex(3)}`;
    await mustMcp(A.chat, 'add_project', { name: q });
    const asked = (await mustMcp(A.code, 'ask', { project: q, to: 'me', kind: 'approve', ask: `${marker} will it move` })).need;
    const seen = async key => (await mustMcp(key, 'needs', { project: q, status: 'all' })).needs.length;
    const tBefore = await seen(T.chat);
    await mustMcp(A.chat, 'update_project', { project: q, visibility: 'private' });
    const doc = await rawDb.collection('needs').findOne({ _id: asked.id });
    const tList = await mcpCall(T.chat, 'needs', { project: q, status: 'all' });
    const tAll = await mcpCall(T.chat, 'needs', { status: 'all' });
    const tAsk = await mcpCall(T.chat, 'ask', { project: q, to: 'me', kind: 'approve', ask: 'lkq into a project that went private' });
    const tWd = await mcpCall(T.chat, 'withdraw_need', { id: asked.id });
    const tAns = await action('app/(app)/needs/actions.ts#answerNeedAction', [asked.id, 'yes'], { cookie: T.cookie });
    const after = await rawDb.collection('needs').findOne({ _id: asked.id });
    check('needs: a project made private takes its Needs along (stamped private to its owner)', doc?.visibility === 'private' && doc.ownerId === A.userId && !(doc.sharedWith ?? []).length, JSON.stringify([doc?.visibility, doc?.ownerId === A.userId]));
    check('needs: ...so a member who read them before cannot read, ask on, withdraw or answer them', tBefore === 1 && !tList.ok && !tAll.text.includes(marker) && !tAsk.ok && !tWd.ok && (tAns.value?.ok === false || tAns.error) && after.status === 'open' && !(await rawDb.collection('needs').countDocuments({ projectId: doc.projectId, 'from.actor.userId': T.userId })), JSON.stringify([tBefore, tList.ok, tAll.text.includes(marker), tAsk.ok, tWd.ok, tAns.value, after.status]));
    check('needs: ...and the owner still reads them', (await mustMcp(A.chat, 'needs', { project: q })).needs.length === 1);
    await mustMcp(A.code, 'withdraw_need', { id: asked.id }); // frees a place: the owner's own control ask below is the 5th, not the 6th
    // The asker cannot answer its own Need to someone else; a review Need (slice 5) is the owner's alone: a teammate who reads
    // it cannot answer or withdraw it, and an agent cannot take it back.
    {
      const toT = (await mustMcp(A.chat, 'ask', { project: S.projectName, to: T.email, kind: 'approve', ask: 'lkq for T only' })).need;
      const self = await action('app/(app)/needs/actions.ts#answerNeedAction', [toT.id, 'yes'], { cookie: A.cookie });
      check('needs: the asker cannot answer its own Need to someone else (refused, still open)', (self.value?.ok === false || self.error) && (await rawDb.collection('needs').findOne({ _id: toT.id })).status === 'open', JSON.stringify(self.value ?? self.error ?? '').slice(0, 160));
      const rv = (await mustMcp(A.chat, 'add_task', { title: 'lkq review probe', project: S.projectName, result_kind: 'code' })).created;
      await mustMcp(A.code, 'hand_in', { task: rv.ref, changed: 'lkq review probe done', left: ['lkq more'] });
      const rn = await rawDb.collection('needs').findOne({ taskRef: rv.ref, kind: 'review', status: 'open' });
      const tAnsR = await action('app/(app)/needs/actions.ts#answerNeedAction', [rn?._id, 'accept'], { cookie: T.cookie });
      const tWdR = await mcpCall(T.chat, 'withdraw_need', { id: rn?._id });
      const aWdR = await mcpCall(A.code, 'withdraw_need', { id: rn?._id });
      const aDoneR = await mcpCall(A.code, 'update_task', { task: rv.ref, status: 'Done' });
      const rAfter = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: rv.ref });
      const xHi = await mcpCall(X.chat, 'hand_in', { task: rv.ref, changed: 'lkq other org hand in' });
      const tGet = await mcpCall(T.chat, 'get_task', { task: rv.ref });
      let tHand = null;
      try { tHand = JSON.parse(tGet.text).handIn; } catch { /* not JSON */ }
      check('needs: a hand-in on a task of another organization is refused', !xHi.ok && !(await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: rv.ref, 'handIn.changed': 'lkq other org hand in' })), xHi.text.slice(0, 120));
      check('needs: a teammate reading get_task sees the agent hand-in labelled writtenBy', !!tHand?.writtenBy, JSON.stringify(tHand)?.slice(0, 200));
      check('needs: a review Need goes to the task owner, who alone can answer; others and agents cannot answer, withdraw or close past it', !!rn && rn.to === A.userId && (tAnsR.value?.ok === false || tAnsR.error) && !tWdR.ok && !aWdR.ok && rAfter.status !== 'Done' && !!(await rawDb.collection('needs').findOne({ taskRef: rv.ref, kind: 'review', status: 'open' })), JSON.stringify([!!rn, tAnsR.value?.ok, tWdR.ok, aWdR.ok, aDoneR.ok, rAfter?.status]));
    }
    // Discord may steer, never release: an app-only Need (asked so, or by its words) and a review are refused even to their addressee's own linked account
    // The fixtures above already used most of the 10 asks an hour from A to A: age them so the three below are not refused by that limit (not what this audit probes).
    await rawDb.collection('needs').updateMany({ 'from.actor.userId': A.userId, to: A.userId }, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    const appNeed = (await mustMcp(A.oauthTok, 'ask', { project: q, to: 'me', kind: 'approve', ask: `${marker} app only`, app_only: true })).need.id;
    const wordNeed = (await mustMcp(A.oauthTok, 'ask', { project: q, to: 'me', kind: 'do', ask: `${marker} deploy to production` })).need.id;
    const revNeed = (await mustMcp(A.oauthTok, 'ask', { project: q, to: 'me', kind: 'chase', ask: `${marker} review` })).need.id;
    await rawDb.collection('needs').updateOne({ _id: revNeed }, { $set: { kind: 'review' } });
    const dcPress = async (id, opt) => (await interact(null, DA, 3, { custom_id: `wo:need:${id}:${opt}`, component_type: 2 })).text;
    const pApp = await dcPress(appNeed, 'yes'), pWord = await dcPress(wordNeed, 'done'), pRev = await dcPress(revNeed, 'done');
    const stillOpen = async id => (await rawDb.collection('needs').findOne({ _id: id }))?.status === 'open';
    check('needs: an app-only Need, a Need whose words make it app-only and a review are refused when their addressee presses them in Discord', [pApp, pWord, pRev].every(t => /"type":\s*4/.test(t) && !/"type":\s*7[,}]/.test(t)) && (await stillOpen(appNeed)) && (await stillOpen(wordNeed)) && (await stillOpen(revNeed)), JSON.stringify([pApp, pWord, pRev]).slice(0, 400));
    await rawDb.collection('needs').updateMany({ _id: { $in: [appNeed, wordNeed, revNeed] } }, { $set: { status: 'withdrawn', closedAt: new Date() } }); // so they do not count against the five open Needs per asker
    // An app-only Need's answer text is the addressee's and the asker's person's alone; a teammate who reads the project sees that it was answered.
    {
      const secret = `lkqans${hex(5)}`;
      const ao = (await mustMcp(A.oauthTok, 'ask', { project: S.projectName, to: 'me', kind: 'approve', ask: `lkq answer text probe`, app_only: true })).need;
      const now = new Date();
      await rawDb.collection('needs').updateOne({ _id: ao.id }, { $set: { status: 'answered', answer: { option: 'yes', text: secret, by: A.userId, via: 'app', at: now }, answeredAt: now, closedAt: now, waitedMs: 1000 } });
      const tRead = await mcpCall(T.chat, 'needs', { project: S.projectName, status: 'all' });
      const aRead = await mcpCall(A.chat, 'needs', { project: S.projectName, status: 'all' });
      const tNeed = (JSON.parse(tRead.text).needs ?? []).find(n => n.id === ao.id);
      check('needs: a teammate reading an app-only Need sees it was answered (by whom, when) but not the answer text', tRead.ok && !tRead.text.includes(secret) && tNeed?.status === 'answered' && tNeed.answer?.text === '(answer hidden)' && !!tNeed.answer?.at, JSON.stringify(tNeed)?.slice(0, 250));
      check('needs: ...and the addressee still reads the answer text', aRead.ok && aRead.text.includes(secret));
      await rawDb.collection('needs').updateOne({ _id: ao.id }, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    }
    await sleep(2000); // the alerts these asks queued are flushed (after the response) before the first persona's writes are measured
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
  // Slice 1: a project made private takes its State and presence along; Orders are set and written only by whoever holds the layer
  {
    const nm = can('mvproj', ['A', 'T']);
    const cn = `lkqmvstate${hex(4)}`;
    CANARIES.push({ s: cn, tag: 'mvstate', allow: new Set(['A', 'T']) });
    await mustMcp(A.chat, 'add_project', { name: nm });
    await mustMcp(A.chat, 'save_state', { project: nm, ops: [{ op: 'add_next', text: cn }, { op: 'add_decision', text: cn + 'd' }] });
    await mustMcp(A.chat, 'start_work', { project: nm, machine: 'lkqmv', label: cn + 'p' });
    // Archiving a decision: the app only, and only the project's owner (or an organization owner)
    const pidNm = (await rawDb.collection('projects').findOne({ orgId: A.orgId, name: nm }))._id;
    const decId = (await mustMcp(A.chat, 'get_state', { project: nm })).state.decisions[0].id;
    const viaMcp = await mcpCall(A.chat, 'save_state', { project: nm, ops: [{ op: 'archive_decision', id: decId }] });
    check('State: archive_decision through MCP is refused, even for the owner', !viaMcp.ok && /in the app/.test(viaMcp.text), viaMcp.text.slice(0, 200));
    const archAct = (who) => action('app/(app)/projects/[id]/state-actions.ts#saveStateAction', [pidNm, [{ op: 'archive_decision', id: decId }]], { cookie: who.cookie });
    const tArch = await archAct(T);
    check('State: a teammate who does not own the project cannot archive a decision in the app', tArch.value?.ok === false && /owner/.test(tArch.value?.error ?? ''), JSON.stringify(tArch.value));
    const aArch = await archAct(A);
    check('State: the owner archives it in the app, and it leaves the State', aArch.value?.ok === true && !JSON.stringify((await mustMcp(A.chat, 'get_state', { project: nm })).state.decisions).includes(decId), JSON.stringify(aArch.value));
    // T marks a page of the shared project as their own person Orders; when the project goes private the page changes owner and must not become A's Orders
    const tpn = (await mustMcp(T.code, 'write_note', { project: nm, title: 'lkq T person rules', body: 'lkqpersonrulesbody' })).created?.id;
    const flag = (who, id, layer) => action('app/(app)/notes/orders-actions.ts#setOrdersAction', [id, layer], { cookie: who.cookie });
    const fp = await flag(T, tpn, 'person');
    check('Orders: a member marks their own page as their person Orders', fp.value?.ok === true, JSON.stringify(fp.value));
    const mcn = `lkqmvmsg${hex(4)}`;
    CANARIES.push({ s: mcn, tag: 'mvmsg', allow: new Set(['A', 'T']) });
    const mm = await mustMcp(A.chat, 'send_message', { project: nm, kind: 'fyi', body: mcn, word: 'person' });
    check('Messages: word is set by the server, an argument for it is ignored', mm.word === 'agent' && (await rawDb.collection('messages').findOne({ _id: mm.id })).from.word === 'agent', JSON.stringify(mm));
    const tm = await mcpCall(T.code, 'send_message', { project: nm, kind: 'fyi', body: 'lkq from T', word: 'person' });
    check('Messages: a teammate can send to a shared project, and their word is agent whatever they pass', tm.ok && JSON.parse(tm.text).word === 'agent', tm.text.slice(0, 200));
    const tib = await mcpCall(T.chat, 'inbox', { project: nm });
    scan('T', 'mv inbox (before)', tib.text);
    check('Messages: a teammate reads a shared project’s inbox', tib.ok && tib.text.includes(mcn), tib.text.slice(0, 200));
    const tBefore = await mcpCall(T.chat, 'get_state', { project: nm });
    scan('T', 'mv get_state (before)', tBefore.text);
    check('State: a teammate reads a shared project’s State', tBefore.ok && tBefore.text.includes(cn), tBefore.text.slice(0, 200));
    const tStart = await mcpCall(T.code, 'start_work', { project: nm, machine: 'lkqmvt', label: 'tess' });
    check('State: a teammate can start work on it (presence is theirs)', tStart.ok, tStart.text.slice(0, 200));
    // H3: read state and addressing never leave the server, and nobody else's session id reaches a teammate (alsoHere, target, messages)
    const aSessions = (await rawDb.collection('presence').find({ userId: A.userId, projectId: (await rawDb.collection('projects').findOne({ orgId: A.orgId, name: nm }))._id }).toArray()).map(p => p.session).filter(Boolean);
    const tAll3 = tib.text + tStart.text + (await mcpCall(T.code, 'inbox', { project: nm })).text;
    check('Messages: seenBy and toSids are never in an output', !/seenBy|toSids/.test(tAll3) && !/seenBy|toSids/.test(tib.text), '');
    check('Messages: no other person’s session id in alsoHere, the target or a message', aSessions.length > 0 && aSessions.every(sid => !tAll3.includes(sid)), String(aSessions.length));
    // Activity (note e56029b458): the State and message rows of a shared project reach the teammate's feed until it goes private
    const tActBefore = await mcpCall(T.chat, 'recent_activity', { since: '1d', limit: 300 });
    check('Activity: a teammate’s feed has the shared project’s State and message rows', tActBefore.ok && tActBefore.text.includes(cn) && (tActBefore.json?.events ?? []).some(e => e.project === nm && e.type === 'message_sent'), tActBefore.text.slice(0, 200));
    await mustMcp(A.chat, 'update_project', { project: nm, visibility: 'private' });
    const pid = (await rawDb.collection('projects').findOne({ orgId: A.orgId, name: nm }))._id;
    const actd = await rawDb.collection('activity').find({ projectId: pid, taskId: { $exists: false } }).toArray();
    check('Activity: a project made private takes its State, message and project rows along (placed private, owned by its owner)', actd.length >= 4 && actd.every(a => a.visibility === 'private' && a.ownerId === A.userId), JSON.stringify(actd.map(a => [a.type, a.visibility, a.ownerId])));
    for (const what of ['all', 'state', 'messages', 'projects']) {
      const r = await mcpCall(T.chat, 'recent_activity', { since: '1d', limit: 300, what });
      scan('T', `mv recent_activity what=${what} (after private)`, r.text);
      check(`Activity: after it was made private the teammate’s feed carries none of it (what=${what})`, r.ok && !r.text.includes(cn) && !r.text.includes(nm), r.text.slice(0, 200));
    }
    const tRev = await req('GET', '/review?view=activity', { cookie: T.cookie });
    check('Activity: …nor the teammate’s Review › Activity page', tRev.status === 200 && !tRev.text.includes(cn) && !tRev.text.includes(nm), String(tRev.status));
    const sd = await rawDb.collection('states').findOne({ _id: pid });
    const pr = await rawDb.collection('presence').find({ projectId: pid }).toArray();
    check('State: a project made private takes its State along (placed private, owned by its owner)', sd?.visibility === 'private' && sd.ownerId === A.userId, JSON.stringify(sd && [sd.visibility, sd.ownerId]));
    check('State: …and the presence rows (both sessions) with it', pr.length === 2 && pr.every(p => p.visibility === 'private' && p.ownerId === A.userId), JSON.stringify(pr.map(p => [p.visibility, p.ownerId])));
    const mvd = await rawDb.collection('messages').find({ projectId: pid }).toArray();
    check('Messages: a project made private takes its messages along (placed private, owned by its owner)', mvd.length === 2 && mvd.every(m => m.visibility === 'private' && m.ownerId === A.userId), JSON.stringify(mvd.map(m => [m.visibility, m.ownerId])));
    for (const [tool, args] of [['inbox', { project: nm }], ['send_message', { project: nm, kind: 'fyi', body: 'lkq after private' }], ['message_status', { id: mm.id, status: 'seen' }], ['reply', { id: mm.id, body: 'lkq after private' }]]) {
      const r = await mcpCall(T.chat, tool, args);
      scan('T', `mv ${tool} (after private)`, r.text);
      check(`Messages: after the project was made private the teammate is refused (${tool})`, !r.ok && /not found/i.test(r.text) && !r.text.includes(mcn), r.text.slice(0, 200));
    }
    const tinb = await mcpCall(T.chat, 'inbox', {});
    scan('T', 'mv inbox (all, after private)', tinb.text);
    check('Messages: …and the all-projects inbox carries nothing of it', tinb.ok && !tinb.text.includes(mcn), tinb.text.slice(0, 200));
    for (const [tool, args] of [['get_state', { project: nm }], ['start_work', { project: nm }], ['save_state', { project: nm, ops: [{ op: 'add_next', text: 'lkq after private' }] }], ['import_state', { project: nm, markdown: '## Now\n- x' }], ['get_project', { project: nm }]]) {
      const r = await mcpCall(T.chat, tool, args);
      scan('T', `mv ${tool} (after private)`, r.text);
      check(`State: after it was made private the teammate is refused (${tool})`, !r.ok && /not found/i.test(r.text) && !r.text.includes(cn), r.text.slice(0, 200));
    }
    const tpd = await rawDb.collection('notes').findOne({ _id: tpn });
    check('Orders: the page that changed owner lost its person-Orders flag', tpd.ownerId === A.userId && !tpd.orders && !tpd.ordersBy, JSON.stringify([tpd.ownerId, tpd.orders]));
    const aStart = await mcpCall(A.chat, 'start_work', { project: nm });
    check('Orders: the owner’s start_work does not carry it as their Orders', aStart.ok && !aStart.text.includes('lkqpersonrulesbody'), aStart.text.slice(0, 200));
    // T's session on that project no longer gets a "for you" line, nor anything about it, even for a new task
    await mustMcp(A.chat, 'add_task', { title: 'lkq task after private', project: nm });
    const tAfter = await mcpCall(T.code, 'list_tasks', {});
    scan('T', 'mv list_tasks (after private)', tAfter.text);
    check('State: …and their present session’s answers carry nothing about it', tAfter.ok && !/forYou/.test(tAfter.text) && !tAfter.text.includes(cn), tAfter.text.slice(0, 200));
    check('State: the owner still reads it', (await mcpCall(A.chat, 'get_state', { project: nm })).text.includes(cn));
    // Orders: who may set the flag and who may change the page
    let f = await flag(T, S.note, 'org');
    check('Orders: a member who is not an owner cannot make a page the organization’s Orders', /Only an owner/.test(JSON.stringify(f.value)) && !(await rawDb.collection('notes').findOne({ _id: S.note })).orders, JSON.stringify(f.value));
    f = await flag(T, S.note, 'project');
    check('Orders: a teammate who does not own the project cannot make a page its Orders', /project's owner/.test(JSON.stringify(f.value)) && !(await rawDb.collection('notes').findOne({ _id: S.note })).orders, JSON.stringify(f.value));
    f = await flag(T, S.note, 'person');
    check('Orders: nor mark a page they do not own as their own', /own pages/.test(JSON.stringify(f.value)) && !(await rawDb.collection('notes').findOne({ _id: S.note })).orders, JSON.stringify(f.value));
    const before = (await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body;
    // H9: a teammate's keys (with a why, even) are still refused; the holder's own Claude may change the text, with a why.
    for (const [label, key] of [['chat key', T.chat], ['code key', T.code]]) {
      const w = await mcpCall(key, 'write_note', { note_id: S.ordersNote, append: 'lkq injected orders', why: 'lkq injected' });
      check(`Orders: an MCP write to the organization Orders page is refused (${label})`, !w.ok && /Orders/.test(w.text), w.text.slice(0, 200));
    }
    check('Orders: the page is unchanged', (await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body === before);
    const noWhy = await mcpCall(A.chat, 'write_note', { note_id: S.ordersNote, append: 'lkq owner orders' });
    check('Orders: the owner’s own Claude is asked to say why (no why: refused, unchanged)', !noWhy.ok && /why/.test(noWhy.text) && (await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body === before, noWhy.text.slice(0, 200));
    const ownerW = await mcpCall(A.chat, 'write_note', { note_id: S.ordersNote, append: 'lkq owner orders', why: 'lkq audit' });
    const afterOwner = await rawDb.collection('notes').findOne({ _id: S.ordersNote });
    check('Orders: the owner’s own Claude changes the organization Orders with a why, and it makes version 2 (changed from: refused for every key)', ownerW.ok && ownerW.json?.orders?.version === 2 && afterOwner.body.includes('lkq owner orders') && afterOwner.ordersV === 2 && afterOwner.ordersLog?.[0]?.why === 'lkq audit', ownerW.text.slice(0, 200));
    for (const [label, key] of [['chat key', T.chat], ['code key', T.code]]) {
      await mcpCall(key, 'write_note', { note_id: S.ordersNote, body: 'lkq replaced', why: 'lkq injected' });
    }
    check('Orders: after the teammates’ second tries the page is still the owner’s version 2', (await rawDb.collection('notes').findOne({ _id: S.ordersNote })).ordersV === 2 && (await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body === afterOwner.body);
    for (const [label, key] of [['chat key', T.chat], ['code key', T.code], ['owner chat key', A.chat]]) {
      for (const args of [{ note_id: S.ordersNote, archived: true, why: 'lkq' }, { parent_id: S.ordersNote, title: 'lkq sub of orders', why: 'lkq' }]) {
        const w = await mcpCall(key, 'write_note', args);
        check(`Orders: archiving the page or adding a sub-page through MCP is refused (${label}, ${args.archived ? 'archive' : 'sub-page'})`, !w.ok && /Orders/.test(w.text), w.text.slice(0, 200));
      }
    }
    const del = await mcpCall(A.chat, 'delete_note', { note_id: S.ordersNote, title: afterOwner.title });
    check('Orders: …and the owner’s Claude cannot trash it either', !del.ok && /Orders/.test(del.text) && !(await rawDb.collection('notes').findOne({ _id: S.ordersNote })).deletedAt, del.text.slice(0, 200));
    // H9 review: the owner's own Claude Code key needs a real session; a session the dispatcher started (its text can come from a teammate) and a call that names none are refused.
    const ownerNoSess = await mcpCall(A.code, 'write_note', { note_id: S.ordersNote, append: 'lkq code nosession', why: 'lkq audit' });
    check('Orders: the owner’s Claude Code key with no session cannot change the Orders (unchanged)', !ownerNoSess.ok && /Orders/.test(ownerNoSess.text) && !(await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body.includes('lkq code nosession'), ownerNoSess.text.slice(0, 200));
    await mustMcp(A.code, 'start_work', { project: S.projectName, label: 'lkq dispatched · worker · #77', session: 'lkqdispsess' });
    const disp = await mcpCall(A.code, 'write_note', { note_id: S.ordersNote, append: 'lkq dispatched injected', why: 'lkq audit', session: 'lkqdispsess' }, { 'X-Work-OS-Session': 'lkqdispsess' });
    check('Orders: a session the dispatcher started (label "worker · #ref") cannot change the Orders (unchanged)', !disp.ok && /Orders/.test(disp.text) && !(await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body.includes('lkq dispatched injected'), disp.text.slice(0, 200));
    await mustMcp(A.code, 'start_work', { project: S.projectName, label: 'lkq interactive', session: 'lkqintsess' });
    const ownerCode = await mcpCall(A.code, 'write_note', { note_id: S.ordersNote, append: 'lkq owner code orders', why: 'lkq audit' }, { 'X-Work-OS-Session': 'lkqintsess' });
    check('Orders: the owner’s Claude Code key in a real session changes the Orders with a why (version 3)', ownerCode.ok && ownerCode.json?.orders?.version === 3 && (await rawDb.collection('notes').findOne({ _id: S.ordersNote })).body.includes('lkq owner code orders'), ownerCode.text.slice(0, 200));
    const start = await mcpCall(T.chat, 'start_work', { project: S.projectName });
    scan('T', 'start_work (orders)', start.text);
    check('Orders: the organization Orders reach a teammate’s start_work', start.ok && start.text.includes(CANARIES.find(c => c.tag === 'shordersbody').s), start.text.slice(0, 200));
    const xs = await mcpCall(X.chat, 'start_work', { project: S.projectName });
    check('Orders: the other organization cannot start work on it, so reads none of it', !xs.ok);
  }
  // Slice 7: the roster follows the project. A worker row and a project's "could be running" line are seen only by those who can read the project.
  {
    const nm = can('rosterproj', ['A']);
    const idle = can('rosteridle', ['A']);
    const cn = `lkqrostercanary${hex(4)}`;
    CANARIES.push({ s: cn, tag: 'roster', allow: new Set(['A']) });
    await mustMcp(A.chat, 'add_project', { name: nm, visibility: 'private' });
    await mustMcp(A.chat, 'add_project', { name: idle, visibility: 'private' });
    await mustMcp(A.chat, 'save_state', { project: idle, ops: [{ op: 'add_next', text: cn + 'next' }] });
    const tk = await mustMcp(A.chat, 'add_task', { title: cn + 'task', project: nm });
    await mustMcp(A.code, 'start_work', { project: nm, machine: cn + 'box', label: cn + 'label', model: cn + 'model', account: cn + 'acct', branch: cn + 'br', session: 'lkqrostersess' });
    await mustMcp(A.code, 'set_doing', { task: tk.created.ref, session: 'lkqrostersess' });
    const mine = await req('GET', '/claude?tab=workers', { cookie: A.cookie });
    check('roster: the owner sees their worker and the project that could be running', mine.text.includes(cn + 'model') && mine.text.includes(cn + 'task') && mine.text.includes(idle), mine.text.slice(0, 200));
    for (const p of [T, X, R]) {
      const r = await req('GET', '/claude?tab=workers', { cookie: p.cookie });
      scan(p.name, 'roster Workers tab', r.text);
      check(`roster: ${p.name} sees no worker and no "could be running" line of a private project`, !r.text.includes(cn) && !r.text.includes(nm) && !r.text.includes(idle), r.text.slice(0, 160));
      for (const [label, n] of [['worker project', nm], ['idle project', idle]]) {
        const id = (await rawDb.collection('projects').findOne({ orgId: A.orgId, name: n }))._id;
        const pr = await req('GET', `/projects/${id}`, { cookie: p.cookie });
        // (not scanned for the project canaries: a project page echoes the requested id, which is the project name slug)
        check(`roster: ${p.name} gets no project page (${label}) and so no worker line`, !pr.text.includes(cn), pr.text.slice(0, 120));
      }
    }
    // set_doing stores only a task id and refuses a task of another project, so a private task title never reaches a widely read worker row
    {
      const op = can('rosterorgp', ['A', 'T', 'R']);
      const wl = `lkqrosterorglabel${hex(4)}`;
      CANARIES.push({ s: wl, tag: 'rosterorg', allow: new Set(['A', 'T', 'R']) });
      await mustMcp(A.chat, 'add_project', { name: op, visibility: 'org' });
      await mustMcp(A.code, 'start_work', { project: op, machine: 'lkq-orgbox', label: wl, session: 'lkqorgsess' });
      const bad = await mcpCall(A.code, 'set_doing', { task: tk.created.ref, session: 'lkqorgsess' });
      check('roster: set_doing refuses a task of another (private) project', !bad.ok, bad.text.slice(0, 160));
      for (const p of [T, R, X]) {
        const r = await req('GET', '/claude?tab=workers', { cookie: p.cookie });
        scan(p.name, 'roster Workers tab (org project worker)', r.text);
        const st = await mcpCall(p.chat || T.chat, 'start_work', { project: op });
        if (st.ok) scan(p.name, 'start_work others list', st.text);
      }
      // a chosen-people project: only the people chosen see its worker, and not after it goes private
      const cp = can('rosterchosen', ['A', 'T']);
      const cl = `lkqrosterchosenlabel${hex(4)}`;
      CANARIES.push({ s: cl, tag: 'rosterchosen', allow: new Set(['A', 'T']) });
      await mustMcp(A.chat, 'add_project', { name: cp, visibility: 'members', shared_with: [T.email] });
      await mustMcp(A.code, 'start_work', { project: cp, machine: 'lkq-chosenbox', label: cl, session: 'lkqchosensess' });
      const tSees = await mcpCall(T.chat, 'start_work', { project: cp, session: 'lkqchosentess' });
      check('roster: a person the project is shared with sees its worker (start_work others list)', tSees.ok && tSees.text.includes(cl), tSees.text.slice(0, 160));
      for (const p of [R, X]) {
        const r = await req('GET', '/claude?tab=workers', { cookie: p.cookie });
        scan(p.name, 'roster Workers tab (chosen project)', r.text);
        check(`roster: ${p.name} sees no worker of a chosen-people project`, !r.text.includes(cl) && !r.text.includes(cp), r.text.slice(0, 120));
      }
      await mustMcp(A.chat, 'update_project', { project: cp, visibility: 'private' });
      const after = await req('GET', '/claude?tab=workers', { cookie: T.cookie });
      const afterMcp = await mcpCall(T.chat, 'start_work', { project: cp, session: 'lkqchosentess' });
      check('roster: a worker whose project went private after start_work disappears for the others', !after.text.includes(cl) && !afterMcp.ok && !afterMcp.text.includes(cl), after.text.slice(0, 100) + afterMcp.text.slice(0, 100));
    }
    // a heavy slot is the person's own machine: nobody else sees its holders, and a teammate's same-named machine is theirs
    const sl = await mcpCall(A.code, 'slot', { action: 'acquire', machine: 'lkq-slotbox', session: 'lkqslotsess' });
    const tsl = await mcpCall(T.code, 'slot', { action: 'acquire', machine: 'lkq-slotbox', session: 'lkqslotsess' });
    scan('T', 'slot answer', tsl.text);
    check('roster: a teammate’s machine of the same name is their own (one holder, theirs)', sl.ok && tsl.ok && JSON.parse(tsl.text).held === 1 && JSON.parse(tsl.text).holders.length === 1, tsl.text.slice(0, 200));
  }
  // H5: list_sessions and a handover stay inside their readers (the private project's people, the same organization)
  {
    const nm = can('h5priv', ['A']);
    const cn = `lkqh5canary${hex(4)}`;
    CANARIES.push({ s: cn, tag: 'h5', allow: new Set(['A']) });
    await mustMcp(A.chat, 'add_project', { name: nm, visibility: 'private' });
    await mustMcp(A.code, 'start_work', { project: nm, machine: cn + 'box', label: cn + 'label', branch: cn + 'br', session: 'lkqh5sess' });
    const ended = await mustMcp(A.code, 'end_work', { project: nm, base_version: 0, state: [{ op: 'set_now', text: cn + 'now' }], friction: cn + 'friction', handover: { step: cn + 'step', in_flight: [cn + 'flight'] }, session: 'lkqh5sess' });
    await mustMcp(A.code, 'start_work', { project: nm, machine: cn + 'box', label: cn + 'label2', session: 'lkqh5live' });
    // H10: a feedback line on the private project (its text, tool and rule carry the canary) is a row on the project's State
    await mustMcp(A.code, 'feedback', { project: nm, text: cn + 'feedbacktext', tool: cn + 'fbtool', rule: cn + 'fbrule', session: 'lkqh5sess' });
    const mine = await mcpCall(A.code, 'list_sessions', { include_gone: true });
    check('h5: the owner sees their sessions in list_sessions (live and gone)', mine.ok && mine.text.includes(cn + 'label') && mine.text.includes(cn + 'label2'), mine.text.slice(0, 200));
    for (const p of [T, R, X]) {
      const k = p.code || p.chat;
      const r = await mcpCall(k, 'list_sessions', { include_gone: true });
      scan(p.name, 'list_sessions', r.text);
      const byProject = await mcpCall(k, 'list_sessions', { project: nm, include_gone: true });
      check(`h5: ${p.name}'s list_sessions for the private project is refused as not found`, !byProject.ok && /not found|Unauthorized/i.test(byProject.text), byProject.text.slice(0, 120));
      check(`h5: ${p.name}'s list_sessions names no session of a private project`, (!r.ok || (!r.text.includes(nm) && !r.text.includes(cn))), r.text.slice(0, 160));
      const st = await mcpCall(k, 'start_work', { project: nm });
      check(`h5: ${p.name} cannot start work on the private project and so gets no handover`, !st.ok, st.text.slice(0, 120));
      const rn = await mcpCall(k, 'read_note', { note_id: ended.handover.id });
      scan(p.name, 'read_note (handover)', rn.text);
      check(`h5: ${p.name} cannot read the handover note`, !rn.ok || !rn.text.includes(cn), rn.text.slice(0, 120));
      const fd = await mcpCall(k, 'recent_activity', { limit: 50 });
      scan(p.name, 'recent_activity (session_ended, feedback)', fd.text);
      const fb = await mcpCall(k, 'feedback', { project: nm, text: 'probe' });
      check(`h10: ${p.name} cannot send feedback to the private project`, !fb.ok, fb.text.slice(0, 120));
      const ew = await mcpCall(k, 'end_work', { project: nm, state: [{ op: 'set_where', machine: 'x', branch: 'y' }], friction: 'probe', handover: { step: 'probe' } });
      check(`h5: ${p.name} cannot end work on, or leave a handover in, the private project`, !ew.ok, ew.text.slice(0, 120));
    }
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
  add('mcp list_tasks', M('list_tasks', { include_closed: true }), Mc('list_tasks', { include_closed: true, archived: true }, { label: 'code key, archived' }), M('list_tasks', t => ({ project: t.projectName, include_closed: true }), aim(['projectName'], { label: 'by project', ok: r => r.ok && r.json?.total > 0 })), M('list_tasks', { query: 'lkq', include_closed: true }, { label: 'search' }), M('list_tasks', t => ({ parent: t.ref, include_closed: true }), aim(['ref'], { label: 'by parent' })));
  add('mcp get_task', M('get_task', t => ({ task: t.task }), aim(['task'])), M('get_task', t => ({ task: `#${t.ref}` }), aim(['ref'], { label: 'by ref' })), M('get_task', { task: 'constructor' }, { label: 'prototype key', aim: true, aimKeys: [], control: false }), Mc('get_task', t => ({ task: t.ref }), aim(['ref'], { label: 'code key' })));
  add('mcp add_task', M('add_task', t => ({ title: 'lkq probe task', depends_on: [t.ref] }), aim(['ref'], { label: 'waits on' })), M('add_task', t => ({ title: 'lkq probe in project', project: t.project }), { label: 'into a project id', controlOk: r => r.ok, ok: r => r.ok && !/"project":\s*"lkqpvproj|"project":\s*"lkqshproj/.test(r.text) }), M('add_task', t => ({ title: 'lkq probe subtask', parent: t.ref }), aim(['ref'], { label: 'under a task' })));
  add('mcp update_task', M('update_task', t => ({ task: t.task, title: 'lkq hacked' }), aim(['task'])), M('update_task', t => ({ task: t.ref, assignee: 'me' }), aim(['ref'], { label: 'assign to me' })));
  add('mcp log_progress', M('log_progress', t => ({ task: t.ref, progress: 40 }), aim(['ref'])));
  add('mcp complete_task', M('complete_task', t => ({ task: t.task }), aim(['task'], { stage: 1 })));
  add('mcp hand_in', M('hand_in', t => ({ task: t.ref, changed: 'lkq probe hand in', checked: 'lkq', rating: 'works', left: ['lkq left'] }), aim(['ref'], { stage: 1, controlOk: r => r.ok || /already Done/.test(r.text) })));
  add('mcp add_comment', M('add_comment', t => ({ task: t.ref, note: 'lkq probe comment' }), aim(['ref'])));
  add('mcp update_checklist', M('update_checklist', t => ({ task: t.task, add: ['lkq probe item'] }), aim(['task'])));
  add('mcp list_projects', M('list_projects', { include_inactive: true }), Mc('list_projects', { include_inactive: true }, { label: 'code key' }));
  add('mcp add_project', M('add_project', t => ({ name: t.projectName }), { label: 'a name someone else uses', ok: r => r.ok, control: false /* the owner gets "already exists" by design */ }));
  add('mcp update_project', M('update_project', t => ({ project: t.project, description: 'lkq hacked' }), aim(['project'])), M('update_project', t => ({ project: t.projectName, visibility: 'org' }), aim(['projectName'], { label: 'by name, make shared', control: false })));
  add('mcp daily_summary', M('daily_summary', { since: '30d' }), Mc('daily_summary', { since: '30d' }, { label: 'code key' }));
  add('mcp recent_activity', M('recent_activity', { since: '30d', limit: 300 }), M('recent_activity', t => ({ since: '30d', project: t.project }), aim(['project'], { label: 'by project', ok: r => r.ok && r.json?.count > 0 })),
    // the What filter (note e56029b458): State, notes, messages, Needs and project rows, each read through its subject
    ...['state', 'notes', 'messages', 'needs', 'projects'].flatMap(what => [M('recent_activity', { since: '30d', limit: 300, what }, { label: `what=${what}` }), M('recent_activity', t => ({ since: '30d', project: t.project, what }), aim(['project'], { label: `by project, what=${what}`, ok: r => r.ok && r.json?.count > 0 }))]));
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
  add('mcp get_project', M('get_project', t => ({ project: t.project, depth: 'full' }), aim(['project'])), M('get_project', t => ({ project: t.projectName }), aim(['projectName'], { label: 'by name' })), M('get_project', t => ({ remote: t.remote }), { label: 'by remote (H13: unmatched, the remote only ranks candidates)', ok: r => r.ok && r.json?.unmatched === true && r.json?.candidates?.[0]?.why === 'same remote', aim: true, aimKeys: ['remote'] }), M('get_project', { project: 'constructor' }, { label: 'prototype key', aim: true, aimKeys: [], control: false }));
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
  // Starting work and State (slice 1). start_work registers presence, so each is aimed at a project the caller cannot see.
  add('mcp start_work',
    M('start_work', t => ({ project: t.project, machine: 'lkq', label: 'lkq probe' }), aim(['project'])),
    M('start_work', t => ({ project: t.projectName }), aim(['projectName'], { label: 'by name' })),
    M('start_work', t => ({ remote: t.remote }), { label: 'by remote (H13: unmatched, the remote only ranks candidates)', ok: r => r.ok && r.json?.unmatched === true && r.json?.candidates?.[0]?.why === 'same remote', aim: true, aimKeys: ['remote'] }),
    Mc('start_work', t => ({ project: t.project }), aim(['project'], { label: 'code key' })),
    M('start_work', { path: 'C:/lkq/quiet', machine: 'lkq', not_work_os: true }, { label: 'not_work_os (own quiet list)' }),
    M('start_work', t => ({ project: t.project, folder: 'lkqf0001', link: true }), aim(['project'], { label: 'link (project, own folder id)' })),
    M('start_work', t => ({ project: t.project, path: 'C:/lkq/linkpath', machine: 'lkq', link: true }), aim(['project'], { label: 'link by path and machine' })),
    M('start_work', { project: 'constructor' }, { label: 'prototype key', aim: true, aimKeys: [], control: false }),
  );
  add('mcp get_state', M('get_state', t => ({ project: t.project }), aim(['project'])), M('get_state', t => ({ project: t.projectName }), aim(['projectName'], { label: 'by name' })), Mc('get_state', t => ({ project: t.project }), aim(['project'], { label: 'code key' })));
  add('mcp save_state',
    M('save_state', t => ({ project: t.project, ops: [{ op: 'add_next', text: 'lkq sneaked line' }] }), aim(['project'])),
    M('save_state', t => ({ project: t.project, base_version: 0, ops: [{ op: 'set_now', text: 'lkq sneaked goal' }] }), aim(['project'], { label: 'set_now' })),
    M('save_state', t => ({ project: t.projectName, ops: [{ op: 'add_decision', text: 'lkq sneaked decision' }, { op: 'set_where', machine: 'lkq' }] }), aim(['projectName'], { label: 'decision and where, by name' })),
    M('save_state', t => ({ project: t.project, ops: [{ op: 'add_later', text: 'lkq parked' }, { op: 'promote_later', id: 'l_none' }] }), aim(['project'], { label: 'promote_later', control: false })),
  );
  // (the owner already has a State there, so import is refused for them by design: its refusals must read as the access check)
  add('mcp import_state', M('import_state', t => ({ project: t.project, markdown: '## Now\n- lkq imported goal' }), aim(['project'], { control: false })));
  // Messages (slice 3): a reader of the project only
  add('mcp send_message',
    M('send_message', t => ({ project: t.project, kind: 'fyi', body: 'lkq sneaked message' }), aim(['project'])),
    M('send_message', t => ({ project: t.projectName, kind: 'request', body: 'lkq sneaked request', to_session: 'lkq' }), aim(['projectName'], { label: 'by name' })),
    Mc('send_message', t => ({ project: t.project, kind: 'decision', body: 'lkq sneaked decision' }), aim(['project'], { label: 'code key' })),
  );
  add('mcp inbox',
    M('inbox', t => ({ project: t.project }), aim(['project'])),
    M('inbox', t => ({ project: t.projectName, status: 'unread' }), aim(['projectName'], { label: 'by name' })),
    M('inbox', {}, { label: 'every project' }),
    Mc('inbox', t => ({ project: t.project }), aim(['project'], { label: 'code key' })),
  );
  add('mcp message_status',
    M('message_status', t => ({ id: t.msg, status: 'seen' }), aim(['msg'])),
    M('message_status', t => ({ id: t.msgReq, status: 'applied', make_task: true, note: 'lkq' }), aim(['msgReq'], { label: 'make a task', control: false })),
    Mc('message_status', t => ({ id: t.msg, status: 'rejected', note: 'lkq' }), aim(['msg'], { label: 'code key', control: false })),
  );
  add('mcp reply', M('reply', t => ({ id: t.msg, body: 'lkq sneaked reply' }), aim(['msg'])), Mc('reply', t => ({ id: t.msg, body: 'lkq code reply' }), aim(['msg'], { label: 'code key' })));
  // The roster (slice 7). set_doing names a task, so it is aimed at one the caller cannot see (control off: the owner has no present session in the probe). slot works on the caller's own machines only.
  add('mcp set_doing', M('set_doing', t => ({ task: t.ref }), aim(['ref'], { control: false })), M('set_doing', t => ({ task: t.task }), aim(['task'], { label: 'by id', control: false })));
  // H5: end_work writes State, a handover note and a feed row, so each probe is aimed at a project the caller cannot read; list_sessions lists only readable projects' sessions
  add('mcp end_work',
    M('end_work', t => ({ project: t.project, state: [{ op: 'add_next', text: 'lkq sneaked end line' }], friction: 'lkq probe', handover: { step: 'lkq sneaked handover' } }), aim(['project'])),
    M('end_work', t => ({ project: t.projectName, base_version: 0, state: [{ op: 'set_now', text: 'lkq sneaked end goal' }], friction: 'lkq probe', handover: { step: 'lkq by name', for: 'anyone' } }), aim(['projectName'], { label: 'set_now, by name' })),
  );
  // H10: feedback writes a feed row on the project's State, so each probe is aimed at a project the caller cannot read
  add('mcp feedback',
    M('feedback', t => ({ project: t.project, text: 'lkq sneaked feedback', tool: 'lkq', rule: 'lkq' }), aim(['project'])),
    M('feedback', t => ({ project: t.projectName, text: 'lkq sneaked feedback by name' }), aim(['projectName'], { label: 'by name' })),
  );
  add('mcp list_sessions', M('list_sessions', { include_gone: true }), M('list_sessions', t => ({ project: t.project, include_gone: true }), aim(['project'], { label: 'by project', control: false, ok: r => r.ok && r.json?.sessions?.length > 0 })));
  add('mcp slot', M('slot', { action: 'acquire', machine: 'lkq-slot-box' }, { label: 'acquire' }), M('slot', { action: 'release', machine: 'lkq-slot-box' }, { label: 'release' }));
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

  // ── Needs (slice 4): one ask to one person. NO tool answers one (checked above); the app's action does, for the addressee only ──
  add('mcp ask',
    M('ask', t => ({ project: t.projectName, to: 'me', kind: 'approve', ask: 'lkq probe ask' }), aim(['projectName'], { label: 'into their project' })),
    M('ask', (t, ctx) => ({ project: t.projectName, to: ctx.T.email, kind: 'approve', ask: 'lkq ask someone who cannot read the project' }), { label: 'to someone who cannot read the project', ownerOnly: true, ok: r => !r.ok && /cannot see this project/.test(r.text) }),
  );
  // H9: a proposal to change Orders is a Need to the holder. The owner holds the layer (so the control call is refused with that sentence); everyone else is aimed at a project they cannot read.
  add('mcp propose_order',
    M('propose_order', t => ({ project: t.projectName, layer: 'org', new: 'lkq probe line', why: 'lkq probe' }), aim(['projectName'], { label: 'into their project', ok: r => r.ok || /You hold this layer/.test(r.text) })),
  );
  add('mcp needs',
    M('needs', { status: 'all' }),
    Mc('needs', {}, { label: 'code key, my own list' }),
    M('needs', t => ({ project: t.projectName, status: 'all' }), aim(['projectName'], { label: 'by project' })),
    M('needs', { to: 'me', status: 'all' }, { label: 'addressed to me' }),
  );
  add('mcp withdraw_need',
    M('withdraw_need', t => ({ id: t.needWd }), aim(['needWd'], { label: 'one I cannot see', stage: 1 })),
    M('withdraw_need', t => ({ id: t.needWdS }), aim(['needWdS'], { label: 'one I can read but did not ask', stage: 1 })),
  );
  const NEED_ACT = 'app/(app)/needs/actions.ts#answerNeedAction';
  add(`action ${NEED_ACT}`,
    act(NEED_ACT, t => [t.needAns, 'yes'], aim(['needAns'], { label: 'a Need I cannot see' })),
    act(NEED_ACT, t => [t.needAnsS, 'yes'], aim(['needAnsS'], { label: 'a Need I can read, addressed to someone else' })),
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
  add(`action ${A_}setProductionAction`, act(A_ + 'setProductionAction', t => [t.project, null], aim(['project'])), act(A_ + 'setProductionAction', ['constructor', null], { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add(`action ${A_}updateProjectAction`, act(A_ + 'updateProjectAction', t => [t.project, { description: 'lkq hacked' }], aim(['project'])), act(A_ + 'updateProjectAction', ['constructor', { description: 'x' }], { label: 'prototype key', aim: true, aimKeys: [], control: false }));
  add(`action ${A_}projectSharingImpactAction`, act(A_ + 'projectSharingImpactAction', t => [t.project], aim(['project'])));
  add(`action ${A_}logoutAction`, act(A_ + 'logoutAction', [], { ok: r => !!r.redirect && /login/.test(r.redirect), public: true, only: ['N'], control: false /* it would sign the persona out for the rest of its probes; the misuse checks sign out a spare session */ }));
  const D_ = 'app/(app)/claude/dispatcher-actions.ts#';
  add(`action ${D_}markOptionsAction`, act(D_ + 'markOptionsAction', t => [t.task], aim(['task'])));
  add(`action ${D_}giveToClaudeAction`, act(D_ + 'giveToClaudeAction', t => [String(t.give), t.folder], aim(['give', 'folder'])));
  // Open in Claude Code / Claude Desktop: a job on the caller's own computer only; someone else's task or folder must not resolve.
  add(`action ${D_}openTaskInClaudeCodeAction`, act(D_ + 'openTaskInClaudeCodeAction', t => [t.task, t.folder], aim(['task', 'folder'], { controlOk: r => actOk(r) || /allowPrompts|linked|folder|archived task/i.test(r.text) })));
  add(`action ${D_}openTaskInClaudeDesktopAction`, act(D_ + 'openTaskInClaudeDesktopAction', t => [t.task, t.folder], aim(['task', 'folder'], { controlOk: r => actOk(r) || /allowPrompts|linked|folder|archived task/i.test(r.text) })));
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
  add(`action ${N_}createSubPageAction`, act(N_ + 'createSubPageAction', t => [t.note, 'lkq sub by action'], aim(['note'], { ok: r => actOk(r) && !!r.value?.id })));
  add(`action ${N_}saveNoteAction`, act(N_ + 'saveNoteAction', t => [t.note, { title: 'lkq hacked' }], aim(['note'])), act(N_ + 'saveNoteAction', t => [t.taskNote, { archived: true }], aim(['taskNote'], { label: 'archive a task note' })));
  add(`action ${N_}setShelfAction`, act(N_ + 'setShelfAction', t => [t.note, 'runbooks'], aim(['note'])));
  add(`action ${N_}deleteNoteAction`, act(N_ + 'deleteNoteAction', t => [t.sub], aim(['sub'], { stage: 1 })));
  add(`action ${N_}restoreNoteAction`, act(N_ + 'restoreNoteAction', t => [t.sub], aim(['sub'], { stage: 2 })));
  // (sub2 is put in the trash by mcp delete_note earlier in stage 2; this deletes it for good)
  add(`action ${N_}purgeNoteAction`, act(N_ + 'purgeNoteAction', t => [t.sub2], aim(['sub2'], { stage: 2 })));
  add(`action ${N_}searchMentionsAction`, act(N_ + 'searchMentionsAction', ['lkq'], { ok: r => r.status === 200 && !r.error && Array.isArray(r.value) }));
  const SA = 'app/(app)/projects/[id]/state-actions.ts#';
  const OA = 'app/(app)/notes/orders-actions.ts#';
  const IA = 'app/(app)/projects/[id]/inbox-actions.ts#';
  add(`action ${IA}sendMessageAction`, act(IA + 'sendMessageAction', t => [t.project, 'fyi', 'lkq action message'], aim(['project'])), act(IA + 'sendMessageAction', t => [t.project, 'request', 'lkq action request', 'lkq'], aim(['project'], { label: 'for a session' })));
  add(`action ${IA}messageStatusAction`, act(IA + 'messageStatusAction', t => [t.project, t.msg, 'seen'], aim(['project', 'msg'])), act(IA + 'messageStatusAction', t => [t.project, t.msg, 'rejected', 'lkq'], aim(['project', 'msg'], { label: 'rejected', control: false })));
  add(`action ${IA}makeTaskFromMessageAction`, act(IA + 'makeTaskFromMessageAction', t => [t.project, t.msgReq], aim(['project', 'msgReq'], { control: false })));
  add(`action ${SA}saveStateAction`, act(SA + 'saveStateAction', t => [t.project, [{ op: 'add_next', text: 'lkq action sneak' }]], aim(['project'])), act(SA + 'saveStateAction', t => [t.project, [{ op: 'add_decision', text: 'lkq action decision' }, { op: 'add_later', text: 'lkq action later' }]], aim(['project'], { label: 'decision and later' })));
  add(`action ${OA}setOrdersAction`, act(OA + 'setOrdersAction', t => [t.ordersNote, 'project'], aim(['ordersNote'])), act(OA + 'setOrdersAction', t => [t.ordersNote, null], aim(['ordersNote'], { label: 'clearing it' })));
  // H9: undo writes the text before a version back; the holder only. The probe's page is not Orders (the flag on it is the setOrdersAction probe's), so the owner's control is answered "not found", the same as everyone's.
  add(`action ${OA}undoOrdersAction`, act(OA + 'undoOrdersAction', t => [t.ordersNote, 2], aim(['ordersNote'], { controlOk: r => actOk(r) || /not found/i.test(r.text) })));
  const CI = 'app/(app)/projects/[id]/claude-items-actions.ts#';
  add(`action ${CI}updateClaudeItemAction`, act(CI + 'updateClaudeItemAction', t => [t.itemProject, t.item, { note: 'lkq hacked' }], aim(['itemProject', 'item'])));
  add(`action ${CI}moveClaudeItemAction`, act(CI + 'moveClaudeItemAction', t => [t.itemProject, t.item, 'top'], aim(['itemProject', 'item'])));
  const L_ = 'app/(app)/projects/[id]/launcher-actions.ts#';
  add(`action ${L_}quietFoldersAction`, act(L_ + 'quietFoldersAction', [])); // the caller's own not-Work-OS list (per person), nothing of anyone else's
  add(`action ${L_}removeQuietFolderAction`, act(L_ + 'removeQuietFolderAction', ['lkq', 'c:/lkq/quiet']));
  add(`action ${L_}searchFoldersAction`, act(L_ + 'searchFoldersAction', t => [t.device, ''], aim(['device'], { ok: r => actOk(r) && r.value.data?.length > 0 })));
  // Another person's computer (same organization or another) is 'not found' for both, exactly as a made-up id; the owner's own call works (nothing matches the canary remotes, so nothing is linked).
  add(`action ${L_}matchingFoldersAction`, act(L_ + 'matchingFoldersAction', t => [t.device], aim(['device'], { ok: r => actOk(r) && Array.isArray(r.value.data?.matches) })));
  add(`action ${L_}linkMatchingFoldersAction`, act(L_ + 'linkMatchingFoldersAction', t => [t.device], aim(['device'], { ok: r => actOk(r) && r.value.data?.linked === 0 })));
  add(`action ${L_}folderPickerAction`, act(L_ + 'folderPickerAction', t => [t.device, ''], aim(['device', 'project'], { ok: r => actOk(r) && r.value.data?.folders?.length > 0 })));
  add(`action ${L_}relinkFolderAction`, act(L_ + 'relinkFolderAction', t => [t.folder, t.project], aim(['project', 'folder'], { stage: 2 })));
  add(`action ${L_}linkFolderAction`, act(L_ + 'linkFolderAction', t => [t.project, t.folder], aim(['project', 'folder'])));
  add(`action ${L_}unlinkFolderAction`, act(L_ + 'unlinkFolderAction', t => [t.project, t.folder], aim(['project', 'folder'], { stage: 2 })));
  add(`action ${L_}startSessionAction`, act(L_ + 'startSessionAction', t => [t.project, t.folder, 'lkq prompt'], aim(['project', 'folder'], { stage: 1 })));
  add(`action ${L_}turboStartAction`, act(L_ + 'turboStartAction', t => [t.project, t.device, 'lkq prompt'], aim(['project', 'device'], { stage: 1 })));
  add(`action ${L_}resumeSessionAction`, act(L_ + 'resumeSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 1, controlOk: r => actOk(r) || /running|already/i.test(r.text) })));
  add(`action ${L_}stopSessionAction`, act(L_ + 'stopSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 1 })));
  add(`action ${L_}removeSessionAction`, act(L_ + 'removeSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 2, controlOk: r => actOk(r) || /running|stop it/i.test(r.text) })));
  add(`action ${L_}unhideSessionAction`, act(L_ + 'unhideSessionAction', t => [t.project, t.session], aim(['project', 'session'], { stage: 2 })));
  add(`action ${L_}openInVscodeAction`, act(L_ + 'openInVscodeAction', t => [t.device, t.session], aim(['device', 'session'], { stage: 1 })));
  add(`action ${L_}reopenAllAction`, act(L_ + 'reopenAllAction', t => [t.device], aim(['device'], { stage: 1 })));
  add(`action ${L_}dismissReopenAction`, act(L_ + 'dismissReopenAction', t => [t.device], aim(['device'], { stage: 1 })));
  add(`action ${L_}jobOutcomeAction`, act(L_ + 'jobOutcomeAction', t => [t.job], aim(['job'])));
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
  add(`action ${PR}saveTeamChannelAction`, act(PR + 'saveTeamChannelAction', [''], { mayWork: w => w === 'X' /* X sets the team channel of X's own organization (it clears it here) */ }));
  add(`action ${PR}discordLinkCodeAction`, act(PR + 'discordLinkCodeAction', []));
  add(`action ${PR}unlinkDiscordAction`, act(PR + 'unlinkDiscordAction', [], { only: ['R', 'N'], control: false /* T and X would unlink their own Discord account before their Discord probes run; the owner's for the rest of the run */ }));
  add(`action ${PR}saveDiscordServerAction`, act(PR + 'saveDiscordServerAction', [G2], { label: 'claim the second org\'s server', control: false }), act(PR + 'saveDiscordServerAction', [G1], { label: 'own server again', controlOk: actOk, only: ['R', 'N'] }));
  // Delpat OS import (lib/delpat-os.ts): this audit runs with no Delpat OS client set, so each action answers "not set up" to everyone;
  // they take no id of anyone else's (each acts on the caller's own link), and the delpat-os suite covers the working paths.
  const DO = 'app/(app)/settings/delpat-os-actions.ts#';
  const DP = 'app/(app)/projects/delpat-os-actions.ts#';
  const notSetUp = r => actOk(r) || /not set up/i.test(r.text);
  add(`action ${DO}startDelpatOsLinkAction`, act(DO + 'startDelpatOsLinkAction', [], { ok: notSetUp, controlOk: notSetUp }));
  add(`action ${DO}unlinkDelpatOsAction`, act(DO + 'unlinkDelpatOsAction', [], { ok: notSetUp, controlOk: notSetUp }));
  add(`action ${DP}delpatOsStatusAction`, act(DP + 'delpatOsStatusAction', [], { ok: r => actOk(r) && r.value.data?.enabled === false, controlOk: r => actOk(r) && r.value.data?.enabled === false }));
  add(`action ${DP}listDelpatOsProjectsAction`, act(DP + 'listDelpatOsProjectsAction', [], { ok: notSetUp, controlOk: notSetUp }));
  add(`action ${DP}importDelpatOsProjectAction`, act(DP + 'importDelpatOsProjectAction', ['lkqdp1', 'org'], { ok: notSetUp, controlOk: notSetUp }));
  // ── Mail (Mailloom, each person's own sealed key). Nobody has a key in this audit, so every tool answers "link your mailbox"
  // (the control, the owner, answers the same): nothing of anyone else's can come back through a tool with no key to open. ──
  const noMail = r => r.ok || /Link your mailbox|not set up/i.test(r.text);
  const MID = { message_id: '<lkq-probe@example.test>' };
  for (const [tool, args] of [
    ['mail_folders', {}],
    ['mail_needs_attention', {}],
    ['mail_search', { query: 'lkq' }],
    ['mail_read', MID],
    ['mail_attachment', { ...MID, index: 0 }],
    ['mail_send', { to: 'lkq@example.test', subject: 'lkq probe', text: 'lkq probe' }],
    ['mail_reply', { ...MID, text: 'lkq probe' }],
    ['mail_forward', { ...MID, to: 'lkq@example.test' }],
    ['mail_move', { ...MID, to_folder: 'Archive' }],
    ['mail_flag', { ...MID, flagged: true }],
    ['mail_delete', MID],
    ['mail_message_to_task', MID],
  ]) add(`mcp ${tool}`, M(tool, args, { ok: noMail, controlOk: noMail }));
  const MA = 'app/(app)/settings/mail-actions.ts#';
  add(`action ${MA}saveMailKeyAction`, act(MA + 'saveMailKeyAction', ['not-a-key'], { ok: () => false, controlOk: r => r.status === 200 && r.value?.ok === false }));
  add(`action ${MA}testMailKeyAction`, act(MA + 'testMailKeyAction', [], { ok: () => false, controlOk: r => r.status === 200 && r.value?.ok === false }));
  add(`action ${MA}removeMailKeyAction`, act(MA + 'removeMailKeyAction', [], { controlOk: r => actOk(r) }));
  // Connect Mailloom (lib/mail/connect.ts): off in this audit (no Mailloom), so it answers "not set up" to everyone; it takes no input
  // and acts on the caller's own key only. The mail suite covers the working flow (state bound to person, org and session).
  add(`action ${MA}startMailConnectAction`, act(MA + 'startMailConnectAction', [], { ok: () => false, controlOk: r => r.status === 200 && r.value?.ok === false && /not set up/i.test(r.value.error) }));
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
  items['page /projects/[id]'].probes.push(pg(t => `/projects/${t.project}?tab=needs`, aim(['project'], { label: 'needs tab' })));
  add('page /notes', pg('/notes?state=all'), pg(t => `/notes?project=${t.project}&state=all`, { label: 'filtered by project' }));
  add('page /notes/[id]', pg(t => `/notes/${t.note}`, aim(['note'])), pg(t => `/notes/${t.sub}`, aim(['sub'], { label: 'sub-page' })), pg(t => `/notes/${t.taskNote}`, aim(['taskNote'], { label: 'task note' })));
  add('page /modes/[mode]', pg('/modes/growth', { ok: r => /^redirect \/tasks\?mode=/.test(pageState(r)) }), pg(() => `/modes/${CANARIES.find(c => c.tag === 'xmode').s}`, { label: 'the second org\'s mode', echo: () => [CANARIES.find(c => c.tag === 'xmode').s], ok: r => /^redirect \/tasks\?mode=/.test(pageState(r)), aim: true, aimKeys: [], control: false }));
  add('page /notifications', pg('/notifications'));
  // Needs: the open Needs addressed to the caller and those they answered lately, read through the door (lib/data/needs.ts listNeeds, to = the caller).
  add('page /needs', pg('/needs'));
  // What's new: the fixed list (lib/whats-new.ts) and the caller's own seen list; the action writes only the caller's own profile.
  add('page /whats-new', pg('/whats-new'));
  const WN = 'app/(app)/whats-new/actions.ts#markWhatsNewSeenAction';
  add(`action ${WN}`, act(WN, []), act(WN, ['needs'], { label: 'one entry' }), act(WN, ['lkqnotanentry'], { label: 'an unknown id' }));
  add('page /review', ...['done', 'activity', 'activity&what=state', 'activity&what=notes', 'activity&what=needs', 'activity&what=messages', 'weekly', 'stale', 'archive', 'trash'].map(v => pg(`/review?view=${v}`, { label: v })));
  add('page /settings', ...['account', 'notifications', 'connections', 'started', 'team', 'server'].map(v => pg(`/settings?section=${v}`, { label: v })));
  add('page /claude', ...['now', 'queue', 'workers', 'setup'].map(v => pg(`/claude?tab=${v}`, { label: v })));
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
  add('route POST /api/cron/reel', { kind: 'route', ok: r => two(r.status), call: ({ p }) => req('POST', '/api/cron/reel', { cookie: p.cookie, bearer: p.chat, body: { post: 'lkq', container: '10000001', slot: 1900000000 } }), control: false /* the CRON_SECRET holder is the server timer; the reel suite runs it */ });
  add('route POST /api/discord/interactions', { kind: 'route', ok: r => two(r.status), call: () => req('POST', '/api/discord/interactions', { body: '{"type":1}', headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': String(Math.floor(Date.now() / 1000)) } }), label: 'unsigned', control: false });
  // Mailloom's intake (lib/intake.ts): only the intake token opens it, never a session or a Work OS key (in this suite's
  // server mode it is not configured at all: 503; other methods 405).
  const intakeProbe = (m, path, body) => ({ kind: 'route', ok: r => two(r.status), call: ({ p }) => req(m, path, { cookie: p.cookie, bearer: p.chat, ...(['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? { body } : {}) }), control: false /* only Mailloom holds the intake token; the intake suite runs it */ });
  for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    add(`route ${m} /api/intake/mailloom`, intakeProbe(m, '/api/intake/mailloom', { report_id: 'lkq', reporter: 'lkq@example.test', title: 'lkq probe report', description_markdown: 'lkq' }));
    add(`route ${m} /api/intake/mailloom/notice`, intakeProbe(m, '/api/intake/mailloom/notice', { text: 'lkq probe notice' }));
  }
  add('route GET /worker/work-os-worker.mjs', route('GET', '/worker/work-os-worker.mjs', { public: true }));
  add('route GET /worker/latest.json', route('GET', '/worker/latest.json', { public: true }));
  // The calendar link (docs/calendar.md): the token is the only credential; anything but a live token is the same bare 404, for everyone.
  add('route GET /api/calendar/[file]', { kind: 'route', public: true, ok: r => r.status === 404, call: () => req('GET', '/api/calendar/' + 'lkq'.repeat(14) + 'a.ics'), label: 'a token that is not a link', controlOk: r => r.status === 404 });
  const CAL = 'app/(app)/settings/calendar-actions.ts#';
  for (const n of ['createCalendarLinkAction', 'rotateCalendarLinkAction', 'revokeCalendarLinkAction', 'getCalendarLinkAction']) add(`action ${CAL}${n}`, act(CAL + n, [])); // each acts on the caller's own link only
  add('route GET /api/delpat-os/callback', route('GET', '/api/delpat-os/callback?code=lkqcode&state=lkqstate', { ok: r => r.status === 404, controlOk: r => r.status === 404 }));
  add('route GET /api/mail/callback', route('GET', '/api/mail/callback?code=lkqcode&state=lkqstate', { ok: r => r.status === 404, controlOk: r => r.status === 404 }));
  add('route GET /api/live', route('GET', '/api/live', { public: true }));
  add('route HEAD /api/live', route('HEAD', '/api/live', { public: true }));
  const mcpRoute = m => ({ kind: 'mcp', ok: r => two(r.status) && !/Unauthorized/.test(r.text), call: ({ cred }) => req(m, '/api/mcp', { bearer: cred, headers: { accept: 'application/json, text/event-stream' }, body: m === 'POST' ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : undefined }), controlOk: r => (m === 'POST' ? two(r.status) : r.status !== 401) });
  add('route POST /api/mcp/[[...key]]', mcpRoute('POST'), { kind: 'route', label: 'key in the URL (off)', ok: r => two(r.status), call: ({ p }) => req('POST', `/api/mcp/${p.chat || 'wos_none'}`, { headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), control: false });
  add('route GET /api/mcp/[[...key]]', { ...mcpRoute('GET'), ok: r => two(r.status) && /lkq/.test(r.text), controlOk: r => r.status === 405 /* no stream, no sessions: 405 for every credential, and never any data */ });
  add('route DELETE /api/mcp/[[...key]]', { ...mcpRoute('DELETE'), ok: r => two(r.status) && /lkq/.test(r.text), controlOk: r => r.status === 405 /* no stream, no sessions: 405 for every credential, and never any data */ });
  add('route GET /api/notes/file', route('GET', t => `/api/notes/file?p=${encodeURIComponent(`notes/${A.orgId}/${t.note}/x.png`)}`, aim(['note'], { ok: r => r.status === 503, controlOk: r => r.status === 503 })));
  add('route POST /api/notes/upload', route('POST', '/api/notes/upload', aim(['note'], { body: t => ({ type: 'blob.generate-client-token', payload: { pathname: `notes/${A.orgId}/${t.note}/x.png`, callbackUrl: B, clientPayload: null, multipart: false } }), ok: r => r.status === 503, controlOk: r => r.status === 503 })));
  add('route GET /api/stream', { kind: 'route', ok: r => r.status === 200, call: ({ p }) => streamPeek('/api/stream', p.cookie ? { cookie: p.cookie } : {}) });
  add('route GET /api/timetable/today', route('GET', '/api/timetable/today'), route('GET', '/api/timetable/today', { label: 'chat key', useKey: true }));
  add('route POST /api/worker/folders', worker('POST', '/api/worker/folders', () => ({ folders: [{ id: 'lkqf0001', name: 'lkq probe folder', path: 'C:/lkq', git: false }] }), { label: 'own scan' }));
  add('route GET /api/worker/jobs', worker('GET', '/api/worker/jobs'));
  add('route POST /api/worker/status', worker('POST', '/api/worker/status', t => ({ worker: { version: '0.1.0', os: 'win32', allowPrompts: false }, jobs: [{ id: t.job, ok: false, error: 'lkq' }], sessions: [{ sessionId: t.session, state: 'dead' }] }), { label: 'their job and session ids', controlOk: r => two(r.status), stage: 1 }));
  add('route GET /api/worker/stream', { kind: 'worker', ok: r => r.status === 200, call: ({ p }) => streamPeek('/api/worker/stream', p.wkr ? { authorization: `Bearer ${p.wkr}` } : {}) });
  // The hook's sign-in (device key): A's private project by its remote. A's computer has a folder linked to it (the
  // control); anyone else's computer gets the same 404 as for a remote no project has, or 401.
  add('route POST /api/agent/start', worker('POST', '/api/agent/start', t => ({ remote: t.remote, branch: 'main' }), { ok: r => r.status === 200, aim: true, aimKeys: ['remote'], label: 'a project by its remote', controlOk: r => r.status === 200 && /"token":"wst_/.test(r.text) }));
  // The hook's State route (session token only): each person's computer first signs in for A's project by its remote (the
  // token exists only for A, whose computer has the folder), then asks for the copy with that token or, where there is none,
  // with a made-up one. Nobody but A gets the copy, and nobody's other credential opens it (misuse list below).
  add('route POST /api/agent/state', worker('POST', '/api/agent/state', {}, { ok: r => r.status === 200, label: 'the copy of a project by a token', call: async ({ p, o: t }) => {
    const s = await req('POST', '/api/agent/start', { bearer: p.wkr, body: { remote: t.remote, branch: 'main' } });
    let token = 'wst_' + 'a'.repeat(43);
    try { token = JSON.parse(s.text).token ?? token; } catch { /* no token: the made-up one is refused */ }
    return req('POST', '/api/agent/state', { bearer: token, body: {} });
  }, controlOk: r => r.status === 200 && /Copy of the Work OS state/.test(r.text) }));
  // The hook's session-state route (session token only): the same sign-in as above, then one event with that token (or a
  // made-up one where the computer got none). Only A, whose computer has the folder, gets a state; nobody's other credential
  // opens it (misuse list below).
  add('route POST /api/agent/event', worker('POST', '/api/agent/event', {}, { ok: r => r.status === 200, label: 'a session event by a token', call: async ({ p, o: t }) => {
    const s = await req('POST', '/api/agent/start', { bearer: p.wkr, body: { remote: t.remote, branch: 'main' } });
    let token = 'wst_' + 'a'.repeat(43);
    try { token = JSON.parse(s.text).token ?? token; } catch { /* no token: the made-up one is refused */ }
    return req('POST', '/api/agent/event', { bearer: token, body: { event: 'prompt' } });
  }, controlOk: r => r.status === 200 && /"state":"working"/.test(r.text) }));
  // The idle session's wait (session token only): the same sign-in, then a prompt event (the session is working, so the wait answers
  // busy at once instead of holding the call), then the wait. Only A, whose computer has the folder, gets an answer; nobody's other
  // credential opens it (misuse list below).
  add('route POST /api/agent/wait', worker('POST', '/api/agent/wait', {}, { ok: r => r.status === 200, label: 'the wait of a session by a token', call: async ({ p, o: t }) => {
    const s = await req('POST', '/api/agent/start', { bearer: p.wkr, body: { remote: t.remote, branch: 'main' } });
    let token = 'wst_' + 'a'.repeat(43);
    try { token = JSON.parse(s.text).token ?? token; } catch { /* no token: the made-up one is refused */ }
    await req('POST', '/api/agent/event', { bearer: token, body: { event: 'prompt' } });
    return req('POST', '/api/agent/wait', { bearer: token, body: {} });
  }, controlOk: r => r.status === 200 && /"busy":true/.test(r.text) }));
  // The hook's production check (session token only, H8): the same sign-in, then the check with that token (or a made-up one where
  // the computer got none). Only A, whose computer has the folder, gets an answer; nobody's other credential opens it (misuse list below).
  add('route POST /api/agent/release', worker('POST', '/api/agent/release', {}, { ok: r => r.status === 200, label: 'a production check by a token', call: async ({ p, o: t }) => {
    const s = await req('POST', '/api/agent/start', { bearer: p.wkr, body: { remote: t.remote, branch: 'main' } });
    let token = 'wst_' + 'a'.repeat(43);
    try { token = JSON.parse(s.text).token ?? token; } catch { /* no token: the made-up one is refused */ }
    return req('POST', '/api/agent/release', { bearer: token, body: { what: 'push', name: 'main' } });
  }, controlOk: r => r.status === 200 && /"allowed":false/.test(r.text) }));
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
  // A press on a Need button in a DM: no server, only the user. Only the addressee's own linked account answers (type 7 updates the message);
  // every other press (another member, another organization, an unknown id) is an ephemeral refusal (type 4).
  const discDm = (data, o = {}) => ({ kind: 'discord', ok: r => /"type":\s*7[,}]/.test(r.text), call: async ({ p, o: t, ctx }) => interact(null, linkedDiscord(p), 3, typeof data === 'function' ? data(t, ctx, p) : data, {}), ...o });
  add('discord component need',
    discDm(t => ({ custom_id: `wo:need:${t.needDc}:yes`, component_type: 2 }), aim(['needDc'], { stage: 1, label: 'a Need I cannot see' })),
    discDm(t => ({ custom_id: `wo:need:${t.needDcS}:yes`, component_type: 2 }), aim(['needDcS'], { stage: 1, label: 'a Need I can read, addressed to someone else' })),
  );
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
    L(`${label} on /api/agent/start`, () => req('POST', '/api/agent/start', { bearer, cookie, body: { remote: 'lkqmisuse/repo' } }), r => r.status === 401);
    L(`${label} on /api/agent/state`, () => req('POST', '/api/agent/state', { bearer, cookie, body: {} }), r => r.status === 401);
    L(`${label} on /api/agent/event`, () => req('POST', '/api/agent/event', { bearer, cookie, body: { event: 'prompt' } }), r => r.status === 401);
    L(`${label} on /api/agent/event with deliver`, () => req('POST', '/api/agent/event', { bearer, cookie, body: { event: 'tool', deliver: true } }), r => r.status === 401);
    L(`${label} on /api/agent/wait`, () => req('POST', '/api/agent/wait', { bearer, cookie, body: {} }), r => r.status === 401);
    L(`${label} on /api/agent/release`, () => req('POST', '/api/agent/release', { bearer, cookie, body: { what: 'push', name: 'main' } }), r => r.status === 401);
  }
  L('the device key in X-API-Key on /api/agent/start', () => req('POST', '/api/agent/start', { headers: { 'x-api-key': A.wkr }, body: { remote: 'lkqmisuse/repo' } }), r => r.status === 401);
  L('a wst_ token in X-API-Key on /api/agent/state', () => req('POST', '/api/agent/state', { headers: { 'x-api-key': 'wst_' + 'a'.repeat(43) }, body: {} }), r => r.status === 401);
  L('a wst_ token in X-API-Key on /api/agent/event', () => req('POST', '/api/agent/event', { headers: { 'x-api-key': 'wst_' + 'a'.repeat(43) }, body: { event: 'prompt' } }), r => r.status === 401);
  L('a wst_ token in X-API-Key on /api/agent/wait', () => req('POST', '/api/agent/wait', { headers: { 'x-api-key': 'wst_' + 'a'.repeat(43) }, body: {} }), r => r.status === 401);
  L('a made-up wst_ token on /api/agent/wait', () => req('POST', '/api/agent/wait', { bearer: 'wst_' + 'a'.repeat(43), body: {} }), r => r.status === 401);
  L('a wst_ token in X-API-Key on /api/agent/release', () => req('POST', '/api/agent/release', { headers: { 'x-api-key': 'wst_' + 'a'.repeat(43) }, body: { what: 'push' } }), r => r.status === 401);
  L('a made-up wst_ token on /api/agent/release', () => req('POST', '/api/agent/release', { bearer: 'wst_' + 'a'.repeat(43), body: { what: 'push' } }), r => r.status === 401);
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
  L('a chat key on /api/cron/reel', () => req('POST', '/api/cron/reel', { bearer: A.chat, body: { post: 'lkq', container: '10000001', slot: 1900000000 } }));
  L('a session cookie on /api/cron/reel', () => req('POST', '/api/cron/reel', { cookie: A.cookie, body: { post: 'lkq', container: '10000001', slot: 1900000000 } }));
  L('the cron secret in the query on /api/cron/reel', () => req('POST', `/api/cron/reel?key=${CRON}`, { body: { post: 'lkq', container: '10000001', slot: 1900000000 } }));
  L('a chat key on /api/intake/mailloom', () => req('POST', '/api/intake/mailloom', { bearer: A.chat, body: { report_id: 'lkq', reporter: 'lkq@example.test', title: 'lkq', description_markdown: 'lkq' } }), r => r.status === 401 || r.status === 503); // 503 while the intake is not configured (this suite's mode)
  L('a session cookie on /api/intake/mailloom/notice', () => req('POST', '/api/intake/mailloom/notice', { cookie: A.cookie, body: { text: 'lkq' } }), r => r.status === 401 || r.status === 503);
  L('a chat key on /api/discord/interactions', () => req('POST', '/api/discord/interactions', { bearer: A.chat, body: { type: 2, data: { name: 'today' } } }));
  L('Better Auth API key endpoints (not served)', () => req('POST', '/api/auth/api-key/create', { cookie: A.cookie, body: { name: 'lkq' } }));
  L('Better Auth sign-up (closed)', () => req('POST', '/api/auth/sign-up/email', { body: { email: 'lkqsignup@example.test', password: 'lkq-password-9', name: 'x' } }));
  L('Better Auth organization create (not served)', () => req('POST', '/api/auth/organization/create', { cookie: X.cookie, body: { name: 'lkq', slug: 'lkq' } }));
  // cancelled through the Members action only (the endpoint answered "Member not found" for another organization's invitation)
  L('Better Auth cancel-invitation (not served)', () => req('POST', '/api/auth/organization/cancel-invitation', { cookie: X.cookie, body: { invitationId: A.invite } }), r => r.status === 404);
  return list;
}
