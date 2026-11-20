// Unit test for lib/state-lists-move.ts: a State's legacy parked and decisions arrays become rows. No database: tiny in-memory collections.
// Run: npm run check:state-lists-move (Node 22.6+, type stripping).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { moveLegacyLists, idProblems } = await import(pathToFileURL(join(ROOT, 'lib/state-lists-move.ts')).href);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => (v === null ? doc[k] === undefined || doc[k] === null : v && typeof v === 'object' && v.$in ? v.$in.includes(doc[k]) : doc[k] === v));
const col = () => {
  const rows = [];
  return {
    rows,
    async updateOne(filter, update, opts = {}) {
      const hit = rows.find(r => matches(r, filter));
      if (!hit) {
        if (!opts.upsert) return { upsertedCount: 0 };
        rows.push({ ...filter, ...(update.$setOnInsert ?? {}) });
        return { upsertedCount: 1 };
      }
      if (update.$set) Object.assign(hit, update.$set);
      for (const k of Object.keys(update.$unset ?? {})) delete hit[k];
      return { upsertedCount: 0 };
    },
    async countDocuments(filter) {
      return rows.filter(r => matches(r, filter)).length;
    },
  };
};
const setup = st => {
  const states = col();
  states.rows.push(st);
  return { states, parked: col(), decisions: col(), st };
};
const T = ms => new Date(1_700_000_000_000 + ms);
const base = { _id: 'p1', orgId: 'o1', projectId: 'p1', ownerId: 'u1', visibility: 'org' };

// Empty arrays: nothing to move, counts 0, arrays gone.
let c = setup({ ...base, parked: [], decisions: [] });
let r = await moveLegacyLists(c, c.st);
check('empty arrays: counts 0 and the arrays are unset', r?.parkedCount === 0 && r.decisionsCount === 0 && !('parked' in c.st) && !('decisions' in c.st), JSON.stringify(r));

// No arrays: left alone, unless recount.
c = setup({ ...base });
check('no arrays: left alone (null)', (await moveLegacyLists(c, c.st)) === null);
r = await moveLegacyLists(c, c.st, { recount: true });
check('no arrays with recount: counts set', r?.moved === false && c.st.parkedCount === 0 && c.st.decisionsCount === 0);

// Only decisions.
c = setup({ ...base, decisions: [{ id: 'd1', at: T(0), by: 'u1', via: 'chat', text: 'one' }, { id: 'd2', at: T(1000), by: 'u1', via: 'app', text: 'two', key: 'k1' }] });
r = await moveLegacyLists(c, c.st);
check('only decisions: 2 rows, 0 parked, placement copied', r?.decisionRows === 2 && r.parkedRows === 0 && c.decisions.rows.every(x => x.orgId === 'o1' && x.ownerId === 'u1' && x.visibility === 'org' && x.projectId === 'p1' && typeof x._id === 'string') && c.decisions.rows[1].key === 'k1', JSON.stringify(c.decisions.rows));
check('only decisions: decisionsCount 2', c.st.decisionsCount === 2 && c.st.parkedCount === 0);

// Same-millisecond at values keep their order.
c = setup({
  ...base,
  parked: [1, 2, 3].map(n => ({ id: `l_${n}`, text: `line ${n}`, by: 'u1', at: T(0) })),
  decisions: [1, 2, 3].map(n => ({ id: `d${n}`, at: T(5), by: 'u1', via: 'code', text: `dec ${n}` })),
});
await moveLegacyLists(c, c.st);
const pOrder = [...c.parked.rows].sort((a, b) => a.parkedAt - b.parkedAt).map(x => x.id).join();
const dOrder = [...c.decisions.rows].sort((a, b) => a.at - b.at).map(x => x.id).join();
check('same-millisecond parked lines keep their order', pOrder === 'l_1,l_2,l_3', pOrder);
check('same-millisecond decisions keep their order', dOrder === 'd1,d2,d3', dOrder);
check('the first line keeps its own date', c.parked.rows.find(x => x.id === 'l_1').parkedAt.getTime() === T(0).getTime() && c.parked.rows.find(x => x.id === 'l_1').at.getTime() === T(0).getTime());

// Archived decisions keep archivedAt and are not counted.
c = setup({ ...base, decisions: [{ id: 'd1', at: T(0), by: 'u1', via: 'app', text: 'old', archivedAt: T(9) }, { id: 'd2', at: T(1), by: 'u1', via: 'app', text: 'live' }] });
await moveLegacyLists(c, c.st);
check('archived decisions keep archivedAt and are not counted', c.decisions.rows.find(x => x.id === 'd1').archivedAt?.getTime() === T(9).getTime() && c.st.decisionsCount === 1 && c.decisions.rows.length === 2);

// A second call is a no-op.
const before = JSON.stringify(c.decisions.rows);
r = await moveLegacyLists(c, c.st);
check('a second call moves nothing and changes nothing', r === null && JSON.stringify(c.decisions.rows) === before);
// A second call from the old document (a run stopped halfway) finds the rows and adds none.
const again = { ...base, decisions: [{ id: 'd1', at: T(0), by: 'u1', via: 'app', text: 'old', archivedAt: T(9) }, { id: 'd2', at: T(1), by: 'u1', via: 'app', text: 'live' }] };
c.states.rows.length = 0;
c.states.rows.push(again);
r = await moveLegacyLists(c, again);
check('the same arrays again add no rows and keep the counts', r?.decisionRows === 0 && c.decisions.rows.length === 2 && again.decisionsCount === 1);

// Repeated or missing ids: the move throws before writing and the arrays stay.
c = setup({ ...base, parked: [{ id: 'x', text: 'a', by: 'u1', at: T(0) }, { id: 'x', text: 'b', by: 'u1', at: T(1) }] });
let threw = false;
try {
  await moveLegacyLists(c, c.st);
} catch {
  threw = true;
}
check('repeated ids: the move throws, no rows, the arrays stay', threw && c.parked.rows.length === 0 && c.st.parked.length === 2 && !('parkedCount' in c.st));
check('idProblems names repeated and missing ids', /repeated Parked/.test(idProblems({ parked: [{ id: 'a' }, { id: 'a' }] }) ?? '') && /without an id/.test(idProblems({ decisions: [{ text: 'x' }] }) ?? '') && idProblems({ parked: [{ id: 'a' }] }) === null);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall ok');
