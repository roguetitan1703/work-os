#!/usr/bin/env node
// Phase 2 of docs/multi-user.md: gives every document an organization and an owner, so the scoped door (lib/scope.ts)
// can serve it. Everything from before belongs to the first organization and its owner (Om):
//
//   projects                      private to Om (visibility 'private'); Om shares them one by one from the app
//   tasks, notes, Claude items,   follow their project (so private to Om too); no project: private to Om
//   history, trash
//   reviews, ritual logs          Om's own
//   computers, folders, jobs,     their computer's owner (computers without an owner stay as they are: refused)
//   sessions
//   inbox, push devices,          Om (the recipient)
//   alert log and queue
//   actors                        'me' / 'claude' / 'claude-code' / 'discord' / 'system' → { kind, userId } (Om)
//   Claude items waitingOnOm      → waitingText + waitingOn (Om)
//   tasks given to Claude         claude.markedByUserId / markedByOrgId → Om / the first organization
//   counters                      task / claudeItems → task:<orgId> / claudeItems:<orgId>, rebuilt from the highest ref
//   settings                      notify / dispatcher / alerts / status → <area>:<Om's id>; discord → discord:<orgId>;
//                                 authMigration gets the organization
//
//   node scripts/migrate-ownership.mjs --db <database>                    dry run: counts what it would change
//   node scripts/migrate-ownership.mjs --db <database> --apply            does it
//   node scripts/migrate-ownership.mjs --db <database> --copy-to <name>   copies <database> to <name> (same server, or
//                                                                         --copy-uri <uri>) and migrates the copy;
//                                                                         never writes to <database>
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: a second run finds nothing to do. Prints counts only, never titles or text.
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const die = msg => {
  console.error(msg);
  process.exit(2);
};

const source = arg('--db');
const copyTo = arg('--copy-to');
const copyUri = arg('--copy-uri');
const APPLY = args.includes('--apply') || !!copyTo;
if (!source) die('Name the database: node scripts/migrate-ownership.mjs --db <database> [--apply | --copy-to <name>]');
if (args.includes('--apply') && copyTo) die('--copy-to migrates the copy; do not combine it with --apply.');
if (copyTo && copyTo === source && !copyUri) die('--copy-to must name another database.');

const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');

const AGENTS = new Set(['claude', 'claude-code']);
/** A stored actor in either shape → the object shape, legacy strings acting for `owner`. */
function actor(a, owner) {
  if (a && typeof a === 'object' && a.kind) return a;
  if (a === 'me') return { kind: 'user', userId: owner };
  if (a === 'discord') return { kind: 'discord', userId: owner };
  if (AGENTS.has(a)) return { kind: 'agent', agent: a, userId: owner };
  return { kind: 'system' };
}
const legacy = a => a !== undefined && a !== null && !(typeof a === 'object' && a.kind);

const counts = {};
const count = (what, n = 1) => (counts[what] = (counts[what] ?? 0) + n);

const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

const client = new MongoClient(uri);
await client.connect();
let target = client;
try {
  let db = client.db(source);
  if (copyTo) {
    target = copyUri ? new MongoClient(copyUri) : client;
    if (copyUri) await target.connect();
    const dest = target.db(copyTo);
    if ((await dest.listCollections({}, { nameOnly: true }).toArray()).length) die(`Database "${copyTo}" is not empty; name a new one.`);
    const cols = (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith('system.'));
    for (const name of cols) {
      const docs = await db.collection(name).find({}).toArray();
      if (docs.length) await dest.collection(name).insertMany(docs, { ordered: false });
      count(`copied: ${name}`, docs.length);
    }
    console.log(`Copied "${source}" to "${copyTo}" at ${host(copyUri ?? uri)}; migrating the copy (the source is not written).\n`);
    db = dest;
  } else {
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);
  }

  // The first organization and its owner.
  const org = await db.collection('organization').find({}).sort({ createdAt: 1 }).limit(1).next();
  if (!org) die('No organization yet: run scripts/migrate-auth.mjs first.');
  const orgId = String(org._id);
  const ownerMember = await db.collection('member').find({ organizationId: { $in: [org._id, orgId] }, role: 'owner' }).sort({ createdAt: 1 }).limit(1).next();
  if (!ownerMember) die('The first organization has no owner.');
  const owner = String(ownerMember.userId);

  const write = async (col, filter, update) => {
    if (APPLY) await db.collection(col).updateOne(filter, update);
  };
  const noOrg = { orgId: { $exists: false } };

  // ── Projects: private to Om (he shares them one by one) ──
  const projects = new Map();
  for (const p of await db.collection('projects').find({}).toArray()) {
    if (p.orgId === undefined) {
      count('projects');
      await write('projects', { _id: p._id }, { $set: { orgId, ownerId: owner, visibility: 'private' } });
      p.orgId = orgId;
      p.ownerId = owner;
      p.visibility = 'private';
    }
    projects.set(p._id, p);
  }
  /** Where a document with this project lives: the project's place, or private to Om. */
  const placeOf = projectId => {
    const p = projectId ? projects.get(projectId) : null;
    return p ? { ownerId: p.visibility === 'private' ? p.ownerId : owner, visibility: p.visibility } : { ownerId: owner, visibility: 'private' };
  };

  // ── Tasks ──
  const tasks = new Map();
  for (const t of await db.collection('tasks').find({}).toArray()) {
    const set = {};
    if (t.orgId === undefined) Object.assign(set, { orgId }, placeOf(t.projectId), t.assigneeId === undefined ? { assigneeId: null } : {});
    if (legacy(t.createdBy)) set.createdBy = actor(t.createdBy, owner);
    if (legacy(t.doneBy)) set.doneBy = actor(t.doneBy, owner);
    if (t.claude && t.claude.markedBy === 'om') set['claude.markedBy'] = 'user';
    // Marks from before per-person dispatch were Om's: only he can take them back, and only his computers claim them.
    if (t.claude && !t.claude.markedByUserId) {
      Object.assign(set, { 'claude.markedByUserId': owner, 'claude.markedByOrgId': orgId });
      count('tasks given to Claude (who gave it)');
    }
    if (Object.keys(set).length) {
      count('tasks');
      await write('tasks', { _id: t._id }, { $set: set });
    }
    tasks.set(t._id, { ...t, ...set });
  }
  const taskPlace = id => {
    const t = tasks.get(id);
    return t ? { ownerId: t.ownerId, visibility: t.visibility } : { ownerId: owner, visibility: 'private' };
  };

  // ── History ──
  for (const a of await db.collection('activity').find({ $or: [noOrg, { actorUserId: { $exists: true } }, { actor: { $type: 'string' } }] }).toArray()) {
    const set = {};
    if (a.orgId === undefined) Object.assign(set, { orgId }, taskPlace(a.taskId));
    if (legacy(a.actor)) set.actor = actor(a.actor, a.actorUserId || owner);
    count('history entries');
    if (APPLY) await db.collection('activity').updateOne({ _id: a._id }, { $set: set, $unset: { actorUserId: '' } });
  }

  // ── Notes: their task, their project, or the page they are inside ──
  const notes = await db.collection('notes').find({}).toArray();
  const byId = new Map(notes.map(n => [n._id, n]));
  const notePlace = (n, depth = 0) => {
    if (n.orgId !== undefined) return { ownerId: n.ownerId, visibility: n.visibility };
    if (n.taskId) return taskPlace(n.taskId);
    if (n.parentId && byId.has(n.parentId) && depth < 50) return notePlace(byId.get(n.parentId), depth + 1);
    return placeOf(n.projectId);
  };
  for (const n of notes) {
    const set = {};
    if (n.orgId === undefined) Object.assign(set, { orgId }, notePlace(n));
    if (legacy(n.createdBy)) set.createdBy = actor(n.createdBy, owner);
    if (legacy(n.updatedBy)) set.updatedBy = actor(n.updatedBy, owner);
    if (Object.keys(set).length) {
      count('notes');
      await write('notes', { _id: n._id }, { $set: set });
    }
  }

  // ── Claude items ──
  for (const d of await db.collection('claudeItems').find({}).toArray()) {
    const set = {};
    const unset = {};
    if (d.orgId === undefined) Object.assign(set, { orgId }, placeOf(d.projectId));
    if (legacy(d.createdBy)) set.createdBy = actor(d.createdBy, owner);
    if ((d.log ?? []).some(l => legacy(l.actor))) set.log = d.log.map(l => ({ ...l, actor: actor(l.actor, owner) }));
    if (d.waitingOnOm !== undefined) {
      const text = String(d.waitingOnOm ?? '').trim();
      set.waitingText = text;
      set.waitingOn = text ? owner : null;
      unset.waitingOnOm = '';
    }
    if (Object.keys(set).length) {
      count('Claude items');
      if (APPLY) await db.collection('claudeItems').updateOne({ _id: d._id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    }
  }

  // ── Trash: the deleted task's place, and its saved copy ──
  for (const d of await db.collection('trash').find({}).toArray()) {
    const set = {};
    if (d.orgId === undefined) {
      const place = placeOf(d.task?.projectId);
      Object.assign(set, { orgId }, place);
      if (d.task) {
        set.task = { ...d.task, orgId, ...place, assigneeId: d.task.assigneeId ?? null, createdBy: actor(d.task.createdBy, owner), ...(d.task.doneBy ? { doneBy: actor(d.task.doneBy, owner) } : {}) };
        set.activity = (d.activity ?? []).map(({ actorUserId, ...a }) => ({ ...a, orgId, ...place, actor: actor(a.actor, actorUserId || owner) }));
      }
    }
    if (legacy(d.deletedBy)) set.deletedBy = actor(d.deletedBy, owner);
    if (Object.keys(set).length) {
      count('trash');
      await write('trash', { _id: d._id }, { $set: set });
    }
  }

  // ── Om's own ──
  for (const col of ['reviews', 'ritualLogs']) {
    const n = await db.collection(col).countDocuments(noOrg);
    if (n) count(col, n);
    if (APPLY && n) await db.collection(col).updateMany(noOrg, { $set: { orgId, ownerId: owner } });
  }
  for (const col of ['notifications', 'pushSubs', 'alertLog', 'alertQueue']) {
    const n = await db.collection(col).countDocuments(noOrg);
    if (n) count(col, n);
    if (APPLY && n) await db.collection(col).updateMany(noOrg, { $set: { orgId, userId: owner } });
  }

  // ── Computers and what hangs off them: their owner ──
  const devices = new Map((await db.collection('devices').find({}, { projection: { ownerId: 1, orgId: 1 } }).toArray()).map(d => [d._id, d]));
  for (const col of ['workerFolders', 'workerJobs', 'workerSessions']) {
    for (const d of await db.collection(col).find({ $or: [noOrg, { ownerId: { $exists: false } }] }, { projection: { deviceId: 1 } }).toArray()) {
      const dev = devices.get(d.deviceId);
      if (!dev?.ownerId || !dev.orgId) {
        count(`${col} of computers without an owner (left as they are)`);
        continue;
      }
      count(col);
      await write(col, { _id: d._id }, { $set: { orgId: dev.orgId, ownerId: dev.ownerId } });
    }
  }

  // ── Counters, per organization, from the highest ref in use ──
  for (const [kind, col] of [['task', 'tasks'], ['claudeItems', 'claudeItems']]) {
    const top = await db.collection(col).find({ orgId }, { projection: { ref: 1 } }).sort({ ref: -1 }).limit(1).next();
    const trashTop = kind === 'task' ? await db.collection('trash').find({ orgId }, { projection: { ref: 1 } }).sort({ ref: -1 }).limit(1).next() : null;
    const old = await db.collection('counters').findOne({ _id: kind });
    const cur = await db.collection('counters').findOne({ _id: `${kind}:${orgId}` });
    // In a dry run nothing is stamped yet, so count every ref (they are all the first organization's).
    const anyTop = APPLY ? null : await db.collection(col).find({}, { projection: { ref: 1 } }).sort({ ref: -1 }).limit(1).next();
    const seq = Math.max(top?.ref ?? 0, trashTop?.ref ?? 0, anyTop?.ref ?? 0, old?.seq ?? 0, cur?.seq ?? 0);
    if (!cur || cur.seq !== seq || old) {
      count(`counters (${kind})`);
      if (APPLY) {
        await db.collection('counters').updateOne({ _id: `${kind}:${orgId}` }, { $set: { seq, orgId } }, { upsert: true });
        if (old) await db.collection('counters').deleteOne({ _id: kind });
      }
    }
  }

  // ── Settings: per person or per organization ──
  const RENAME = { notify: `notify:${owner}`, dispatcher: `dispatcher:${owner}`, alerts: `alerts:${owner}`, status: `status:${owner}`, discord: `discord:${orgId}` };
  for (const [from, to] of Object.entries(RENAME)) {
    const doc = await db.collection('settings').findOne({ _id: from });
    if (!doc) continue;
    count(`settings (${from})`);
    if (!APPLY) continue;
    const { _id, ...rest } = doc;
    const area = from;
    const who = from === 'discord' ? { area, orgId } : { area, orgId, userId: owner };
    const exists = await db.collection('settings').findOne({ _id: to });
    if (!exists) await db.collection('settings').insertOne({ ...rest, ...who, _id: to });
    await db.collection('settings').deleteOne({ _id: from });
  }
  const am = await db.collection('settings').findOne({ _id: 'authMigration', orgId: { $exists: false } });
  if (am) {
    count('settings (authMigration)');
    await write('settings', { _id: 'authMigration' }, { $set: { orgId } });
  }

  const lines = Object.entries(counts);
  console.log(lines.length ? lines.map(([k, n]) => `  ${APPLY ? '✓' : '-'} ${k}: ${n}`).join('\n') : '  Nothing to do: everything already has an organization and an owner.');
  if (!APPLY) console.log('\nDry run: nothing was changed.');
} finally {
  await client.close();
  if (target !== client) await target.close();
}
