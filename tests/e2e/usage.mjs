// Request log (docs/usage-log.md): proxy auth unchanged on every path (self-authenticating APIs still bypass the
// session check, guarded ones still guarded), known requests counted with the right kind/caller/route, no ids,
// query strings or keys stored, static files not counted, and Settings › Usage at 390 and 1280. Seed profile: none.
import { B, MCP, CRON, SP, db, state, check, finish, launch, login, mkDevice, mkWos, overflow, okO, sessionCookies } from './lib.mjs';

const proxy401 = '{"error":"unauthorized"}';
const req = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o }).then(async r => ({ status: r.status, text: await r.text(), loc: r.headers.get('location') }));
const bearer = k => ({ authorization: `Bearer ${k}` });
const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const mcpHdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function counts() {
  const out = {};
  for (const d of await db.collection('requestStats').find().toArray()) for (const [k, n] of Object.entries(d.counts ?? {})) out[k] = (out[k] ?? 0) + n;
  return out;
}
// Counting runs after the response; wait until every expectation is met (or 5 s).
async function expectCounts(base, want, label) {
  let c = {};
  for (let i = 0; i < 25; i++) {
    c = await counts();
    if (Object.entries(want).every(([k, n]) => (c[k] ?? 0) - (base[k] ?? 0) >= n)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  for (const [k, n] of Object.entries(want)) check(`${label}: ${k} +${n}`, (c[k] ?? 0) - (base[k] ?? 0) >= n, `got +${(c[k] ?? 0) - (base[k] ?? 0)}`);
  if (state.fails.length) console.log('  new since last step:', JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k, n]) => n !== (base[k] ?? 0)).map(([k, n]) => [k, n - (base[k] ?? 0)]))));
  return c;
}

const dev = await mkDevice('usage-dev');
const wos = await mkWos();
let base = await counts();

// ---- 1. auth unchanged on the paths the matcher used to skip ----
let r = await req('/api/mcp', { method: 'POST', headers: mcpHdr, body: mcpBody });
check('mcp: no key -> 401 from the route (JSON-RPC body, not the proxy)', r.status === 401 && r.text.includes('jsonrpc'), `${r.status} ${r.text.slice(0, 80)}`);
r = await req('/api/mcp', { method: 'POST', headers: { ...mcpHdr, ...bearer(MCP) }, body: mcpBody });
check('mcp: Claude chat key -> 200', r.status === 200, r.status);
r = await req('/api/mcp', { method: 'POST', headers: { ...mcpHdr, ...bearer(wos) }, body: mcpBody });
check('mcp: wos_ key -> 200 (the proxy would refuse it: still bypassed)', r.status === 200, r.status);
r = await req('/api/mcp', { method: 'POST', headers: { ...mcpHdr, ...bearer(dev.key) }, body: mcpBody });
check('mcp: wkr_ key -> 401 from the route', r.status === 401 && r.text.includes('jsonrpc'), r.status);

r = await req('/api/worker/jobs');
check('worker: no key -> 401', r.status === 401, r.status);
r = await req('/api/worker/jobs', { headers: bearer(dev.key) });
check('worker: wkr_ key -> 200 (the proxy would refuse it: still bypassed)', r.status === 200, r.status);
r = await req('/api/worker/jobs', { headers: bearer(MCP) });
check('worker: Claude chat key -> 401 (the route decides, not the proxy)', r.status === 401, r.status);

r = await req('/api/cron/alerts?dry=1');
check('cron: no secret -> 401', r.status === 401, r.status);
r = await req('/api/cron/alerts?dry=1', { headers: bearer(CRON) });
check('cron: CRON_SECRET header -> 200 (the proxy would refuse it: still bypassed)', r.status === 200, r.status);
r = await req(`/api/cron/alerts?dry=1&key=${CRON}`);
check('cron: ?key= -> 200', r.status === 200, r.status);
r = await req('/api/cron/alerts?dry=1', { headers: bearer(MCP) });
check('cron: Claude chat key -> 401 (the route decides, not the proxy)', r.status === 401, r.status);

r = await req('/api/discord/interactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":1}' });
check('discord: unsigned -> refused by the route, not the proxy', r.status >= 400 && r.text !== proxy401, `${r.status} ${r.text.slice(0, 60)}`);
r = await req('/api/discord/interactions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': '1' }, body: '{"type":1}' });
check('discord: bad signature -> refused by the route', r.status >= 400 && r.text !== proxy401, `${r.status} ${r.text.slice(0, 60)}`);

r = await req('/api/cronx');
check('lookalike /api/cronx -> proxy 401 (self-checking prefixes match whole path segments only)', r.status === 401 && r.text === proxy401, r.status);

// ---- 2. guarded paths still guarded ----
r = await req('/api/admin/health');
check('admin: no key -> proxy 401', r.status === 401 && r.text === proxy401, `${r.status} ${r.text.slice(0, 60)}`);
r = await req('/api/admin/health', { headers: bearer(MCP) });
check('admin: Claude chat key of an owner -> 200', r.status === 200, r.status);
r = await req('/api/admin/health', { headers: bearer(wos) });
check('admin: Claude Code key -> 401 (opens /api/mcp only)', r.status === 401, r.status);
r = await req('/api/timetable/today', { headers: bearer(dev.key) });
check('other api: wkr_ key -> 401', r.status === 401, r.status);
r = await req('/today', { headers: { accept: 'text/html' } });
check('/today without a session -> redirect to /login?next=/today', [302, 307].includes(r.status) && /\/login\?next=%2Ftoday$/.test(r.loc ?? ''), `${r.status} ${r.loc}`);
r = await req('/today', { headers: { accept: 'text/html', cookie: 'workos.session_token=forged.token; workos.session_data=eyJmb3JnZWQiOnRydWV9' } });
check('/today with a forged cookie -> redirect', [302, 307].includes(r.status), r.status);
r = await req('/login', { headers: { accept: 'text/html' } });
check('/login open', r.status === 200, r.status);
r = await req('/login/reset', { headers: { accept: 'text/html' } });
check('/login/reset open', r.status === 200, r.status);
r = await req('/login/x', { headers: { accept: 'text/html' } });
check('/login/x not open', [302, 307].includes(r.status), r.status);

// ---- 3. counts for those calls ----
base = await expectCounts(base, {
  'api|anonymous|/api/mcp': 1, 'api|mcp|/api/mcp': 3,
  'api|anonymous|/api/worker/jobs': 1, 'api|worker|/api/worker/jobs': 2,
  'api|anonymous|/api/cron/alerts': 1, 'api|cron|/api/cron/alerts': 3,
  'api|anonymous|/api/discord/interactions': 1, 'api|discord|/api/discord/interactions': 1,
  'api|anonymous|/api/admin/health': 1, 'api|mcp|/api/admin/health': 1,
  'api|anonymous|/api/(other)': 1,
  'page|anonymous|/today': 2, 'page|anonymous|/login': 1, 'page|anonymous|/login/reset': 1, 'page|anonymous|(other)': 1,
}, 'api + auth calls');

// ---- 4. browser: page, page data (prefetch and navigation), action ----
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await login(p, { next: '/settings' });
const cookie = (await sessionCookies(ctx)).map(c => `${c.name}=${c.value}`).join('; ');
check('signed in', !!cookie);
base = await expectCounts(base, { 'page|anonymous|/login': 1, 'api|anonymous|/api/auth/[all]': 1 }, 'login');

await p.goto(B + '/today'); await p.waitForLoadState('networkidle').catch(() => {});
base = await expectCounts(base, { 'page|browser|/today': 1 }, 'page load');

// what the router sends for a prefetch (the proxy cannot see the RSC/prefetch headers: counted as page data)
await p.evaluate(() => fetch('/projects', { headers: { RSC: '1', 'Next-Router-Prefetch': '1' } }).then(r => r.text()));
base = await expectCounts(base, { 'rsc|browser|/projects': 1 }, 'prefetch');
// a real client navigation
await p.locator('aside a[href="/notes"]').first().click();
await p.waitForURL(/\/notes/);
base = await expectCounts(base, { 'rsc|browser|/notes': 1 }, 'client navigation or preload');

// a server action: Settings › Alerts switch, then back
await p.goto(B + '/settings?section=alerts'); await p.waitForSelector('table[aria-label="Alerts by channel"]');
const sw = p.getByRole('switch', { name: 'Overdue', exact: true });
await sw.click(); await p.waitForTimeout(700); await sw.click(); await p.waitForTimeout(700);
base = await expectCounts(base, { 'action|browser|/settings': 2 }, 'server action');

// ids and query strings are never stored; URL keys neither
await req('/tasks/98765?q=secretword', { headers: { cookie, accept: 'text/html' } });
await req('/projects/abc-def-777', { headers: { cookie } });
await req('/api/mcp/urlkeyabc123456789', { method: 'POST', headers: mcpHdr, body: mcpBody });
await req('/sw.js'); await req('/manifest.webmanifest'); await req('/icons/192');
await expectCounts(base, { 'page|browser|/tasks/[id]': 1, 'rsc|browser|/projects/[id]': 1, 'api|mcp|/api/mcp/[key]': 1 }, 'normalised routes');
const raw = JSON.stringify(await db.collection('requestStats').find().toArray());
for (const s of ['98765', 'secretword', 'abc-def-777', 'urlkeyabc', '?', MCP, CRON, dev.key.slice(0, 12), wos.slice(0, 12), '127.0.0.1', '::1'])
  check(`not stored: ${s.length > 14 ? s.slice(0, 6) + '…' : s}`, !raw.includes(s));
check('static files not counted (sw.js, manifest, icons, _next)', !/sw\.js|webmanifest|\/icons|_next/.test(raw));

// ---- 5. storage shape ----
const docs = await db.collection('requestStats').find().toArray();
check('hour buckets: _id YYYY-MM-DDTHH, at = start of that UTC hour', docs.length > 0 && docs.every(d => /^\d{4}-\d\d-\d\dT\d\d$/.test(d._id) && d.at instanceof Date && d.at.toISOString().startsWith(d._id + ':00:00')));
check('total = sum of counts', docs.every(d => d.total === Object.values(d.counts).reduce((a, n) => a + n, 0)));
check('keys are kind|caller|route', docs.every(d => Object.keys(d.counts).every(k => /^(page|rsc|action|api)\|(browser|worker|mcp|cron|discord|anonymous)\|(\/|\()/.test(k))));
const ix = (await db.collection('requestStats').indexes()).find(i => i.name === 'at_ttl');
check('TTL index keeps 35 days', ix?.expireAfterSeconds === 35 * 86400, JSON.stringify(ix));

// ---- 6. Settings › Usage ----
const total = Object.values(await counts()).reduce((a, n) => a + n, 0);
for (const [label, vp, touch] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  const c2 = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch });
  await c2.addCookies(await sessionCookies(ctx));
  const q = await c2.newPage(); q.on('pageerror', e => errs.push(e.message));
  // the entry (phone: a row on the overview; desktop: the sub-nav), then the section itself
  await q.goto(B + '/settings');
  check(`${label}: Usage entry links to the section`, (await q.locator(label === 'phone' ? '[data-row=usage]' : '[data-section=usage]').getAttribute('href')) === '/settings?section=usage');
  await q.goto(B + '/settings?section=usage');
  await q.waitForSelector('[data-usage]');
  const day = Number((await q.locator('[data-usage-total=day]').innerText()).replace(/,/g, ''));
  check(`${label}: 24 h total shown (${day} >= ${total})`, day >= total);
  check(`${label}: 24 hour bars`, (await q.locator('[data-usage-hours] > div').count()) === 24);
  check(`${label}: 7 day rows`, (await q.locator('[data-usage-day]').count()) === 7);
  check(`${label}: worker route with its kind and caller`, (await q.locator('[data-usage-route="/api/worker/jobs"] [data-usage-part="api|worker"]').count()) === 1);
  check(`${label}: /tasks/[id] row`, (await q.locator('[data-usage-route="/tasks/[id]"]').count()) === 1);
  check(`${label}: Vercel note`, (await q.locator('[data-usage]').innerText()).includes("Vercel's limit counts these plus static files."));
  const o = await overflow(q); check(`${label}: no overflow`, okO(o), JSON.stringify(o));
  await q.screenshot({ path: `${SP}/usage-${label}.png`, fullPage: true });
  check(`${label}: 7-day toggle links to range=7d`, (await q.locator('[data-usage-range="7d"]').getAttribute('href')) === '/settings?section=usage&range=7d');
  await q.goto(B + '/settings?section=usage&range=7d');
  await q.waitForSelector('[data-usage-range="7d"][aria-selected=true]');
  check(`${label}: 7-day range shows routes`, (await q.locator('[data-usage-route]').count()) > 3);
  const o2 = await overflow(q); check(`${label}: no overflow (7 days)`, okO(o2), JSON.stringify(o2));
  await c2.close();
}
check('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
await finish();
