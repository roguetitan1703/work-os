// Claude usage per session, recorded (`usage` tool, POST /api/worker/status `usage`; no page yet). Covers: rows a worker reports
// are stored (bad rows dropped, only the known fields, a day's total replaced not added); the `usage` tool answers them
// (sessions by share with the formula of lib/data/claude-usage.ts, subagents under their session, models, ranges); another
// member of the organization and another organization see nothing. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { ME, MCP, api, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH } from './flow-lib.mjs';

const TZ = 'Asia/Kolkata';
const dayOf = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + offset * 86_400_000));
const today = dayOf(0);
const twoAgo = dayOf(-2);
const OPUS = 'claude-opus-4-5-20251101';
const SONNET = 'claude-sonnet-4-5-20250929';
// The weight formula of lib/data/claude-usage.ts: model ratio (Opus 5/3, Sonnet 1) × (input + 1.25 cache write + 0.1 cache read + 5 output).
const w = (model, c) => (model === OPUS ? 5 / 3 : 1) * (c.i + 1.25 * c.cw + 0.1 * c.cr + 5 * c.o);

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

// ── 2. The `usage` tool, as the owner ──
const total = () => w(OPUS, C1) + w(OPUS, C1b) + w(SONNET, CX) + w(OPUS, CY) + w(SONNET, C2);
const s1Weight = () => w(OPUS, C1) + w(OPUS, C1b) + w(SONNET, CX) + w(OPUS, CY);
const near = (a, b) => Math.abs(a - b) < 1e-6;
const week = await mcpH(MCP, 'usage', {});
const ws = week.json?.bySession ?? [];
check('the week of the owner: S1 first, then S2', ws.map(s => s.sessionId).join(',') === `${S1},${S2}`, ws.map(s => s.sessionId).join(','));
check('the share of S1 is the formula', near(ws[0]?.share, s1Weight() / total()), `${ws[0]?.share} vs ${s1Weight() / total()}`);
const sub = ws[0]?.subagents;
check('S1 has its two subagents, by name', sub?.count === 2 && sub.items.map(i => i.name).sort().join(',') === 'Explorer X,Planner Y', JSON.stringify(sub));
check('models: Opus and Sonnet', (week.json?.byModel ?? []).length === 2, JSON.stringify(week.json?.byModel));
check('the answer says it is an estimate, not a share of the limit', /not a share of your plan limit/.test(week.json?.note ?? ''));
const todayOnly = await mcpH(MCP, 'usage', { range: 'today' });
check('today leaves out the row two days ago', near(todayOnly.json?.total, Math.round(total() - w(OPUS, C1b))) || Math.abs(todayOnly.json.total - (total() - w(OPUS, C1b))) <= 1, `${todayOnly.json?.total}`);

// ── 3. A day's total is replaced, not added ──
C2 = { i: 5000, cw: 30000, cr: 800000, o: 40000 };
await report(dev, [row(S2, 'main', SONNET, today, C2)]);
check('still five rows', (await rawDb.collection('claudeUsage').countDocuments({})) === 5);
const again = await mcpH(MCP, 'usage', {});
check('the new total replaced the old: S2 now first', again.json?.bySession?.[0]?.sessionId === S2 && near(again.json.bySession[0].share, w(SONNET, C2) / total()), JSON.stringify(again.json?.bySession?.map(s => [s.sessionId, s.share])));

// ── 4. Nobody else sees it ──
const B_ = await makeUser({ email: 'usage-b@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
const C_ = await makeUser({ email: 'usage-c@example.test', name: 'Cy', orgName: 'Usage C Org' });
const kB = await mkKey({ userId: B_.userId, orgId: B_.orgId });
const kC = await mkKey({ userId: C_.userId, orgId: C_.orgId });
for (const [who, key] of [['member of the same organization', kB], ['another organization', kC]]) {
  const m = await mcpH(key, 'usage', {});
  check(`${who}: the usage tool returns no sessions`, !m.isError && m.json.bySession.length === 0 && m.json.total === 0, m.text.slice(0, 200));
}
await finish();
