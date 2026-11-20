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
const FIELDS = ['_id', 'orgId', 'ownerId', 'deviceId', 'sessionId', 'part', 'partName', 'model', 'day', 'dayAt', 'i', 'cw', 'cr', 'o', 'title', 'folder', 'origin', 'updatedAt', 'ov'];
check('only the known fields are stored', docs.every(d => Object.keys(d).every(k => FIELDS.includes(k))), JSON.stringify(docs.map(d => Object.keys(d)).flat().filter(k => !FIELDS.includes(k))));
check('each row is the owner\'s, in their organization, on this computer', docs.every(d => d.ownerId === ME.userId && d.orgId === ME.orgId && d.deviceId === dev.id));
check('with no Orders yet, ov is 0 on every row', docs.every(d => d.ov === 0));
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

// ── 5. Account, 5-minute buckets, limit hits, compactions (plan note e6036c777f) ──
const ACCT_A = 'aaaaaaaaaaaaaaaa';
const ACCT_B = 'bbbbbbbbbbbbbbbb';
const floor5 = (ms) => new Date(Math.floor(ms / 300_000) * 300_000);
const at1 = floor5(Date.now() - 3600_000);
const at2 = new Date(at1.getTime() - 300_000);
const nowIso = () => new Date(Date.now() - 600_000).toISOString();
const E1 = randomUUID();
const E2 = randomUUID();
const E3 = randomUUID();
const E4 = randomUUID();
const resetAt = new Date(Date.now() + 3600_000).toISOString();
// The organization's Orders (version 3): ov must be that number.
await rawDb.collection('notes').insertOne({ _id: 'orders-org-usage', orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', orders: 'org', ordersV: 3, title: 'Orders', body: 'x', createdAt: new Date(), updatedAt: new Date(), deletedAt: null, archived: false, blocks: [] });
const bucketOf = (o) => ({ sessionId: S1, part: 'main', model: OPUS, i: 10, cw: 20, cw1h: 5, cr: 30, o: 4, n: 2, acct: ACCT_A, ...o });
const withAcct = await api(dev.key, 'POST', '/api/worker/status', {
  usage: {
    rows: [{ ...row(S1, 'main', OPUS, today, C1), acct: ACCT_A }, { ...row(S2, 'main', SONNET, today, C2), acct: 'not-a-hash' }],
    sessions,
    buckets: [
      bucketOf({ at: at1.toISOString() }),
      bucketOf({ at: at2.toISOString(), acct: ACCT_B, extra: 'dropped' }),
      bucketOf({ at: new Date(at1.getTime() + 1000).toISOString() }), // not on a 5-minute boundary: dropped
      bucketOf({ at: new Date(Date.now() - 20 * 86_400_000).toISOString() }), // too old: dropped
      bucketOf({ at: at1.toISOString(), part: 'bad part' }), // dropped
    ],
    events: [
      { kind: 'limit', id: E1, sessionId: S1, part: 'main', at: nowIso(), acct: ACCT_A, which: 'weekly', resetAt },
      { kind: 'compact', id: E2, sessionId: S1, part: 'main', at: nowIso(), acct: ACCT_A, trigger: 'auto', pre: 150000, post: 12000 },
      { kind: 'compact', id: E3, sessionId: S1, part: 'main', at: nowIso(), acct: ACCT_A, trigger: 'manual', pre: 50000, post: 8000 },
      { kind: 'limit', id: 'not-an-id', sessionId: S1, part: 'main', at: nowIso(), acct: ACCT_A, which: '5h' }, // dropped
      { kind: 'other', id: E4, sessionId: S1, part: 'main', at: nowIso(), acct: ACCT_A }, // dropped
    ],
    accounts: [{ id: ACCT_A, label: 'pat' }, { id: ACCT_B, label: '' }, { id: 'bad', label: 'x' }],
  },
});
check('the report with buckets and events is accepted', withAcct.status === 200, JSON.stringify(withAcct.body));
const bks = await rawDb.collection('claudeUsageBuckets').find({}).toArray();
check('two buckets are stored, the three bad ones dropped', bks.length === 2, String(bks.length));
const BFIELDS = ['_id', 'orgId', 'ownerId', 'deviceId', 'sessionId', 'part', 'model', 'at', 'acct', 'i', 'cw', 'cw1h', 'cr', 'o', 'n', 'ov', 'updatedAt'];
check('buckets keep only the known fields, owner and organization set', bks.every(b => Object.keys(b).every(k => BFIELDS.includes(k)) && b.ownerId === ME.userId && b.orgId === ME.orgId && b.deviceId === dev.id), JSON.stringify(bks[0]));
const b1 = bks.find(b => b.at.getTime() === at1.getTime());
check('a bucket has its counts, account and cw1h', b1 && b1.i === 10 && b1.cw === 20 && b1.cw1h === 5 && b1.cr === 30 && b1.o === 4 && b1.n === 2 && b1.acct === ACCT_A, JSON.stringify(b1));
const evs = await rawDb.collection('claudeUsageEvents').find({}).toArray();
check('three events are stored, the two bad ones dropped', evs.length === 3, String(evs.length));
const EFIELDS = ['_id', 'orgId', 'ownerId', 'deviceId', 'sessionId', 'part', 'kind', 'at', 'acct', 'which', 'resetAt', 'trigger', 'pre', 'post', 'ov', 'createdAt'];
check('events keep only the known fields', evs.every(e => Object.keys(e).every(k => EFIELDS.includes(k))), JSON.stringify(evs.map(e => Object.keys(e)).flat().filter(k => !EFIELDS.includes(k))));
const lim = evs.find(e => e._id === `${dev.id}:${E1}`);
check('the limit hit has its kind and reset time', lim && lim.which === 'weekly' && lim.resetAt.toISOString() === resetAt, JSON.stringify(lim));
const rowsNow = await rawDb.collection('claudeUsage').find({}).toArray();
const rA = rowsNow.find(d => d.sessionId === S1 && d.part === 'main' && d.day === today);
const rB = rowsNow.find(d => d.sessionId === S2 && d.part === 'main' && d.day === today);
check('a good acct is kept on the row', rA?.acct === ACCT_A, JSON.stringify(rA?.acct));
check('a bad acct is dropped but the row is kept', rB && rB.acct === undefined && rB.i === C2.i, JSON.stringify(rB));
check('ov equals the organization Orders version on rows, buckets and events', [rA, rB, ...bks, ...evs].every(d => d.ov === 3));
const accts = await rawDb.collection('claudeAccounts').find({}).toArray();
check('two accounts are stored (the bad id dropped), keyed by owner and id', accts.length === 2 && accts.every(a => a._id === `${ME.userId}:${a.id}` && a.ownerId === ME.userId), JSON.stringify(accts));

// A repeated event changes nothing; an empty label never replaces a label.
const before = JSON.stringify(await rawDb.collection('claudeUsageEvents').find({}).sort({ _id: 1 }).toArray());
await api(dev.key, 'POST', '/api/worker/status', { usage: { rows: [], sessions, events: [{ kind: 'limit', id: E1, sessionId: S1, part: 'main', at: nowIso(), acct: ACCT_B, which: '5h', resetAt: null }], accounts: [{ id: ACCT_A, label: '' }] } });
check('a repeated event changes nothing', JSON.stringify(await rawDb.collection('claudeUsageEvents').find({}).sort({ _id: 1 }).toArray()) === before);
check('an empty label does not replace a label', (await rawDb.collection('claudeAccounts').findOne({ id: ACCT_A }))?.label === 'pat');
// The same bucket again is replaced, not added.
await api(dev.key, 'POST', '/api/worker/status', { usage: { rows: [], sessions, buckets: [bucketOf({ at: at1.toISOString(), i: 11 })] } });
check('a bucket sent again is replaced, not added', (await rawDb.collection('claudeUsageBuckets').countDocuments({})) === 2 && (await rawDb.collection('claudeUsageBuckets').findOne({ at: at1 }))?.i === 11);

// The usage tool: byAccount, limits, compactions and their two-line summary.
const rep5 = await mcpH(MCP, 'usage', {});
const jr = rep5.json ?? {};
check('byAccount names the account by label, and the unknown one', (jr.byAccount ?? []).some(a => a.name === 'pat') && (jr.byAccount ?? []).some(a => a.name === 'Unknown account'), JSON.stringify(jr.byAccount));
check('limits has the weekly hit with its account and session', jr.limits?.length === 1 && jr.limits[0].which === 'weekly' && jr.limits[0].account === 'pat' && jr.limits[0].session === 'Build the usage page' && jr.limits[0].resetAt === resetAt, JSON.stringify(jr.limits));
check('compactions: two in one session, the averages', jr.compactions?.total === 2 && jr.compactions.sessions[0]?.count === 2 && jr.compactions.sessions[0].avgPre === 100000 && jr.compactions.sessions[0].avgPost === 10000, JSON.stringify(jr.compactions));
check('the answer text has the account, limit and compaction lines', (jr.summary ?? []).length === 6 && /^By account: /.test(jr.summary[0]) && /^Limit hits: 1/.test(jr.summary[2]) && /^Compactions: 2 in 1 session/.test(jr.summary[4]), JSON.stringify(jr.summary));
console.log('SAMPLE usage summary:', JSON.stringify(jr.summary));

// Nobody else sees the buckets, events or accounts, and nothing of them changes their answer.
for (const [who, key] of [['member of the same organization', kB], ['another organization', kC]]) {
  const m = await mcpH(key, 'usage', {});
  check(`${who}: no accounts, limit hits or compactions`, !m.isError && m.json.byAccount.length === 0 && m.json.limits.length === 0 && m.json.compactions.total === 0, m.text.slice(0, 200));
}
const aB = await rawDb.collection('claudeAccounts').countDocuments({ ownerId: { $ne: ME.userId } });
check('their own collections hold none of it', aB === 0);
await finish();
