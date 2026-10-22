// Reading the measurements (tests/load/README.md): the server meter (meter.cjs, in the app's process) and the mongod
// profiler of the throwaway database, grouped by the route each call was made for (the meter tags every call with
// comment 'wos|<route>').
import { rawDb } from '../e2e/lib.mjs';

const METER = process.env.LOAD_METER_URL;

export async function meter() {
  if (!METER) return null;
  return fetch(METER + '/stats', { signal: AbortSignal.timeout(30_000) }).then(r => r.json());
}
export async function meterReset() {
  if (METER) await fetch(METER + '/reset', { method: 'POST' }).then(r => r.text());
}

/** Profiler on, every operation, into a fresh capped collection big enough for a whole run. */
export async function profilerOn(mb = 400) {
  await rawDb.command({ profile: 0 });
  await rawDb.collection('system.profile').drop().catch(() => {});
  await rawDb.createCollection('system.profile', { capped: true, size: mb * 1024 * 1024 });
  await rawDb.command({ profile: 2 });
}
export async function profilerOff() {
  await rawDb.command({ profile: 0 });
}

/**
 * Per route since `since`: operations, documents examined, keys examined, documents returned, KB returned, and how
 * many ran without an index (COLLSCAN), with the collections they scanned.
 */
export async function profileByRoute(since = new Date(0)) {
  const rows = await rawDb.collection('system.profile').aggregate([
    { $match: { ts: { $gte: since }, ns: { $not: /system\.profile|\$cmd$|\.indexes$/ }, op: { $ne: 'getmore' } } },
    {
      $project: {
        route: { $ifNull: ['$command.comment', { $ifNull: ['$originatingCommand.comment', '(untagged)'] }] },
        coll: { $arrayElemAt: [{ $split: ['$ns', '.'] }, 1] },
        docsExamined: { $ifNull: ['$docsExamined', 0] }, keysExamined: { $ifNull: ['$keysExamined', 0] },
        nreturned: { $ifNull: ['$nreturned', 0] }, responseLength: { $ifNull: ['$responseLength', 0] },
        scan: { $cond: [{ $regexMatch: { input: { $ifNull: ['$planSummary', ''] }, regex: 'COLLSCAN' } }, 1, 0] },
      },
    },
    { $group: { _id: '$route', ops: { $sum: 1 }, docsExamined: { $sum: '$docsExamined' }, keysExamined: { $sum: '$keysExamined' }, nreturned: { $sum: '$nreturned' }, bytes: { $sum: '$responseLength' }, collscans: { $sum: '$scan' }, scanned: { $addToSet: { $cond: [{ $eq: ['$scan', 1] }, '$coll', '$$REMOVE'] } } } },
  ], { allowDiskUse: true }).toArray();
  const out = {};
  for (const r of rows) out[String(r._id).replace(/^wos\|/, '')] = { ops: r.ops, docsExamined: r.docsExamined, keysExamined: r.keysExamined, nreturned: r.nreturned, kb: Math.round(r.bytes / 1024), collscans: r.collscans, scanned: r.scanned };
  return out;
}

/** The slowest-growing shapes: COLLSCANs by collection and filter keys (to find missing indexes). */
export async function collscans(since = new Date(0)) {
  const docs = await rawDb.collection('system.profile').find({ ts: { $gte: since }, planSummary: /COLLSCAN/, ns: { $not: /system\.profile/ } }).project({ ns: 1, command: 1, docsExamined: 1 }).toArray();
  const keysOf = c => {
    const f = c?.filter ?? c?.pipeline?.[0]?.$match ?? c?.q ?? c?.updates?.[0]?.q ?? c?.deletes?.[0]?.q ?? {};
    return Object.keys(f).sort();
  };
  const by = new Map();
  for (const d of docs) {
    const coll = d.ns.split('.').slice(1).join('.');
    const keys = keysOf(d.command);
    const k = coll + JSON.stringify(keys);
    const e = by.get(k) ?? { _id: { coll, keys }, n: 0, docs: 0, routes: new Set() };
    e.n++;
    e.docs += d.docsExamined ?? 0;
    e.routes.add(String(d.command?.comment ?? '(untagged)').replace(/^wos\|/, ''));
    by.set(k, e);
  }
  return [...by.values()].map(e => ({ ...e, routes: [...e.routes] })).sort((a, b) => b.docs - a.docs).slice(0, 30);
}

/** mongod's own counters (for totals that do not depend on the profiler). */
export async function serverStatus() {
  const s = await rawDb.admin().command({ serverStatus: 1 });
  return { scannedObjects: s.metrics.queryExecutor.scannedObjects, scanned: s.metrics.queryExecutor.scanned, returned: s.metrics.document.returned, opcounters: s.opcounters, bytesOut: s.network.bytesOut };
}
