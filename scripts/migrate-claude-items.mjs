#!/usr/bin/env node
// Claude items retire (H11 step 7, docs/flows/agent-system.md 16.7): each open item (queued, active, blocked) moves into the
// State or the task list, and the item is set to `dropped` with `movedTo` ("#123" or "later:l_...") so it stays as history.
// Where an item goes is lib/claude-items-migrate.ts (tested by npm run check:claude-items-migrate):
//   waiting on a person        -> a Later line waiting on them by name
//   kind not idea + done-when  -> a task (P3, tag from-claude-item, description = why + "Done when: ...")
//   an idea, or no done-when   -> a Later line "title: first sentence of why"
//   done / dropped items       -> untouched (history)
//
//   node --experimental-strip-types --no-warnings scripts/migrate-claude-items.mjs --db <database> [--org <orgId>]           dry run: counts per project
//   node --experimental-strip-types --no-warnings scripts/migrate-claude-items.mjs --db <database> [--org <orgId>] --apply   does it
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the environment.
// Each organization is handled on its own (--org limits it to one); an item is only moved into its own project, under that
// project's placement, so nothing crosses an organization or a project. Idempotent: only open items are moved, and a
// half-finished run finds the task or line it already made (same project, same title or text) instead of making another.
// Prints counts per project and never item text.
import { randomBytes, randomUUID } from 'node:crypto';
import { MongoClient, ObjectId } from 'mongodb';
import { migratePlan, movedToLine, movedToTask, OPEN_STATES } from '../lib/claude-items-migrate.ts';

const args = process.argv.slice(2);
const val = f => (args.indexOf(f) >= 0 && args[args.indexOf(f) + 1] && !args[args.indexOf(f) + 1].startsWith('--') ? args[args.indexOf(f) + 1] : null);
const source = val('--db');
const onlyOrg = val('--org');
const APPLY = args.includes('--apply');
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node --experimental-strip-types scripts/migrate-claude-items.mjs --db <database> [--org <orgId>] [--apply]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
const SYSTEM = { kind: 'system' };
const LATER_MAX = 300; // lib/data/states.ts LIMITS.later: past it the item becomes a task instead
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  const userName = async id => {
    const ids = /^[0-9a-f]{24}$/i.test(id) ? [id, new ObjectId(id)] : [id];
    const u = await db.collection('user').findOne({ _id: { $in: ids } }, { projection: { name: 1 } });
    return typeof u?.name === 'string' && u.name.trim() ? u.name.trim() : undefined;
  };
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}${onlyOrg ? ` (organization ${onlyOrg})` : ''}\n`);

  const openQuery = { state: { $in: OPEN_STATES }, ...(onlyOrg ? { orgId: onlyOrg } : {}) };
  const orgs = (await db.collection('claudeItems').distinct('orgId', openQuery)).filter(Boolean);
  const total = { tasks: 0, lines: 0, left: 0, projects: 0 };
  for (const orgId of orgs) {
    console.log(`Organization ${orgId}`);
    const projectIds = await db.collection('claudeItems').distinct('projectId', { orgId, state: { $in: OPEN_STATES } });
    for (const projectId of projectIds) {
      const project = await db.collection('projects').findOne({ _id: projectId, orgId });
      const items = await db.collection('claudeItems').find({ orgId, projectId, state: { $in: OPEN_STATES } }).sort({ order: 1 }).toArray();
      if (!project) {
        console.log(`  ! ${plural(items.length, 'open item')} in a project that is gone: left as they are`);
        total.left += items.length;
        continue;
      }
      const place = { orgId, ownerId: project.ownerId, visibility: project.visibility, sharedWith: project.visibility === 'members' ? [...new Set([project.ownerId, ...(project.sharedWith ?? [])])] : [] };
      const state = await db.collection('states').findOne({ orgId, projectId }, { projection: { later: 1 } });
      let laterCount = state?.later?.length ?? 0;
      let tasks = 0;
      let lines = 0;
      for (const d of items) {
        const plan = migratePlan(d, d.waitingOn ? await userName(d.waitingOn) : undefined);
        if (!plan) continue;
        // No State document, or Later is full: a line cannot go in, so the item becomes a task instead.
        const toTask = plan.to === 'task' || !state || laterCount >= LATER_MAX;
        let movedTo = '';
        if (toTask) {
          const title = (plan.to === 'task' ? plan.title : plan.text).slice(0, 300);
          const description = plan.to === 'task' ? plan.description : [plan.text, plan.waitsOn ? `Waiting on: ${plan.waitsOn}` : ''].filter(Boolean).join('\n\n');
          tasks++;
          if (APPLY) {
            const again = await db.collection('tasks').findOne({ orgId, projectId, tags: 'from-claude-item', title }, { projection: { ref: 1 } });
            let ref = again?.ref;
            if (!ref) {
              const seq = await db.collection('counters').findOneAndUpdate({ _id: `task:${orgId}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
              ref = seq.seq;
              const now = new Date();
              const doc = {
                _id: randomUUID(), ...place, assigneeIds: [], ref, title, description, mode: null, projectId, priority: 'P3', status: d.state === 'blocked' ? 'Blocked' : 'Not Started',
                tags: ['from-claude-item'], due: null, start: null, estimateMins: null, progress: 0, checklist: [], links: [], blockedReason: d.state === 'blocked' ? 'From a blocked Claude item' : '',
                titleBy: SYSTEM, ...(description ? { descriptionBy: SYSTEM } : {}), tagsBy: SYSTEM, dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: SYSTEM,
                createdAt: now, updatedAt: now, doneAt: null, doneOn: null, doneBy: null,
              };
              await db.collection('tasks').insertOne(doc);
              await db.collection('activity').insertOne({ _id: randomUUID(), ...place, taskId: doc._id, taskRef: ref, taskTitle: title, at: now, actor: SYSTEM, type: 'created', note: `From Claude item C${d.ref}` });
            }
            movedTo = movedToTask(ref);
          }
        } else {
          lines++;
          laterCount++;
          if (APPLY) {
            const fresh = await db.collection('states').findOne({ orgId, projectId }, { projection: { later: 1 } });
            let line = (fresh?.later ?? []).find(l => l.text === plan.text);
            if (!line) {
              line = { id: `l_${randomBytes(4).toString('hex')}`, text: plan.text, ...(plan.waitsOn ? { waitsOn: plan.waitsOn } : {}), by: project.ownerId, at: new Date() };
              await db.collection('states').updateOne({ orgId, projectId }, { $push: { later: line }, $inc: { version: 1 }, $set: { updatedAt: new Date() } });
            }
            movedTo = movedToLine(line.id);
          }
        }
        if (APPLY) {
          const now = new Date();
          await db.collection('claudeItems').updateOne({ _id: d._id }, { $set: { state: 'dropped', movedTo, updatedAt: now }, $push: { log: { at: now, actor: SYSTEM, text: `Moved by the Claude items migration: ${movedTo}` } } });
        }
      }
      total.tasks += tasks;
      total.lines += lines;
      total.projects++;
      console.log(`  ${APPLY ? '✓' : '-'} ${project.name}: ${plural(items.length, 'open item')} -> ${plural(tasks, 'task')}, ${plural(lines, 'Later line')}${APPLY ? '' : ' (would be)'}`);
    }
  }
  if (!orgs.length) console.log('Nothing to do: no open Claude items.');
  else console.log(`\n${APPLY ? 'Moved' : 'Would move'}: ${plural(total.tasks, 'task')} and ${plural(total.lines, 'Later line')} from ${plural(total.projects, 'project')}${total.left ? `; ${plural(total.left, 'item')} left (their project is gone)` : ''}.`);
  if (!APPLY) console.log('\nDry run: nothing was changed.');
} finally {
  await client.close();
}
