// H11 (docs/flows/agent-system.md section 7, Declutter). Part 1 (step 1): archived lines. archive_line {id|find, why?} takes a
// Next or Later line off the State and keeps its text; an edit_line removal of a Later line keeps its text too; a feed row says
// what was archived. Putting a line back is a person's action in the app (restoreLine): checked in the UI part (step 5).
// Later parts are added by the later steps. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, check, finish, launch, login, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'H11 Alpha';
const stateDoc = async () => rawDb.collection('states').findOne({ projectId: P1 });
let P1 = null;
let browser = null;
try {
  const cc = await mkKey({ agent: 'claude-code', name: 'H11 cc' });
  P1 = (await must(cc, 'add_project', { name: P, visibility: 'org' })).project.id;
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

  // ══ Part 2 (step 3): a declutter Need is answered, and the server applies it as the person who answered ══
  // The Need is made through the data layer here (an approve Need, then given its declutter data and the fixed options), as the
  // MCP tool arrives in step 4. The answer is the person's tap in the app, as in life.
  const P2name = 'H11 Beta';
  const P2 = (await must(cc, 'add_project', { name: P2name, visibility: 'org' })).project.id;
  const old = new Date(Date.now() - 40 * 86_400_000);
  await must(cc, 'save_state', { project: P2name, ops: [{ op: 'add_next', text: 'Beta next stale' }, { op: 'add_later', text: 'Beta later to archive' }, { op: 'add_later', text: 'Beta later to keep' }, { op: 'add_later', text: 'Beta later to archive too', waits_on: 'Akash' }] });
  const st2 = await rawDb.collection('states').findOne({ projectId: P2 });
  const lid = t => [...st2.next, ...st2.later].find(l => l.text === t).id;
  const mkNote = async (proj, title, body) => (await must(cc, 'write_note', { project: proj, title, body })).created.id;
  const nOld = await mkNote(P2name, 'Beta plan', 'old copy');
  const nNew = await mkNote(P2name, 'Beta plan', 'new copy');
  await rawDb.collection('notes').updateOne({ _id: nOld }, { $set: { updatedAt: old } });
  const nOther = await mkNote(P, 'Alpha elsewhere', 'a page in another project');
  const tDone = (await must(cc, 'add_task', { title: 'H11 task at 100', project: P2name })).created;
  const tOther = (await must(cc, 'add_task', { title: 'H11 task in Alpha', project: P })).created;
  await rawDb.collection('tasks').updateMany({ ref: { $in: [tDone.ref, tOther.ref] } }, { $set: { progress: 100, status: 'In Progress' } });
  const oldNeed = (await must(cc, 'ask', { project: P2name, to: 'me', kind: 'decide', ask: 'H11 an old question', options: [{ label: 'A' }, { label: 'B' }] })).need;
  await rawDb.collection('needs').updateOne({ ref: oldNeed.ref }, { $set: { createdAt: old } });
  const WHY = 'This item exists for the declutter flow test. It says what and where in enough words to pass the clarity rule.';
  const DONE = 'The declutter test finds this item moved into a task.';
  const addItem = async (title, extra = {}) => {
    const r = await must(cc, 'update_claude_items', { project: P2name, ops: [{ op: 'add', project: P2name, kind: 'bug', title, why: WHY, done_when: DONE, ...extra }] });
    return r;
  };
  await addItem('H11 item that becomes a task');
  await addItem('H11 idea that becomes a Later line', { kind: 'idea', why: 'An idea for later, kept in the declutter test and moved by it. It has a second sentence that stays out.' });
  const itemOf = async title => rawDb.collection('claudeItems').findOne({ title });
  const iTask = await itemOf('H11 item that becomes a task');
  const iIdea = await itemOf('H11 idea that becomes a Later line');
  check('H11 setup: the two Claude items exist and are open', iTask?.state === 'queued' && iIdea?.state === 'queued', JSON.stringify([iTask?.state, iIdea?.state]));

  const items = [
    { id: `later:${lid('Beta later to archive')}`, kind: 'archive_line', text: 'Beta later to archive', why: 'stale', target: lid('Beta later to archive') },
    { id: `later:${lid('Beta later to archive too')}`, kind: 'archive_line', text: 'Beta later to archive too', why: 'stale', target: lid('Beta later to archive too') },
    { id: `next:${lid('Beta next stale')}`, kind: 'archive_line', text: 'Beta next stale', why: 'stale', target: lid('Beta next stale') },
    { id: 'later:l_gone0001', kind: 'archive_line', text: 'A line that is gone already', why: 'x', target: 'l_gone0001' },
    { id: `note:${nOld}`, kind: 'archive_note', text: '"Beta plan"', why: 'older of two', target: nOld },
    { id: `note:${nOther}`, kind: 'archive_note', text: '"Alpha elsewhere"', why: 'a page of another project pasted in', target: nOther },
    { id: `task:${tDone.ref}`, kind: 'complete_task', text: `#${tDone.ref} H11 task at 100`, why: 'at 100', target: String(tDone.ref) },
    { id: `task:${tOther.ref}`, kind: 'complete_task', text: `#${tOther.ref} H11 task in Alpha`, why: 'a task of another project pasted in', target: String(tOther.ref) },
    { id: `need:${oldNeed.ref}`, kind: 'withdraw_need', text: `#${oldNeed.ref} an old question`, why: 'open 40 days', target: String(oldNeed.ref) },
    { id: `item:C${iTask.ref}`, kind: 'item_to_task', text: iTask.title, why: 'becomes a task', target: `C${iTask.ref}` },
    { id: `item:C${iIdea.ref}`, kind: 'item_to_later', text: 'H11 idea that becomes a Later line: An idea for later, kept in the declutter test and moved by it.', why: 'idea', target: `C${iIdea.ref}`, waits: 'Akash: needs a key' },
    { id: 'add:1', kind: 'add_later', text: 'Added Later line from the session', why: 'added by the session' },
    { id: 'add:2', kind: 'add_task', text: 'Added task from the session', why: 'added by the session' },
  ];
  // The Need as an agent's ask leaves it: approve, to the owner; then the server's fixed options and the declutter data.
  const mkDeclutterNeed = async (projectName, its, ask) => {
    const n = (await must(cc, 'ask', { project: projectName, to: 'me', kind: 'approve', ask })).need;
    await rawDb.collection('needs').updateOne({ ref: n.ref }, { $set: { options: [{ id: 'yes', label: 'Yes, apply', means: 'x' }, { id: 'no', label: 'No', means: 'x' }], declutter: { items: its, disk: ['remove worktree wos-s2 (merged)'] }, noAlert: true } });
    const pid = (await rawDb.collection('projects').findOne({ name: projectName }))._id;
    await rawDb.collection('states').updateOne({ projectId: pid }, { $set: { 'declutter.needId': (await rawDb.collection('needs').findOne({ ref: n.ref }))._id, 'declutter.needRef': n.ref } });
    return n.ref;
  };
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await login(page, { phone: false, next: '/needs' });
  const answerUI = async (ref, option) => {
    await page.goto(`${B}/needs`);
    const btn = page.locator(`[data-need="${ref}"] [data-need-option="${option}"]`);
    await btn.waitFor({ timeout: 20000 });
    await btn.click();
    await page.waitForFunction(r => !document.querySelector(`[data-need="${r}"] [data-need-option]`), ref, { timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
  };

  const ref1 = await mkDeclutterNeed(P2name, items, 'Declutter H11 Beta: 13 changes');
  await answerUI(ref1, 'yes');
  const nd = await rawDb.collection('needs').findOne({ ref: ref1 });
  const res = nd.declutter?.result ?? { applied: [], failed: [] };
  check('H11 apply: the Need is answered Yes by the person (app), with a result stored on it', nd.status === 'answered' && nd.answer?.option === 'yes' && nd.answer?.by === ME.userId && nd.answer?.via === 'app' && !!nd.declutter?.result, JSON.stringify([nd.status, nd.answer, nd.declutter?.result]));
  check('H11 apply: 11 applied, the two items from another project fail as not found', res.applied.length === 11 && res.failed.length === 2 && res.failed.every(f => /not found/.test(f)) && res.failed.some(f => f.startsWith(`note:${nOther}`)) && res.failed.some(f => f.startsWith(`task:${tOther.ref}`)), JSON.stringify(res));
  const s2 = await rawDb.collection('states').findOne({ projectId: P2 });
  check('H11 apply: the two Later lines and the Next line are archived with their text, waits on kept', ['Beta later to archive', 'Beta later to archive too', 'Beta next stale'].every(t => s2.archived?.some(a => a.text === t)) && s2.archived.find(a => a.text === 'Beta later to archive too').waitsOn === 'Akash' && !s2.later.some(l => l.text === 'Beta later to archive') && !s2.next.some(l => l.text === 'Beta next stale'), JSON.stringify(s2.archived));
  check('H11 apply: "Beta later to keep" is untouched', s2.later.some(l => l.text === 'Beta later to keep'));
  check('H11 apply: the session\'s add_later became a Later line', s2.later.some(l => l.text === 'Added Later line from the session'));
  const noteOld = await rawDb.collection('notes').findOne({ _id: nOld });
  const noteNew = await rawDb.collection('notes').findOne({ _id: nNew });
  check('H11 apply: the older note is archived (not deleted), the newer one stays', noteOld.archived === true && !noteOld.deletedAt && noteNew.archived === false, JSON.stringify([noteOld.archived, noteOld.deletedAt]));
  check('H11 apply: a note of another project is left alone', (await rawDb.collection('notes').findOne({ _id: nOther })).archived === false);
  const taskD = await rawDb.collection('tasks').findOne({ ref: tDone.ref });
  check('H11 apply: the task at 100 is Done, closed by the person (not the agent)', taskD.status === 'Done' && taskD.doneBy?.kind === 'user' && taskD.doneBy?.userId === ME.userId, JSON.stringify(taskD.doneBy));
  check('H11 apply: a task of another project is left open', (await rawDb.collection('tasks').findOne({ ref: tOther.ref })).status === 'In Progress');
  const addedTask = await rawDb.collection('tasks').findOne({ title: 'Added task from the session' });
  check('H11 apply: the session\'s add_task became a task in the project, P3', addedTask?.projectId === P2 && addedTask.priority === 'P3', JSON.stringify(addedTask && [addedTask.projectId, addedTask.priority]));
  const needNow = await rawDb.collection('needs').findOne({ ref: oldNeed.ref });
  check('H11 apply: the old Need is withdrawn (status kept as a record), not deleted', needNow.status === 'withdrawn' && needNow.withdrawnReason === 'declutter', JSON.stringify([needNow.status, needNow.withdrawnReason]));
  const iT = await rawDb.collection('claudeItems').findOne({ _id: iTask._id });
  const migrated = await rawDb.collection('tasks').findOne({ title: iTask.title, tags: 'from-claude-item' });
  check('H11 apply: the Claude item becomes a P3 task tagged from-claude-item with done-when in it, and the item is dropped with movedTo', iT.state === 'dropped' && migrated?.priority === 'P3' && iT.movedTo === `#${migrated.ref}` && /Done when:/.test(migrated.description) && migrated.projectId === P2, JSON.stringify([iT.state, iT.movedTo, migrated && [migrated.ref, migrated.priority]]));
  const iI = await rawDb.collection('claudeItems').findOne({ _id: iIdea._id });
  const ideaLine = s2.later.find(l => l.text.startsWith('H11 idea that becomes a Later line'));
  check('H11 apply: the idea becomes a Later line waiting on what the item waited on, and the item points at it', iI.state === 'dropped' && ideaLine?.waitsOn === 'Akash: needs a key' && iI.movedTo === `later:${ideaLine.id}`, JSON.stringify([iI.state, iI.movedTo, ideaLine]));
  check('H11 quiet: quietUntil is about 14 days out and the State no longer names the Need', s2.declutter?.quietUntil && Math.abs(s2.declutter.quietUntil.getTime() - Date.now() - 14 * 86_400_000) < 3_600_000 && !s2.declutter.needId && !s2.declutter.needRef, JSON.stringify(s2.declutter));
  const feedRows = await rawDb.collection('activity').find({ type: 'declutter_applied', projectId: P2 }).toArray();
  check('H11 feed: one declutter_applied row, "11 changes applied, 2 failed"', feedRows.length === 1 && /11 changes applied, 2 failed/.test(feedRows[0].note ?? ''), JSON.stringify(feedRows.map(r => r.note)));
  const act2 = await must(cc, 'recent_activity', { since: '1d', limit: 200 });
  check('H11 feed: declutter_applied is in recent_activity', (act2.events ?? []).some(e => e.type === 'declutter_applied'), '');

  // No: nothing is applied, the project goes quiet
  const ref2 = await mkDeclutterNeed(P2name, [{ id: `later:${lid('Beta later to keep')}`, kind: 'archive_line', text: 'Beta later to keep', why: 'x', target: lid('Beta later to keep') }], 'Declutter H11 Beta: 1 change');
  await rawDb.collection('states').updateOne({ projectId: P2 }, { $unset: { 'declutter.quietUntil': '' } });
  await answerUI(ref2, 'no');
  const s2b = await rawDb.collection('states').findOne({ projectId: P2 });
  const nd2 = await rawDb.collection('needs').findOne({ ref: ref2 });
  check('H11 No: the line stays, no result is stored, the Need says No', s2b.later.some(l => l.text === 'Beta later to keep') && nd2.answer?.option === 'no' && !nd2.declutter?.result, JSON.stringify(nd2.answer));
  check('H11 No: the project is quiet for 14 days and the Need is no longer open on the State', s2b.declutter?.quietUntil && !s2b.declutter.needId, JSON.stringify(s2b.declutter));

  // Withdrawn by the asker: the State stops naming it
  const ref3 = await mkDeclutterNeed(P2name, [{ id: 'add:1', kind: 'add_later', text: 'never applied', why: 'x' }], 'Declutter H11 Beta: 1 change');
  const w = await mcpH(cc, 'withdraw_need', { id: ref3 });
  const s2c = await rawDb.collection('states').findOne({ projectId: P2 });
  check('H11 withdraw: the State no longer names the withdrawn declutter Need', !w.isError && !s2c.declutter?.needId && !s2c.declutter?.needRef, w.text.slice(0, 200) + JSON.stringify(s2c.declutter));
  void randomUUID;
} catch (e) {
  check('flow-h11 (error)', false, e?.stack || String(e));
}
if (browser) await browser.close().catch(() => {});
await finish();
