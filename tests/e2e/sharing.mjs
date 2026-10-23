// Shared / Private projects from the app: the new-project choice, switching on the project's Info tab (owner only, with a
// confirm that names who loses access), the Private badge, and what a teammate can see at each step. Seed profile: none.
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
  await pp.waitForSelector(`a[href="/projects/${id}"]`, { timeout: 15000 });
  check('phone: the list card carries the Private badge', (await pp.locator(`a[href="/projects/${id}"] [data-private-badge]:visible`).count()) > 0);
  await pp.click('button[aria-label="New project"]');
  await pp.waitForSelector('[data-sharing-choice]', { timeout: 15000 });
  check('phone: the new-project sheet has the choice, Shared by default', (await pp.getAttribute('[data-sharing="org"]', 'aria-checked')) === 'true' && (await pp.locator('[data-sharing-help]').count()) > 0);
  await pp.goto(`${B}/projects/${id}`);
  await pp.waitForSelector('[data-edit-header]', { timeout: 15000 });
  check('phone: the project header shows Private', (await pp.locator('[data-private-badge]:visible').count()) > 0);
  await Promise.all([ctxA.close(), ctxB.close(), ctxP.close()]);
} catch (e) {
  check('suite ran to the end', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await browser.close().catch(() => {});
}
await finish();
