// H11 (docs/flows/agent-system.md section 7, Declutter). Part 1 (step 1): archived lines. archive_line {id|find, why?} takes a
// Next or Later line off the State and keeps its text; an edit_line removal of a Later line keeps its text too; a feed row says
// what was archived. Putting a line back is a person's action in the app (restoreLine): checked in the UI part (step 5).
// Later parts are added by the later steps. Seed profile: none.
import { check, finish, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'H11 Alpha';
const stateDoc = async () => rawDb.collection('states').findOne({});
try {
  const cc = await mkKey({ agent: 'claude-code', name: 'H11 cc' });
  await must(cc, 'add_project', { name: P, visibility: 'org' });
  const save = (ops, extra = {}) => mcpH(cc, 'save_state', { project: P, ops, ...extra });
  const seed = await save([
    { op: 'set_now', text: 'Declutter' },
    { op: 'add_next', text: 'Next one to keep' },
    { op: 'add_next', text: 'Next two to archive' },
    { op: 'add_later', text: 'Later A to archive by id', waits_on: 'Akash' },
    { op: 'add_later', text: 'Later B to remove with edit_line' },
    { op: 'add_later', text: 'Later C to archive by find' },
    { op: 'add_later', text: 'Later D stays' },
  ], { base_version: 0 });
  check('H11 setup: the State is saved', !seed.isError, seed.text.slice(0, 200));
  let st = await stateDoc();
  check('H11 setup: no archived lines yet', !st.archived || st.archived.length === 0, JSON.stringify(st.archived));
  const idOf = (list, t) => st[list].find(l => l.text.includes(t)).id;

  // archive_line by id (a Later line that waits on someone)
  const aId = idOf('later', 'Later A');
  const r1 = await save([{ op: 'archive_line', id: aId, why: 'superseded' }]);
  st = await stateDoc();
  const a = (st.archived ?? []).find(x => x.id === aId);
  check('H11 archive_line: the Later line leaves Later', !r1.isError && !st.later.some(l => l.id === aId) && st.later.length === 3, r1.text.slice(0, 200));
  check('H11 archive_line: text, waits on, from, why and who are kept', a && a.text === 'Later A to archive by id' && a.waitsOn === 'Akash' && a.from === 'Later' && a.why === 'superseded' && a.archivedBy && a.by && a.archivedAt && a.at, JSON.stringify(a));

  // archive_line by find, a Next line
  const r2 = await save([{ op: 'archive_line', find: 'Next two' }]);
  st = await stateDoc();
  const n2 = (st.archived ?? []).find(x => x.text === 'Next two to archive');
  check('H11 archive_line: find works on a Next line, which goes to archived as from Next', !r2.isError && n2?.from === 'Next' && st.next.length === 1 && st.next[0].text === 'Next one to keep', r2.text.slice(0, 200) + JSON.stringify(st.next));

  // archive_line by find, a Later line; and a find that matches nothing or an unknown id is refused, nothing written
  const v0 = st.version;
  const bad1 = await save([{ op: 'archive_line', find: 'no such text anywhere' }]);
  const bad2 = await save([{ op: 'archive_line', id: 'l_nonexistent' }]);
  const bad3 = await save([{ op: 'archive_line' }]);
  st = await stateDoc();
  check('H11 archive_line: no match, unknown id and no id are refused with nothing written', bad1.isError && bad2.isError && bad3.isError && st.version === v0 && /no line l_nonexistent/.test(bad2.text) && /needs id or find/.test(bad3.text), [bad1.text, bad2.text, bad3.text].map(t => t.slice(0, 120)).join(' | '));
  const r3 = await save([{ op: 'archive_line', find: 'Later C' }]);
  st = await stateDoc();
  check('H11 archive_line: find works on a Later line', !r3.isError && (st.archived ?? []).some(x => x.text === 'Later C to archive by find') && st.version === v0 + 1, r3.text.slice(0, 200));

  // edit_line removal of a Later line keeps the text
  const r4 = await save([{ op: 'edit_line', find: 'Later B to remove with edit_line', new: '' }]);
  st = await stateDoc();
  const b = (st.archived ?? []).find(x => x.text === 'Later B to remove with edit_line');
  check('H11 edit_line: removing a Later line archives it with its text', !r4.isError && b?.from === 'Later' && !st.later.some(l => l.text.includes('Later B')), r4.text.slice(0, 200) + JSON.stringify(b));
  // edit_line removal of a Next line is still done (not archived), as before
  await save([{ op: 'add_next', text: 'Next three to finish' }]);
  const r5 = await save([{ op: 'edit_line', find: 'Next three to finish', new: '' }]);
  st = await stateDoc();
  check('H11 edit_line: removing a Next line still counts as done and is not archived', !r5.isError && !(st.archived ?? []).some(x => x.text.includes('Next three')), r5.text.slice(0, 200));
  check('H11 State: Later D and Next one are untouched', st.later.some(l => l.text === 'Later D stays') && st.next.some(l => l.text === 'Next one to keep'));

  // the feed
  const act = await must(cc, 'recent_activity', { since: '1d', limit: 100 });
  const rows = (act.events ?? []).filter(x => x.type === 'line_archived');
  check('H11 feed: one line_archived row per archived line (4)', rows.length === 4, JSON.stringify(act).slice(0, 400));
  check('H11 feed: the row says which list and keeps the text', rows.some(x => /Later line: Later A to archive by id/.test(JSON.stringify(x))) && rows.some(x => /Next line: Next two to archive/.test(JSON.stringify(x))), JSON.stringify(rows).slice(0, 400));

  // the log keeps the id of an archived line; the State out (get_state) does not break
  const gs = await mcpH(cc, 'get_state', { project: P });
  check('H11 get_state: still answers with the archive in place', !gs.isError, gs.text.slice(0, 200));

  // the cap: the newest 300 stay
  const bulk = [];
  for (let i = 0; i < 12; i++) bulk.push({ op: 'add_later', text: `bulk line ${i}` });
  await save(bulk);
  st = await stateDoc();
  const ids = st.later.filter(l => l.text.startsWith('bulk line')).map(l => l.id);
  const r6 = await save(ids.map(id => ({ op: 'archive_line', id })));
  st = await stateDoc();
  check('H11 archive_line: several in one call all land, newest last', !r6.isError && st.archived.length === 16 && st.archived.at(-1).text === 'bulk line 11', r6.text.slice(0, 200) + st.archived?.length);
} catch (e) {
  check('flow-h11 (error)', false, e?.stack || String(e));
}
await finish();
