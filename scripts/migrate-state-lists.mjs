#!/usr/bin/env node
// Parked lines and decisions leave the State document for their own collections (stateParked, stateDecisions; plan note
// 4a1ccbf69d). The app moves a project lazily on first touch; this script makes the move complete and verified.
//
//   node --experimental-strip-types --no-warnings scripts/migrate-state-lists.mjs --db <database> [--org <orgId>]             dry run: counts per project
//   node --experimental-strip-types --no-warnings scripts/migrate-state-lists.mjs --db <database> [--org <orgId>] --apply     moves every State that still has the arrays
//   node --experimental-strip-types --no-warnings scripts/migrate-state-lists.mjs --db <database> [--org <orgId>] --rollback  rebuilds the arrays from the rows and deletes the rows
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is always named on the command line.
// The move is lib/state-lists-move.ts, the code the app runs. Each project is one transaction: the arrays are unset in the
// transaction that wrote the rows, so a project is moved whole or not at all. Idempotent: rows are upserted by
// { orgId, projectId, id }, a second --apply moves nothing, and every run recounts parkedCount and decisionsCount from the rows.
// --rollback is only for after the previous master is deployed again (the old code reads the arrays).
// Prints counts per project, never any text.
import { MongoClient } from 'mongodb';
import { moveLegacyLists } from '../lib/state-lists-move.ts';

const args = process.argv.slice(2);
const val = f => (args.indexOf(f) >= 0 && args[args.indexOf(f) + 1] && !args[args.indexOf(f) + 1].startsWith('--') ? args[args.indexOf(f) + 1] : null);
const source = val('--db');
const onlyOrg = val('--org');
const APPLY = args.includes('--apply');
const ROLLBACK = args.includes('--rollback');
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node --experimental-strip-types scripts/migrate-state-lists.mjs --db <database> [--org <orgId>] [--apply | --rollback]');
if (APPLY && ROLLBACK) die('Give --apply or --rollback, not both.');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');

const client = new MongoClient(uri);
await client.connect();
let failed = 0;
try {
  const db = client.db(source);
  const states = db.collection('states');
  const parked = db.collection('stateParked');
  const decisions = db.collection('stateDecisions');
  const scope = onlyOrg ? { orgId: onlyOrg } : {};
  console.log(`${APPLY ? 'APPLY' : ROLLBACK ? 'ROLLBACK' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}${onlyOrg ? ` (organization ${onlyOrg})` : ''}\n`);

  if (ROLLBACK) {
    let n = 0;
    const ids = await parked.distinct('projectId', scope);
    for (const d of await decisions.distinct('projectId', scope)) if (!ids.includes(d)) ids.push(d);
    for (const projectId of ids) {
      const st = await states.findOne({ _id: projectId, ...scope }, { projection: { orgId: 1 } });
      if (!st) {
        console.log(`  project ${projectId}: no State, rows left alone`);
        continue;
      }
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          const pRows = await parked.find({ orgId: st.orgId, projectId }, { session }).sort({ parkedAt: 1, id: 1 }).toArray();
          const dRows = await decisions.find({ orgId: st.orgId, projectId }, { session }).sort({ at: 1, id: 1 }).toArray();
          const strip = ({ _id, projectId: _p, orgId: _o, ownerId: _w, visibility: _v, sharedWith: _s, ...rest }) => rest;
          const lines = pRows.map(({ parkedAt: _t, ...r }) => strip(r));
          const decs = dRows.map(strip);
          await states.updateOne({ _id: projectId }, { $set: { parked: lines, decisions: decs }, $unset: { parkedCount: '', decisionsCount: '' } }, { session });
          await parked.deleteMany({ orgId: st.orgId, projectId }, { session });
          await decisions.deleteMany({ orgId: st.orgId, projectId }, { session });
          console.log(`  project ${projectId}: ${lines.length} parked, ${decs.length} decisions put back as arrays`);
          n++;
        });
      } finally {
        await session.endSession();
      }
    }
    console.log(`\nRolled back ${n} project(s).`);
  } else {
    // Every State: those with arrays are moved; the others are recounted (repairs drift).
    let toMove = 0;
    let moved = 0;
    let recounted = 0;
    for await (const st of states.find(scope)) {
      const projectId = st.projectId ?? st._id;
      const hasArrays = Array.isArray(st.parked) || Array.isArray(st.decisions);
      if (!APPLY) {
        if (hasArrays) {
          toMove++;
          const existing = (await parked.countDocuments({ orgId: st.orgId, projectId })) + (await decisions.countDocuments({ orgId: st.orgId, projectId }));
          console.log(`  project ${projectId}: ${(st.parked ?? []).length} parked, ${(st.decisions ?? []).length} decisions to move (${existing} rows already there)`);
        }
        continue;
      }
      const session = client.startSession();
      try {
        let result = null;
        await session.withTransaction(async () => {
          result = await moveLegacyLists({ states, parked, decisions }, st, { session, recount: true });
        });
        // Verify: rows equal the old array length; the counts equal the rows.
        const pRows = await parked.countDocuments({ orgId: st.orgId, projectId });
        const live = await decisions.countDocuments({ orgId: st.orgId, projectId, archivedAt: null });
        const after = await states.findOne({ _id: st._id }, { projection: { parkedCount: 1, decisionsCount: 1, parked: 1, decisions: 1 } });
        const okRows = !hasArrays || (pRows >= (st.parked ?? []).length && (await decisions.countDocuments({ orgId: st.orgId, projectId })) >= (st.decisions ?? []).length);
        if (!okRows || after.parkedCount !== pRows || after.decisionsCount !== live || after.parked || after.decisions) {
          failed++;
          console.log(`  project ${projectId}: CHECK FAILED (rows ${pRows}, live decisions ${live}, counts ${after.parkedCount}/${after.decisionsCount})`);
        } else if (hasArrays) {
          moved++;
          console.log(`  project ${projectId}: moved ${result.parkedRows} parked and ${result.decisionRows} decisions (${result.parkedCount} parked, ${result.decisionsCount} live decisions)`);
        } else recounted++;
      } finally {
        await session.endSession();
      }
    }
    console.log(APPLY ? `\nMoved ${moved} project(s); counts checked on ${recounted} that had nothing to move.` : `\n${toMove} project(s) to move.`);
  }
} finally {
  await client.close();
}
if (failed) {
  console.error(`${failed} project(s) failed the check.`);
  process.exit(1);
}
