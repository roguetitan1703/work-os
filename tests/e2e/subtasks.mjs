// Subtasks (docs/subtasks.md) over MCP and in the app: a parent and its subtasks in one call (add_task, apply_changes),
// the rollup (count and progress: Done counts 100, Dropped is left out), one level only, a subtask stays in its parent's
// project, moving the parent moves them (and who sees them), completing a parent leaves open subtasks open over MCP,
// trash and restore go together, a recurring parent's next occurrence gets the subtasks again, rename and detach. Then
// the app at 1280 (task page section, board chip and "in" line, the "Close the N open subtasks too?" question) and 390
// (task page section, list row, Leave them open).
// Seed profile: none.
import { B, ME, MCP, check, finish, launch, login, makeUser, mcpAs, mkKey, okO, overflow, rawDb, settle } from './lib.mjs';

const as = (key, name, args = {}) => mcpAs(key, name, args);
const must = async (key, name, args) => {
  const r = await as(key, name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  return r.json;
};
const T = rawDb.collection('tasks');
const doc = ref => T.findOne({ orgId: ME.orgId, ref });
const kA = MCP;

let browser;
try {
  const Bu = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const kB = await mkKey({ agent: 'claude', userId: Bu.userId, orgId: ME.orgId, name: 'bea chat' });
  await must(kA, 'add_project', { name: 'Kyc Demo' });

  // ---- one call: a parent and its subtasks ----
  const made = await must(kA, 'add_task', { title: 'KYC demo', project: 'Kyc Demo', subtasks: [{ title: 'Upload screen', assignee: 'bea@example.test' }, { title: 'Review queue', due: '2030-01-10' }, { title: 'Audit log' }] });
  check('add_task: parent and 3 subtasks in one call', made?.created?.ref && made.subtasks?.length === 3, JSON.stringify(made).slice(0, 300));
  const P = made.created.ref;
  const [s1, s2, s3] = made.subtasks.map(x => x.ref);
  const pd = await doc(P);
  const kids = await T.find({ parentId: pd._id }).toArray();
  check('subtasks: same project as the parent, its number and title copied', kids.length === 3 && kids.every(k => k.projectId === pd.projectId && k.parentRef === P && k.parentTitle === 'KYC demo' && k.visibility === 'org'), JSON.stringify(kids.map(k => [k.projectId === pd.projectId, k.parentRef, k.visibility])));
  check('subtasks: each keeps its own fields (assignee, due)', kids.find(k => k.ref === s1)?.assigneeIds?.includes(Bu.userId) && kids.find(k => k.ref === s2)?.due === '2030-01-10');
  check('rollup: a new parent is 0 of 3 done', pd.subtaskCount?.done === 0 && pd.subtaskCount.total === 3 && pd.progress === 0, JSON.stringify(pd.subtaskCount));
  check('brief: the parent says "0 of 3 done", a subtask names its parent', made.created.subtasks === '0 of 3 done' && made.subtasks[0].parent === `#${P} KYC demo`, JSON.stringify([made.created.subtasks, made.subtasks[0].parent]));

  // ---- rollup numbers ----
  await must(kA, 'log_progress', { task: s1, progress: 50, note: 'half' });
  check('rollup: 50 / 0 / 0 → 17%', (await doc(P)).progress === 17, String((await doc(P)).progress));
  await must(kA, 'complete_task', { task: s2 });
  let p = await doc(P);
  check('rollup: 50 / Done / 0 → 50%, 1 of 3 done', p.progress === 50 && p.subtaskCount.done === 1 && p.subtaskCount.total === 3, JSON.stringify([p.progress, p.subtaskCount]));
  await must(kA, 'update_task', { task: s3, status: 'Dropped', note: 'not needed' });
  p = await doc(P);
  check('rollup: a Dropped subtask is left out → 75%, 1 of 2 done', p.progress === 75 && p.subtaskCount.done === 1 && p.subtaskCount.total === 2, JSON.stringify([p.progress, p.subtaskCount]));

  // ---- reads ----
  const g = await must(kA, 'get_task', { task: P });
  check('get_task: the parent lists its subtasks with status and progress', g.subtasks?.length === 3 && g.subtasks.some(x => x.ref === s1 && x.progress === 50 && x.assignees?.includes('Bea')) && /1 of 2 done/.test(g.subtaskProgress ?? ''), JSON.stringify([g.subtasks, g.subtaskProgress]).slice(0, 300));
  const gs = await must(kA, 'get_task', { task: s1 });
  check('get_task: a subtask names its parent', gs.parent?.ref === P && gs.parent.title === 'KYC demo' && !gs.subtasks, JSON.stringify(gs.parent));
  const lo = await must(kA, 'list_tasks', { parent: P });
  const la = await must(kA, 'list_tasks', { parent: P, include_closed: true });
  check('list_tasks parent: the open subtasks, or all with include_closed', lo.total === 1 && lo.tasks[0].ref === s1 && la.total === 3, `${lo.total} ${la.total}`);

  // ---- rules ----
  const deep = await as(kA, 'add_task', { title: 'Too deep', parent: s1 });
  check('one level: a subtask of a subtask is refused', deep.isError && /one level/.test(deep.text), deep.text);
  const other = (await must(kA, 'add_task', { title: 'Other parent' })).created.ref;
  const up = await as(kA, 'update_task', { task: P, parent: other });
  check('one level: a task with subtasks cannot go under another', up.isError && /subtasks of its own/.test(up.text), up.text);
  await must(kA, 'add_project', { name: 'Elsewhere' });
  const away = await as(kA, 'update_task', { task: s1, project: 'Elsewhere' });
  check("a subtask can't move to another project on its own", away.isError && /stays in its parent's project/.test(away.text), away.text);
  const both = await as(kA, 'add_task', { title: 'Both', parent: P, subtasks: [{ title: 'x' }] });
  check('parent and subtasks together are refused', both.isError, both.text);

  // ---- apply_changes: create with subtasks and "$name" as a parent ----
  const ac = await must(kA, 'apply_changes', { ops: [
    { op: 'create_task', as: '$launch', title: 'Launch plan', project: 'Kyc Demo', subtasks: [{ title: 'Write copy' }, { title: 'Pick a date' }] },
    { op: 'create_task', title: 'Tell the client', parent: '$launch' },
  ] });
  const L = ac.labels.$launch;
  const ld = await doc(L);
  check('apply_changes: create_task with subtasks, and parent "$name"', ld.subtaskCount?.total === 3 && (await T.countDocuments({ parentId: ld._id })) === 3, JSON.stringify(ac.results).slice(0, 300));

  // ---- moving the parent moves its subtasks (and who sees them) ----
  await must(kA, 'add_project', { name: 'Hush Room', visibility: 'private' });
  await must(kA, 'update_task', { task: L, project: 'Hush Room' });
  const hush = await rawDb.collection('projects').findOne({ name: 'Hush Room' });
  let lk = await T.find({ parentId: ld._id }).toArray();
  check('move: the subtasks follow the parent to a private project', lk.length === 3 && lk.every(k => k.projectId === hush._id && k.visibility === 'private' && k.ownerId === ME.userId), JSON.stringify(lk.map(k => [k.projectId === hush._id, k.visibility])));
  const bSees = await as(kB, 'list_tasks', { include_closed: true });
  check('move: the teammate sees none of them now', !/Launch plan|Write copy|Pick a date|Tell the client/.test(bSees.text), bSees.text.slice(0, 200));
  const bGet = await as(kB, 'get_task', { task: lk[0].ref });
  check('move: a teammate asking for a subtask gets not found', bGet.isError && /not found/i.test(bGet.text), bGet.text);
  await must(kA, 'update_task', { task: L, project: 'Kyc Demo' });
  lk = await T.find({ parentId: ld._id }).toArray();
  check('move back: the subtasks are shared again', lk.every(k => k.projectId === pd.projectId && k.visibility === 'org'), JSON.stringify(lk.map(k => k.visibility)));
  check('move: each subtask has a history line for the move', (await rawDb.collection('activity').countDocuments({ taskId: lk[0]._id, note: `Moved with #${L}` })) === 2);

  // ---- rename and detach ----
  await must(kA, 'update_task', { task: L, title: 'Launch plan v2' });
  check('rename: the subtasks carry the new title', (await T.find({ parentId: ld._id }).toArray()).every(k => k.parentTitle === 'Launch plan v2'));
  const tell = lk.find(k => k.title === 'Tell the client');
  await must(kA, 'update_task', { task: tell.ref, parent: null });
  const td = await doc(tell.ref);
  check('detach: parent null takes it out, it stays in the project', !td.parentId && !td.parentRef && td.projectId === pd.projectId && (await doc(L)).subtaskCount.total === 2, JSON.stringify([td.parentId, (await doc(L)).subtaskCount]));
  await must(kA, 'update_task', { task: tell.ref, parent: L });
  check('attach: update_task parent puts it back under', (await doc(tell.ref)).parentId === ld._id && (await doc(L)).subtaskCount.total === 3);

  // ---- completing a parent over MCP leaves open subtasks open ----
  const cp = await must(kA, 'complete_task', { task: P, note: 'demo shown' });
  check('complete_task: the parent is done, its open subtask listed and left open', cp.completed.status === 'Done' && cp.openSubtasks?.length === 1 && cp.openSubtasks[0].ref === s1 && (await doc(s1)).status === 'In Progress', JSON.stringify(cp).slice(0, 300));
  check('complete_task: a done parent keeps 100%', (await doc(P)).progress === 100);
  await must(kA, 'update_task', { task: P, status: 'In Progress' });
  check('reopen: the parent takes its progress from its subtasks again', (await doc(P)).progress === 75, String((await doc(P)).progress));

  // ---- trash and restore go together ----
  const del = await must(kA, 'delete_task', { task: L, title: 'Launch plan v2' });
  check('delete_task: the subtasks go to the trash with it', del.withSubtasks === 3 && (await T.countDocuments({ parentId: ld._id })) === 0 && (await rawDb.collection('trash').countDocuments({ withParent: ld._id })) === 3, JSON.stringify(del));
  const tl = await must(kA, 'list_trash', {});
  check('list_trash: only the parent is listed', tl.some(x => x.ref === L) && !tl.some(x => lk.some(k => k.ref === x.ref)), JSON.stringify(tl.map(x => x.ref)));
  const r1 = await as(kA, 'restore_task', { task: lk[0].ref });
  check('restore: a subtask that went with its parent is not restored alone', r1.isError && new RegExp(`restore #${L}`).test(r1.text), r1.text);
  await must(kA, 'restore_task', { task: L });
  const back = await T.find({ parentId: ld._id }).toArray();
  check('restore: the parent brings its subtasks back, counted again', back.length === 3 && (await doc(L))?.subtaskCount?.total === 3 && (await rawDb.collection('trash').countDocuments({ withParent: ld._id })) === 0, `${back.length}`);
  await must(kA, 'delete_task', { task: back[0].ref, title: back[0].title });
  check('trash one subtask: the parent counts one fewer', (await doc(L)).subtaskCount.total === 2);
  await must(kA, 'restore_task', { task: back[0].ref });
  check('restore one subtask: back under its parent', (await doc(back[0].ref)).parentId === ld._id && (await doc(L)).subtaskCount.total === 3);

  // ---- a recurring parent's next occurrence gets the subtasks again ----
  const rec = await must(kA, 'add_task', { title: 'Weekly ship', recurrence: { freq: 'weekly', interval: 1 }, due: '2030-02-04', subtasks: [{ title: 'Changelog' }, { title: 'Deploy' }] });
  await must(kA, 'complete_task', { task: rec.subtasks[0].ref });
  const rc = await must(kA, 'complete_task', { task: rec.created.ref });
  const nx = rc.nextOccurrence ? await doc(rc.nextOccurrence.ref) : null;
  const nk = nx ? await T.find({ parentId: nx._id }).sort({ ref: 1 }).toArray() : [];
  check('recurring: the next one has the subtasks as new open ones', nk.length === 2 && nk.map(k => k.title).join() === 'Changelog,Deploy' && nk.every(k => k.status === 'Not Started') && nx.subtaskCount?.total === 2, JSON.stringify(nk.map(k => [k.title, k.status])));

  // ---- the app ----
  browser = await launch();
  // desktop 1280: task page section, board chip and line, the close question
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  const ui = (await must(kA, 'add_task', { title: 'Site relaunch', project: 'Kyc Demo', subtasks: [{ title: 'New header' }, { title: 'New footer' }] })).created.ref;
  await login(pg, { next: `/tasks/${ui}` });
  await pg.waitForSelector('[data-subtasks]:visible', { timeout: 20000 });
  check('desktop: the task page shows its subtasks', (await pg.locator('[data-subtasks]:visible [data-subtask]').count()) === 2);
  await pg.locator('[data-subtasks]:visible [data-add-subtask]').fill('New menu');
  await pg.locator('[data-subtasks]:visible [data-add-subtask]').press('Enter');
  await pg.waitForFunction(() => [...document.querySelectorAll('[data-subtasks] [data-subtask]')].filter(e => e.offsetParent).length === 3, null, { timeout: 15000 }).catch(() => {});
  const uid = (await doc(ui))._id;
  check('desktop: Enter in "Add subtask" makes one', (await T.countDocuments({ parentId: uid })) === 3 && (await pg.locator('[data-subtasks]:visible [data-subtask]').count()) === 3);
  const header = (await T.findOne({ parentId: uid, title: 'New header' })).ref;
  await pg.locator(`[data-subtasks]:visible [data-subtask="${header}"] input[type=checkbox]`).click();
  await pg.waitForFunction(() => /1\/3/.test(document.querySelector('[data-subtasks] h3')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  check('desktop: ticking a subtask marks it done and the count moves', (await doc(header)).status === 'Done' && /1\/3/.test(await pg.locator('[data-subtasks]:visible h3').innerText()), await pg.locator('[data-subtasks]:visible h3').innerText());
  await pg.goto(`${B}/tasks/${header}`);
  await pg.waitForSelector('[data-part-of]:visible', { timeout: 15000 });
  check('desktop: a subtask page says what it is part of, and has no Subtasks section', /Subtask of #\d+ Site relaunch/.test(await pg.locator('[data-part-of]:visible').innerText()) && (await pg.locator('[data-subtasks]:visible').count()) === 0);
  await pg.goto(`${B}/tasks`);
  await pg.waitForSelector('[data-subtask-chip]:visible', { timeout: 15000 });
  check('desktop board: the parent card shows the 1/3 chip', (await pg.locator('[data-subtask-chip]:visible').allInnerTexts()).some(t => t.trim() === '1/3'), JSON.stringify(await pg.locator('[data-subtask-chip]:visible').allInnerTexts()));
  check('desktop board: a subtask card says "in Site relaunch"', (await pg.locator('[data-parent-line]:visible').allInnerTexts()).some(t => t.trim() === 'in Site relaunch'));
  check('desktop board: no horizontal scroll', okO(await overflow(pg)));
  await pg.goto(`${B}/tasks/${ui}`);
  await pg.locator('button:has-text("Complete"):visible').click();
  await pg.waitForSelector('[data-close-subtasks]', { timeout: 10000 });
  check('desktop: completing asks "Close the 2 open subtasks too?"', (await pg.locator('[role=dialog]').innerText()).includes('Close the 2 open subtasks too?'));
  await pg.click('[data-close-them]');
  await pg.waitForFunction(() => true);
  let all = [];
  for (let i = 0; i < 30; i++) {
    all = await T.find({ parentId: uid }).toArray();
    if ((await doc(ui)).status === 'Done' && all.every(k => k.status === 'Done')) break;
    await settle(pg, 500);
  }
  check('desktop: Close them marks the parent and its subtasks done', (await doc(ui)).status === 'Done' && all.length === 3 && all.every(k => k.status === 'Done'), JSON.stringify(all.map(k => k.status)));
  // live: a subtask changed elsewhere (Claude over MCP) refreshes the open parent page without a reload
  await pg.goto(`${B}/tasks/${ui}`);
  await pg.waitForFunction(() => /3\/3/.test(document.querySelector('[data-subtasks] h3')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
  await pg.waitForTimeout(2000);
  await must(kA, 'update_task', { task: header, status: 'In Progress', note: 'one more pass' });
  const liveOk = await pg.waitForFunction(() => /2\/3/.test(document.querySelector('[data-subtasks] h3')?.textContent ?? ''), null, { timeout: 20000 }).then(() => true, () => false);
  check('live: the parent page shows the new count (2/3) after a subtask changes over MCP', liveOk, await pg.locator('[data-subtasks]:visible h3').innerText());
  await ctx.close();

  // phone 390: section, list row, Leave them open
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pp = await ph.newPage();
  const mob = (await must(kA, 'add_task', { title: 'Phone parent', project: 'Kyc Demo', subtasks: [{ title: 'Phone child one' }] })).created.ref;
  const mid = (await doc(mob))._id;
  await login(pp, { phone: true, next: `/tasks/${mob}` });
  await pp.waitForSelector('[data-subtasks]:visible', { timeout: 20000 });
  check('phone: the task page shows its subtasks', (await pp.locator('[data-subtasks]:visible [data-subtask]').count()) === 1);
  await pp.locator('[data-subtasks]:visible [data-add-subtask]').fill('Phone child two');
  await pp.locator('[data-subtasks]:visible [data-add-subtask]').press('Enter');
  for (let i = 0; i < 30 && (await T.countDocuments({ parentId: mid })) < 2; i++) await settle(pp, 500);
  await pp.waitForFunction(() => [...document.querySelectorAll('[data-subtasks] [data-subtask]')].filter(e => e.offsetParent).length === 2, null, { timeout: 15000 }).catch(() => {});
  check('phone: Enter in "Add subtask" makes one', (await T.countDocuments({ parentId: mid })) === 2 && (await pp.locator('[data-subtasks]:visible [data-subtask]').count()) === 2);
  const box = await pp.locator('[data-subtasks]:visible [data-subtask] button').first().boundingBox();
  check('phone: the tick is a 44px target', box && box.height >= 44, JSON.stringify(box));
  check('phone: no horizontal scroll on the task page', okO(await overflow(pp)));
  await pp.goto(`${B}/tasks`);
  await pp.waitForSelector('[data-subtask-chip]:visible', { timeout: 15000 });
  check('phone list: the parent row shows 0/2', (await pp.locator('[data-subtask-chip]:visible').allInnerTexts()).some(t => t.trim() === '0/2'));
  check('phone list: a subtask row says "in Phone parent"', (await pp.locator('[data-parent-line]:visible').allInnerTexts()).some(t => t.trim() === 'in Phone parent'));
  check('phone list: no horizontal scroll', okO(await overflow(pp)));
  await pp.goto(`${B}/tasks/${mob}`);
  await pp.locator('button:has-text("Mark done"):visible').tap();
  await pp.waitForSelector('[data-close-subtasks]', { timeout: 10000 });
  check('phone: Mark done asks "Close the 2 open subtasks too?"', (await pp.locator('[data-sheet]').last().innerText()).includes('Close the 2 open subtasks too?'));
  await pp.tap('[data-leave-open]');
  for (let i = 0; i < 30 && (await doc(mob)).status !== 'Done'; i++) await settle(pp, 500);
  const mk = await T.find({ parentId: mid }).toArray();
  check('phone: Leave them open completes only the parent', (await doc(mob)).status === 'Done' && mk.length === 2 && mk.every(k => k.status === 'Not Started'), JSON.stringify(mk.map(k => k.status)));
  await ph.close();
} catch (e) {
  check('suite error', false, e?.stack || String(e));
} finally {
  await browser?.close().catch(() => {});
}
await finish();
