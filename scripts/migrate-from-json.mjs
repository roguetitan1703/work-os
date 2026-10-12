// One-off import of the old local data/tasks.json into MongoDB.
//
//   node --env-file=.env.local scripts/migrate-from-json.mjs --dry-run
//   node --env-file=.env.local scripts/migrate-from-json.mjs [path/to/tasks.json]
//
// Safe to re-run: every document gets a deterministic _id and is upserted, existing
// task refs are kept, and the source file is only read. After writing it re-reads
// every imported task and compares it with the source.

import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find(a => !a.startsWith('--')) ?? path.join(process.cwd(), 'data', 'tasks.json');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set (use --env-file=.env.local)');
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(file, 'utf-8'));
const srcTasks = source.tasks ?? [];
const srcReviews = source.reviews ?? [];
const srcRituals = source.ritualLogs ?? [];
console.log(`Source ${file}: ${srcTasks.length} tasks, ${srcReviews.length} reviews, ${srcRituals.length} ritual logs`);

const at = d => new Date(`${d}T12:00:00Z`);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const slugify = s =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
// "Eric / Grant Leads" and "grant leads / eric" are the same project.
const projectKey = s => s.split('/').map(p => p.trim().toLowerCase()).filter(Boolean).sort().join(' / ');

// ── Projects ────────────────────────────────────────────────────────────────
const projectsByKey = new Map();
for (const t of srcTasks) {
  const name = (t.projectClient ?? '').trim();
  if (!name) continue;
  const key = projectKey(name);
  const p = projectsByKey.get(key);
  if (!p) projectsByKey.set(key, { name, count: 1, firstSeen: t.addedOn });
  else {
    p.count++;
    // Prefer a capitalised spelling ("Marron7" over "marron7").
    if (p.name === p.name.toLowerCase() && name !== name.toLowerCase()) p.name = name;
  }
}

const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'workos');
const tasksCol = db.collection('tasks');
const activityCol = db.collection('activity');
const projectsCol = db.collection('projects');
const reviewsCol = db.collection('reviews');
const ritualsCol = db.collection('ritualLogs');
const countersCol = db.collection('counters');

try {
  // Reuse existing projects (by name) so re-runs and renamed projects stay stable.
  const existingProjects = await projectsCol.find({}).toArray();
  const usedIds = new Set(existingProjects.map(p => p._id));
  const projectIdByKey = new Map();
  const projectDocs = [];
  for (const [key, p] of projectsByKey) {
    const existing = existingProjects.find(e => projectKey(e.name) === key || e.nameLower === p.name.toLowerCase());
    if (existing) {
      projectIdByKey.set(key, existing._id);
      continue;
    }
    let id = slugify(p.name);
    for (let i = 2; usedIds.has(id); i++) id = `${slugify(p.name)}-${i}`;
    usedIds.add(id);
    projectIdByKey.set(key, id);
    projectDocs.push({
      _id: id,
      name: p.name,
      nameLower: p.name.toLowerCase(),
      client: '',
      description: '',
      status: 'active',
      createdAt: at(p.firstSeen ?? '2026-01-01'),
      updatedAt: new Date(),
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const existingTasks = new Map((await tasksCol.find({}, { projection: { ref: 1 } }).toArray()).map(t => [t._id, t.ref]));
  const counter = await countersCol.findOne({ _id: 'task' });
  let nextRef = Math.max(counter?.seq ?? 0, ...[...existingTasks.values()], 0);

  const ordered = srcTasks.map((t, i) => ({ t, i })).sort((a, b) => (a.t.addedOn ?? '').localeCompare(b.t.addedOn ?? '') || a.i - b.i);
  const taskDocs = [];
  const activityDocs = [];
  for (const { t } of ordered) {
    const ref = existingTasks.get(t.id) ?? ++nextRef;
    const name = (t.projectClient ?? '').trim();
    const done = t.status === 'Done';
    const addedOn = isDate(t.addedOn) ? t.addedOn : '2026-01-01';
    const lastTouched = isDate(t.lastTouched) ? t.lastTouched : addedOn;
    const doneOn = done ? (isDate(t.doneDate) ? t.doneDate : lastTouched) : null;
    const doc = {
      _id: t.id,
      ref,
      title: t.task,
      description: t.notes ?? '',
      mode: t.mode ?? null,
      projectId: name ? projectIdByKey.get(projectKey(name)) : null,
      priority: t.priority ?? 'P2',
      status: t.status ?? 'Not Started',
      tags: [],
      due: isDate(t.due) ? t.due : null,
      start: null,
      estimateMins: typeof t.estimateMins === 'number' ? t.estimateMins : null,
      progress: done ? 100 : t.status === 'In Progress' ? 10 : 0,
      checklist: [],
      links: [],
      blockedReason: '',
      dependsOn: [],
      recurrence: null,
      nextRef: null,
      archived: false,
      createdBy: 'me',
      createdAt: at(addedOn),
      updatedAt: at(lastTouched),
      doneAt: doneOn ? at(doneOn) : null,
      doneOn,
      doneBy: done ? 'me' : null,
    };
    taskDocs.push(doc);

    const base = { taskId: doc._id, taskRef: ref, taskTitle: doc.title, actor: 'me' };
    activityDocs.push({ _id: `import-created-${doc._id}`, ...base, at: doc.createdAt, type: 'created', note: 'Imported from tasks.json' });
    if (done) {
      activityDocs.push({
        _id: `import-done-${doc._id}`,
        ...base,
        at: doc.doneAt,
        type: 'completed',
        changes: { status: { from: null, to: 'Done' } },
      });
    } else if (doc.status !== 'Not Started') {
      activityDocs.push({
        _id: `import-status-${doc._id}`,
        ...base,
        at: doc.updatedAt,
        type: 'status',
        changes: { status: { from: 'Not Started', to: doc.status } },
      });
    }
  }

  console.log(`Projects: ${projectsByKey.size} distinct (${projectDocs.length} new):`);
  for (const [key, p] of projectsByKey) console.log(`  ${projectIdByKey.get(key).padEnd(28)} ${p.name} (${p.count} tasks)`);
  console.log(`Tasks: ${taskDocs.length} (${taskDocs.filter(d => existingTasks.has(d._id)).length} already in DB, refs kept)`);
  console.log(`Activity entries: ${activityDocs.length}`);

  if (dryRun) {
    console.log('\nDry run: nothing written.');
    process.exit(0);
  }

  const upsertAll = (col, docs) =>
    docs.length
      ? col.bulkWrite(docs.map(d => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })))
      : null;

  // Existing tasks keep later edits made in the new app: only insert missing ones.
  const newTasks = taskDocs.filter(d => !existingTasks.has(d._id));
  if (projectDocs.length) await upsertAll(projectsCol, projectDocs);
  if (newTasks.length) await upsertAll(tasksCol, newTasks);
  if (activityDocs.length) {
    await activityCol.bulkWrite(
      activityDocs.map(d => ({ updateOne: { filter: { _id: d._id }, update: { $setOnInsert: d }, upsert: true } })),
    );
  }
  await upsertAll(reviewsCol, srcReviews.map(({ id, ...r }) => ({ _id: id, ...r })));
  await upsertAll(ritualsCol, srcRituals.map(({ id, ...r }) => ({ _id: id, ...r })));
  await countersCol.updateOne({ _id: 'task' }, { $max: { seq: nextRef } }, { upsert: true });

  // ── Verify ────────────────────────────────────────────────────────────────
  const inDb = new Map((await tasksCol.find({ _id: { $in: srcTasks.map(t => t.id) } }).toArray()).map(d => [d._id, d]));
  const problems = [];
  for (const t of srcTasks) {
    const d = inDb.get(t.id);
    if (!d) {
      problems.push(`missing ${t.id} "${t.task}"`);
      continue;
    }
    if (existingTasks.has(t.id)) continue; // may have been edited since the first import
    if (d.title !== t.task) problems.push(`title mismatch ${t.id}`);
    if (d.status !== t.status) problems.push(`status mismatch ${t.id}`);
    if ((d.due ?? '') !== (isDate(t.due) ? t.due : '')) problems.push(`due mismatch ${t.id}`);
    if (d.description !== (t.notes ?? '')) problems.push(`notes mismatch ${t.id}`);
  }
  const reviewCount = await reviewsCol.countDocuments({ _id: { $in: srcReviews.map(r => r.id) } });
  const ritualCount = await ritualsCol.countDocuments({ _id: { $in: srcRituals.map(r => r.id) } });
  if (reviewCount !== srcReviews.length) problems.push(`reviews: ${reviewCount}/${srcReviews.length}`);
  if (ritualCount !== srcRituals.length) problems.push(`ritual logs: ${ritualCount}/${srcRituals.length}`);

  console.log(`\nVerified ${inDb.size}/${srcTasks.length} tasks, ${reviewCount}/${srcReviews.length} reviews, ${ritualCount}/${srcRituals.length} ritual logs.`);
  if (problems.length) {
    console.error('PROBLEMS:\n  ' + problems.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log('OK: every source record is in MongoDB.');
  }
} finally {
  await client.close();
}
