// Shared / Private projects from the app: the new-project choice, switching on the project's Info tab (owner only, with a
// confirm that names who loses access), the Private badge, and what a teammate can see at each step. Then sharing with
// chosen people: the Everyone / Choose people choice, the list and its confirm, who has access, the people badge, what
// someone off the list sees (MCP and pages), assignees on the list only, owner-only changes, and back to everyone.
// Seed profile: none.
import { randomBytes, randomUUID } from 'node:crypto';
import { B, ME, MCP, check, finish, launch, login, makeUser, mkKey, rawDb, setProfile, sha } from './lib.mjs';

let rid = 0;
async function as(key, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  let b;
  try { b = JSON.parse(line ? line.slice(5) : t); } catch { return { isError: true, text: t, json: null }; }
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!b.result?.isError || !!b.error || r.status >= 400, text, json };
}
const must = async (key, name, args) => {
  const r = await as(key, name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  return r.json;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(300);
  }
  return v;
}
const NAME = 'Secret Plan';
const proj = () => rawDb.collection('projects').findOne({ name: NAME });
// What Bea can see of the project, through her own key.
async function beaSees(kB) {
  const [p, t, n] = await Promise.all([as(kB, 'list_projects'), as(kB, 'list_tasks', {}), as(kB, 'list_notes', { state: 'all' })]);
  return { project: p.text.includes(NAME), task: t.text.includes('Secret task'), note: n.text.includes('Secret note') };
}

const browser = await launch();
try {
  const A = ME;
  const kA = MCP;
  await setProfile(A, { quietStart: 0, quietEnd: 0 });
  const Bu = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: A.orgId, role: 'member' });
  const kB = await mkKey({ agent: 'claude', userId: Bu.userId, orgId: A.orgId, name: 'bea chat' });

  // ======== 1. create private through the dialog (desktop) ========
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pa = await ctxA.newPage();
  await login(pa, { next: '/projects' });
  await pa.click('button:has-text("New project"):visible');
  await pa.waitForSelector('[data-sharing-choice]', { timeout: 15000 });
  check('dialog: Shared is the default', (await pa.getAttribute('[data-sharing="org"]', 'aria-checked')) === 'true' && (await pa.getAttribute('[data-sharing="private"]', 'aria-checked')) === 'false');
  check('dialog: says what each choice means', (await pa.locator('[data-sharing-help]').innerText()).trim() === 'Shared: everyone in Delpat sees it and its tasks and notes. Private: only you.');
  await pa.fill('input[placeholder="Name"]', NAME);
  await pa.click('[data-sharing="private"]');
  await pa.click('button[type=submit]:has-text("Create")');
  await pa.waitForURL(u => u.pathname.startsWith('/projects/') && u.pathname !== '/projects', { timeout: 20000 });
  const p0 = await proj();
  check('create: the project is private and owned by the creator', p0?.visibility === 'private' && p0.ownerId === A.userId, JSON.stringify(p0 && [p0.visibility, p0.ownerId]));
  check('create: the project page shows the Private badge', (await pa.locator('[data-private-badge]:visible').count()) > 0);
  const id = p0._id;

  const t1 = (await must(kA, 'add_task', { title: 'Secret task', project: NAME })).created;
  await must(kA, 'write_note', { project: NAME, title: 'Secret note', body: 'only mine' });
  check('create: its task follows it (private)', (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t1.ref }))?.visibility === 'private');
  let seen = await beaSees(kB);
  check('private: a teammate sees no project, task or note', !seen.project && !seen.task && !seen.note, JSON.stringify(seen));
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pb = await ctxB.newPage();
  await login(pb, { email: 'bea@example.test', next: '/projects' });
  check("private: the teammate's Projects list does not show it", !(await pb.locator('body').innerText()).includes(NAME));
  await pb.goto(`${B}/projects/${id}`);
  check('private: the teammate cannot open its page', !(await pb.locator('body').innerText()).includes(NAME));
  await pa.goto(`${B}/projects`);
  check("list: the owner's card carries the Private badge", (await pa.locator(`a[href="/projects/${id}"] [data-private-badge]`).count()) > 0);
  await pa.goto(`${B}/tasks/${t1.ref}`);
  await pa.waitForSelector('[data-private-badge]', { timeout: 8000 }).catch(() => {});
  check('task page: the project shows a lock', (await pa.locator('[data-private-badge]:visible').count()) > 0, pa.url() + ' ' + (await pa.locator('body').innerText()).slice(0, 300));

  // ======== 2. switch to shared ========
  await pa.goto(`${B}/projects/${id}?tab=info`);
  await pa.waitForSelector('[data-section="sharing"] [data-sharing="org"]', { timeout: 15000 });
  await pa.click('[data-section="sharing"] [data-sharing="org"]');
  check('shared: the project switches', !!(await until(async () => (await proj())?.visibility === 'org')));
  check('shared: its task and note followed', (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t1.ref }))?.visibility === 'org' && (await rawDb.collection('notes').findOne({ title: 'Secret note' }))?.visibility === 'org');
  seen = await beaSees(kB);
  check('shared: the teammate now sees project, task and note', seen.project && seen.task && seen.note, JSON.stringify(seen));
  await pa.goto(`${B}/projects`);
  check('shared: no Private badge on its card', (await pa.locator(`a[href="/projects/${id}"] [data-private-badge]`).count()) === 0);

  // ======== 3. a non-owner cannot switch ========
  const refuse = await as(kB, 'update_project', { project: NAME, visibility: 'private' });
  check('non-owner: MCP update_project visibility is refused', refuse.isError && /owner/i.test(refuse.text), refuse.text);
  check('non-owner: and nothing changed', (await proj())?.visibility === 'org');
  await pb.goto(`${B}/projects/${id}?tab=info`);
  await pb.waitForSelector('[data-section="sharing"]', { timeout: 15000 });
  check('non-owner: the Info tab choice is disabled and says who can change it', (await pb.locator('[data-section="sharing"] [data-sharing="private"]').isDisabled()) && /can change this/.test(await pb.locator('[data-section="sharing"]').innerText()));

  // ======== 4. back to private: confirm, access and assignment go ========
  await must(kA, 'update_task', { task: t1.ref, assignee: 'bea@example.test' });
  const cm = await as(kB, 'add_comment', { task: t1.ref, note: 'Bea was here' });
  check('setup: Bea is assigned and has commented', !cm.isError && (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t1.ref }))?.assigneeId === Bu.userId, cm.text);
  // Bea gives a shared task to Claude (queued), another is running, and a Claude item waits on her. Her computer is linked to the project.
  const t2 = (await must(kA, 'add_task', { title: 'Bea queued for Claude', project: NAME })).created;
  const t3 = (await must(kA, 'add_task', { title: 'Bea running with Claude', project: NAME })).created;
  const dkey = 'wkr_' + randomBytes(32).toString('base64url');
  const devId = randomUUID();
  await rawDb.collection('devices').insertOne({ _id: devId, name: 'Bea PC', ownerId: Bu.userId, orgId: A.orgId, hash: sha(dkey), prefix: dkey.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  await rawDb.collection('workerFolders').insertOne({ _id: `${devId}:f_bea01`, deviceId: devId, folderId: 'f_bea01', name: 'bea-folder', git: false, orgId: A.orgId, ownerId: Bu.userId, visibility: 'private', projectId: id, linkedAt: new Date(), seenAt: new Date(), missing: false });
  await rawDb.collection('settings').updateOne({ _id: `dispatcher:${Bu.userId}` }, { $set: { area: 'dispatcher', orgId: A.orgId, userId: Bu.userId, enabled: true, maxConcurrent: 2, boilerplateNoteId: null } }, { upsert: true });
  const mark = o => ({ state: 'queued', markedAt: new Date(), markedBy: 'user', markedByUserId: Bu.userId, markedByOrgId: A.orgId, ...o });
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: t2.ref }, { $set: { claude: mark({}) } });
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: t3.ref }, { $set: { status: 'In Progress', claude: mark({ state: 'running', claimedAt: new Date(), deviceId: devId, sessionId: randomUUID(), prevStatus: 'Not Started' }) } });
  const itemId = randomUUID();
  await rawDb.collection('claudeItems').insertOne({ _id: itemId, orgId: A.orgId, ownerId: A.userId, visibility: 'org', ref: 9001, projectId: id, title: 'Needs Bea', kind: 'task', why: 'w', doneWhen: 'd', state: 'blocked', next: false, order: 1, note: '', parts: [], blockedBy: null, waitingOn: Bu.userId, waitingText: 'Pick one', gitRef: '', claimedBy: null, createdBy: { kind: 'user', userId: A.userId }, createdAt: new Date(), updatedAt: new Date(), doneAt: null, log: [] });
  await pa.goto(`${B}/projects/${id}?tab=info`);
  await pa.waitForSelector('[data-section="sharing"] [data-sharing="private"]', { timeout: 15000 });
  await pa.click('[data-section="sharing"] [data-sharing="private"]');
  await pa.waitForSelector('[data-private-confirm]', { timeout: 15000 });
  const msg = await pa.locator('[data-private-confirm]').innerText();
  check('confirm: names who loses access and the assignment', /Bea/.test(msg) && /lose access/.test(msg) && /unassigned/.test(msg), msg);
  check("confirm: says Bea's Claude task is stopped and the waiting item", /Claude task will be stopped/.test(msg) && /stop waiting/.test(msg), msg);
  check('confirm: nothing changed yet', (await proj())?.visibility === 'org');
  await pa.click('[data-confirm]');
  check('private again: the project switches', !!(await until(async () => (await proj())?.visibility === 'private')));
  const tDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t1.ref });
  check('private again: the task is private to the owner and unassigned', tDoc?.visibility === 'private' && tDoc.ownerId === A.userId && tDoc.assigneeId === null, JSON.stringify(tDoc && [tDoc.visibility, tDoc.assigneeId]));
  seen = await beaSees(kB);
  check('private again: the teammate loses project, task and note', !seen.project && !seen.task && !seen.note, JSON.stringify(seen));
  const q2 = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t2.ref });
  const q3 = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t3.ref });
  check("private again: Bea's queued Claude mark is cleared", !q2?.claude, JSON.stringify(q2?.claude));
  check("private again: Bea's running Claude task is stopped (project made private)", q3?.claude?.state === 'stopped' && /made private/.test(q3.claude.note), JSON.stringify(q3?.claude));
  check('private again: the item waiting on Bea no longer waits', !(await rawDb.collection('claudeItems').findOne({ _id: itemId }))?.waitingOn);
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: t2.ref }, { $set: { claude: mark({}) } }); // a leftover queued mark must still not be claimed
  const poll = await fetch(`${B}/api/worker/jobs`, { headers: { authorization: `Bearer ${dkey}` } });
  const pj = await poll.json().catch(() => ({}));
  check("private again: Bea's worker claims nothing", poll.status === 200 && (pj.jobs ?? []).length === 0 && (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t2.ref }))?.claude?.state === 'queued', JSON.stringify(pj).slice(0, 200));
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: t2.ref }, { $set: { claude: null } });
  // With nobody assigned or commenting, the switch is immediate (no dialog).
  await pa.goto(`${B}/projects/${id}?tab=info`);
  await pa.waitForSelector('[data-section="sharing"] [data-sharing="org"]', { timeout: 15000 });
  await pa.click('[data-section="sharing"] [data-sharing="org"]');
  await until(async () => (await proj())?.visibility === 'org');
  await rawDb.collection('activity').deleteMany({ taskId: tDoc._id, type: 'comment' });
  await pa.reload();
  await pa.waitForSelector('[data-section="sharing"] [data-sharing="private"]', { timeout: 15000 });
  await pa.click('[data-section="sharing"] [data-sharing="private"]');
  check('no one affected: it switches with no dialog', !!(await until(async () => (await proj())?.visibility === 'private')) && (await pa.locator('[data-private-confirm]').count()) === 0);

  // ======== 5. phone ========
  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ctxP.newPage();
  await login(pp, { phone: true, next: '/projects' });
  await pp.waitForSelector(`a[href="/projects/${id}"]:visible`, { timeout: 15000 });
  check('phone: the list card carries the Private badge', (await pp.locator(`a[href="/projects/${id}"] [data-private-badge]:visible`).count()) > 0);
  await pp.click('button[aria-label="New project"]');
  await pp.waitForSelector('[data-sharing-choice]', { timeout: 15000 });
  check('phone: the new-project sheet has the choice, Shared by default', (await pp.getAttribute('[data-sharing="org"]', 'aria-checked')) === 'true' && (await pp.locator('[data-sharing-help]').count()) > 0);
  await pp.goto(`${B}/projects/${id}`);
  await pp.waitForSelector('[data-edit-header]', { timeout: 15000 });
  check('phone: the project header shows Private', (await pp.locator('[data-private-badge]:visible').count()) > 0);
  // ======== 6. shared with chosen people ========
  const Cal = await makeUser({ email: 'cal@example.test', name: 'Cal', orgId: A.orgId, role: 'member' });
  const kC = await mkKey({ agent: 'claude', userId: Cal.userId, orgId: A.orgId, name: 'cal chat' });
  const TEAM = 'Team Plan';
  const team = () => rawDb.collection('projects').findOne({ orgId: A.orgId, name: TEAM, visibility: { $ne: 'org' } }).then(p => p ?? rawDb.collection('projects').findOne({ orgId: A.orgId, name: TEAM }));
  const sees = async (key, title) => {
    const [p, t, n] = await Promise.all([as(key, 'list_projects'), as(key, 'list_tasks', {}), as(key, 'list_notes', { state: 'all' })]);
    return { project: p.text.includes(TEAM), task: t.text.includes(title), note: n.text.includes('Team note') };
  };
  await must(kA, 'add_project', { name: TEAM });
  const tt = (await must(kA, 'add_task', { title: 'Team task', project: TEAM, assignee: 'cal@example.test' })).created;
  await must(kA, 'write_note', { project: TEAM, title: 'Team note', body: 'for the team' });
  await must(kC, 'add_comment', { task: tt.ref, note: 'Cal was here' });
  const bt = (await must(kB, 'add_task', { title: 'Bea team task', project: TEAM })).created;
  const teamId = (await team())._id;
  await pa.goto(`${B}/projects/${teamId}?tab=info`);
  await pa.waitForSelector('[data-section="sharing"] [data-audience="people"]', { timeout: 15000 });
  check('choose: Shared offers Everyone (picked) or Choose people', (await pa.getAttribute('[data-audience="everyone"]', 'aria-checked')) === 'true');
  check('choose: says everyone has access', /Has access: Everyone in/.test(await pa.locator('[data-access]').innerText()));
  await pa.click('[data-audience="people"]');
  await pa.waitForSelector('[data-people-picker]', { timeout: 8000 });
  check('choose: the owner is on the list and cannot be taken off', (await pa.locator(`[data-person="${A.userId}"] input`).isChecked()) && (await pa.locator(`[data-person="${A.userId}"] input`).isDisabled()));
  check('choose: nothing changes before Save', (await team())?.visibility === 'org');
  await pa.click(`[data-person="${Bu.userId}"] input`);
  await pa.click('[data-save-people]');
  await pa.waitForSelector('[data-cut-confirm]', { timeout: 15000 });
  const cmsg = await pa.locator('[data-cut-confirm]').innerText();
  check('choose: the confirm names who loses access (Cal, assigned and commented), not Bea', /Cal/.test(cmsg) && /lose access/.test(cmsg) && /unassigned/.test(cmsg) && !/Bea/.test(cmsg), cmsg);
  await pa.click('[data-confirm]');
  check('choose: the project is shared with the owner and Bea', !!(await until(async () => { const p = await team(); return p?.visibility === 'members' && p.sharedWith.length === 2 && p.sharedWith.includes(A.userId) && p.sharedWith.includes(Bu.userId); })), JSON.stringify(await team()));
  const ttDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: tt.ref });
  check('choose: its task follows (the list) and Cal is unassigned', ttDoc?.visibility === 'members' && ttDoc.sharedWith?.includes(Bu.userId) && !ttDoc.sharedWith.includes(Cal.userId) && ttDoc.assigneeId === null, JSON.stringify(ttDoc && [ttDoc.visibility, ttDoc.sharedWith, ttDoc.assigneeId]));
  const noteDoc = await rawDb.collection('notes').findOne({ title: 'Team note' });
  const actDocs = await rawDb.collection('activity').find({ taskId: ttDoc._id }).toArray();
  check('choose: its note and history follow', noteDoc?.visibility === 'members' && actDocs.length > 0 && actDocs.every(a => a.visibility === 'members' && !a.sharedWith.includes(Cal.userId)), JSON.stringify(actDocs.map(a => a.visibility)));
  // Cal (off the list) can make a project shared with everyone with the same name; work put "in Team Plan" by the
  // people on the list still lands in their narrower one.
  const calSame = await as(kC, 'add_project', { name: TEAM });
  const calProj = await rawDb.collection('projects').findOne({ orgId: A.orgId, name: TEAM, visibility: 'org' });
  check('names: someone off the list may use the name for a project shared with everyone', !calSame.isError && !!calProj && calProj._id !== teamId, calSame.text);
  const intoA = (await must(kA, 'add_task', { title: 'Name pick by owner', project: TEAM })).created;
  const intoB = (await must(kB, 'add_task', { title: 'Name pick by Bea', project: TEAM })).created;
  const pickA = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: intoA.ref });
  const pickB = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: intoB.ref });
  check('names: by name, the owner and Bea get the project shared with them, not the one everyone sees', pickA?.projectId === teamId && pickB?.projectId === teamId && pickB.visibility === 'members', JSON.stringify([pickA?.projectId, pickB?.projectId]));
  check('names: add_project with that name gives Bea the list project back', (await must(kB, 'add_project', { name: TEAM })).project?.id === teamId);
  // Moving a task out of the list's project: the task's owner or the project's owner only
  const mvB = await as(kB, 'update_task', { task: tt.ref, project: calProj._id });
  const mvBatch = await as(kB, 'apply_changes', { ops: [{ op: 'update_task', task: tt.ref, project: calProj._id }] });
  const ttNow = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: tt.ref });
  check('move: Bea cannot move the owner\'s task out to a project everyone sees (update_task, apply_changes)', mvB.isError && /project's owner/.test(mvB.text) && /project's owner|not found|failed/i.test(mvBatch.text) && ttNow?.projectId === teamId && ttNow.visibility === 'members', `${mvB.text.slice(0, 120)} | ${mvBatch.text.slice(0, 120)}`);
  const mvOwn = await as(kB, 'update_task', { task: intoB.ref, project: calProj._id });
  check('move: Bea may move her own task out', !mvOwn.isError && (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: intoB.ref }))?.visibility === 'org', mvOwn.text.slice(0, 120));
  for (const r of [intoA.ref, intoB.ref]) {
    const d = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: r });
    await rawDb.collection('tasks').deleteOne({ _id: d._id });
    await rawDb.collection('activity').deleteMany({ taskId: d._id });
  }
  await rawDb.collection('projects').deleteOne({ _id: calProj._id });
  let bs = await sees(kB, 'Team task');
  let cs = await sees(kC, 'Team task');
  check('choose: Bea (on the list) sees project, task and note', bs.project && bs.task && bs.note, JSON.stringify(bs));
  check('choose: Cal (off the list) sees none of them', !cs.project && !cs.task && !cs.note, JSON.stringify(cs));
  check('choose: Cal cannot read the task by number', (await as(kC, 'get_task', { task: tt.ref })).isError);
  await pa.reload();
  await pa.waitForSelector('[data-access]', { timeout: 15000 });
  const acc = await pa.locator('[data-access]').innerText();
  check('choose: the Info tab shows who has access', /\(owner\)/.test(acc) && /Bea/.test(acc) && !/Cal/.test(acc), acc);
  check('choose: the project header shows how many people', /2 people/.test(await pa.locator('[data-people-badge]:visible').first().innerText()));
  await pa.goto(`${B}/projects`);
  check('choose: the list card shows how many people', (await pa.locator(`a[href="/projects/${teamId}"] [data-people-badge]`).count()) > 0);
  await pb.goto(`${B}/projects/${teamId}?tab=info`);
  await pb.waitForSelector('[data-section="sharing"]', { timeout: 15000 });
  check('choose: Bea (not the owner) sees the list but cannot change it', (await pb.locator('[data-audience="everyone"]').isDisabled()) && (await pb.locator('[data-people-picker]').count()) === 0 && /Bea/.test(await pb.locator('[data-access]').innerText()));
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pc = await ctxC.newPage();
  await login(pc, { email: 'cal@example.test', next: '/projects' });
  check("choose: Cal's Projects list does not show it", !(await pc.locator('body').innerText()).includes(TEAM));
  await pc.goto(`${B}/projects/${teamId}`);
  check('choose: Cal cannot open its page', !(await pc.locator('body').innerText()).includes(TEAM));
  await pc.goto(`${B}/tasks/${tt.ref}`);
  check('choose: Cal cannot open its task', !(await pc.locator('body').innerText()).includes('Team task') && (await pc.locator('input[value="Team task"]').count()) === 0);
  await ctxC.close();

  // assignees must be on the list; only the owner changes it
  const assignCal = await as(kA, 'update_task', { task: tt.ref, assignee: 'cal@example.test' });
  check('assignee: someone off the list is refused', assignCal.isError && /chosen people/.test(assignCal.text), assignCal.text);
  const assignBea = await as(kA, 'update_task', { task: tt.ref, assignee: 'bea@example.test' });
  check('assignee: someone on the list is fine', !assignBea.isError && (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: tt.ref }))?.assigneeId === Bu.userId, assignBea.text);
  const beaList = await as(kB, 'update_project', { project: TEAM, shared_with: ['bea@example.test', 'cal@example.test'] });
  check('list: a non-owner cannot change it (MCP)', beaList.isError && /owner/i.test(beaList.text) && !(await team()).sharedWith.includes(Cal.userId), beaList.text);
  const outsider = await as(kA, 'update_project', { project: TEAM, shared_with: ['nobody@example.test'] });
  check('list: someone outside the organization is refused', outsider.isError && /not a member/.test(outsider.text), outsider.text);
  // MCP: Cal on, Bea off. Bea's own task goes to the owner, her assignment ends, her queued Claude task ends.
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: bt.ref }, { $set: { claude: mark({}) } });
  const swap = await as(kA, 'update_project', { project: TEAM, shared_with: ['cal@example.test'] });
  check('list (MCP): swap Bea for Cal', !swap.isError && (await team()).sharedWith.includes(Cal.userId) && !(await team()).sharedWith.includes(Bu.userId), swap.text);
  const btDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: bt.ref });
  check("list: Bea's own task in it now belongs to the owner (she is off the list)", btDoc?.ownerId === A.userId && btDoc.visibility === 'members' && !btDoc.claude, JSON.stringify(btDoc && [btDoc.ownerId === A.userId, btDoc.visibility, btDoc.claude]));
  check("list: Bea's assignment ended", (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: tt.ref }))?.assigneeId === null);
  bs = await sees(kB, 'Bea team task');
  cs = await sees(kC, 'Team task');
  check('list: Bea now sees nothing of it, not even the task she made', !bs.project && !bs.task && !bs.note, JSON.stringify(bs));
  check('list: Cal now sees it', cs.project && cs.task && cs.note, JSON.stringify(cs));
  const gp = await must(kA, 'get_project', { project: TEAM });
  check('MCP get_project: lists who sees it by name', gp.project.visibility === 'members' && gp.project.sharedWith?.includes('me') && gp.project.sharedWith.includes('Cal'), JSON.stringify(gp.project.sharedWith));
  // back to everyone: no confirm (nobody loses access)
  await pa.goto(`${B}/projects/${teamId}?tab=info`);
  await pa.waitForSelector('[data-audience="everyone"]', { timeout: 15000 });
  await pa.click('[data-audience="everyone"]');
  check('everyone: one click shares it with everyone again', !!(await until(async () => (await team())?.visibility === 'org')) && (await pa.locator('[data-cut-confirm]').count()) === 0);
  check('everyone: its tasks follow (no list left)', (await rawDb.collection('tasks').countDocuments({ projectId: teamId, $or: [{ visibility: { $ne: 'org' } }, { 'sharedWith.0': { $exists: true } }] })) === 0);
  check('everyone: Bea sees it again', (await sees(kB, 'Team task')).project);
  // the New project dialog offers Choose people under Shared
  await pa.goto(`${B}/projects`);
  await pa.click('button:has-text("New project"):visible');
  await pa.waitForSelector('[data-sharing-choice]', { timeout: 15000 });
  check('dialog: Shared offers Everyone (picked) or Choose people', (await pa.getAttribute('[data-audience="everyone"]', 'aria-checked')) === 'true');
  await pa.fill('input[placeholder="Name"]', 'Picked Plan');
  await pa.click('[data-audience="people"]');
  await pa.click(`[data-people-picker] [data-person="${Bu.userId}"] input`);
  await pa.click('button[type=submit]:has-text("Create")');
  await pa.waitForURL(u => u.pathname.startsWith('/projects/') && u.pathname !== '/projects', { timeout: 20000 });
  const picked = await rawDb.collection('projects').findOne({ orgId: A.orgId, name: 'Picked Plan' });
  check('dialog: Choose people makes a project shared with you and the people ticked', picked?.visibility === 'members' && picked.sharedWith.length === 2 && picked.sharedWith.includes(A.userId) && picked.sharedWith.includes(Bu.userId), JSON.stringify(picked && [picked.visibility, picked.sharedWith]));
  await Promise.all([ctxA.close(), ctxB.close(), ctxP.close()]);
} catch (e) {
  check('suite ran to the end', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await browser.close().catch(() => {});
}
await finish();
