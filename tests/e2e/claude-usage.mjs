// Claude usage per session (Claude › Usage, `usage` tool, POST /api/worker/status `usage`). Covers: rows a worker reports are
// stored (bad rows dropped, only the known fields, a day's total replaced not added); the Usage tab shows them (sessions by
// share with the formula of lib/data/claude-usage.ts, subagents under their session, models, ranges); another member of the
// organization and another organization see nothing (page and `usage` tool); the week-starts form; no overflow at 390 px;
// screenshots at 390 and 1280, light and dark. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, PW, SP, api, check, finish, launch, login, makeUser, mkDevice, mkKey, okO, overflow, rawDb } from './lib.mjs';
import { mcpH } from './flow-lib.mjs';

const TZ = 'Asia/Kolkata';
const dayOf = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + offset * 86_400_000));
const today = dayOf(0);
const twoAgo = dayOf(-2);
const OPUS = 'claude-opus-4-5-20251101';
const SONNET = 'claude-sonnet-4-5-20250929';
// The weight formula of lib/data/claude-usage.ts: model ratio (Opus 5/3, Sonnet 1) × (input + 1.25 cache write + 0.1 cache read + 5 output).
const w = (model, c) => (model === OPUS ? 5 / 3 : 1) * (c.i + 1.25 * c.cw + 0.1 * c.cr + 5 * c.o);
const pct = x => (x < 0.001 ? '<0.1%' : `${Math.round(x * 1000) / 10}%`);

const S1 = randomUUID();
const S2 = randomUUID();
const C1 = { i: 100, cw: 2000, cr: 50000, o: 800 };
const C1b = { i: 40, cw: 0, cr: 10000, o: 300 };
const CX = { i: 10, cw: 400, cr: 9000, o: 200 };
const CY = { i: 20, cw: 100, cr: 4000, o: 100 };
let C2 = { i: 50, cw: 300, cr: 8000, o: 400 };
const row = (sessionId, part, model, day, c, partName) => ({ sessionId, part, model, day, ...c, ...(partName ? { partName } : {}) });
const sessions = [
  { sessionId: S1, title: 'Build the usage page', folder: 'usage-proj', origin: 'vscode' },
  { sessionId: S2, title: 'Fix the login', folder: 'login-proj', origin: 'cli' },
];
const report = (dev, rows) => api(dev.key, 'POST', '/api/worker/status', { usage: { rows, sessions } });

const dev = await mkDevice('usage-pc');
// The week starts three days ago, so the row two days ago is inside "this week" whatever day this runs.
const wd = new Date(today + 'T00:00:00Z');
wd.setUTCDate(wd.getUTCDate() - 3);
await rawDb.collection('settings').updateOne({ _id: `profile:${ME.userId}` }, { $set: { area: 'profile', orgId: ME.orgId, userId: ME.userId, claudePlanReset: { weekday: wd.getUTCDay(), time: '00:00', tz: TZ } } }, { upsert: true });

// ── 1. A worker reports ──
const first = await report(dev, [
  row(S1, 'main', OPUS, today, C1),
  row(S1, 'main', OPUS, twoAgo, C1b),
  row(S1, 'agent-x', SONNET, today, CX, 'Explorer X'),
  row(S1, 'agent-y', OPUS, today, CY, 'Planner Y'),
  row(S2, 'main', SONNET, today, C2),
  row(S2, 'main', '', today, C2), // no model: dropped
  row('not-a-session', 'main', OPUS, today, C2), // bad session id: dropped
]);
check('the report is accepted', first.status === 200, JSON.stringify(first.body));
const docs = await rawDb.collection('claudeUsage').find({}).toArray();
check('five rows are stored, the two bad ones dropped', docs.length === 5, String(docs.length));
const FIELDS = ['_id', 'orgId', 'ownerId', 'deviceId', 'sessionId', 'part', 'partName', 'model', 'day', 'dayAt', 'i', 'cw', 'cr', 'o', 'title', 'folder', 'origin', 'updatedAt'];
check('only the known fields are stored', docs.every(d => Object.keys(d).every(k => FIELDS.includes(k))), JSON.stringify(docs.map(d => Object.keys(d)).flat().filter(k => !FIELDS.includes(k))));
check('each row is the owner\'s, in their organization, on this computer', docs.every(d => d.ownerId === ME.userId && d.orgId === ME.orgId && d.deviceId === dev.id));
check('a bad shape is refused', (await api(dev.key, 'POST', '/api/worker/status', { usage: { rows: 'x' } })).status === 400);

// ── 2. The page, as the owner ──
const total = () => w(OPUS, C1) + w(OPUS, C1b) + w(SONNET, CX) + w(OPUS, CY) + w(SONNET, C2);
const s1Weight = () => w(OPUS, C1) + w(OPUS, C1b) + w(SONNET, CX) + w(OPUS, CY);
const b = await launch();
try {
  const open = async (p, range = 'week', email, ) => { void email; await p.goto(`${B}/claude?tab=usage&range=${range}`); await p.waitForSelector('[data-section="usage"]'); };
  for (const vp of [390, 1280]) {
    const ctx = await b.newContext({ viewport: { width: vp, height: 900 }, ...(vp === 390 ? { isMobile: true, hasTouch: true } : {}) });
    const p = await ctx.newPage();
    await login(p, { phone: vp === 390, next: '/claude?tab=usage' });
    await open(p);
    const s1 = p.locator(`[data-usage-session="${S1}"]`);
    const s2 = p.locator(`[data-usage-session="${S2}"]`);
    const order = await p.locator('[data-usage-sessions] > details').evaluateAll(els => els.map(e => e.getAttribute('data-usage-session')));
    check(`[${vp}] S1 is above S2`, order[0] === S1 && order[1] === S2, order.join(','));
    check(`[${vp}] S1's share is the formula's`, (await s1.locator('summary').innerText()).includes(pct(s1Weight() / total())), await s1.locator('summary').innerText());
    check(`[${vp}] the line says project, computer, where, models and subagents`, /No project · usage-pc · VS Code · Opus 4\.5 [\d.]+%/.test(await s1.innerText()) && /2 subagents \(/.test(await s1.innerText()), await s1.innerText());
    await s1.locator('summary').click();
    const body = await s1.textContent();
    check(`[${vp}] opening S1 lists agent-x and agent-y`, /Explorer X/.test(body) && /Planner Y/.test(body) && (await s1.locator('[data-usage-subagent]').count()) === 2);
    check(`[${vp}] Models lists Opus and Sonnet`, /Opus 4\.5/.test(await p.locator('main').innerText()) && /Sonnet 4\.5/.test(await p.locator('main').innerText()));
    check(`[${vp}] the note says estimate, not a share of the limit`, /estimated from your computers' session logs · not a share of your plan limit/.test(await p.locator('[data-usage-note]').innerText()));
    check(`[${vp}] the Days section has the days since the week start`, (await p.locator('section', { hasText: 'Days' }).first().locator('li').count()) === 4);
    check(`[${vp}] no horizontal overflow`, okO(await overflow(p)), JSON.stringify(await overflow(p)));
    await p.screenshot({ path: `${SP}/usage-${vp}-light.png`, fullPage: true });
    await p.evaluate(() => document.documentElement.classList.add('dark'));
    await p.screenshot({ path: `${SP}/usage-${vp}-dark.png`, fullPage: true });
    await p.evaluate(() => document.documentElement.classList.remove('dark'));
    // today leaves out the row two days ago
    await open(p, 'today');
    const t1 = await p.locator(`[data-usage-session="${S1}"] summary`).innerText();
    const todayS1 = w(OPUS, C1) + w(SONNET, CX) + w(OPUS, CY);
    const todayTotal = todayS1 + w(SONNET, C2);
    check(`[${vp}] Today leaves out the row of two days ago`, t1.includes(pct(todayS1 / todayTotal)) && !t1.includes(pct(s1Weight() / total())), t1);
    await ctx.close();
  }
  const r = await mcpH(MCP, 'usage', { range: 'today' });
  check('the usage tool: today leaves out the older row', !r.isError && r.json.bySession.find(s => s.sessionId === S1)?.weight === Math.round(w(OPUS, C1) + w(SONNET, CX) + w(OPUS, CY)), r.text.slice(0, 300));

  // ── 3. A day's total is replaced, not added ──
  C2 = { i: 5000, cw: 0, cr: 0, o: 5000 };
  await report(dev, [row(S2, 'main', SONNET, today, C2)]);
  check('re-posting a day keeps five rows', (await rawDb.collection('claudeUsage').countDocuments({})) === 5);
  const ctx2 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  await login(p2, { next: '/claude?tab=usage' });
  await open(p2);
  const order2 = await p2.locator('[data-usage-sessions] > details').evaluateAll(els => els.map(e => e.getAttribute('data-usage-session')));
  check('the new total replaced the old: S2 now has the larger share', order2[0] === S2 && (await p2.locator(`[data-usage-session="${S2}"] summary`).innerText()).includes(pct(w(SONNET, C2) / total())), order2.join(','));

  // ── 5. The week-starts form ──
  await p2.locator('summary', { hasText: 'Week starts' }).click();
  await p2.evaluate(() => { const f = document.querySelector('[data-usage-reset]'); f.querySelector('input[name=weekday]').value = '1'; });
  await p2.fill('[data-usage-reset] input[name=time]', '09:00');
  await p2.locator('[data-usage-reset] button[type=submit]').click();
  await p2.waitForFunction(() => /Week starts Monday 09:00/.test(document.body.innerText), null, { timeout: 15000 });
  check('saving Monday 09:00 changes the label', true);
  check('the week label says Mon 09:00', /Mon 09:00/.test(await p2.locator('[data-usage-note]').innerText()), await p2.locator('[data-usage-note]').innerText());
  await p2.evaluate(() => { document.querySelector('[data-usage-reset]').closest('details').open = true; });
  await p2.evaluate(() => { document.querySelector('[data-usage-reset] input[name=time]').value = '25:00'; });
  await p2.locator('[data-usage-reset] button[type=submit]').click();
  await p2.waitForSelector('[data-usage-reset-error]', { timeout: 15000 });
  check('a time that is not a time shows the error', /hours and minutes/.test(await p2.locator('[data-usage-reset-error]').innerText()));
  await ctx2.close();

  // ── 4. Nobody else sees it ──
  const B_ = await makeUser({ email: 'usage-b@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const C_ = await makeUser({ email: 'usage-c@example.test', name: 'Cy', orgName: 'Usage C Org' });
  const kB = await mkKey({ userId: B_.userId, orgId: B_.orgId });
  const kC = await mkKey({ userId: C_.userId, orgId: C_.orgId });
  for (const [who, email, key] of [['member of the same organization', 'usage-b@example.test', kB], ['another organization', 'usage-c@example.test', kC]]) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await login(p, { email, password: PW, next: '/claude?tab=usage' });
    await open(p);
    const text = await p.locator('main').innerText();
    check(`${who}: the page says No usage yet`, /No usage yet/.test(text) && !text.includes('Build the usage page'), text.slice(0, 200));
    const m = await mcpH(key, 'usage', {});
    check(`${who}: the usage tool returns no sessions`, !m.isError && m.json.bySession.length === 0 && m.json.total === 0, m.text.slice(0, 200));
    await ctx.close();
  }
  const mine = await mcpH(MCP, 'usage', {});
  const ids = (mine.json?.bySession ?? []).map(s => s.sessionId);
  check('the owner\'s usage tool returns S1 and S2', ids.includes(S1) && ids.includes(S2) && /not a share of your plan limit/.test(mine.json.note), mine.text.slice(0, 200));
  const sub = mine.json.bySession.find(s => s.sessionId === S1)?.subagents;
  check('the tool shows S1\'s two subagents', sub?.count === 2 && sub.items.length === 2, JSON.stringify(sub));
} finally { await b.close(); }
await finish();
