// Cut-over rehearsal, part 1 (docs/hosting.md "Rehearsal"): fills an empty throwaway database the way the single-user
// Work OS (before phase 1, commit f9ae24e) did, through that old app's own MCP and alert cron where it can, and with
// direct inserts in the old shapes for what has no MCP tool (reviews, routine logs, old keys and computers, push
// devices, settings). Run it against the OLD app only, on a throwaway database.
//
//   OLD_BASE=http://localhost:3283 MCP_TOKEN=… CRON_SECRET=… MONGODB_URI=… MONGODB_DB=… node tests/rehearsal/seed-legacy.mjs
//
// Prints counts per collection. Refuses a database that is not empty, or a URI that is not on localhost.
import { MongoClient } from 'mongodb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const B = process.env.OLD_BASE;
const TOKEN = process.env.MCP_TOKEN;
const CRON = process.env.CRON_SECRET;
const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB;
if (!B || !TOKEN || !CRON || !URI || !DB) throw new Error('set OLD_BASE, MCP_TOKEN, CRON_SECRET, MONGODB_URI, MONGODB_DB');
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URI)) throw new Error('throwaway databases on localhost only');

const mc = new MongoClient(URI);
await mc.connect();
const db = mc.db(DB);
const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
for (const n of existing) if (await db.collection(n).estimatedDocumentCount()) throw new Error(`database ${DB} is not empty (${n})`);

let rid = 0;
async function call(name, args = {}) {
  const r = await fetch(B + '/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const line = raw.split('\n').find(l => l.startsWith('data: '));
  const j = JSON.parse(line ? line.slice(6) : raw);
  const res = j.result ?? {};
  const text = res.content?.[0]?.text ?? JSON.stringify(j.error ?? j);
  if (res.isError || j.error) throw new Error(`${name}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const day = n => new Date(Date.now() + 5.5 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const sha = s => createHash('sha256').update(s).digest('hex');

// ── Projects, tasks, history (through the old MCP: actors are the old strings) ──
const P = ['Grant Leads', 'AKAR', 'Delpat Site', 'Fiverr'];
for (const name of P) await call('add_project', { name, client: name === 'AKAR' ? 'Acme' : '', description: `Rehearsal project ${name}` });
const T = [
  ['Send invoice to Grant Leads', { project: 'Grant Leads', priority: 'P1', due: day(-3), mode: 'Business Admin' }],
  ['Follow up on proposal', { project: 'Grant Leads', priority: 'P2', due: day(-1), mode: 'Outreach & Sales' }],
  ['Fix webhook retries', { project: 'AKAR', priority: 'P1', due: 'today', mode: 'Code & Dev', checklist: ['reproduce', 'patch', 'deploy'] }],
  ['Invoice export columns', { project: 'AKAR', priority: 'P2', status: 'In Progress', due: '+2d', mode: 'Client Delivery' }],
  ['Header logo vector', { project: 'AKAR', priority: 'P3', mode: 'Client Delivery' }],
  ['Landing page copy', { project: 'Delpat Site', priority: 'P2', due: '+5d', mode: 'Growth', tags: ['site', 'copy'] }],
  ['Blocked on DNS access', { project: 'Delpat Site', priority: 'P2', status: 'Blocked', blocked_reason: 'Waiting for registrar login' }],
  ['Place five bids', { project: 'Fiverr', priority: 'P2', mode: 'Outreach & Sales', recurrence: { freq: 'weekdays', interval: 1 }, due: 'today' }],
  ['File GST return', { priority: 'P1', due: 'tomorrow', mode: 'Business Admin' }],
  ['Pricing decision', { priority: 'P1', due: 'today', mode: 'Founder Decisions' }],
  ['Read on team rituals', { priority: 'P4', mode: 'Team Direction' }],
  ['Plan Q4 roadmap', { priority: 'P3', mode: 'Research & Planning', due: '+7d' }],
];
const ref = {};
for (const [title, a] of T) ref[title] = (await call('add_task', { title, ...a })).created.ref;
await call('update_task', { task: ref['Landing page copy'], depends_on: [ref['Blocked on DNS access']] });
await call('add_comment', { task: ref['Send invoice to Grant Leads'], note: 'Client asked for the PDF version.' });
await call('add_comment', { task: ref['Fix webhook retries'], note: 'Retries double-post on 502.' });
await call('apply_changes', {
  ops: [
    { op: 'log_progress', task: ref['Invoice export columns'], progress: 40, note: 'Columns agreed' },
    { op: 'complete_task', task: ref['Header logo vector'], note: 'Done with the SVG' },
    { op: 'complete_task', task: ref['Place five bids'], note: 'Five sent' },
    { op: 'create_task', title: 'Draft follow-up email', project: 'Grant Leads', priority: 'P3', as: '$f' },
    { op: 'update_task', task: '$f', due: '+1d' },
  ],
});
const trashMe = (await call('add_task', { title: 'Duplicate idea', priority: 'P4' })).created.ref;
await call('delete_task', { task: trashMe, title: 'Duplicate idea', reason: 'duplicate' });

// ── Notes: a task's note, project notes, a sub-page ──
await call('write_note', { task: ref['Fix webhook retries'], body: '# Webhook retries\n\n- [ ] add idempotency key\n- [x] reproduce on staging\n\nSee [#' + ref['Invoice export columns'] + ' Invoice export columns](/tasks/' + ref['Invoice export columns'] + ').' });
const scope = await call('write_note', { project: 'AKAR', title: 'AKAR scope', body: '## Scope\n\nQuarterly invoice export. Vector logo in the header.' });
const scopeId = scope.created?.id ?? scope.updated?.id;
if (!scopeId) throw new Error('write_note: no id');
await call('write_note', { parent_id: scopeId, title: 'Open questions', body: 'Which currency format?' });
await call('write_note', { project: 'Delpat Site', title: 'Site plan', body: 'Pages: home, work, contact.' });

// ── Claude items, one waiting on Om ──
await call('update_claude_items', {
  project: 'AKAR',
  ops: [
    { op: 'add', project: 'AKAR', kind: 'feature', title: 'Reorder invoice export', why: 'The invoice export (lib/export.ts) lists columns in our order; the client wants theirs.', done_when: 'The export file matches the client sample column for column.' },
    { op: 'add', project: 'AKAR', kind: 'bug', title: 'Webhook sender retries storm on 502', why: 'The webhook sender (lib/webhooks.ts) retries at once on a 502 and posts the same event many times.', done_when: 'One post per event while the receiver answers 502, checked on staging.', waiting_on_om: 'Is a 30 s backoff acceptable?' },
  ],
});

// ── What has no tool: direct inserts in the old shapes ──
const now = new Date();
const ago = d => new Date(now - d * 864e5);
await db.collection('reviews').insertMany([
  { _id: randomUUID(), weekOf: day(-14), shipped: 'Invoice app v1', slipped: 'Logo', toDrop: 'Old CRM', brokenDays: 1, extensionTokensUsed: 0, adjustments: 'Fewer meetings' },
  { _id: randomUUID(), weekOf: day(-7), shipped: 'Webhook fix', slipped: '', toDrop: '', brokenDays: 0, extensionTokensUsed: 1, adjustments: '' },
]);
await db.collection('ritualLogs').insertMany([
  { _id: randomUUID(), date: day(-2), bidsPlaced: 5, notes: '' },
  { _id: randomUUID(), date: day(-1), bidsPlaced: 3, notes: 'slow day' },
]);
await db.collection('settings').insertMany([
  { _id: 'notify', notify: { channels: { push: true, discord: false }, kinds: { stalled: false } }, updatedAt: now },
  { _id: 'dispatcher', enabled: false, maxConcurrent: 2, boilerplateNoteId: scopeId ?? null, updatedAt: now },
  { _id: 'discord', blockedIds: ['111111111111111111'], updatedAt: now },
  { _id: 'security', passwordHash: 'old-hash-not-real', totpSecret: null, recoveryCodes: [], updatedAt: now },
]);
const oldKey = 'wos_' + randomBytes(32).toString('base64url');
await db.collection('apiKeys').insertOne({ _id: randomUUID(), name: 'laptop claude code', role: 'claude-code', hash: sha(oldKey), prefix: oldKey.slice(0, 8), createdAt: ago(20), lastUsedAt: ago(1), revokedAt: null });
const devKey = 'wkr_' + randomBytes(32).toString('base64url');
const deviceId = randomUUID();
await db.collection('devices').insertOne({ _id: deviceId, name: 'OM-PC', hash: sha(devKey), prefix: devKey.slice(0, 8), createdAt: ago(10), lastSeenAt: ago(1), revokedAt: null, worker: { version: '1', os: 'win32', allowPrompts: true } });
await db.collection('workerFolders').insertOne({ _id: `${deviceId}:f1`, deviceId, folderId: 'f1', name: 'akar', git: true, remote: 'delpat/akar', branch: 'main', projectId: null, linkedAt: null, seenAt: ago(1), missing: false });
await db.collection('pushSubs').insertOne({ _id: 'https://push.example.test/' + randomUUID(), keys: { p256dh: 'x', auth: 'y' }, device: 'Om phone', createdAt: ago(5), updatedAt: ago(5) });
// A task given to Claude, still queued (old mark: markedBy 'om', no user).
const fixId = (await db.collection('tasks').findOne({ ref: ref['Fix webhook retries'] }))._id;
await db.collection('tasks').updateOne({ _id: fixId }, { $set: { claude: { state: 'queued', markedAt: ago(0.1), markedBy: 'om' } } });

// ── The old alert cron: inbox notices and the alert log ──
const cron = await fetch(`${B}/api/cron/alerts`, { headers: { authorization: `Bearer ${CRON}` } }).then(r => r.json());
console.log(`old cron: ${cron.alerts ?? 0} alerts${cron.quiet ? ' (quiet hours)' : ''}`);

const counts = {};
for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) counts[name] = await db.collection(name).countDocuments();
console.log(Object.entries(counts).sort().map(([k, n]) => `${k}=${n}`).join(' '));
const refs = Object.fromEntries(Object.entries(ref).map(([t, r]) => [r, t]));
console.log('SEEDED ' + JSON.stringify({ tasks: Object.keys(refs).length, sample: refs[ref['Send invoice to Grant Leads']] }));
await mc.close();
