// Turbo mode: Start Claude (and a task given to Claude) on a project whose repo is not on the PC yet makes the PC's worker clone it, link the folder
// and start. A stub worker (device key + the worker API) plays the PC: what the server hands out, what it shows, what it refuses. Seed profile: none.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { launch, B, PW, ME, db, check, finish, api, makeUser, login, pick } from './lib.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');

for (const n of ['tasks', 'activity', 'alertLog', 'alertQueue', 'notifications', 'workerSessions', 'workerJobs', 'workerFolders', 'devices', 'settings', 'projects', 'notes', 'trash', 'claudeItems']) await db.collection(n).deleteMany({});
const now = new Date();
const proj = (id, name, code) => ({ _id: id, name, nameLower: name.toLowerCase(), client: '', description: '', status: 'active', createdAt: now, updatedAt: now, ...(code ? { code } : {}) });
await db.collection('projects').insertMany([
  proj('tp1', 'Turbo One', [{ remote: 'delpat-tech/turbo-demo' }]),
  proj('tp2', 'No Repo Co'),
  proj('tp3', 'Gitlab Two', [{ remote: 'acme/widgets', host: 'gitlab.com' }]),
  proj('tp4', 'Scanned Four', [{ remote: 'delpat-tech/scanned-four' }]),
  proj('tp5', 'Dispatch Five', [{ remote: 'delpat-tech/dispatch-five' }]),
  proj('tp6', 'Elsewhere Six', [{ remote: 'delpat-tech/elsewhere-six' }]),
]);
const dev = async (name, worker) => {
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  const id = randomUUID();
  await db.collection('devices').insertOne({ _id: id, name, ownerId: ME.userId, orgId: ME.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: now, lastSeenAt: now, revokedAt: null, ...(worker ? { worker } : {}) });
  return { id, key };
};
const status = (d, extra = {}, worker = { version: '0.2.0', os: 'win32', allowPrompts: true, allowClone: true, projectsDir: 'D:\\Work' }) => api(d.key, 'POST', '/api/worker/status', { worker, jobs: [], sessions: [], ...extra });
const poll = d => api(d.key, 'GET', '/api/worker/jobs');
const T = await dev('PC-T');
const OFF = await dev('PC-Off');
const OLD = await dev('PC-Old', { version: '0.1.0', os: 'win32', allowPrompts: true });

// ── what a worker reports ──
await status(T);
await status(OFF, {}, { version: '0.2.0', os: 'win32', allowPrompts: true, allowClone: false, projectsDir: 'E:\\Code' });
let w = (await db.collection('devices').findOne({ _id: T.id })).worker;
check('status stores allowClone and projectsDir', w.allowClone === true && w.projectsDir === 'D:\\Work', JSON.stringify(w));
check('allowClone false is kept as false', (await db.collection('devices').findOne({ _id: OFF.id })).worker.allowClone === false);
await status(OLD, {}, { version: '0.1.0', os: 'win32', allowPrompts: true });
check('an older worker (no allowClone) is stored without it, so it reads as "cannot clone yet"', (await db.collection('devices').findOne({ _id: OLD.id })).worker.allowClone === undefined);
await status(T, {}, { version: '0.2.0', os: 'win32', allowPrompts: true, allowClone: true, projectsDir: 'D:\\Work\u0000\n' });
check('projectsDir is cleaned of control characters', (await db.collection('devices').findOne({ _id: T.id })).worker.projectsDir === 'D:\\Work');
await status(T, {}, { version: '0.2.0', os: 'win32', allowPrompts: true, allowClone: true });
check('allowClone true without a projects folder does not count as ready', (await db.collection('devices').findOne({ _id: T.id })).worker.allowClone === false);
await status(T);

// ── code location keeps the host of a full URL ──
const savedCode = (await db.collection('projects').findOne({ _id: 'tp3' })).code;
check('a gitlab location is stored with its host', savedCode[0].host === 'gitlab.com');

const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(p.url() + ' ' + e.message.slice(0, 300)));
try {
  await login(p);

  // ── Info › Code and the Start sheet say what will happen ──
  await p.goto(B + '/projects/tp1?tab=info');
  await p.locator('[data-turbo-device="PC-T"]').waitFor();
  const lineT = await p.locator('[data-turbo-device="PC-T"]').innerText();
  check('Info › Code: "Not on PC-T yet" with the folder it will clone into', /Not on PC-T yet/.test(lineT) && lineT.includes('D:\\Work\\turbo-demo'), lineT);
  check('Info › Code: cloning off on PC-Off is said', /Cloning is turned off/.test(await p.locator('[data-turbo-device="PC-Off"]').innerText()));
  check('Info › Code: older worker is said', /older and cannot clone/.test(await p.locator('[data-turbo-device="PC-Old"]').innerText()));
  await p.goto(B + '/projects/tp2?tab=info');
  await p.locator('[data-turbo-norepo]').waitFor();
  check('project without a repo: "Add the repo in Info › Code to let your PC clone it"', /Add the repo in Info › Code to let your PC clone it/.test(await p.locator('[data-turbo-norepo]').innerText()));

  // ── Start on a project that is not on the PC: Clone and start ──
  await p.goto(B + '/projects/tp1?start=tp1');
  await p.locator('[data-start-step="confirm"]').waitFor();
  await pick(p, '[aria-label="Computer"]', { label: 'PC-T' }).catch(() => {});
  await p.locator('[data-turbo-clone]').waitFor();
  const cloneText = await p.locator('[data-turbo-clone]').innerText();
  check('Start sheet: will clone delpat-tech/turbo-demo into D:\\Work\\turbo-demo', cloneText.includes('delpat-tech/turbo-demo') && cloneText.includes('D:\\Work\\turbo-demo'), cloneText);
  await p.fill('textarea[aria-label="First message"]', 'hello turbo');
  await p.locator('[data-start-clone]').click();
  await p.waitForFunction(() => !document.querySelector('[data-start-step]'));
  const job = await db.collection('workerJobs').findOne({ deviceId: T.id, kind: 'start' });
  check('a clone job was made for PC-T: repo, project, prompt, no folder', !!job && job.clone?.repo === 'delpat-tech/turbo-demo' && job.projectId === 'tp1' && job.prompt === 'hello turbo' && !job.folderId, JSON.stringify(job));
  const sess = await db.collection('workerSessions').findOne({ _id: job?.sessionId });
  check('its session is starting and cloning, with no folder yet', sess?.state === 'starting' && sess.cloning === true && sess.folderId === '' && sess.repo === 'delpat-tech/turbo-demo', JSON.stringify(sess));
  check('no job for the other computers', (await db.collection('workerJobs').countDocuments({ deviceId: { $in: [OFF.id, OLD.id] } })) === 0);
  await p.goto(B + '/projects/tp1?tab=claude');
  await p.locator(`[data-session="${sess._id}"]`).waitFor();
  check('session row says Cloning', /Cloning/.test(await p.locator(`[data-session="${sess._id}"]`).innerText()), await p.locator(`[data-session="${sess._id}"]`).innerText());

  // The stub worker plays the PC.
  let jb = await poll(T);
  const got = jb.body.jobs.find(j => j.id === job._id);
  check('the worker gets the clone job with the repo and the project name', got?.clone?.repo === 'delpat-tech/turbo-demo' && got.projectName === 'Turbo One' && !got.folderId && got.prompt === 'hello turbo', JSON.stringify(jb.body.jobs));
  await api(T.key, 'POST', '/api/worker/status', { sessions: [{ sessionId: sess._id, state: 'starting', phase: 'cloning' }] });
  check('a cloning heartbeat keeps the row cloning', (await db.collection('workerSessions').findOne({ _id: sess._id })).cloning === true);
  await api(T.key, 'POST', '/api/worker/folders', { folders: [{ id: 'f_clone1', name: 'turbo-demo', git: true, remote: 'https://github.com/delpat-tech/turbo-demo.git', branch: 'main' }] });
  await api(T.key, 'POST', '/api/worker/status', { sessions: [{ sessionId: sess._id, state: 'starting', phase: 'starting' }] });
  await p.reload();
  check('after the clone the row says starting, not cloning', !/Cloning/.test(await p.locator(`[data-session="${sess._id}"]`).innerText()) && /starting/i.test(await p.locator(`[data-session="${sess._id}"]`).innerText()));
  await api(T.key, 'POST', '/api/worker/status', { jobs: [{ id: job._id, ok: true, folderId: 'f_clone1' }], sessions: [{ sessionId: sess._id, state: 'running' }] });
  const f1 = await db.collection('workerFolders').findOne({ _id: `${T.id}:f_clone1` });
  const s2 = await db.collection('workerSessions').findOne({ _id: sess._id });
  check('the new folder is linked to the project', f1?.projectId === 'tp1' && !!f1.linkedAt, JSON.stringify(f1));
  check('the session shows in that folder, running, no longer cloning', s2.folderId === 'f_clone1' && s2.state === 'running' && !s2.cloning, JSON.stringify(s2));
  jb = await poll(T);
  check('the next poll lists the folder as linked', jb.body.links.some(l => l.folderId === 'f_clone1' && l.projectId === 'tp1'), JSON.stringify(jb.body.links));
  await p.goto(B + '/projects/tp1?start=tp1');
  await p.locator('[data-start-step="confirm"]:not([data-start-mode="loading"])').waitFor();
  check('Start now shows the linked folder (no clone)', (await p.locator('[data-start-step]').getAttribute('data-start-mode')) === 'linked' && (await p.locator('[data-turbo-clone]').count()) === 0);
  await p.goto(B + '/projects/tp1?tab=info');
  await p.locator('[data-turbo-device="PC-Off"]').waitFor();
  check('Info › Code no longer says "Not on PC-T yet"', (await p.locator('[data-turbo-device="PC-T"]').count()) === 0);

  // ── failure in plain words ──
  await p.goto(B + '/projects/tp3?start=tp3');
  await p.locator('[data-start-step="confirm"]').waitFor();
  await pick(p, '[aria-label="Computer"]', { label: 'PC-T' }).catch(() => {});
  await p.locator('[data-start-clone]').click();
  await p.waitForFunction(() => !document.querySelector('[data-start-step]'));
  const job3 = await db.collection('workerJobs').findOne({ deviceId: T.id, projectId: 'tp3', kind: 'start' });
  check('a host other than github.com is sent as a full https URL', job3?.clone?.repo === 'https://gitlab.com/acme/widgets', JSON.stringify(job3));
  await poll(T);
  const msg = "Couldn't clone: no access to acme/widgets; check that this PC is signed in to git";
  await api(T.key, 'POST', '/api/worker/status', { jobs: [{ id: job3._id, ok: false, error: msg }], sessions: [] });
  const s3 = await db.collection('workerSessions').findOne({ _id: job3.sessionId });
  check('the session failed with the worker\'s words', s3.state === 'failed' && s3.error === msg, JSON.stringify(s3));
  await p.goto(B + '/projects/tp3?tab=claude');
  await p.locator(`[data-session="${s3._id}"]`).waitFor();
  const row3 = await p.locator(`[data-session="${s3._id}"]`).innerText();
  check('the row shows failed and the reason, not "folder unlinked"', /failed/.test(row3) && row3.includes(msg) && !/folder unlinked/.test(row3), row3);
  check('no Resume on a session with no folder', (await p.locator(`[data-session="${s3._id}"] [aria-label="Resume"]`).count()) === 0);
  const f3 = await db.collection('workerFolders').countDocuments({ projectId: 'tp3' });
  check('a failed clone links nothing', f3 === 0);

  // ── cannot clone: no repo, cloning off, older worker ──
  await p.goto(B + '/projects/tp2?start=tp2');
  await p.locator('[data-start-step="confirm"]').waitFor();
  await pick(p, '[aria-label="Computer"]', { label: 'PC-T' }).catch(() => {});
  await p.locator('[data-turbo-hint]').waitFor();
  check('no repo: Start keeps asking for a folder and says to add the repo', /Add the repo in Info › Code to let your PC clone it/.test(await p.locator('[data-turbo-hint]').innerText()) && (await p.locator('[data-folder-search]').count()) === 1 && (await p.locator('[data-start-clone]').count()) === 0);
  await p.goto(B + '/projects/tp4?start=tp4');
  await p.locator('[data-start-step="confirm"]').waitFor();
  await pick(p, '[aria-label="Computer"]', { label: 'PC-Off' });
  await p.locator('[data-turbo-hint]').waitFor();
  check('cloning off on that PC is said, no clone button', /turned off on PC-Off/.test(await p.locator('[data-turbo-hint]').innerText()) && (await p.locator('[data-start-clone]').count()) === 0);
  await pick(p, '[aria-label="Computer"]', { label: 'PC-Old' });
  await p.locator('[data-turbo-hint]').waitFor();
  check('an older worker is said, no clone button', /older worker/.test(await p.locator('[data-turbo-hint]').innerText()) && (await p.locator('[data-start-clone]').count()) === 0);

  // ── a scanned folder with the project's remote is linked and started, no clone ──
  await db.collection('workerFolders').insertOne({ _id: `${T.id}:f_scan4`, deviceId: T.id, folderId: 'f_scan4', name: 'scanned-four', git: true, remote: 'delpat-tech/scanned-four', projectId: null, linkedAt: null, seenAt: new Date(), missing: false });
  await p.goto(B + '/projects/tp4?start=tp4');
  await p.locator('[data-start-step="confirm"]').waitFor();
  await pick(p, '[aria-label="Computer"]', { label: 'PC-T' }).catch(() => {});
  check('a scanned folder with the same remote is offered (link and start), not a clone', (await p.locator('[data-start-step]').getAttribute('data-start-mode')) === 'suggest' && (await p.locator('[data-turbo-clone]').count()) === 0);

  // ── a teammate cannot clone onto someone else's PC ──
  const mate = await makeUser({ email: 'turbo-mate@example.test', name: 'Mate', orgId: ME.orgId, role: 'member' });
  const mctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const mp = await mctx.newPage();
  await login(mp, { email: 'turbo-mate@example.test', password: PW });
  await mp.goto(B + '/projects/tp1?start=tp1');
  await mp.locator('[data-start-step="confirm"]:not([data-start-mode="loading"])').waitFor();
  const mateText = await mp.locator('[data-start-step]').innerText();
  check("a teammate's Start sheet shows no computer of the owner and no clone button", /Add a computer first/.test(mateText) && !/PC-T/.test(mateText) && (await mp.locator('[data-start-clone]').count()) === 0, mateText.slice(0, 200));
  const before = await db.collection('workerJobs').countDocuments({});
  await mp.goto(B + '/projects/tp1?tab=info');
  check("a teammate's Info › Code lists none of the owner's computers", (await mp.locator('[data-turbo-device]').count()) === 0);
  check('the teammate made no job', (await db.collection('workerJobs').countDocuments({})) === before && mate.userId !== ME.userId);
  await mctx.close();

  // ── dispatcher: a task given to Claude follows the same path ──
  const baseT = { description: '', mode: null, priority: 'P2', status: 'Not Started', tags: [], due: null, start: null, estimateMins: null, progress: 0, checklist: [], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: 'me', createdAt: new Date(Date.now() - 864e5), updatedAt: new Date(Date.now() - 36e5), doneAt: null, doneOn: null, doneBy: null };
  const mark = n => ({ state: 'queued', markedAt: new Date(Date.now() - (100 - n) * 60_000), markedBy: 'om', markedByUserId: ME.userId, markedByOrgId: ME.orgId });
  const task = (ref, title, projectId, n) => ({ ...baseT, _id: 'tt' + ref, ref, title, projectId, claude: mark(n) });
  await db.collection('tasks').insertMany([task(301, 'Dispatch into a clone', 'tp5', 1), task(302, 'Linked elsewhere', 'tp6', 2), task(303, 'Scanned folder here', 'tp4', 3), task(304, 'No repo', 'tp2', 4)]);
  await db.collection('counters').updateOne({ _id: 'task' }, { $set: { seq: 400 } }, { upsert: true });
  await db.collection('notes').insertOne({ _id: 'nb', title: 'Rules', blocks: [], body: 'x', parentId: null, taskId: null, projectId: null, archived: false, createdBy: 'me', createdAt: new Date(), updatedBy: 'me', updatedAt: new Date(), deletedAt: null });
  await db.collection('settings').updateOne({ _id: 'dispatcher' }, { $set: { enabled: true, maxConcurrent: 4, boilerplateNoteId: 'nb' } }, { upsert: true });
  await db.collection('workerFolders').insertOne({ _id: `${OFF.id}:f_else6`, deviceId: OFF.id, folderId: 'f_else6', name: 'elsewhere-six', git: true, projectId: 'tp6', linkedAt: new Date(), seenAt: new Date(), missing: false });
  await status(OFF, {}, { version: '0.2.0', os: 'win32', allowPrompts: true, allowClone: true, projectsDir: 'E:\\Code' }); // cloning on, and the PC that has tp6
  const rOld = await poll(OLD);
  check('a worker that cannot clone is given no clone task', rOld.body.jobs.length === 0, JSON.stringify(rOld.body.jobs));
  const res = await poll(T);
  const starts = res.body.jobs.filter(j => j.kind === 'start');
  const clone5 = starts.find(j => j.projectId === 'tp5');
  check('dispatcher: task on a project with a repo not on the PC becomes a clone job with the fixed prompt', !!clone5 && clone5.clone?.repo === 'delpat-tech/dispatch-five' && !clone5.folderId && /#301/.test(clone5.prompt ?? ''), JSON.stringify(starts));
  const t301 = await db.collection('tasks').findOne({ ref: 301 });
  const s301 = await db.collection('workerSessions').findOne({ _id: t301.claude.sessionId });
  check('dispatcher: the task is running and its session is cloning', t301.claude.state === 'running' && s301?.cloning === true && s301.dispatched === true && s301.taskId === 'tt301', JSON.stringify(t301.claude));
  check('dispatcher: no clone when the project is linked on another computer of the person', !starts.some(j => j.projectId === 'tp6') && (await db.collection('tasks').findOne({ ref: 302 })).claude.state === 'queued');
  check('dispatcher: a project with no repo is not claimed', (await db.collection('tasks').findOne({ ref: 304 })).claude.state === 'queued');
  // one task per poll: take the next ones
  const res2 = await poll(T);
  const s2jobs = res2.body.jobs.filter(j => j.kind === 'start' && j.projectId === 'tp4');
  check('dispatcher: a scanned folder with the project remote is linked and started normally (no clone)', s2jobs.length === 1 && s2jobs[0].folderId === 'f_scan4' && !s2jobs[0].clone, JSON.stringify(res2.body.jobs));
  check('dispatcher: that folder is now linked to the project', (await db.collection('workerFolders').findOne({ _id: `${T.id}:f_scan4` })).projectId === 'tp4');
  // the clone finishes: folder linked, session moves to it
  await api(T.key, 'POST', '/api/worker/folders', { folders: [{ id: 'f_clone5', name: 'dispatch-five', git: true, remote: 'delpat-tech/dispatch-five' }, { id: 'f_scan4', name: 'scanned-four', git: true, remote: 'delpat-tech/scanned-four' }, { id: 'f_clone1', name: 'turbo-demo', git: true, remote: 'delpat-tech/turbo-demo' }] });
  await api(T.key, 'POST', '/api/worker/status', { jobs: [{ id: clone5.id, ok: true, folderId: 'f_clone5' }], sessions: [{ sessionId: clone5.sessionId, state: 'running' }] });
  check('dispatcher: the cloned folder is linked to the project and the session moved into it', (await db.collection('workerFolders').findOne({ _id: `${T.id}:f_clone5` })).projectId === 'tp5' && (await db.collection('workerSessions').findOne({ _id: clone5.sessionId })).folderId === 'f_clone5');
  // a failed clone ends the claim like any failed start (requeued up to its attempts), with the reason on the session
  await db.collection('tasks').insertOne(task(305, 'Dispatch that fails', 'tp3', 5));
  const res3 = await poll(T);
  const c3 = res3.body.jobs.find(j => j.projectId === 'tp3');
  check('dispatcher: a gitlab project is cloned from its full URL', c3?.clone?.repo === 'https://gitlab.com/acme/widgets', JSON.stringify(res3.body.jobs));
  await api(T.key, 'POST', '/api/worker/status', { jobs: [{ id: c3.id, ok: false, error: msg }], sessions: [] });
  check('dispatcher: a failed clone leaves the session failed with the reason', (await db.collection('workerSessions').findOne({ _id: c3.sessionId })).error === msg);

  check('no page errors', errs.length === 0, errs.join(' | '));
} catch (e) {
  check('turbo suite ran to the end', false, e?.stack || String(e));
}
await b.close();
await finish();
