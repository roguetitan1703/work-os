// Team (docs/multi-user.md phase 4): assignees, alerts to the assignee, take-back through a sub-page of a task's note,
// the phase 2 review leftovers (project made private onto a private name, restore order), and Settings › Members:
// invite, accept, role changes, the last-owner guard, and removing a member (sessions, Claude keys, computers and
// claims stop; their private things are kept). Seed profile: none (this suite makes its own people and data).
import { B, CRON, EMAIL, ME, MCP, PW, check, finish, launch, login, makeUser, mkKey, rawDb, setProfile, sha, pick } from './lib.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';

let rid = 0;
async function as(key, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  let b;
  try { b = JSON.parse(line ? line.slice(5) : t); } catch { return { isError: true, status: r.status, text: t, json: null }; }
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!b.result?.isError || !!b.error || r.status >= 400, status: r.status, text, json };
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
const idIn = id => ({ $in: ObjectId.isValid(id) && String(id).length === 24 ? [new ObjectId(id), String(id)] : [String(id)] });
const mcpStatus = key => fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/list' }) }).then(r => r.status);
const cron = () => fetch(`${B}/api/cron/alerts`, { headers: { authorization: `Bearer ${CRON}` } }).then(r => r.json());
const roleOf = async (userId, orgId) => (await rawDb.collection('member').findOne({ userId: idIn(userId), organizationId: idIn(orgId) }))?.role ?? null;
const task = async (orgId, ref) => rawDb.collection('tasks').findOne({ orgId, ref });
// No quiet hours: alerts go out whatever time the suite runs.
const NO_QUIET = { quietStart: 0, quietEnd: 0 };

const browser = await launch();
try {
  const A = ME;
  const kA = MCP;
  const ownerEmail = EMAIL;
  await setProfile(A, NO_QUIET);
  const Bu = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: A.orgId, role: 'member' });
  await setProfile(Bu, { timezone: 'Asia/Kolkata', ...NO_QUIET });
  const kB = await mkKey({ agent: 'claude', userId: Bu.userId, orgId: A.orgId, name: 'bea chat' });
  await makeUser({ email: 'cy@example.test', name: 'Cy', orgName: 'Other Org' });

  // ======== 1. assignee ========
  await must(kA, 'add_project', { name: 'Team Shared' });
  const t1 = (await must(kA, 'add_task', { title: 'Team task for Bea', project: 'Team Shared', assignee: 'bea@example.test' })).created;
  check('assign: add_task takes an assignee (by email) and shows the name', t1.assignee === 'Bea', JSON.stringify(t1));
  check('assign: stored as the member\'s user id', (await task(A.orgId, t1.ref))?.assigneeId === Bu.userId);
  const note1 = await until(() => rawDb.collection('notifications').findOne({ userId: Bu.userId, kind: 'assigned' }));
  check('assign: the assignee gets an inbox notice at once, saying who', !!note1 && note1.title.includes(`#${t1.ref}`) && /E2E Owner/.test(note1.title), JSON.stringify(note1));
  check('assign: whoever assigned gets no notice', (await rawDb.collection('notifications').countDocuments({ userId: A.userId, kind: 'assigned' })) === 0);
  check('get_task: shows the assignee', (await must(kA, 'get_task', { task: t1.ref })).assignee === 'Bea');
  const bMine = await must(kB, 'list_tasks', { assignee: 'me' });
  check('list_tasks assignee:"me": the assignee\'s own list', bMine.tasks.length === 1 && bMine.tasks[0].ref === t1.ref && bMine.tasks[0].assignee === 'me', JSON.stringify(bMine.tasks));
  const t2 = (await must(kB, 'add_task', { title: 'Bea assigns herself', project: 'Team Shared', assignee: 'me' })).created;
  await sleep(2500);
  check('assign: assigning yourself sends no notice', (await rawDb.collection('notifications').countDocuments({ userId: Bu.userId, kind: 'assigned' })) === 1);
  check('assign: "me" is the caller', (await task(A.orgId, t2.ref))?.assigneeId === Bu.userId);
  const outsider = await as(kA, 'update_task', { task: t1.ref, assignee: 'cy@example.test' });
  check('assign: someone outside the organization is refused', outsider.isError && /not a member/.test(outsider.text), outsider.text);
  for (const name of ['constructor', 'toString', '__proto__']) {
    const odd = await as(kA, 'update_task', { task: t1.ref, assignee: name });
    check(`assign: "${name}" is not a member (no inherited keys)`, odd.isError && /not a member/.test(odd.text), odd.text);
  }
  const re = await as(kA, 'update_task', { task: t1.ref, assignee: null });
  check('assign: null clears it', !re.isError && (await task(A.orgId, t1.ref))?.assigneeId === null, re.text);
  const hist = (await must(kA, 'get_task', { task: t1.ref })).activity.map(a => a.text).join(' | ');
  check('assign: history names the people, not ids', /assignee Bea → —/.test(hist), hist);

  // a private task can't be assigned to anyone else
  const priv = await as(kA, 'add_task', { title: 'Private for Bea', assignee: 'bea@example.test' });
  check('private: add_task with a teammate as assignee is refused', priv.isError && /private/.test(priv.text), priv.text);
  check('private: and nothing was created', !(await rawDb.collection('tasks').findOne({ title: 'Private for Bea' })));
  const p1 = (await must(kA, 'add_task', { title: 'Private loose task' })).created;
  const priv2 = await as(kA, 'update_task', { task: p1.ref, assignee: 'bea@example.test' });
  check('private: update_task with a teammate as assignee is refused', priv2.isError && /private/.test(priv2.text), priv2.text);
  const self = await as(kA, 'update_task', { task: p1.ref, assignee: 'me' });
  check('private: its owner may be its assignee', !self.isError && (await task(A.orgId, p1.ref))?.assigneeId === A.userId, self.text);
  const bat = await as(kA, 'apply_changes', { ops: [{ op: 'create_task', title: 'Batch private for Bea', assignee: 'bea@example.test' }] });
  check('private: apply_changes create_task follows the same rule (nothing saved)', bat.isError && /private/.test(bat.text) && !(await rawDb.collection('tasks').findOne({ title: 'Batch private for Bea' })), bat.text);
  const t3 = (await must(kA, 'add_task', { title: 'Moves to private', project: 'Team Shared', assignee: 'bea@example.test' })).created;
  await must(kA, 'update_task', { task: t3.ref, project: null });
  const t3d = await task(A.orgId, t3.ref);
  check('private: taking a task out of its shared project drops a teammate assignee', t3d?.visibility === 'private' && t3d.assigneeId === null, JSON.stringify(t3d && [t3d.visibility, t3d.assigneeId]));
  await must(kA, 'add_project', { name: 'Goes Private' });
  const t4 = (await must(kA, 'add_task', { title: 'In a project made private', project: 'Goes Private', assignee: 'bea@example.test' })).created;
  await must(kA, 'update_project', { project: 'Goes Private', visibility: 'private' });
  check('private: making the project private drops teammate assignees', (await task(A.orgId, t4.ref))?.assigneeId === null);

  // ======== 2. alerts go to the assignee ========
  const t5 = (await must(kA, 'add_task', { title: 'Old P1 nobody started', project: 'Team Shared', priority: 'P1' })).created;
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: t5.ref }, { $set: { createdAt: new Date(Date.now() - 3 * 864e5) } });
  const ns = who => rawDb.collection('notifications').countDocuments({ userId: who.userId, kind: 'never_started', title: { $regex: `#${t5.ref} ` } });
  await cron();
  check('alerts: with nobody assigned, the owner gets the alert', (await ns(A)) === 1 && (await ns(Bu)) === 0, `A ${await ns(A)} Bea ${await ns(Bu)}`);
  await must(kA, 'update_task', { task: t5.ref, assignee: 'bea@example.test' });
  await cron();
  check('alerts: once assigned, the assignee gets it (the owner had it already: the log is per recipient)', (await ns(Bu)) === 1, String(await ns(Bu)));
  check('alerts: the owner does not get it again', (await ns(A)) === 1, String(await ns(A)));
  await cron();
  check('alerts: and the assignee only once', (await ns(Bu)) === 1, String(await ns(Bu)));

  // ======== 3. take-back through a sub-page of a task's note ========
  const mark = (extra = {}) => ({ state: 'queued', markedAt: new Date(), markedBy: 'user', markedByUserId: A.userId, markedByOrgId: A.orgId, ...extra });
  const t6 = (await must(kA, 'add_task', { title: 'Given to Claude', project: 'Team Shared' })).created;
  const setMark = m => rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: t6.ref }, { $set: { claude: m } });
  await setMark(mark());
  const root = (await must(kA, 'write_note', { task: t6.ref, body: 'Root note' })).created;
  const sub = (await must(kA, 'write_note', { parent_id: root.id, title: 'Sub page', body: 'Sub body' })).created;
  const sub2 = (await must(kA, 'write_note', { parent_id: sub.id, title: 'Sub sub page', body: 'Deeper' })).created;
  check('take-back: the giver\'s own note edits keep it queued', (await task(A.orgId, t6.ref))?.claude?.state === 'queued');
  await must(kB, 'write_note', { note_id: sub.id, append: 'Bea edits the sub-page' });
  let c6 = (await task(A.orgId, t6.ref))?.claude;
  check('take-back: a teammate editing a sub-page takes the task back', c6?.state === 'stopped' && /taken back: changed by Claude for Bea/.test(c6.note ?? ''), JSON.stringify(c6));
  check('take-back: the giver is told', (await rawDb.collection('notifications').countDocuments({ userId: A.userId, kind: 'claude_stopped', title: { $regex: `#${t6.ref} changed by Claude for Bea` } })) === 1);
  await setMark(mark());
  await must(kB, 'write_note', { note_id: sub2.id, append: 'two levels down' });
  check('take-back: two levels down too', (await task(A.orgId, t6.ref))?.claude?.state === 'stopped');
  await setMark(mark({ state: 'running', sessionId: randomUUID(), claimedAt: new Date(), deviceId: 'no-such-device' }));
  await must(kB, 'write_note', { parent_id: root.id, title: 'Bea adds a page', body: 'new' });
  check('take-back: a teammate adding a sub-page stops a running one', (await task(A.orgId, t6.ref))?.claude?.state === 'stopped');
  await setMark(mark());
  await must(kB, 'delete_note', { note_id: sub2.id, title: 'Sub sub page' });
  check('take-back: a teammate deleting a sub-page takes it back', (await task(A.orgId, t6.ref))?.claude?.state === 'stopped');
  await setMark(mark());
  await must(kB, 'write_note', { project: 'Team Shared', title: 'Unrelated memo', body: 'x' });
  check('take-back: an unrelated note leaves it queued', (await task(A.orgId, t6.ref))?.claude?.state === 'queued');
  await must(kB, 'add_comment', { task: t6.ref, note: 'Bea comments' });
  c6 = (await task(A.orgId, t6.ref))?.claude;
  check('take-back: a teammate\'s comment still takes it back (before the write)', c6?.state === 'stopped');

  // ======== 4. phase 2 leftovers: private name clash, restore order ========
  const now = new Date();
  const proj = (id, visibility) => ({ _id: id, orgId: A.orgId, ownerId: A.userId, visibility, name: 'Dup Name', nameLower: 'dup name', client: '', description: '', status: 'active', createdAt: now, updatedAt: now });
  await rawDb.collection('projects').insertMany([proj('dup-shared-e2e', 'org'), proj('dup-private-e2e', 'private')]);
  const dupTask = (await must(kA, 'add_task', { title: 'In the shared Dup', project: 'dup-shared-e2e' })).created;
  const dup = await as(kA, 'update_project', { project: 'dup-shared-e2e', visibility: 'private' });
  check('project: made private onto a private name you use: a clear error, not a 500', dup.isError && /already have a private project/.test(dup.text), dup.text);
  check('project: and nothing moved (the project and its tasks stay shared)', (await rawDb.collection('projects').findOne({ _id: 'dup-shared-e2e' }))?.visibility === 'org' && (await task(A.orgId, dupTask.ref))?.visibility === 'org');
  const t7 = (await must(kA, 'add_task', { title: 'Trash and back again', project: 'Team Shared', assignee: 'bea@example.test' })).created;
  await must(kA, 'delete_task', { task: t7.ref, title: 'Trash and back again' });
  await must(kA, 'restore_task', { task: t7.ref });
  const t7d = await task(A.orgId, t7.ref);
  check('restore: the task is back, its trash entry gone, its assignee kept', !!t7d && t7d.assigneeId === Bu.userId && !(await rawDb.collection('trash').findOne({ _id: t7d._id })));

  // ======== 5. members: invite, accept, roles, last owner ========
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pa = await ctxA.newPage();
  await login(pa, { next: '/settings?section=members' });
  await pa.waitForSelector('[data-members]', { timeout: 15000 });
  const tess = 'tess@example.test';
  await pa.fill('input[aria-label="Email to invite"]', tess);
  await pick(pa, '[aria-label="Role"]', 'member');
  await pa.click('form button:has-text("Invite")');
  await pa.waitForSelector(`[data-invitation="${tess}"]`, { timeout: 15000 }).catch(() => {});
  check('invite: the invitation is listed as pending', (await pa.locator(`[data-invitation="${tess}"]`).count()) === 1);
  const link = ((await pa.locator('[data-invite-link] code').textContent().catch(() => '')) ?? '').trim();
  check('invite: the inviter sees the link (the default switch)', link.startsWith(B + '/accept-invitation/'), link);
  // a second invitation, revoked
  await pa.fill('input[aria-label="Email to invite"]', 'nobody@example.test');
  await pa.click('form button:has-text("Invite")');
  await pa.waitForSelector('[data-invitation="nobody@example.test"]', { timeout: 15000 }).catch(() => {});
  await pa.click('button[aria-label="Cancel invitation for nobody@example.test"]');
  const revoked = await until(async () => (await rawDb.collection('invitation').findOne({ email: 'nobody@example.test' }))?.status === 'canceled');
  check('invite: a pending invitation can be revoked', !!revoked);

  const ctxT = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pt = await ctxT.newPage();
  await pt.goto(link);
  await pt.fill('input[name=name]', 'Tess');
  await pt.fill('input[name=password]', PW);
  await pt.fill('input[name=again]', PW);
  await pt.click('button:has-text("Join")');
  await pt.waitForURL(u => u.pathname === '/today', { timeout: 20000 }).catch(() => {});
  check('accept: Tess joined and is signed in', new URL(pt.url()).pathname === '/today', pt.url());
  const tUser = await rawDb.collection('user').findOne({ email: tess });
  const T = { userId: String(tUser?._id), orgId: A.orgId };
  check('accept: Tess is a member', (await roleOf(T.userId, A.orgId)) === 'member');

  await pa.reload();
  await pa.waitForSelector(`[data-role-select="${tess}"]`, { timeout: 15000 });
  await pick(pa, `[data-role-select="${tess}"]`, 'admin');
  check('roles: the owner makes Tess an admin', !!(await until(async () => (await roleOf(T.userId, A.orgId)) === 'admin')));
  await pt.goto(B + '/settings?section=members');
  await pt.waitForSelector('[data-members]', { timeout: 15000 });
  check('roles: an admin gets no role control on an owner', (await pt.locator(`[data-role-select="${ownerEmail}"]`).count()) === 0 && (await pt.locator(`button[aria-label="Remove ${ownerEmail}"]`).count()) === 0);
  check('roles: an admin cannot invite an owner', (await (async () => { await pt.locator('[aria-label="Role"]').click(); const n = await pt.locator('[role=option][data-value="owner"]').count(); await pt.keyboard.press('Escape'); return n; })()) === 0);
  check('roles: an admin manages members', (await pt.locator('[data-role-select="bea@example.test"]').count()) === 1);
  // Tess is demoted behind the role cache (as by another server): her open page must not still manage members
  await rawDb.collection('member').updateOne({ userId: idIn(T.userId), organizationId: idIn(A.orgId) }, { $set: { role: 'member' } });
  await pick(pt, '[data-role-select="bea@example.test"]', 'admin');
  await sleep(2000);
  check('roles: a demotion counts at once (fresh role, not the cached one)', (await roleOf(Bu.userId, A.orgId)) === 'member');
  await rawDb.collection('member').updateOne({ userId: idIn(T.userId), organizationId: idIn(A.orgId) }, { $set: { role: 'admin' } });

  // Better Auth's organization reads: invitations only for owners and admins, never their tokenHash
  const fullOrg = async pg => { const r = await pg.request.get(B + '/api/auth/organization/get-full-organization'); return { status: r.status(), json: await r.json().catch(() => null) }; };
  const ownerView = await fullOrg(pa);
  const invs = ownerView.json?.invitations ?? [];
  check('get-full-organization: the owner sees the invitations', ownerView.status === 200 && invs.length >= 1, JSON.stringify(ownerView.json)?.slice(0, 200));
  check('get-full-organization: no tokenHash in any invitation', invs.every(i => !('tokenHash' in i)) && !JSON.stringify(ownerView.json).includes('tokenHash'));
  const ctxBe = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pbe = await ctxBe.newPage();
  await login(pbe, { email: 'bea@example.test', password: PW });
  const memberView = await fullOrg(pbe);
  check('get-full-organization: a plain member sees no invitations', memberView.status === 200 && Array.isArray(memberView.json?.invitations) && memberView.json.invitations.length === 0 && !JSON.stringify(memberView.json).includes('tokenHash'), JSON.stringify(memberView.json)?.slice(0, 200));
  const li = await pbe.request.get(B + '/api/auth/organization/list-invitations');
  check('list-invitations is not served', li.status() === 404, String(li.status()));
  await ctxBe.close();

  // the last owner can't step down
  await pa.reload();
  await pa.waitForSelector(`[data-role-select="${ownerEmail}"]`, { timeout: 15000 });
  const refusedP = pa.waitForSelector('text=needs an owner', { timeout: 15000 }).then(() => true).catch(() => false);
  await pick(pa, `[data-role-select="${ownerEmail}"]`, 'admin');
  const refused = await refusedP;
  check('last owner: stepping down is refused with a reason', refused);
  check('last owner: still the owner', (await roleOf(A.userId, A.orgId)) === 'owner');
  // with a second owner it works; the new owner promotes the first back
  await pick(pa, `[data-role-select="${tess}"]`, 'owner');
  check('roles: an owner promotes to owner', !!(await until(async () => (await roleOf(T.userId, A.orgId)) === 'owner')));
  await pa.reload();
  await pa.waitForSelector(`[data-role-select="${ownerEmail}"]`, { timeout: 15000 });
  await pick(pa, `[data-role-select="${ownerEmail}"]`, 'admin');
  check('roles: with another owner, an owner may step down', !!(await until(async () => (await roleOf(A.userId, A.orgId)) === 'admin')));
  await pt.reload();
  await pt.waitForSelector(`[data-role-select="${ownerEmail}"]`, { timeout: 15000 });
  await pick(pt, `[data-role-select="${ownerEmail}"]`, 'owner');
  check('roles: and is made owner again', !!(await until(async () => (await roleOf(A.userId, A.orgId)) === 'owner')));

  // ======== 6. removing a member ends their access ========
  const R = await makeUser({ email: 'rex@example.test', name: 'Rex', orgId: A.orgId, role: 'member' });
  const kR = await mkKey({ agent: 'claude', userId: R.userId, orgId: A.orgId, name: 'rex chat' });
  const kRcode = await mkKey({ agent: 'claude-code', userId: R.userId, orgId: A.orgId, name: 'rex code' });
  const devKey = 'wkr_' + randomBytes(32).toString('base64url');
  const devId = randomUUID();
  await rawDb.collection('devices').insertOne({ _id: devId, name: 'Rex-PC', ownerId: R.userId, orgId: A.orgId, hash: sha(devKey), prefix: devKey.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  const rTask = (await must(kR, 'add_task', { title: 'Rex gave this to Claude', project: 'Team Shared' })).created;
  await rawDb.collection('tasks').updateOne({ orgId: A.orgId, ref: rTask.ref }, { $set: { claude: { state: 'queued', markedAt: new Date(), markedBy: 'user', markedByUserId: R.userId, markedByOrgId: A.orgId } } });
  const rAssigned = (await must(kA, 'add_task', { title: 'Assigned to Rex', project: 'Team Shared', assignee: 'rex@example.test' })).created;
  const rPriv = (await must(kR, 'add_task', { title: 'Rex private thing' })).created;
  const rPrivBefore = await task(A.orgId, rPriv.ref);
  // an invitation Rex sent (as if he had been an admin) and an alert waiting for him
  const tessInv = await rawDb.collection('invitation').findOne({ email: tess });
  const rexInvId = new ObjectId();
  await rawDb.collection('invitation').insertOne({ ...tessInv, _id: rexInvId, email: 'rex-alt@example.test', status: 'pending', inviterId: tessInv.inviterId instanceof ObjectId ? new ObjectId(R.userId) : R.userId, expiresAt: new Date(Date.now() + 864e5), tokenHash: sha('x'.repeat(40)) });
  await rawDb.collection('alertQueue').insertOne({ _id: `assigned:test:${R.userId}:1`, orgId: A.orgId, userId: R.userId, kind: 'assigned', taskId: 'none', byTaskId: 'none', createdAt: new Date(), sentAt: null, detail: 'test' });
  const poll = () => fetch(B + '/api/worker/jobs', { headers: { authorization: `Bearer ${devKey}` } }).then(r => r.status);
  check('before: Rex\'s keys and computer work', (await mcpStatus(kR)) === 200 && (await mcpStatus(kRcode)) === 200 && (await poll()) === 200);
  const ctxR = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pr = await ctxR.newPage();
  await login(pr, { email: 'rex@example.test', password: PW });
  check('before: Rex is signed in', new URL(pr.url()).pathname === '/today', pr.url());

  await pa.goto(B + '/settings?section=members');
  await pa.waitForSelector('button[aria-label="Remove rex@example.test"]', { timeout: 15000 });
  await pa.click('button[aria-label="Remove rex@example.test"]');
  await pa.click('[data-remove-confirm="rex@example.test"] button:has-text("Remove")');
  check('remove: Rex is no longer a member', !!(await until(async () => (await roleOf(R.userId, A.orgId)) === null)));
  await sleep(500);
  check('remove: his Claude chat and Claude Code keys stop working', (await mcpStatus(kR)) === 401 && (await mcpStatus(kRcode)) === 401);
  check('remove: his keys for the organization are deleted', (await rawDb.collection('apikey').countDocuments({ referenceId: idIn(R.userId) })) === 0);
  check('remove: his computer is refused', (await poll()) === 401);
  check('remove: his computer is revoked', !!(await rawDb.collection('devices').findOne({ _id: devId }))?.revokedAt);
  check('remove: his sessions in the organization are deleted', (await rawDb.collection('session').countDocuments({ userId: idIn(R.userId) })) === 0);
  await pr.goto(B + '/today');
  await pr.waitForURL(u => u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
  check('remove: his open browser is signed out', new URL(pr.url()).pathname.startsWith('/login'), pr.url());
  const rc = (await task(A.orgId, rTask.ref))?.claude;
  check('remove: the task he gave to Claude stops', rc?.state === 'stopped', JSON.stringify(rc));
  check('remove: a task assigned to him goes back to its owner', (await task(A.orgId, rAssigned.ref))?.assigneeId === null);
  const rPrivAfter = await task(A.orgId, rPriv.ref);
  check('remove: his private task is kept untouched', !!rPrivAfter && rPrivAfter.ownerId === R.userId && rPrivAfter.visibility === 'private' && rPrivAfter.updatedAt.getTime() === rPrivBefore.updatedAt.getTime());
  const aSees = await as(kA, 'get_task', { task: rPriv.ref });
  check('remove: nobody else can reach his private task', aSees.isError, aSees.text.slice(0, 120));
  check('remove: invitations he sent are cancelled', (await rawDb.collection('invitation').findOne({ _id: rexInvId }))?.status === 'canceled');
  check('remove: alerts waiting for him are dropped', (await rawDb.collection('alertQueue').countDocuments({ userId: R.userId, sentAt: null })) === 0);
  // one queued after the removal (a race) is never sent: a flush skips anyone who is not a member (section 7 flushes)
  await rawDb.collection('alertQueue').insertOne({ _id: `assigned:test:${R.userId}:2`, orgId: A.orgId, userId: R.userId, kind: 'assigned', taskId: (await task(A.orgId, rAssigned.ref))._id, byTaskId: 'none', createdAt: new Date(), sentAt: null, detail: 'test' });
  check('remove: the shared task he made stays in the organization', !(await as(kA, 'get_task', { task: rTask.ref })).isError);

  // removing an owner who is not the last one
  await pa.reload();
  await pa.waitForSelector(`button[aria-label="Remove ${tess}"]`, { timeout: 15000 });
  await pa.click(`button[aria-label="Remove ${tess}"]`);
  await pa.click(`[data-remove-confirm="${tess}"] button:has-text("Remove")`);
  check('remove: an owner can remove another owner', !!(await until(async () => (await roleOf(T.userId, A.orgId)) === null)));
  check('remove: the remover is still the owner', (await roleOf(A.userId, A.orgId)) === 'owner');
  await pt.goto(B + '/today');
  await pt.waitForURL(u => u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {});
  check('remove: Tess (phone) is signed out', new URL(pt.url()).pathname.startsWith('/login'), pt.url());

  // ======== 7. assignee picker and "Assigned to me" views ========
  const t8 = (await must(kA, 'add_task', { title: 'Picker task', project: 'Team Shared' })).created;
  await pa.goto(`${B}/tasks/${t8.ref}`);
  await pa.waitForSelector('[data-assignee-picker]', { timeout: 15000 });
  await pick(pa, '[data-assignee-picker]', Bu.userId);
  check('picker (desktop): assigns from the task page', !!(await until(async () => (await task(A.orgId, t8.ref))?.assigneeId === Bu.userId)));
  check('picker: the assignee is told at once (the flush ran)', !!(await until(() => rawDb.collection('notifications').findOne({ userId: Bu.userId, kind: 'assigned', title: { $regex: `#${t8.ref} ` } }))));
  check('flush: nothing goes to a removed member', (await rawDb.collection('alertQueue').findOne({ _id: `assigned:test:${R.userId}:2` }))?.sentAt === null);
  await pa.goto(`${B}/tasks/${p1.ref}`);
  await pa.waitForSelector('text=Private: only you', { timeout: 15000 }).catch(() => {});
  check('picker (desktop): a private task offers no picker', (await pa.locator('[data-assignee-picker]').count()) === 0 && (await pa.locator('text=Private: only you').count()) > 0);
  // A is assigned two tasks: t8 goes to A too, plus p1 (own private)
  await must(kA, 'update_task', { task: t8.ref, assignee: 'me' });
  await pa.goto(`${B}/tasks?assigned=me`);
  await pa.waitForSelector('[data-assigned-filter]', { timeout: 15000 });
  const shown = (pg, ref) => pg.locator(`a[href="/tasks/${ref}"]:visible`).count();
  check('Tasks › Assigned to me (desktop): only tasks assigned to you', (await shown(pa, t8.ref)) > 0 && (await shown(pa, p1.ref)) > 0 && (await shown(pa, t5.ref)) === 0 && (await shown(pa, t2.ref)) === 0);
  check('Tasks › Assigned to me (desktop): the button is on', (await pa.getAttribute('[data-assigned-filter]', 'aria-pressed')) === 'true');
  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ctxP.newPage();
  await login(pp, { phone: true, next: '/tasks?assigned=me' });
  await pp.waitForSelector(`a[href="/tasks/${t8.ref}"]:visible`, { timeout: 15000 }).catch(() => {});
  check('Tasks › Assigned to me (phone): only tasks assigned to you', (await shown(pp, t8.ref)) > 0 && (await shown(pp, t5.ref)) === 0 && (await shown(pp, t2.ref)) === 0);
  await pp.goto(`${B}/today`);
  await pp.waitForSelector('[data-variant="phone"]', { timeout: 15000 });
  const todayPhone = await pp.locator('[data-variant="phone"]').innerText();
  check('Today (phone): an "Assigned to you" section and a link to them all', /Assigned to you/i.test(todayPhone) && /assigned to you in Tasks/.test(todayPhone), todayPhone.slice(0, 400));
  await pa.goto(`${B}/today`);
  await pa.waitForSelector('[data-variant="desk"]', { timeout: 15000 });
  const todayDesk = await pa.locator('[data-variant="desk"]').innerText();
  check('Today (desktop): "Assigned to you"', /Assigned to you/i.test(todayDesk) && /Picker task/.test(todayDesk), todayDesk.slice(0, 400));
  await pp.goto(`${B}/tasks/${t1.ref}`);
  await pp.waitForSelector('select:visible', { timeout: 15000 }).catch(() => {});
  const phonePicker = await pp.locator('select:visible').evaluateAll(els => els.map(e => [...e.options].map(o => o.text).join(',')));
  check('picker (phone): the task screen lists members to assign', phonePicker.some(o => /Me/.test(o) && /Bea/.test(o)), JSON.stringify(phonePicker));
  await Promise.all([ctxA.close(), ctxT.close(), ctxR.close(), ctxP.close()]);
} catch (e) {
  check('suite ran to the end', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await browser.close().catch(() => {});
}
await finish();
