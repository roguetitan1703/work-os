#!/usr/bin/env node
// Several assignees per task (Work OS #165): a task's one `assigneeId` becomes the list `assigneeIds`, on tasks and on
// the copies kept in the trash. The app already reads both (lib/assignees.ts) and moves a task over at its next change,
// so this can run any time after the deploy; once it has, nothing carries the old field and its read paths can go.
//
//   node scripts/migrate-assignees.mjs --db <database>           dry run: counts what it would change
//   node scripts/migrate-assignees.mjs --db <database> --apply   does it
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: a second run finds nothing to do. Prints counts only, never ids, titles or names.
// Each document changes in one server-side update (an update pipeline), so a write by the app at the same moment is
// never lost: an assignee already in the list is kept, the old one is added to it.
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
const APPLY = args.includes('--apply');
if (!source) die('Name the database: node scripts/migrate-assignees.mjs --db <database> [--apply]');

const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

/**
 * The pipeline that moves `<at>assigneeId` into `<at>assigneeIds` (at: '' for a task, 'task.' for a trash copy). The old
 * assignee goes into the list only if they can see the task (the app's rule, lib/assignees.ts canBeAssigned): anyone
 * on a task shared with everyone, its owner, or someone on the list of a project shared with chosen people
 * ('members'). Anyone else is dropped (an older build may have left them), and so leaves its alerts to the owner.
 */
function moveOver(at) {
  const one = `$${at}assigneeId`;
  return [
    {
      $set: {
        [`${at}assigneeIds`]: {
          $let: {
            vars: { a: { $cond: [{ $isArray: `$${at}assigneeIds` }, `$${at}assigneeIds`, []] } },
            in: { $cond: [{ $and: [{ $eq: [{ $type: one }, 'string'] }, { $ne: [one, ''] }, { $not: [{ $in: [one, '$$a'] }] }, sees(at, one)] }, { $concatArrays: ['$$a', [one]] }, '$$a'] },
          },
        },
      },
    },
    { $unset: `${at}assigneeId` },
  ];
}

/** Can the user (an expression) see the task at `at`? */
const sees = (at, user) => ({
  $or: [
    { $eq: [`$${at}visibility`, 'org'] },
    { $eq: [user, `$${at}ownerId`] },
    { $and: [{ $eq: [`$${at}visibility`, 'members'] }, { $in: [user, { $ifNull: [`$${at}sharedWith`, []] }] }] },
  ],
});

/** The query form: an old assignee who could not see the task (dropped). */
const blind = at => ({
  [`${at}assigneeId`]: { $type: 'string', $ne: '' },
  $expr: { $not: [sees(at, `$${at}assigneeId`)] },
});

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);
  const lines = [];
  for (const [label, col, at] of [
    ['tasks', 'tasks', ''],
    ['tasks in the trash', 'trash', 'task.'],
  ]) {
    const filter = { [`${at}assigneeId`]: { $exists: true } };
    const total = await db.collection(col).countDocuments(filter);
    const assigned = await db.collection(col).countDocuments({ [`${at}assigneeId`]: { $type: 'string', $ne: '' } });
    const dropped = await db.collection(col).countDocuments(blind(at));
    if (APPLY && total) await db.collection(col).updateMany(filter, moveOver(at));
    if (total) lines.push(`  ${APPLY ? '✓' : '-'} ${label}: ${total} moved to the list (${assigned} with someone assigned, ${total - assigned} with nobody; ${dropped} assignee${dropped === 1 ? '' : 's'} who could not see the task dropped)`);
  }
  console.log(lines.length ? lines.join('\n') : '  Nothing to do: every task already has the list.');
  if (!APPLY) console.log('\nDry run: nothing was changed.');
  else {
    const left = (await db.collection('tasks').countDocuments({ assigneeId: { $exists: true } })) + (await db.collection('trash').countDocuments({ 'task.assigneeId': { $exists: true } }));
    console.log(left ? `\n! ${left} still carry the old field (written meanwhile by an older build?); run again.` : '\nDone: no task carries the old field.');
  }
} finally {
  await client.close();
}
