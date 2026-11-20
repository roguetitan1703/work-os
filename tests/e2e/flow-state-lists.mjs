// Parked and decisions in their own collections (plan note 4a1ccbf69d): rows in stateParked and stateDecisions, the counts on
// the State, no cap, paging with before/next, search, the short State for agents, the move of a legacy State (on first touch
// and by scripts/migrate-state-lists.mjs), the transaction, the hourly limit and the WORK-STATE.md copy. Seed profile: none.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DBNAME, ME, MCP, check, finish, launch, login, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const projectOf = async name => (await must(MCP, 'add_project', { name })).project;
const doc = id => rawDb.collection('states').findOne({ projectId: id });
const rowsOf = (col, id, sort = {}) => rawDb.collection(col).find({ projectId: id }).sort(sort).toArray();
const placeOf = async id => {
  const p = await rawDb.collection('projects').findOne({ _id: id });
  return { orgId: p.orgId, ownerId: p.ownerId, visibility: p.visibility, ...(p.sharedWith?.length ? { sharedWith: p.sharedWith } : {}) };
};
let seq = 0;
const T0 = Date.now() - 86_400_000 * 5;
const parkedRow = (projectId, place, i, text) => ({ _id: `r${++seq}x${i}`, projectId, id: `l_raw${i}`, text, by: ME.userId, at: new Date(T0 + i), parkedAt: new Date(T0 + i), ...place });
const decisionRow = (projectId, place, i, text, extra = {}) => ({ _id: `d${++seq}x${i}`, projectId, id: `l_dec${i}`, at: new Date(T0 + i), by: ME.userId, via: 'code', text, ...place, ...extra });
const legacyState = async (projectId, parked, decisions) => {
  const place = await placeOf(projectId);
  const now = new Date();
  await rawDb.collection('states').insertOne({ _id: projectId, projectId, ...place, now: null, next: [], later: [], parked, decisions, where: {}, version: 1, createdAt: now, updatedAt: now });
};
const legacyLists = () => ({
  parked: [0, 1, 2].map(i => ({ id: `l_lp${i}`, text: `Legacy parked ${i} zebra`, by: ME.userId, at: new Date(T0 + i * 1000), ...(i === 1 ? { when: 'later in the year' } : {}) })),
  decisions: Array.from({ length: 12 }, (_, i) => ({ id: `l_ld${i}`, at: new Date(T0 + i * 1000), by: ME.userId, via: i % 2 ? 'chat' : 'code', text: `Legacy decision ${i}`, ...(i === 3 ? { archivedAt: new Date(T0 + 99_000) } : {}) })),
});

try {
  // 1 + 2: park and add_decision write rows, the counts follow, the State holds no arrays
  const A = await projectOf('SL Basic');
  await must(MCP, 'save_state', { project: 'SL Basic', ops: [{ op: 'park', text: 'First idea', when: 'someday' }, { op: 'add_decision', text: 'We chose rows' }] });
  const placeA = await placeOf(A.id);
  const pa = await rowsOf('stateParked', A.id);
  const da = await rowsOf('stateDecisions', A.id);
  let d = await doc(A.id);
  check('park: a row in stateParked with the project placement, parkedCount 1, no parked field on the State', pa.length === 1 && pa[0].text === 'First idea' && pa[0].when === 'someday' && pa[0].orgId === placeA.orgId && pa[0].ownerId === placeA.ownerId && pa[0].visibility === placeA.visibility && d.parkedCount === 1 && !('parked' in d), JSON.stringify([pa, d.parkedCount]));
  check('add_decision: a row in stateDecisions, decisionsCount 1, no decisions field on the State', da.length === 1 && da[0].text === 'We chose rows' && da[0].via && da[0].visibility === placeA.visibility && d.decisionsCount === 1 && !('decisions' in d), JSON.stringify([da, d.decisionsCount]));

  // 3: no cap
  const B1 = await projectOf('SL Nocap');
  const placeB = await placeOf(B1.id);
  await must(MCP, 'save_state', { project: 'SL Nocap', ops: [{ op: 'add_next', text: 'something' }] }); // makes the State; the rows below are added raw, so the counts are set raw too
  await rawDb.collection('stateParked').insertMany(Array.from({ length: 1200 }, (_, i) => parkedRow(B1.id, placeB, i, `Bulk idea ${i}`)));
  await rawDb.collection('stateDecisions').insertMany(Array.from({ length: 600 }, (_, i) => decisionRow(B1.id, placeB, i, `Bulk decision ${i}`)));
  await rawDb.collection('states').updateOne({ projectId: B1.id }, { $set: { parkedCount: 1200, decisionsCount: 600 } });
  const nc = await mcpH(MCP, 'save_state', { project: 'SL Nocap', ops: [{ op: 'park', text: 'The 1201st idea' }, { op: 'add_decision', text: 'The 601st decision' }] });
  const ncs = (await must(MCP, 'get_state', { project: 'SL Nocap' })).state;
  check('no cap: the 1201st Parked line and the 601st decision are taken, totals 1201 and 601', !nc.isError && ncs.parkedTotal === 1201 && ncs.decisionsTotal === 601, nc.text.slice(0, 200) + JSON.stringify([ncs.parkedTotal, ncs.decisionsTotal]));

  // 4: paging
  const seen = [];
  let before;
  let pages = 0;
  let lastNext = 'x';
  for (;;) {
    const r = await must(MCP, 'list_parked', { project: 'SL Nocap', limit: 100, ...(before ? { before } : {}) });
    seen.push(...r.parked.map(x => x.text));
    pages++;
    lastNext = r.next;
    if (!r.next || pages > 20) break;
    before = r.next;
  }
  const expectP = ['The 1201st idea', ...Array.from({ length: 1200 }, (_, i) => `Bulk idea ${1199 - i}`)];
  check('list_parked: pages of 100 with before cover all 1201 lines, newest first, no repeat and no gap; the last page has no next', pages === 13 && seen.length === 1201 && seen.every((t, i) => t === expectP[i]) && lastNext === undefined, `${pages} ${seen.length}`);
  const seenD = [];
  before = undefined;
  pages = 0;
  for (;;) {
    const r = await must(MCP, 'list_decisions', { project: 'SL Nocap', limit: 250, since: '30d', ...(before ? { before } : {}) });
    seenD.push(...r.decisions.map(x => x.text));
    pages++;
    if (!r.next || pages > 20) break;
    before = r.next;
  }
  check('list_decisions: pages with before and since cover all 601 decisions in order', pages === 3 && seenD.length === 601 && seenD[0] === 'The 601st decision' && seenD[600] === 'Bulk decision 0' && new Set(seenD).size === 601, `${pages} ${seenD.length}`);
  const otherCursor = (await must(MCP, 'list_parked', { project: 'SL Nocap', limit: 5 })).next;
  const foreign = await mcpH(MCP, 'list_parked', { project: 'SL Basic', before: otherCursor });
  check('before: a cursor from another project is refused and returns nothing of it', foreign.isError && !foreign.text.includes('Bulk idea'), foreign.text.slice(0, 200));

  // 5: search
  const S = await projectOf('SL Search');
  await must(MCP, 'save_state', { project: 'SL Search', ops: [{ op: 'park', text: 'Add the Gamma Widget soon' }, { op: 'park', text: 'literal a.b( chars', when: 'when ZEBRA herds come' }, { op: 'park', text: 'axb unrelated' }, { op: 'add_decision', text: 'Use the Gamma Widget everywhere' }] });
  const q1 = await must(MCP, 'list_parked', { project: 'SL Search', query: 'gAmMa wid' });
  const q2 = await must(MCP, 'list_parked', { project: 'SL Search', query: 'a.b(' });
  const q3 = await must(MCP, 'list_parked', { project: 'SL Search', query: 'zebra' });
  const q4 = await must(MCP, 'list_decisions', { project: 'SL Search', query: 'WIDGET EVER' });
  check('search: query matches the middle of a line, case-insensitively', q1.parked.length === 1 && q1.parked[0].text.startsWith('Add the Gamma') && q4.decisions.length === 1, JSON.stringify([q1, q4]).slice(0, 300));
  check('search: regex characters are taken literally (a.b( does not match axb)', q2.parked.length === 1 && q2.parked[0].text.startsWith('literal'), JSON.stringify(q2));
  check('search: for Parked the "bring back when" matches too', q3.parked.length === 1 && q3.parked[0].text.startsWith('literal'), JSON.stringify(q3));

  // 6: get_state
  const G = await projectOf('SL Ten');
  await must(MCP, 'save_state', { project: 'SL Ten', ops: Array.from({ length: 13 }, (_, i) => ({ op: 'add_decision', text: `Ten decision ${i + 1}` })) });
  await must(MCP, 'save_state', { project: 'SL Ten', ops: [{ op: 'park', text: 'p1' }, { op: 'park', text: 'p2' }] });
  const gs = (await must(MCP, 'get_state', { project: 'SL Ten' })).state;
  const gc = (await must(MCP, 'get_state', { project: 'SL Ten', compact: true })).state;
  check('get_state: the latest 10 live decisions, oldest first, with the totals', gs.decisions.length === 10 && gs.decisions[0].text === 'Ten decision 4' && gs.decisions[9].text === 'Ten decision 13' && gs.decisionsTotal === 13 && gs.parkedTotal === 2 && !gs.parked, JSON.stringify(gs.decisions.map(x => x.text)));
  check('get_state compact: says "N lines: list_parked"', gc.parked === '2 lines: list_parked' && gc.decisionsTotal === 13, JSON.stringify(gc).slice(0, 300));

  // 7: unpark, edit_line, archive_line on Parked
  const U = await projectOf('SL Ops');
  await must(MCP, 'save_state', { project: 'SL Ops', ops: [{ op: 'park', text: 'Unpark me' }, { op: 'park', text: 'Edit me please' }, { op: 'park', text: 'Archive me' }, { op: 'park', text: 'Remove me' }] });
  let ud = await doc(U.id);
  check('ops: four parked, count 4', ud.parkedCount === 4);
  const uRows = await rowsOf('stateParked', U.id, { parkedAt: 1 });
  const idOf = t => uRows.find(r => r.text === t).id;
  const up = await mcpH(MCP, 'save_state', { project: 'SL Ops', ops: [{ op: 'unpark', id: idOf('Unpark me') }] });
  ud = await doc(U.id);
  check('unpark: the row is gone, the line is in Later, the count is 3', !up.isError && ud.parkedCount === 3 && ud.later.some(l => l.text === 'Unpark me') && !(await rawDb.collection('stateParked').findOne({ projectId: U.id, text: 'Unpark me' })), up.text.slice(0, 200));
  const ed = await mcpH(MCP, 'save_state', { project: 'SL Ops', ops: [{ op: 'edit_line', find: 'Edit me', new: 'Edited' }] });
  const edRow = await rawDb.collection('stateParked').findOne({ projectId: U.id, id: idOf('Edit me please') });
  check('edit_line: changes the row, keeps its id and place; the count stays 3', !ed.isError && edRow?.text === 'Edited please' && (await doc(U.id)).parkedCount === 3, ed.text.slice(0, 200));
  const ar = await mcpH(MCP, 'save_state', { project: 'SL Ops', ops: [{ op: 'archive_line', id: idOf('Archive me') }, { op: 'edit_line', find: 'Remove me', new: '' }] });
  ud = await doc(U.id);
  check('archive_line and an emptied edit_line: rows gone, count 1, both in archived from Parked', !ar.isError && ud.parkedCount === 1 && ud.archived?.filter(a => a.from === 'Parked').map(a => a.text).sort().join() === 'Archive me,Remove me', ar.text.slice(0, 200) + JSON.stringify(ud.archived));

  // 8: archived decisions (the write is app only: set the row as the app does) are hidden from agents and not counted
  const AR = await projectOf('SL Archive');
  await must(MCP, 'save_state', { project: 'SL Archive', ops: [{ op: 'add_decision', text: 'Keep this' }, { op: 'add_decision', text: 'Archive this' }] });
  const arRow = await rawDb.collection('stateDecisions').findOne({ projectId: AR.id, text: 'Archive this' });
  await rawDb.collection('stateDecisions').updateOne({ _id: arRow._id }, { $set: { archivedAt: new Date(), archivedBy: ME.userId } });
  await rawDb.collection('states').updateOne({ projectId: AR.id }, { $inc: { decisionsCount: -1 } });
  const ars = (await must(MCP, 'get_state', { project: 'SL Archive' })).state;
  const arl = await must(MCP, 'list_decisions', { project: 'SL Archive' });
  check('archived decision: hidden from get_state and list_decisions, the row keeps its text', ars.decisions.length === 1 && ars.decisionsTotal === 1 && arl.decisions.length === 1 && arl.total === 1 && (await rawDb.collection('stateDecisions').countDocuments({ projectId: AR.id })) === 2);

  // 9 + 10: a legacy State is moved on first touch
  const L = await projectOf('SL Legacy');
  const lg = legacyLists();
  await legacyState(L.id, lg.parked, lg.decisions);
  const ls = (await must(MCP, 'get_state', { project: 'SL Legacy' })).state;
  d = await doc(L.id);
  const lp = await rowsOf('stateParked', L.id, { parkedAt: 1 });
  const ld = await rowsOf('stateDecisions', L.id, { at: 1 });
  check('lazy move: get_state shows the right totals and the arrays are gone', ls.parkedTotal === 3 && ls.decisionsTotal === 11 && d.parkedCount === 3 && d.decisionsCount === 11 && !('parked' in d) && !('decisions' in d), JSON.stringify([ls.parkedTotal, ls.decisionsTotal, Object.keys(d)]));
  check('lazy move: the rows keep their ids, texts and order; the archived decision keeps its row', lp.map(r => r.id).join() === 'l_lp0,l_lp1,l_lp2' && lp[1].when === 'later in the year' && ld.length === 12 && ld.map(r => r.id).join() === lg.decisions.map(x => x.id).join() && !!ld[3].archivedAt && ls.decisions.length === 10 && ls.decisions[9].text === 'Legacy decision 11', JSON.stringify(lp.map(r => r.id)));
  const L2 = await projectOf('SL Legacy Save');
  const lg2 = legacyLists();
  await legacyState(L2.id, lg2.parked, lg2.decisions);
  const sv = await mcpH(MCP, 'save_state', { project: 'SL Legacy Save', ops: [{ op: 'park', text: 'Fourth idea' }] });
  d = await doc(L2.id);
  const lp2 = await rowsOf('stateParked', L2.id);
  check('lazy move under save: all 4 Parked rows are there, once each, counts right, arrays gone', !sv.isError && lp2.length === 4 && new Set(lp2.map(r => r.id)).size === 4 && d.parkedCount === 4 && d.decisionsCount === 11 && !('parked' in d) && !('decisions' in d), sv.text.slice(0, 200));

  // 11: transaction: a later op fails, nothing of the call stays
  const T = await projectOf('SL Tx');
  await must(MCP, 'save_state', { project: 'SL Tx', ops: [{ op: 'park', text: 'stays' }] });
  const txv = (await doc(T.id)).version;
  const tx = await mcpH(MCP, 'save_state', { project: 'SL Tx', ops: [{ op: 'park', text: 'would be new' }, { op: 'add_decision', text: 'would be new too' }, { op: 'unpark', id: 'l_nothere' }] });
  d = await doc(T.id);
  check('transaction: a failing later op leaves no new row, no count change and no version bump', tx.isError && d.parkedCount === 1 && (d.decisionsCount ?? 0) === 0 && d.version === txv && (await rawDb.collection('stateParked').countDocuments({ projectId: T.id })) === 1 && (await rawDb.collection('stateDecisions').countDocuments({ projectId: T.id })) === 0, tx.text.slice(0, 200));

  // 12: the hourly limit
  const kR = await mkKey({ agent: 'claude-code', name: 'sl-rate' });
  const R = await projectOf('SL Rate');
  const thirty = await mcpH(kR, 'save_state', { project: 'SL Rate', ops: Array.from({ length: 30 }, (_, i) => ({ op: 'add_decision', text: `Rate ${i}` })) });
  const thirtyOne = await mcpH(kR, 'save_state', { project: 'SL Rate', ops: [{ op: 'add_decision', text: 'Rate 31' }] });
  check('rate limit: 30 decisions in an hour are taken, the 31st is refused with the message', !thirty.isError && thirtyOne.isError && /more than 30 decisions an hour/.test(thirtyOne.text) && (await rawDb.collection('stateDecisions').countDocuments({ projectId: R.id })) === 30, thirty.text.slice(0, 150) + thirtyOne.text.slice(0, 150));

  // 12b: an hourly limit on Parked lines too (200 a key)
  const kP = await mkKey({ agent: 'claude-code', name: 'sl-park-rate' });
  const PR = await projectOf('SL Park Rate');
  const park1 = await mcpH(kP, 'save_state', { project: 'SL Park Rate', ops: [{ op: 'park', text: 'PR first' }] });
  const first = await rawDb.collection('stateParked').findOne({ projectId: PR.id });
  const placePR = await placeOf(PR.id);
  await rawDb.collection('stateParked').insertMany(Array.from({ length: 199 }, (_, i) => ({ ...parkedRow(PR.id, placePR, 1000 + i, `PR raw ${i}`), parkedAt: new Date(), key: first.key })));
  await rawDb.collection('states').updateOne({ projectId: PR.id }, { $set: { parkedCount: 200 } });
  const parkOver = await mcpH(kP, 'save_state', { project: 'SL Park Rate', ops: [{ op: 'park', text: 'PR one too many' }] });
  check('park rate limit: the 201st Parked line in an hour from one key is refused', !park1.isError && !!first.key && parkOver.isError && /more than 200 Parked lines an hour/.test(parkOver.text), parkOver.text.slice(0, 200));

  // 12c: duplicate ids in a legacy array: the move is refused, the arrays stay, the dry run names the problem
  const DUP = await projectOf('SL Dup');
  await legacyState(DUP.id, [{ id: 'l_same', text: 'a', by: ME.userId, at: new Date(T0) }, { id: 'l_same', text: 'b', by: ME.userId, at: new Date(T0 + 1) }], []);
  const dupGet = await mcpH(MCP, 'get_state', { project: 'SL Dup' });
  const dupSave = await mcpH(MCP, 'save_state', { project: 'SL Dup', ops: [{ op: 'add_next', text: 'x' }] });
  const dupDoc = await doc(DUP.id);
  const br = await launch();
  let dupPage = '';
  try {
    const pg = await br.newPage();
    await login(pg, { phone: false, next: `/projects/${DUP.id}` });
    await pg.waitForSelector('[data-card="state"]', { timeout: 30000 });
    dupPage = await pg.locator('[data-part="parked"] summary').innerText();
  } finally {
    await br.close();
  }
  check('duplicate ids: the project stays readable (get_state and the page) from its arrays; nothing is moved', !dupGet.isError && dupGet.json.state.parkedTotal === 2 && /Parked · 2/.test(dupPage) && Array.isArray(dupDoc.parked) && dupDoc.parked.length === 2 && (await rawDb.collection('stateParked').countDocuments({ projectId: DUP.id })) === 0, dupGet.text.slice(0, 200) + dupPage);
  check('duplicate ids: a save answers an error naming the repeated ids and writes nothing', dupSave.isError && /repeated Parked ids/.test(dupSave.text) && (await doc(DUP.id)).next.length === 0, dupSave.text.slice(0, 250));
  await rawDb.collection('states').deleteOne({ projectId: DUP.id }); // so the migration checks below see only their own projects

  // 13: the copy lists the last 30 decisions as before
  const C = await projectOf('SL Copy');
  const many = {
    parked: [],
    decisions: Array.from({ length: 35 }, (_, i) => ({ id: `l_cd${i}`, at: new Date(T0 + i * 60_000), by: ME.userId, via: 'code', text: `Copy decision ${i}` })),
  };
  await legacyState(C.id, many.parked, many.decisions);
  await rawDb.collection('projects').updateOne({ _id: C.id }, { $set: { code: [{ remote: 'acme/sl-copy' }], repoPublic: false, repoPublicAt: new Date() } });
  const cp = await must(MCP, 'get_state', { project: 'SL Copy', copy: true });
  const section = cp.markdown.split('## Decisions\n')[1] ?? '';
  const who = /\(([^,)]+), code\)/.exec(section)?.[1];
  const expectLines = many.decisions.slice(-30).map(x => `- ${x.at.toISOString().slice(0, 10)}: ${x.text} (${who}, ${x.via})`);
  check('copy: Decisions list the latest 30 of 35, byte for byte as before the move', section.trimEnd() === expectLines.join('\n') && !cp.markdown.includes('Copy decision 4\n') && cp.markdown.includes('Copy decision 5 '), section.slice(0, 200));

  // 14: the migration script, on this database
  const M1 = await projectOf('SL Mig One');
  const M2 = await projectOf('SL Mig Two');
  const m1 = legacyLists();
  const m2 = legacyLists();
  await legacyState(M1.id, m1.parked, m1.decisions);
  await legacyState(M2.id, m2.parked, m2.decisions);
  const run = (...flags) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('../../scripts/migrate-state-lists.mjs', import.meta.url)), '--db', DBNAME, '--org', ME.orgId, ...flags], { encoding: 'utf8', env: process.env });
  const dry = run();
  check('migration: the dry run moves nothing and names the projects to move', dry.status === 0 && /2 project\(s\) to move/.test(dry.stdout) && (await rawDb.collection('stateParked').countDocuments({ projectId: M1.id })) === 0 && !!(await doc(M1.id)).parked, dry.stdout + dry.stderr);
  const ap = run('--apply');
  const m1d = await doc(M1.id);
  check('migration: --apply moves the 2 legacy projects; counts match, arrays gone', ap.status === 0 && /Moved 2 project\(s\)/.test(ap.stdout) && m1d.parkedCount === 3 && m1d.decisionsCount === 11 && !('parked' in m1d) && (await rawDb.collection('stateDecisions').countDocuments({ projectId: M2.id })) === 12, ap.stdout + ap.stderr);
  const ap2 = run('--apply');
  check('migration: a second --apply reports 0 moved', ap2.status === 0 && /Moved 0 project\(s\)/.test(ap2.stdout), ap2.stdout + ap2.stderr);
  await rawDb.collection('states').updateOne({ projectId: M1.id }, { $inc: { parkedCount: 5, decisionsCount: -4 } });
  const ap3 = run('--apply');
  const m1r = await doc(M1.id);
  check('migration: the counts are repaired after drift', ap3.status === 0 && m1r.parkedCount === 3 && m1r.decisionsCount === 11, ap3.stdout + ap3.stderr);
  const EM = await projectOf('SL Empty');
  await must(MCP, 'save_state', { project: 'SL Empty', ops: [{ op: 'add_next', text: 'no rows here' }] });
  const ap4 = run('--rollback');
  const emDoc = await doc(EM.id);
  check('migration: --rollback gives a State with no rows empty arrays, so the old code meets none missing', ap4.status === 0 && Array.isArray(emDoc.parked) && emDoc.parked.length === 0 && Array.isArray(emDoc.decisions) && emDoc.decisions.length === 0 && emDoc.parkedCount === undefined, JSON.stringify([emDoc.parked, emDoc.decisions]));
  const back = await doc(M1.id);
  const same = (x, y) => JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
  check('migration: rollback arrays equal the originals', ap4.status === 0 && back.parked.length === 3 && back.parked.every((x, i) => same(x, m1.parked[i])) && back.decisions.length === 12 && back.decisions.every((x, i) => same(x, m1.decisions[i])) && back.parkedCount === undefined && (await rawDb.collection('stateParked').countDocuments({ projectId: M1.id })) === 0, ap4.stdout + ap4.stderr + JSON.stringify(back.decisions?.[0]));
  const out = [dry, ap, ap2, ap3, ap4].map(r => r.stdout + r.stderr).join(' | ');
  check('migration: the script prints no line text', !/Legacy (parked|decision)|zebra herds|later in the year/i.test(out), out.match(/.{0,40}(Legacy (parked|decision)|zebra).{0,40}/i)?.[0] ?? '');
} catch (e) {
  check('suite ran without throwing', false, String(e?.stack ?? e).slice(0, 800));
}
await finish();
