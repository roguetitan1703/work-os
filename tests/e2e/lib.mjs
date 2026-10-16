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
export const PW = need('APP_PASSWORD');
export const MCP = need('MCP_TOKEN');
export const CRON = need('CRON_SECRET');
export const SP = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'wos-e2e-shots');
fs.mkdirSync(SP, { recursive: true });

export const mc = new MongoClient(URI);
await mc.connect();
export const db = mc.db(DBNAME);

// ---- playwright ----
const req = createRequire(import.meta.url);
function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'C:/Users/VICTUS/AppData/Roaming/npm/node_modules/@delpat/tutorial-videos/node_modules/playwright-core'].filter(Boolean);
  for (const c of cands) { try { return req(c); } catch { /* next */ } }
  throw new Error('playwright-core not found; set PLAYWRIGHT_CORE to its folder');
}
export const { chromium } = loadPlaywright();
const CHROME = process.env.CHROME_EXE || (process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '/ms-playwright/chromium-1243/chrome-win64/chrome.exe' : '');
export const launch = () => chromium.launch(CHROME && fs.existsSync(CHROME) ? { executablePath: CHROME } : {});

// ---- results ----
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
// parsed result; an error comes back as { ERROR } (call) or the raw text (mcp)
export async function call(name, args = {}) { const r = await mcpRaw(name, args); if (r.isError) return { ERROR: r.text }; try { return JSON.parse(r.text); } catch { return r.text; } }
export async function mcp(name, args = {}) { const r = await mcpRaw(name, args); try { return JSON.parse(r.text); } catch { return r.text; } }
export const api = (key, method, p, body, extra = {}) => fetch(B + p, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
export const sha = s => createHash('sha256').update(s).digest('hex');
export async function mkDevice(name) {
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  const _id = randomUUID();
  await db.collection('devices').insertOne({ _id, name, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  return { id: _id, key };
}
export async function mkWos() {
  const K = 'wos_' + randomBytes(32).toString('base64url');
  await db.collection('apiKeys').insertOne({ _id: randomUUID(), name: 'e2e', role: 'claude-code', hash: sha(K), prefix: K.slice(0, 8), createdAt: new Date(), lastUsedAt: null, revokedAt: null });
  return K;
}
export const cron = (extra = '') => fetch(`${B}/api/cron/alerts?key=${CRON}${extra}`).then(r => r.json());

// ---- browser helpers ----
export const settle = (p, ms = 600) => p.waitForTimeout(ms);
export async function login(p, { phone = false, next = '/today' } = {}) {
  await p.goto(B + '/login?next=' + next);
  await p.fill('input[name=password]', PW);
  const btn = p.locator('button[type=submit]');
  await (phone ? btn.tap() : btn.click());
  await p.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 });
}
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
