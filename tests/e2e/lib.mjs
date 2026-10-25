// Shared helpers for the e2e suites. Everything comes from environment variables that run.sh sets;
// nothing here ever touches a real database (see the guard below).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb'; // the repo's own dependency

const need = k => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set; run the suites through tests/e2e/run.sh`); return v; };

// ---- guard: only a throwaway local database ----
const URI = need('MONGODB_URI');
export const DBNAME = need('MONGODB_DB');
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI) || /mongodb\.net|srv/.test(URI)) throw new Error('MONGODB_URI must point at localhost');
if (!/^workos_e2e/.test(DBNAME)) throw new Error('MONGODB_DB must start with workos_e2e');

export const B = process.env.E2E_BASE || 'http://localhost:3281';
export const CRON = need('CRON_SECRET');
const SECRET = need('BETTER_AUTH_SECRET');
export const SP = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'wos-e2e-shots');
fs.mkdirSync(SP, { recursive: true });

export const mc = new MongoClient(URI);
await mc.connect();
/** The test database without the fixture help below (the tenancy suite writes exact documents with it). */
export const rawDb = mc.db(DBNAME);

// ---- fixtures belong to the owner (docs/multi-user.md phase 2) ----
// Suites insert fixtures directly. Every document needs an organization and an owner to be seen through the app's
// scoped door, so `db` fills in what a fixture leaves out: the owner's organization, owner (or recipient), visibility
// 'org', and the per-person / per-organization settings and counter ids ('dispatcher' → 'dispatcher:<owner id>',
// 'task' → 'task:<org id>'). Fields a fixture sets itself (even to null) are kept.
const SHARED = new Set(['projects', 'tasks', 'activity', 'notes', 'claudeItems', 'trash']);
const OWNED = new Set(['reviews', 'ritualLogs', 'devices', 'workerFolders', 'workerJobs', 'workerSessions']);
const RECIPIENT = new Set(['notifications', 'pushSubs', 'alertLog', 'alertQueue']);
const USER_AREAS = new Set(['notify', 'dispatcher', 'alerts', 'status', 'profile', 'schedule']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function mapId(name, id) {
  if (!ME || typeof id !== 'string') return id;
  if (name === 'settings' && USER_AREAS.has(id)) return `${id}:${ME.userId}`;
  if (name === 'settings' && id === 'discord') return `discord:${ME.orgId}`;
  if (name === 'counters' && (id === 'task' || id === 'claudeItems')) return `${id}:${ME.orgId}`;
  return id;
}
function stamp(name, d) {
  if (!ME || !d || typeof d !== 'object') return d;
  const x = { ...d };
  if (has(x, '_id')) x._id = mapId(name, x._id);
  const set = (k, v) => { if (!has(x, k)) x[k] = v; };
  if (SHARED.has(name) || OWNED.has(name) || RECIPIENT.has(name)) set('orgId', ME.orgId);
  if (SHARED.has(name)) { set('ownerId', ME.userId); set('visibility', 'org'); }
  if (name === 'tasks') set('assigneeId', null);
  if (OWNED.has(name)) set('ownerId', ME.userId);
  if (RECIPIENT.has(name)) set('userId', ME.userId);
  if (name === 'claudeItems' && has(x, 'waitingOnOm')) {
    const t = x.waitingOnOm || '';
    delete x.waitingOnOm;
    set('waitingText', t);
    set('waitingOn', t ? ME.userId : null);
  }
  if (name === 'trash' && x.task) x.task = stamp('tasks', x.task);
  if (name === 'settings' && typeof x._id === 'string') {
    const [area, who] = x._id.split(':');
    if (who && USER_AREAS.has(area)) { set('area', area); set('orgId', ME.orgId); set('userId', who); }
    if (who && area === 'discord') { set('area', area); set('orgId', who); }
  }
  if (name === 'counters' && typeof x._id === 'string' && x._id.includes(':')) set('orgId', ME.orgId);
  return x;
}
function mapQ(name, q) {
  if (!q || typeof q !== 'object' || !has(q, '_id')) return q;
  return { ...q, _id: mapId(name, q._id) };
}
/** An upsert inserts with the owner's fields the update does not set itself. */
function upsertStamp(name, q, u) {
  if (!u || Array.isArray(u)) return u;
  const want = stamp(name, { ...(typeof q?._id === 'string' ? { _id: q._id } : {}) });
  const given = new Set([...Object.keys(u.$set ?? {}), ...Object.keys(u.$setOnInsert ?? {}), ...Object.keys(q ?? {})]);
  const add = Object.fromEntries(Object.entries(want).filter(([k]) => k !== '_id' && !given.has(k)));
  return Object.keys(add).length ? { ...u, $setOnInsert: { ...(u.$setOnInsert ?? {}), ...add } } : u;
}
function ownedCollection(name, col) {
  return new Proxy(col, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      const f = v.bind(t);
      switch (p) {
        case 'insertOne': return (d, o) => f(stamp(name, d), o);
        case 'insertMany': return (ds, o) => f(ds.map(d => stamp(name, d)), o);
        case 'replaceOne': return (q, d, o) => f(mapQ(name, q), stamp(name, d), o);
        case 'updateOne': case 'updateMany': case 'findOneAndUpdate':
          return (q, u, o) => f(mapQ(name, q), o?.upsert ? upsertStamp(name, mapQ(name, q), u) : u, o);
        case 'find': case 'findOne': case 'deleteOne': case 'deleteMany': case 'countDocuments': case 'findOneAndDelete':
          return (q, ...a) => f(mapQ(name, q), ...a);
        default: return f;
      }
    },
  });
}
export const db = new Proxy(rawDb, {
  get(t, p) {
    if (p === 'collection') return (name, ...a) => ownedCollection(name, t.collection(name, ...a));
    const v = t[p];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});

// ---- who the suites are (docs/auth.md): one owner, their organization and a Claude chat key, made by seed.mjs on
// every emptied database (makeIdentity) and kept in a small state file so the suite process can read the key ----
export const EMAIL = 'e2e-owner@example.test';
export const PW = 'testpass-e2e-123';
const STATE = process.env.E2E_STATE || path.join(os.tmpdir(), `wos-e2e-state-${DBNAME}.json`);
/** The Claude chat key (agent "claude"): what MCP_TOKEN was. */
export let MCP = null;
/** { userId, orgId } of the owner. */
export let ME = null;
try { const st = JSON.parse(fs.readFileSync(STATE, 'utf8')); MCP = st.claudeKey; ME = { userId: st.userId, orgId: st.orgId }; } catch { /* seed.mjs writes it */ }
let adminP = null;
/** Better Auth admin (scripts/lib/auth-admin.mjs) on the test database. */
export async function admin() {
  adminP ??= import('../../scripts/lib/auth-admin.mjs').then(m => m.authAdmin({ db: rawDb, client: mc, secret: SECRET, baseURL: B }));
  return adminP;
}
/**
 * Owner, organization, membership and a Claude chat key on an emptied database; written to the state file. The owner
 * gets what scripts/migrate-phase3.mjs gives the first owner: the old timetable and routine, in Asia/Kolkata.
 */
export async function makeIdentity() {
  const a = await admin();
  const userId = await a.createUser({ email: EMAIL, name: 'E2E Owner', password: PW });
  const orgId = await a.createOrg({ name: 'E2E Org', slug: 'e2e' });
  await a.addMember({ userId, orgId, role: 'owner' });
  const { key } = await a.createKey({ userId, orgId, agent: 'claude', name: 'e2e chat' });
  fs.writeFileSync(STATE, JSON.stringify({ userId, orgId, claudeKey: key }));
  MCP = key; ME = { userId, orgId };
  await giveLegacyWeek(ME);
  await setProfile(ME, { timezone: 'Asia/Kolkata' });
  return ME;
}
/** The pre-phase-3 timetable, routine, review questions and help as someone's schedule (scripts/lib/legacy-week.mjs). */
export async function giveLegacyWeek(who) {
  const L = await import('../../scripts/lib/legacy-week.mjs');
  const schedule = { blocks: L.LEGACY_BLOCKS, colors: L.LEGACY_COLORS, taskModes: L.LEGACY_TASK_MODES, routine: L.LEGACY_ROUTINE, review: L.LEGACY_REVIEW, help: L.LEGACY_HELP };
  await setSchedule(who, schedule);
}
/** Write someone's schedule document directly (shape: lib/schedule.ts ScheduleSchema). */
export async function setSchedule(who, schedule) {
  await rawDb.collection('settings').updateOne({ _id: `schedule:${who.userId}` }, { $set: { area: 'schedule', orgId: who.orgId, userId: who.userId, schedule } }, { upsert: true });
}
/** Set fields of someone's profile (timezone, quietStart, quietEnd, discordId). The app caches profiles a minute. */
export async function setProfile(who, set) {
  await rawDb.collection('settings').updateOne({ _id: `profile:${who.userId}` }, { $set: { area: 'profile', orgId: who.orgId, userId: who.userId, ...set } }, { upsert: true });
}
/** Connect an organization to a Discord server id (what the operator does in Settings). */
export async function setOrgGuild(orgId, guildId) {
  await rawDb.collection('settings').updateOne({ _id: `discord:${orgId}` }, { $set: { area: 'discord', orgId, guildId } }, { upsert: true });
}
/** Another user (optionally in a new organization of their own, or in orgId with role). Returns { userId, orgId }. */
export async function makeUser({ email, name = 'Someone', password = PW, orgId = null, role = 'member', orgName = null }) {
  const a = await admin();
  const userId = await a.createUser({ email, name, password });
  let org = orgId;
  if (!org) org = await a.createOrg({ name: orgName ?? `${name} Org`, slug: `o-${Math.random().toString(36).slice(2, 10)}` });
  await a.addMember({ userId, orgId: org, role: orgId ? role : 'owner' });
  return { userId, orgId: org };
}
/** A Work OS API key for a user (default: the owner); agent 'claude' or 'claude-code'. Returns the key. */
export async function mkKey({ agent = 'claude-code', userId = ME.userId, orgId = ME.orgId, name = 'e2e' } = {}) {
  return (await (await admin()).createKey({ userId, orgId, agent, name })).key;
}

// ---- playwright ----
const req = createRequire(import.meta.url);
function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'C:/Users/VICTUS/AppData/Roaming/npm/node_modules/@delpat/tutorial-videos/node_modules/playwright-core'].filter(Boolean);
  for (const c of cands) { try { return req(c); } catch { /* next */ } }
  throw new Error('playwright-core not found; set PLAYWRIGHT_CORE to its folder');
}
export const { chromium } = loadPlaywright();
const CHROME = process.env.CHROME_EXE || (process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/ms-playwright/chromium-1243/chrome-win64/chrome.exe' : '');
export const launch = (opts = {}) => chromium.launch({ ...(CHROME && fs.existsSync(CHROME) ? { executablePath: CHROME } : {}), ...opts });

// ---- results ----
// Choose an option in the app's own select (components/ui/select.tsx): open its trigger, click the option by value
// (string) or by label ({ label }). `where` is a selector or a locator.
export async function pick(from, where, v) {
  const page = typeof from.page === 'function' ? from.page() : from; // a locator inside a dialog still has its list in the page's body
  const trig = typeof where === 'string' ? from.locator(where) : where;
  await trig.click();
  const list = page.locator('[data-slot=select-content]').last();
  await list.waitFor({ timeout: 8000 });
  const opt = typeof v === 'object' ? list.getByRole('option', { name: v.label, exact: true }) : list.locator(`[role=option][data-value="${v}"]`);
  await opt.click();
  await page.locator('[data-slot=select-content]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

export const state = { pass: 0, fail: 0, fails: [] };
export const redact = s => String(s).replace(/w(kr|os)_[A-Za-z0-9_-]{8,}/g, 'w$1_<redacted>');
export const check = (l, c, x = '') => { c ? state.pass++ : (state.fail++, state.fails.push(l)); console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${!c && x ? '  - ' + redact(x) : ''}`); };
// Prints the line run.sh parses, closes the database, exits non-zero on any failure.
export async function finish(extraFail = 0) {
  console.log(`\nRESULT pass=${state.pass} fail=${state.fail + extraFail}`);
  if (state.fails.length) console.log('FAILED: ' + JSON.stringify(state.fails));
  await mc.close().catch(() => {});
  process.exit(state.fail + extraFail ? 1 : 0);
}
// For the older assert-style suites: every assert call counts as one check; the first failed assert stops the suite.
import nodeAssert from 'node:assert';
const counted = fn => (...a) => {
  try { const r = fn(...a); state.pass++; return r; } catch (e) {
    state.fail++; const label = String(a[a.length - 1] && typeof a[a.length - 1] === 'string' ? a[a.length - 1] : e.message).split('\n')[0].slice(0, 160);
    state.fails.push(label); console.log('FAIL  assert - ' + redact(label)); e.counted = true; throw e;
  }
};
export const assert = Object.assign(counted(nodeAssert), Object.fromEntries(['ok', 'equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'deepStrictEqual'].map(k => [k, counted(nodeAssert[k])])));
export async function runAssertSuite(name, fn) {
  try { await fn(); } catch (e) { if (!e?.counted) check(name + ' (error)', false, e?.stack || String(e)); else console.log(String(e.stack || e).split('\n').slice(0, 4).join('\n')); }
  await finish();
}

// ---- MCP + worker API ----
let rid = 0;
export async function mcpRaw(name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${MCP}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  return { isError: !!b.result?.isError || !!b.error, text: b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b) };
}
/** An MCP tool call with another key: { isError, text, json }. */
export async function mcpAs(key, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!b.result?.isError || !!b.error, text, json };
}
// parsed result; an error comes back as { ERROR } (call) or the raw text (mcp)
export async function call(name, args = {}) { const r = await mcpRaw(name, args); if (r.isError) return { ERROR: r.text }; try { return JSON.parse(r.text); } catch { return r.text; } }
export async function mcp(name, args = {}) { const r = await mcpRaw(name, args); try { return JSON.parse(r.text); } catch { return r.text; } }
export const api = (key, method, p, body, extra = {}) => fetch(B + p, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
export const sha = s => createHash('sha256').update(s).digest('hex');
export async function mkDevice(name) {
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  const _id = randomUUID();
  await db.collection('devices').insertOne({ _id, name, ...(ME ? { ownerId: ME.userId, orgId: ME.orgId } : {}), hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  return { id: _id, key };
}
/** A Claude Code key of the owner (what the old wos_ keys were). */
export async function mkWos() {
  return mkKey({ agent: 'claude-code' });
}
export const cron = (extra = '') => fetch(`${B}/api/cron/alerts?run=1${extra}`, { headers: { authorization: `Bearer ${CRON}` } }).then(r => r.json());

// ---- browser helpers ----
export const settle = (p, ms = 600) => p.waitForTimeout(ms);
/** Fills the sign-in form once the page is ready (its button is disabled until then). */
export async function fillLogin(p, { email = EMAIL, password = PW } = {}) {
  await p.waitForSelector('form button[type=submit]:not([disabled])', { timeout: 20000 });
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
}
export async function login(p, { phone = false, next = '/today', email = EMAIL, password = PW } = {}) {
  await p.goto(B + '/login?next=' + next);
  await fillLogin(p, { email, password });
  const btn = p.locator('button[type=submit]');
  await (phone ? btn.tap() : btn.click());
  await p.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 });
}
/** The session cookies of a browser context (Better Auth: workos.session_token, workos.session_data). */
export const sessionCookies = async ctx => (await ctx.cookies()).filter(c => c.name.startsWith('workos.'));
export const overflow = p => p.evaluate(() => {
  const w = window.innerWidth;
  const bad = [...document.querySelectorAll('body *')].filter(el => {
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.width === 0 || st.visibility === 'hidden' || st.display === 'none') return false;
    if (el.closest('[class*="overflow-x-auto"]') || el.closest('[data-sonner-toaster]') || el.closest('.toaster')) return false;
    if (!(r.right > w + 1 || r.left < -1)) return false;
    // text clipped with an ellipsis (truncate) by a parent that itself sits inside the viewport is not an overflow
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (/(hidden|clip)/.test(getComputedStyle(a).overflowX)) { const ar = a.getBoundingClientRect(); if (ar.right <= w + 1 && ar.left >= -1) return false; break; }
    }
    return true;
  });
  const main = document.querySelector('main');
  return { docScroll: document.documentElement.scrollWidth > w + 1, mainScroll: main ? main.scrollWidth > main.clientWidth + 1 : false, offenders: bad.slice(0, 3).map(e => `${e.tagName}.${String(e.className).slice(0, 60)}`) };
});
export const okO = o => !o.docScroll && !o.mainScroll && !o.offenders.length;
