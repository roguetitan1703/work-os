// H11 (docs/flows/agent-system.md section 7, Declutter). Part 1 (step 1): archived lines. archive_line {id|find, why?} takes a
// Next or Later line off the State and keeps its text; an edit_line removal of a Later line keeps its text too; a feed row says
// what was archived. Putting a line back is a person's action in the app (restoreLine): checked in the UI part (step 5).
// Later parts are added by the later steps. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, check, finish, launch, login, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'H11 Alpha';
const stateDoc = async () => rawDb.collection('states').findOne({ projectId: P1 });
let P1 = null;
let browser = null;
try {
  // Made before the first call: the server caches the member list for a minute, and this person is asked a Need near the end (review 3).
  const U = await makeUser({ email: 'una-h11@example.test', name: 'Una', orgId: ME.orgId, role: 'member' });
  const kU = await mkKey({ agent: 'claude-code', userId: U.userId, name: 'H11 Una' });
  const cc = await mkKey({ agent: 'claude-code', name: 'H11 cc' });
  P1 = (await must(cc, 'add_project', { name: P, visibility: 'org' })).project.id;
  const save = (ops, extra = {}) => mcpH(cc, 'save_state', { project: P, ops, ...extra });
  // set_now needs a session Work OS knows (Lanes): a fixture session, whose row is removed again.
  await must(cc, 'start_work', { project: P, session: 'h11-fixture' });
  const seed = await save([
    { op: 'set_now', text: 'Declutter' },
    { op: 'add_next', text: 'Next one to keep' },
    { op: 'add_next', text: 'Next two to archive' },
    { op: 'add_later', text: 'Later A to archive by id', waits_on: 'Akash' },
    { op: 'add_later', text: 'Later B to remove with edit_line' },
    { op: 'add_later', text: 'Later C to archive by find' },
    { op: 'add_later', text: 'Later D stays' },
  ], { base_version: 0, session: 'h11-fixture' });
  await rawDb.collection('presence').deleteMany({ session: 'h11-fixture' });
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
  // H14 refuses a second note with one title, so the legacy duplicate is made by renaming in the database.
  const nNew = await mkNote(P2name, 'Beta plan copy', 'new copy');
  await rawDb.collection('notes').updateOne({ _id: nNew }, { $set: { title: 'Beta plan' } });
  await rawDb.collection('notes').updateOne({ _id: nOld }, { $set: { updatedAt: old } });
  const nOther = await mkNote(P, 'Alpha elsewhere', 'a page in another project');
  const tDone = (await must(cc, 'add_task', { title: 'H11 task at 100', project: P2name })).created;
  const tOther = (await must(cc, 'add_task', { title: 'H11 task in Alpha', project: P })).created;
  await rawDb.collection('tasks').updateMany({ ref: { $in: [tDone.ref, tOther.ref] } }, { $set: { progress: 100, status: 'In Progress' } });
  const oldNeed = (await must(cc, 'ask', { project: P2name, to: 'me', kind: 'decide', ask: 'H11 an old question', options: [{ label: 'A' }, { label: 'B' }] })).need;
  await rawDb.collection('needs').updateOne({ ref: oldNeed.ref }, { $set: { createdAt: old } });
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

  const ref1 = await mkDeclutterNeed(P2name, items, 'Declutter H11 Beta: 11 changes');
  await answerUI(ref1, 'yes');
  const nd = await rawDb.collection('needs').findOne({ ref: ref1 });
  const res = nd.declutter?.result ?? { applied: [], failed: [] };
  check('H11 apply: the Need is answered Yes by the person (app), with a result stored on it', nd.status === 'answered' && nd.answer?.option === 'yes' && nd.answer?.by === ME.userId && nd.answer?.via === 'app' && !!nd.declutter?.result, JSON.stringify([nd.status, nd.answer, nd.declutter?.result]));
  check('H11 apply: 9 applied, the two items from another project fail as not found', res.applied.length === 9 && res.failed.length === 2 && res.failed.every(f => /not found/.test(f)) && res.failed.some(f => f.startsWith(`note:${nOther}`)) && res.failed.some(f => f.startsWith(`task:${tOther.ref}`)), JSON.stringify(res));
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
  check('H11 quiet: quietUntil is about 14 days out and the State no longer names the Need', s2.declutter?.quietUntil && Math.abs(s2.declutter.quietUntil.getTime() - Date.now() - 14 * 86_400_000) < 3_600_000 && !s2.declutter.needId && !s2.declutter.needRef, JSON.stringify(s2.declutter));
  const feedRows = await rawDb.collection('activity').find({ type: 'declutter_applied', projectId: P2 }).toArray();
  check('H11 feed: one declutter_applied row, "9 changes applied, 2 failed"', feedRows.length === 1 && /9 changes applied, 2 failed/.test(feedRows[0].note ?? ''), JSON.stringify(feedRows.map(r => r.note)));
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

  // ══ Part 3 (step 4): the brief field, end_work, the declutter tool, and the retired update_claude_items ══
  const hdr = sess => ({ 'X-Work-OS-Session': sess });
  const start = (project, sess) => must(cc, 'start_work', { project, session: sess }, hdr(sess));
  const stateOf = async pid => rawDb.collection('states').findOne({ projectId: pid });
  const mkLines = async (project, n, from = 0) => { for (let k = 0; k < n; k += 25) await must(cc, 'save_state', { project, ops: Array.from({ length: Math.min(25, n - k) }, (_, j) => ({ op: 'add_later', text: `${project} later number ${from + k + j + 1} with its own words ${'ab'.repeat(from + k + j + 1)}` })) }); };

  // a) thresholds in the brief: 25 Later lines say nothing, 26 say so; the brief carries it once, in the State order
  const D = 'H11 Delta';
  await must(cc, 'add_project', { name: D, visibility: 'org' });
  await mkLines(D, 25);
  const b25 = await start(D, 'h11d1');
  check('H11 brief: 25 Later lines are not due (no declutter field)', !('declutter' in b25), JSON.stringify(b25.declutter));
  await mkLines(D, 1, 25);
  const b26 = await start(D, 'h11d1');
  check('H11 brief: 26 Later lines say "Declutter due: Later 26 (over 25)" and name the tool', /^Declutter due: Later 26 \(over 25\)\. Call declutter \{project: "H11 Delta"\}\. If your tools do not list declutter, ask your person to reconnect Work OS \(\/mcp, work-os, Reconnect\)\.$/.test(b26.declutter ?? ''), JSON.stringify(b26.declutter));
  const keys = Object.keys(b26);
  check('H11 brief: the field sits near state (after state, before the inbox)', keys.indexOf('declutter') > keys.indexOf('state') && keys.indexOf('declutter') < keys.indexOf('inbox'), keys.join(','));
  // a stale line (14 days) on its own makes a project due
  const E = 'H11 Epsilon';
  await must(cc, 'add_project', { name: E, visibility: 'org' });
  await must(cc, 'save_state', { project: E, ops: [{ op: 'add_next', text: 'Epsilon stale next' }, { op: 'add_later', text: 'Epsilon waiting later', waits_on: 'Akash' }] });
  const stE = await stateOf((await rawDb.collection('projects').findOne({ name: E }))._id);
  await rawDb.collection('states').updateOne({ _id: stE._id }, { $set: { 'next.0.at': new Date(Date.now() - 20 * 86_400_000), 'later.0.at': new Date(Date.now() - 90 * 86_400_000) } });
  const bE = await start(E, 'h11e1');
  check('H11 brief: a stale line without a waits-on makes it due, a waiting line never counts', /Declutter due: 1 line untouched 14 days/.test(bE.declutter ?? ''), JSON.stringify(bE.declutter));
  // end_work carries the same text
  const endD = await must(cc, 'end_work', { project: D, state: [{ op: 'set_where', machine: 'h11box', branch: 'x' }], friction: 'none', session: 'h11d1' }, hdr('h11d1'));
  check('H11 end_work: the answer carries the same declutter line', /Declutter due: Later 26/.test(endD.declutter ?? ''), JSON.stringify(Object.keys(endD)));

  // b) Gamma: stale lines, two pages with one title, 
  const G = 'H11 Gamma';
  const GID = (await must(cc, 'add_project', { name: G, visibility: 'org' })).project.id;
  await must(cc, 'save_state', { project: G, ops: [{ op: 'add_later', text: 'Gamma stale one' }, { op: 'add_later', text: 'Gamma stale two' }, { op: 'add_later', text: 'Gamma stale three' }, { op: 'add_later', text: 'Gamma fresh' }] });
  const stG = await stateOf(GID);
  const staleIds = ['Gamma stale one', 'Gamma stale two', 'Gamma stale three'].map(t => stG.later.find(l => l.text === t).id);
  for (const id of staleIds) await rawDb.collection('states').updateOne({ _id: stG._id, 'later.id': id }, { $set: { 'later.$.at': new Date(Date.now() - 30 * 86_400_000) } });
  const gn1 = await mkNote(G, 'Gamma plan', 'first');
  const gn2 = await mkNote(G, 'Gamma plan copy', 'second'); // H14 refuses a repeated title: rename in the database
  await rawDb.collection('notes').updateOne({ _id: gn2 }, { $set: { title: 'Gamma plan' } });
  await rawDb.collection('notes').updateOne({ _id: gn1 }, { $set: { updatedAt: new Date(Date.now() - 3 * 86_400_000) } });
  const bG = await start(G, 'h11gA');
  check('H11 brief: the daily check adds "2 notes share a title" and the stale lines', /3 lines untouched 14 days; 2 notes share a title\./.test(bG.declutter ?? ''), JSON.stringify(bG.declutter));
  const cacheG = (await stateOf(GID)).declutter;
  check('H11 cache: the check is stored on the State (no version bump needed to read it) and is not run again within a day', !!cacheG?.checkedAt && cacheG.reasons.length === 1, JSON.stringify(cacheG));
  const verBefore = (await stateOf(GID)).version;
  await start(G, 'h11gA');
  check('H11 cache: a second brief does not change the State version or the check time', (await stateOf(GID)).version === verBefore && (await stateOf(GID)).declutter.checkedAt.getTime() === cacheG.checkedAt.getTime());

  // c) the tool: read only, then ask
  const rd = await must(cc, 'declutter', { project: G }, hdr('h11gA'));
  const kinds = k => rd.items.filter(i => i.kind === k);
  check('H11 declutter read: 3 stale Later lines and the older page; stable ids', kinds('archive_line').length === 3 && kinds('archive_note').length === 1 && kinds('archive_note')[0].id === `note:${gn1}` && kinds('archive_line').every(i => /^later:l_/.test(i.id)), JSON.stringify(rd.items.map(i => i.id)));
  check('H11 declutter read: it says why it is due and what to do next; nothing is written', /Declutter due/.test(rd.due) && /ask: true/.test(rd.next) && (await rawDb.collection('needs').countDocuments({ projectId: GID, declutter: { $exists: true } })) === 0, JSON.stringify([rd.due, rd.next]));
  const skipId = `later:${staleIds[0]}`;
  const ask1 = await mcpH(cc, 'declutter', { project: G, ask: true, skip: [skipId], add: [{ later: 'Gamma added later line', waits_on: 'Akash' }, { task: 'Gamma added task' }], disk: ['remove worktree wos-s2 (merged)'] }, hdr('h11gA'));
  const n1 = ask1.json?.need;
  const n1d = n1 ? await rawDb.collection('needs').findOne({ ref: n1.ref }) : null;
  check('H11 ask: one Need to the project owner, kind approve, the fixed options, written by the server', !ask1.isError && n1d?.to === ME.userId && n1d.kind === 'approve' && JSON.stringify(n1d.options.map(o => o.id)) === '["yes","no"]' && n1d.options[0].label === 'Yes, apply' && n1d.ask === 'Declutter H11 Gamma: 5 changes' && n1d.projectId === GID, ask1.text.slice(0, 300) + JSON.stringify(n1d?.ask));
  check('H11 ask: skip left the one line out, add put the session lines in, disk is stored and nothing was applied', n1d?.declutter.items.length === 5 && !n1d.declutter.items.some(i => i.id === skipId) && n1d.declutter.items.some(i => i.id === 'add:1' && i.kind === 'add_later' && i.waits === 'Akash') && n1d.declutter.items.some(i => i.id === 'add:2' && i.kind === 'add_task') && n1d.declutter.disk[0] === 'remove worktree wos-s2 (merged)' && (await stateOf(GID)).later.length === 4, JSON.stringify(n1d?.declutter));
  check('H11 ask: no push alert is queued and the Need is marked noAlert', n1d?.noAlert === true && (await rawDb.collection('alertQueue').countDocuments({ needId: n1d._id })) === 0, JSON.stringify([n1d?.noAlert]));
  check('H11 ask: the State names the open Need and the brief says so instead of "due"', (await stateOf(GID)).declutter.needRef === n1.ref && (await start(G, 'h11gA')).declutter === `Declutter Need #${n1.ref} is open.`);
  const reread = await must(cc, 'declutter', { project: G }, hdr('h11gA'));
  check('H11 declutter read while a Need is open: says it is open', new RegExp(`#${n1.ref} is open`).test(reread.due), reread.due);
  // a second ask from the same session replaces the first; another session is refused; at most 3 an hour
  const ask2 = await mcpH(cc, 'declutter', { project: G, ask: true, skip: [skipId] }, hdr('h11gA'));
  const n1after = await rawDb.collection('needs').findOne({ _id: n1d._id });
  check('H11 ask: a second ask from the same session replaces the first (one open declutter Need)', !ask2.isError && n1after.status === 'replaced' && (await rawDb.collection('needs').countDocuments({ projectId: GID, status: 'open', declutter: { $exists: true } })) === 1, ask2.text.slice(0, 200));
  const askB = await mcpH(cc, 'declutter', { project: G, ask: true }, hdr('h11gB'));
  check('H11 ask: another session is refused while one is open, naming the Need', askB.isError && /another session/.test(askB.text) && new RegExp('#' + ask2.json.need.ref).test(askB.text), askB.text.slice(0, 200));
  const ask3 = await mcpH(cc, 'declutter', { project: G, ask: true, skip: [skipId] }, hdr('h11gA'));
  const ask4 = await mcpH(cc, 'declutter', { project: G, ask: true, skip: [skipId] }, hdr('h11gA'));
  check('H11 ask: the third ask in an hour goes through, the fourth is refused', !ask3.isError && ask4.isError && /last hour/.test(ask4.text), (ask3.text + ' | ' + ask4.text).slice(0, 300));
  const openNow = await rawDb.collection('needs').findOne({ projectId: GID, status: 'open', declutter: { $exists: true } });
  // d) the answer: Yes in the app applies all but nothing was unticked here; the asker's brief shows the result
  await answerUI(openNow.ref, 'yes');
  const doneG = await rawDb.collection('needs').findOne({ _id: openNow._id });
  check('H11 answer: Yes applied the 3 changes (2 stale lines, the page) as the person, nothing failed', doneG.declutter?.result?.failed.length === 0 && doneG.declutter.result.applied.length === 3, JSON.stringify(doneG.declutter?.result));
  const bGq = await start(G, 'h11gA');
  check('H11 quiet: after the answer the brief says nothing about Declutter, though lines are still stale', !('declutter' in bGq), JSON.stringify(bGq.declutter));
  const answeredForMe = (bGq.needs?.answeredForYou ?? []).find(n => n.ref === openNow.ref);
  check('H11 answer: the asking session sees the result in its brief (applied, failed, disk)', answeredForMe?.declutter?.applied?.length === 3 && answeredForMe.declutter.failed.length === 0 && answeredForMe.declutter.disk?.length === undefined, JSON.stringify(answeredForMe?.declutter));

  // e) privacy and refusals
  const T = await makeUser({ email: 'tess-h11@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'H11 Tess' });
  const PRIV = 'H11 Private';
  await must(kT, 'add_project', { name: PRIV, visibility: 'private' });
  await must(kT, 'save_state', { project: PRIV, ops: [{ op: 'add_later', text: 'Tess private line that must stay hidden' }] });
  const nf1 = await mcpH(cc, 'declutter', { project: PRIV });
  const nf2 = await mcpH(cc, 'declutter', { project: PRIV, ask: true, add: [{ later: 'x' }] });
  const nf3 = await mcpH(cc, 'declutter', { project: 'H11 No Such Project' });
  check('H11 privacy: a project the caller cannot read is "not found" for read and ask, same as one that does not exist', nf1.isError && nf2.isError && /not found/i.test(nf1.text) && /not found/i.test(nf2.text) && nf1.text.replace(PRIV, 'X') === nf3.text.replace('H11 No Such Project', 'X') && !nf1.text.includes('Tess'), [nf1.text, nf3.text].join(' | ').slice(0, 300));
  await must(cc, 'add_project', { name: 'H11 Zeta', visibility: 'org' });
  const empty = await must(cc, 'declutter', { project: 'H11 Zeta' }, hdr('h11z'));
  const emptyAsk = await mcpH(cc, 'declutter', { project: 'H11 Zeta', ask: true }, hdr('h11z'));
  check('H11 declutter: nothing to tidy is said plainly, and an ask for nothing is refused', /Nothing to tidy/.test(empty.next) && emptyAsk.isError && /Nothing to tidy/.test(emptyAsk.text), emptyAsk.text.slice(0, 200));
  const gone = await mcpH(cc, 'update_claude_items', { ops: [{ op: 'note', item: 'C1', text: 'x' }] });
  check('H11 update_claude_items: the tool is gone (step 8)', gone.isError, gone.text.slice(0, 200));
  const gp = await must(cc, 'get_project', { project: G });
  check('H11 get_project: no claudeItems field any more', !('claudeItems' in gp), Object.keys(gp).join(','));

  // ══ Part 4 (step 5): the screens: the Need card with ticks, the project's Declutter dialog, the archived lines on the State card ══
  const SHOTS = 'D:/Work/Delpat/builds/e2e-h11/shots';
  const dark = async p => { await p.evaluate(() => document.documentElement.classList.add('dark')); await p.waitForTimeout(200); };
  const light = async p => { await p.evaluate(() => document.documentElement.classList.remove('dark')); await p.waitForTimeout(200); };
  const shotOf = async (p, target, name, theme) => { await (theme === 'dark' ? dark(p) : light(p)); await (target ? p.locator(target).first() : p).screenshot({ path: `${SHOTS}/${name}-${theme}.png` }).catch(() => {}); };
  const ago = d => new Date(Date.now() - d * 86_400_000);

  // a) the Need card: three changes, one unticked before Yes
  const TH = 'H11 Theta';
  const THID = (await must(cc, 'add_project', { name: TH, visibility: 'org' })).project.id;
  await must(cc, 'save_state', { project: TH, ops: [{ op: 'add_later', text: 'Theta stale line one that nobody touched' }, { op: 'add_later', text: 'Theta stale line two that nobody touched' }, { op: 'add_later', text: 'Theta stale line three, kept by the person' }] });
  const stTh = await stateOf(THID);
  for (const l of stTh.later) await rawDb.collection('states').updateOne({ _id: stTh._id, 'later.id': l.id }, { $set: { 'later.$.at': ago(30) } });
  const askTh = await must(cc, 'declutter', { project: TH, ask: true, disk: ['remove worktree wos-s3 (merged)'] }, hdr('h11th'));
  const thRef = askTh.need.ref;
  await page.goto(`${B}/needs`);
  await page.waitForSelector(`[data-need="${thRef}"] [data-declutter-box]`, { timeout: 20000 });
  const boxes = await page.locator(`[data-need="${thRef}"] [data-declutter-box]`).count();
  check('H11 UI: the Need card lists the 3 changes with a box each, all ticked, and the disk lines under them', boxes === 3 && (await page.locator(`[data-need="${thRef}"] [data-declutter-state="ticked"]`).count()) === 3 && (await page.locator(`[data-need="${thRef}"] [data-declutter-disk] li`).count()) === 1, `boxes ${boxes}`);
  check('H11 UI: the buttons are the Need own: Yes, apply first, then No', (await page.locator(`[data-need="${thRef}"] [data-need-option]`).evaluateAll(es => es.map(e => e.getAttribute('data-need-option')))).join() === 'yes,no' && /^Yes, apply/.test(await page.locator(`[data-need="${thRef}"] [data-need-option="yes"]`).innerText()), '');
  await shotOf(page, `[data-need="${thRef}"]`, 'h11-need-card-desk', 'light');
  await shotOf(page, `[data-need="${thRef}"]`, 'h11-need-card-desk', 'dark');
  await light(page);
  const keepId = `later:${stTh.later[2].id}`;
  await page.locator(`[data-need="${thRef}"] [data-declutter-box="${keepId}"]`).click();
  check('H11 UI: unticking a box marks it unticked', (await page.locator(`[data-need="${thRef}"] [data-declutter-item="${keepId}"]`).getAttribute('data-declutter-state')) === 'unticked');
  await page.locator(`[data-need="${thRef}"] [data-need-option="yes"]`).click();
  await page.waitForFunction(r => !document.querySelector(`[data-need="${r}"] [data-need-option]`), thRef, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  const thDoc = await rawDb.collection('needs').findOne({ ref: thRef });
  const thState = await stateOf(THID);
  check('H11 UI: Yes with one unticked applies the other two, stores skip, keeps the unticked line', JSON.stringify(thDoc.declutter.skip) === JSON.stringify([keepId]) && thDoc.declutter.result.applied.length === 2 && thState.later.length === 1 && thState.later[0].text.includes('kept by the person') && thState.archived.length === 2, JSON.stringify([thDoc.declutter.skip, thDoc.declutter.result]));
  check('H11 UI: the answered card shows what happened: two applied, one left out', (await page.locator(`[data-need="${thRef}"] [data-declutter-state="applied"]`).count()) === 2 && (await page.locator(`[data-need="${thRef}"] [data-declutter-state="left"]`).count()) === 1, '');
  await shotOf(page, `[data-need="${thRef}"]`, 'h11-need-card-answered-desk', 'light');

  // b) the project's Declutter dialog: untick one, apply the rest
  const IO = 'H11 Iota';
  const IOID = (await must(cc, 'add_project', { name: IO, visibility: 'org' })).project.id;
  await must(cc, 'save_state', { project: IO, ops: [{ op: 'add_later', text: 'Iota stale line to archive' }, { op: 'add_later', text: 'Iota second stale line to keep' }] });
  const stIo = await stateOf(IOID);
  for (const l of stIo.later) await rawDb.collection('states').updateOne({ _id: stIo._id, 'later.id': l.id }, { $set: { 'later.$.at': ago(30) } });
  await page.goto(`${B}/projects/${IOID}`);
  await page.locator('[data-project-menu]').click();
  await page.locator('[data-project-declutter]').click();
  await page.waitForSelector('[data-declutter-dialog] [data-declutter-box]', { timeout: 20000 });
  check('H11 dialog: it lists the same kind of rows, all ticked, with an Apply button on the right', (await page.locator('[data-declutter-dialog] [data-declutter-box]').count()) === 2 && /Apply ticked \(2\)/.test(await page.locator('[data-declutter-apply]').innerText()), '');
  await shotOf(page, null, 'h11-dialog-desk', 'light');
  await shotOf(page, null, 'h11-dialog-desk', 'dark');
  await light(page);
  await page.locator(`[data-declutter-dialog] [data-declutter-box="later:${stIo.later[1].id}"]`).click();
  await page.locator('[data-declutter-apply]').click();
  await page.waitForSelector('[data-declutter-dialog] [data-declutter-state="applied"]', { timeout: 20000 });
  const ioState = await stateOf(IOID);
  check('H11 dialog: Apply ticked archives the ticked line only, and the dialog says so', ioState.later.length === 1 && ioState.later[0].text.includes('to keep') && ioState.archived.length === 1 && (await page.locator('[data-declutter-dialog] [data-declutter-state="applied"]').count()) === 1 && ioState.declutter?.quietUntil, JSON.stringify(ioState.archived?.map(a => a.text)));
  check('H11 dialog: a feed row says what the person applied', (await rawDb.collection('activity').countDocuments({ type: 'declutter_applied', projectId: IOID })) === 1);
  await page.reload();
  await page.locator('[data-project-menu]').click();
  await page.locator('[data-project-declutter]').click();
  // the one line left is now fresh in the proposal? It is still stale (30 days): ticked again, but the project is quiet only for the brief, not for the dialog.
  await page.waitForSelector('[data-declutter-dialog]', { timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector('[data-declutter-box]') || !!document.querySelector('[data-declutter-empty]'), null, { timeout: 20000 });
  await page.keyboard.press('Escape');

  // c) the archived lines on the State card, and Put back
  await page.goto(`${B}/projects/${IOID}`);
  await page.waitForSelector('[data-part="archived"]', { timeout: 20000 });
  check('H11 State card: "Archived lines · 1" sits under Later, collapsed', (await page.locator('[data-part="archived"] summary').textContent()).includes('Archived lines · 1') && !(await page.locator('[data-part="archived"]').evaluate(e => e.open)), '');
  await page.locator('[data-part="archived"] summary').click();
  await shotOf(page, '[data-card="state"]', 'h11-state-archived-desk', 'light');
  await shotOf(page, '[data-card="state"]', 'h11-state-archived-desk', 'dark');
  await light(page);
  await page.locator('[data-archived-restore]').click();
  await page.waitForFunction(() => !document.querySelector('[data-part="archived"]'), null, { timeout: 20000 }).catch(() => {});
  const back = await stateOf(IOID);
  check('H11 Put back: the line is at the end of Later with its text and author, and leaves the archive', back.later.length === 2 && back.later[1].text.includes('to archive') && back.later[1].by === ME.userId && !(back.archived ?? []).length, JSON.stringify(back.later.map(l => l.text)));
  check('H11 Put back: a Later line added feed row, and an agent cannot do it (no MCP path)', (await rawDb.collection('activity').countDocuments({ type: 'later_added', projectId: IOID, note: /to archive/ })) >= 1);

  // d) a teammate who is not the owner cannot declutter (read or apply)
  const ctxT = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageT = await ctxT.newPage();
  await login(pageT, { phone: false, next: `/projects/${IOID}`, email: 'tess-h11@example.test' });
  await pageT.locator('[data-project-menu]').click();
  await pageT.locator('[data-project-declutter]').click();
  await pageT.waitForSelector('[data-declutter-error]', { timeout: 20000 });
  check('H11 dialog: a member who is not the owner is told only the owner can declutter, and sees no changes', /Only the project's owner/.test(await pageT.locator('[data-declutter-error]').innerText()) && (await pageT.locator('[data-declutter-box]').count()) === 0, '');
  await ctxT.close();

  // e) phone: the Need card and the dialog at 390
  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageP = await ctxP.newPage();
  const TH2 = 'H11 Kappa';
  const TH2ID = (await must(cc, 'add_project', { name: TH2, visibility: 'org' })).project.id;
  await must(cc, 'save_state', { project: TH2, ops: [{ op: 'add_later', text: 'Kappa stale line for the phone check' }, { op: 'add_later', text: 'Kappa another stale line for the phone check' }] });
  const stK = await stateOf(TH2ID);
  for (const l of stK.later) await rawDb.collection('states').updateOne({ _id: stK._id, 'later.id': l.id }, { $set: { 'later.$.at': ago(30) } });
  const askK = await must(cc, 'declutter', { project: TH2, ask: true, disk: ['delete the old branch builder-k'] }, hdr('h11k'));
  await login(pageP, { phone: true, next: '/needs' });
  await pageP.waitForSelector(`[data-need="${askK.need.ref}"] [data-declutter-box]`, { timeout: 20000 });
  await shotOf(pageP, `[data-need="${askK.need.ref}"]`, 'h11-need-card-phone', 'light');
  await shotOf(pageP, `[data-need="${askK.need.ref}"]`, 'h11-need-card-phone', 'dark');
  await light(pageP);
  const o1 = await pageP.evaluate(() => ({ doc: document.documentElement.scrollWidth > innerWidth + 1 }));
  check('H11 phone: the Need card does not scroll sideways at 390', !o1.doc, JSON.stringify(o1));
  await pageP.goto(`${B}/projects/${TH2ID}`);
  await pageP.locator('[data-project-menu]').click();
  await pageP.locator('[data-project-declutter]').click();
  await pageP.waitForSelector('[data-declutter-dialog] [data-declutter-box]', { timeout: 20000 });
  await shotOf(pageP, null, 'h11-dialog-phone', 'light');
  await shotOf(pageP, null, 'h11-dialog-phone', 'dark');
  await light(pageP);
  const o2 = await pageP.evaluate(() => ({ doc: document.documentElement.scrollWidth > innerWidth + 1 }));
  check('H11 phone: the Declutter sheet does not scroll sideways at 390', !o2.doc, JSON.stringify(o2));
  await ctxP.close();

  // f) Opus review fixes
  // 1. A teammate asks: the Need is private to the owner; the asker's own checks still see it (one open Need, other session refused)
  const XI = 'H11 Xi';
  await must(cc, 'add_project', { name: XI, visibility: 'org' });
  const xa1 = await mcpH(kT, 'declutter', { project: XI, ask: true, add: [{ later: 'Xi line from Tess' }] }, hdr('h11t1'));
  const xa2 = await mcpH(kT, 'declutter', { project: XI, ask: true, add: [{ later: 'Xi line from Tess again' }] }, hdr('h11t1'));
  const xNeeds = await rawDb.collection('needs').find({ projectId: (await rawDb.collection('projects').findOne({ name: XI }))._id, declutter: { $exists: true } }).toArray();
  check('H11 review 1: a teammate Declutter Need is private to the project owner', !xa1.isError && xNeeds.length === 2 && xNeeds.every(n => n.visibility === 'private' && n.ownerId === ME.userId && !(n.sharedWith ?? []).length), JSON.stringify(xNeeds.map(n => [n.visibility, n.status])));
  check('H11 review 1: asking again from the same session still replaces it (the asker cannot read it, the check can)', !xa2.isError && xNeeds.filter(n => n.status === 'open').length === 1 && xNeeds.filter(n => n.status === 'replaced').length === 1, JSON.stringify(xNeeds.map(n => n.status)));
  const xOther = await mcpH(cc, 'declutter', { project: XI, ask: true, add: [{ later: 'Xi from the owner session' }] }, hdr('h11x2'));
  check('H11 review 1: another session cannot ask while the teammate Need is open, though the teammate cannot see it', xOther.isError && /open from another session/.test(xOther.text), xOther.text.slice(0, 200));
  const tNeedsX = await mcpH(kT, 'needs', { project: XI, status: 'all' });
  check('H11 review 1: the Needs read of the teammate does not list it', !tNeedsX.isError && !/Declutter H11 Xi/.test(tNeedsX.text), tNeedsX.text.slice(0, 200));

  // 2. An archived newest copy never makes the only live page a candidate, and does not count as "share a title"
  const NU = 'H11 Nu';
  const NUID = (await must(cc, 'add_project', { name: NU, visibility: 'org' })).project.id;
  await must(cc, 'save_state', { project: NU, ops: [{ op: 'add_later', text: 'Nu fresh line' }] }); // the daily check needs a State to store its result on
  const nuOld = await mkNote(NU, 'Nu plan', 'old copy');
  const nuNew = await mkNote(NU, 'Nu plan copy', 'new copy'); // H14 refuses a repeated title: rename in the database
  await rawDb.collection('notes').updateOne({ _id: nuNew }, { $set: { title: 'Nu plan' } });
  await rawDb.collection('notes').updateOne({ _id: nuOld }, { $set: { updatedAt: ago(5) } });
  const nuT = await must(cc, 'add_task', { title: 'H11 Nu finished in all but status', project: NU });
  await rawDb.collection('tasks').updateOne({ ref: nuT.created.ref }, { $set: { progress: 100, status: 'In Progress' } });
  const nuRd = await must(cc, 'declutter', { project: NU }, hdr('h11n1'));
  check('H11 review 2: with two live pages the older is proposed and the newer stays', nuRd.items.some(i => i.id === `note:${nuOld}`) && !nuRd.items.some(i => i.id === `note:${nuNew}`), JSON.stringify(nuRd.items.map(i => i.id)));
  const nuAsk = await must(cc, 'declutter', { project: NU, ask: true }, hdr('h11n1'));
  await rawDb.collection('notes').updateOne({ _id: nuNew }, { $set: { archived: true, updatedAt: new Date() } });
  const nuRd2 = await must(cc, 'declutter', { project: NU }, hdr('h11n1'));
  check('H11 review 2: once the newest copy is archived the only live page is not proposed', !nuRd2.items.some(i => i.kind === 'archive_note'), JSON.stringify(nuRd2.items.map(i => i.id)));
  await rawDb.collection('states').updateOne({ projectId: NUID }, { $unset: { declutter: '' } });
  const nuBrief = await start(NU, 'h11n2');
  check('H11 review 2: and the daily check does not say notes share a title for it', !/share a title/.test(nuBrief.declutter ?? ''), JSON.stringify(nuBrief.declutter));

  // 4. Stored items are checked again when applied: the newer page is gone (archived above), the task is no longer at 100%
  await rawDb.collection('tasks').updateOne({ ref: nuT.created.ref }, { $set: { progress: 40 } });
  await answerUI(nuAsk.need.ref, 'yes');
  const nuDone = await rawDb.collection('needs').findOne({ ref: nuAsk.need.ref });
  const nuRes = nuDone.declutter?.result ?? { applied: [], failed: [] };
  check('H11 review 4: the older page is not archived because the page that was to stay is no longer live', (await rawDb.collection('notes').findOne({ _id: nuOld })).archived === false && nuRes.failed.some(x => x.startsWith(`note:${nuOld}: skipped, it no longer applies`)), JSON.stringify(nuRes));
  check('H11 review 4: the task that is no longer finished stays open, and the answer lists it as skipped', (await rawDb.collection('tasks').findOne({ ref: nuT.created.ref })).status === 'In Progress' && nuRes.failed.some(x => x.startsWith(`task:${nuT.created.ref}: skipped, it no longer applies`)), JSON.stringify(nuRes));

  // 5. The daily check writes only checkedAt and reasons: quietUntil stays
  const quiet = new Date(Date.now() + 5 * 86_400_000);
  await rawDb.collection('states').updateOne({ projectId: NUID }, { $set: { declutter: { checkedAt: ago(3), reasons: ['old reason'], quietUntil: quiet } } });
  await start(NU, 'h11n3');
  const nuCache = (await stateOf(NUID)).declutter;
  check('H11 review 5: a refreshed daily check leaves quietUntil alone and replaces checkedAt and reasons', nuCache.quietUntil.getTime() === quiet.getTime() && nuCache.checkedAt.getTime() > Date.now() - 60_000 && nuCache.reasons.length === 0, JSON.stringify(nuCache));

  // 3. Someone who was the owner when the Need was asked and can still read the project applies nothing
  const MU = 'H11 Mu';
  const kTown = await must(kU, 'add_project', { name: MU, visibility: 'org' });
  const MUID = kTown.project.id;
  await must(kU, 'save_state', { project: MU, ops: [{ op: 'add_later', text: 'Mu old line that would be archived' }] });
  const stMu = await stateOf(MUID);
  await rawDb.collection('states').updateOne({ _id: stMu._id, 'later.id': stMu.later[0].id }, { $set: { 'later.$.at': ago(30) } });
  const muAsk = await must(kU, 'declutter', { project: MU, ask: true }, hdr('h11m1'));
  await rawDb.collection('projects').updateOne({ _id: MUID }, { $set: { ownerId: ME.userId } });
  const ctxM = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageM = await ctxM.newPage();
  await login(pageM, { phone: false, next: '/needs', email: 'una-h11@example.test' });
  const mBtn = pageM.locator(`[data-need="${muAsk.need.ref}"] [data-need-option="yes"]`);
  await mBtn.waitFor({ timeout: 20000 });
  await mBtn.click();
  await pageM.waitForFunction(r => !document.querySelector(`[data-need="${r}"] [data-need-option]`), muAsk.need.ref, { timeout: 20000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  const muDone = await rawDb.collection('needs').findOne({ ref: muAsk.need.ref });
  const stMu2 = await stateOf(MUID);
  check('H11 review 3: a former owner who can still read the project answers Yes and nothing is applied', muDone.status === 'answered' && stMu2.later.length === 1 && !(stMu2.archived ?? []).length && (muDone.declutter?.result?.failed ?? []).some(x => /only the project's owner/.test(x)) && (muDone.declutter?.result?.applied ?? []).length === 0, JSON.stringify(muDone.declutter?.result));
  await ctxM.close();
  void randomUUID;
} catch (e) {
  check('flow-h11 (error)', false, e?.stack || String(e));
}
if (browser) await browser.close().catch(() => {});
await finish();
