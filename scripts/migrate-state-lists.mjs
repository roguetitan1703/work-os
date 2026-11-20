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
import { idProblems, moveLegacyLists } from '../lib/state-lists-move.ts';

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
    // Every State is walked (not only those with rows): each ends with `parked` and `decisions` arrays, empty if need be, so the old code never meets a missing one.
    let n = 0;
    for await (const st of states.find(scope, { projection: { orgId: 1, projectId: 1 } })) {
      const projectId = st.projectId ?? st._id;
      const session = client.startSession();
      let done = null;
      try {
        await session.withTransaction(async () => {
          done = null;
          const pRows = await parked.find({ orgId: st.orgId, projectId }, { session }).sort({ parkedAt: 1, id: 1 }).toArray();
          const dRows = await decisions.find({ orgId: st.orgId, projectId }, { session }).sort({ at: 1, id: 1 }).toArray();
          const strip = ({ _id, projectId: _p, orgId: _o, ownerId: _w, visibility: _v, sharedWith: _s, ...rest }) => rest;
          const lines = pRows.map(({ parkedAt: _t, ...r }) => strip(r));
          const decs = dRows.map(strip);
          await states.updateOne({ _id: st._id }, { $set: { parked: lines, decisions: decs }, $unset: { parkedCount: '', decisionsCount: '' } }, { session });
          await parked.deleteMany({ orgId: st.orgId, projectId }, { session });
          await decisions.deleteMany({ orgId: st.orgId, projectId }, { session });
          done = { parked: lines.length, decisions: decs.length };
        });
        // Counted and logged after the commit, so a retried transaction never repeats a line.
        n++;
        if (done.parked || done.decisions) console.log(`  project ${projectId}: ${done.parked} parked, ${done.decisions} decisions put back as arrays`);
      } catch (e) {
        failed++;
        console.log(`  project ${projectId}: ROLLBACK FAILED, left as it was (${e instanceof Error ? e.message.slice(0, 120) : 'error'})`);
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
    for await (const st0 of states.find(scope, { projection: { _id: 1 } })) {
      if (!APPLY) {
        const st = await states.findOne({ _id: st0._id });
        const projectId = st.projectId ?? st._id;
        if (Array.isArray(st.parked) || Array.isArray(st.decisions)) {
          toMove++;
          const existing = (await parked.countDocuments({ orgId: st.orgId, projectId })) + (await decisions.countDocuments({ orgId: st.orgId, projectId }));
          const bad = idProblems(st);
          console.log(`  project ${projectId}: ${(st.parked ?? []).length} parked, ${(st.decisions ?? []).length} decisions to move (${existing} rows already there)${bad ? ` PROBLEM: ${bad}` : ''}`);
          if (bad) failed++;
        }
        continue;
      }
      const session = client.startSession();
      let out = null;
      try {
        await session.withTransaction(async () => {
          out = null;
          // Read again inside the transaction: a copy read earlier may be stale (a line unparked since would come back).
          const st = await states.findOne({ _id: st0._id }, { session });
          if (!st) return;
          const projectId = st.projectId ?? st._id;
          const hasArrays = Array.isArray(st.parked) || Array.isArray(st.decisions);
          const result = await moveLegacyLists({ states, parked, decisions }, st, { session, recount: true });
          // Verify against that same copy, inside the transaction: rows cover the arrays, the counts equal the rows, the arrays are gone.
          const pRows = await parked.countDocuments({ orgId: st.orgId, projectId }, { session });
          const dRows = await decisions.countDocuments({ orgId: st.orgId, projectId }, { session });
          const live = await decisions.countDocuments({ orgId: st.orgId, projectId, archivedAt: null }, { session });
          const after = await states.findOne({ _id: st._id }, { projection: { parkedCount: 1, decisionsCount: 1, parked: 1, decisions: 1 }, session });
          if ((hasArrays && (pRows < (st.parked ?? []).length || dRows < (st.decisions ?? []).length)) || after.parkedCount !== pRows || after.decisionsCount !== live || after.parked || after.decisions) {
            throw new Error(`check failed (rows ${pRows}/${dRows}, counts ${after.parkedCount}/${after.decisionsCount})`);
          }
          out = { projectId, hasArrays, result };
        });
        // Counted and logged after the commit (a retried transaction repeats nothing).
        if (out?.hasArrays) {
          moved++;
          console.log(`  project ${out.projectId}: moved ${out.result.parkedRows} parked and ${out.result.decisionRows} decisions (${out.result.parkedCount} parked, ${out.result.decisionsCount} live decisions)`);
        } else if (out) recounted++;
      } catch (e) {
        failed++;
        console.log(`  project ${st0.projectId ?? st0._id}: NOT MOVED, arrays kept (${e instanceof Error ? e.message.slice(0, 160) : 'error'})`);
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
