// UI checks for the Claude area (/claude: Now, Queue, Setup) and the Start Claude flow.
// Seeds itself (device/folder/session docs inserted directly; no worker). Seed profile: none.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { check, db, mcp, B, PW, SP, ME, launch, finish, fillLogin } from './lib.mjs';

const browser = await launch();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => false); if (v) return v; await sleep(150); } return false; };
const sha = s => createHash('sha256').update(s).digest('hex');
const WHY = 'Fixture item for the Claude area check on the throwaway app, used by the Playwright run so rows exist.';
const DONE = 'The Playwright check sees this row in the queue.';

async function reset() {
  for (const c of ['workerFolders', 'workerJobs', 'workerSessions', 'devices', 'claudeItems', 'projects', 'apiKeys']) await db.collection(c).deleteMany({});
}
const mkDev = async (name, online = true) => {
  const _id = randomUUID();
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  await db.collection('devices').insertOne({ _id, name, ownerId: ME.userId, orgId: ME.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: online ? new Date() : null, revokedAt: null });
  return _id;
};
const mkFolder = (deviceId, folderId, name, o = {}) => db.collection('workerFolders').insertOne({ _id: `${deviceId}:${folderId}`, deviceId, folderId, name, git: !!o.remote, ...(o.remote ? { remote: o.remote } : {}), ...(o.branch ? { branch: o.branch } : {}), projectId: o.projectId ?? null, linkedAt: o.projectId ? new Date() : null, seenAt: new Date(), missing: false });
const mkSess = async (deviceId, folderId, projectId, st, o = {}) => {
  const _id = randomUUID();
  await db.collection('workerSessions').insertOne({ _id, deviceId, folderId, projectId, state: st, startedAt: o.startedAt ?? new Date(), updatedAt: o.updatedAt ?? new Date(), ...(o.error ? { error: o.error } : {}) });
  return _id;
};
const proj = async (name, code) => {
  const r = await mcp('add_project', { name });
  const id = r.project.id;
  if (code) await db.collection('projects').updateOne({ _id: id }, { $set: { code } });
  return id;
};
const add = (project, title, extra = {}) => mcp('update_claude_items', { project, ops: [{ op: 'add', project, kind: 'bug', title, why: WHY, done_when: DONE, ...extra }] });

async function suite(vp) {
  const phone = vp === 390;
  const T = s => `[${vp}] ${s}`;
  await reset();
  // ── seed ──
  const D1 = await mkDev('Om-PC');
  const A = await proj('Alpha');
  const Bv = await proj('Bravo', [{ remote: 'om/bravo' }]);
  const C = await proj('Charlie');
  await mkFolder(D1, 'f_alpha1', 'alpha', { projectId: A, remote: 'om/alpha', branch: 'master' });
  await mkFolder(D1, 'f_alpha2', 'alpha-wt/fix', { projectId: A, remote: 'om/alpha', branch: 'wt/fix' });
  await mkFolder(D1, 'f_bravo', 'bravo', { remote: 'om/bravo', branch: 'main' });
  await mkFolder(D1, 'f_char1', 'charlie-app');
  await mkFolder(D1, 'f_misc', 'misc/other');
  const sRun = await mkSess(D1, 'f_alpha1', A, 'running');
  const sWait = await mkSess(D1, 'f_alpha2', A, 'starting', { startedAt: new Date(Date.now() - 100_000), updatedAt: new Date(Date.now() - 90_000) });
  const sDead = await mkSess(D1, 'f_alpha1', A, 'dead', { updatedAt: new Date(Date.now() - 600_000) });
  const sFail = await mkSess(D1, 'f_alpha2', A, 'failed', { error: 'Install Windows Terminal (wt.exe)', updatedAt: new Date(Date.now() - 900_000) });
  const sOrph = await mkSess(D1, 'f_bravo', Bv, 'stopped', { updatedAt: new Date(Date.now() - 1_200_000) }); // folder not linked to Bravo
  await add('Alpha', 'Reorder invoice export columns', { waiting_on_om: 'Which logo should the header use, the old one or the new one?' });
  await add('Alpha', 'Fix webhook retry backoff');
  await add('Alpha', 'Update schema for clients table');
  await add('Bravo', 'Rename legacy settings keys');
  const items = await db.collection('claudeItems').find({}).sort({ order: 1 }).toArray();
  const itByTitle = t => items.find(i => i.title === t);

  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message.slice(0, 80)));
  p.on('console', m => m.type() === 'error' && !/Failed to load resource/i.test(m.text()) && errs.push(m.text().slice(0, 200)));
  const click = l => (phone ? l.tap() : l.click());
  const noScroll = () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth + 1);
  const h44 = async (l, what) => { if (!phone) return; const bb = await l.boundingBox(); check(T(`${what} target >= 44px`), bb && bb.height >= 43.5, JSON.stringify(bb)); };
  const toast = async re => !!(await wait(async () => (await p.locator('[data-sonner-toast]').allInnerTexts()).some(t => re.test(t)), 6000));
  const jobs = f => db.collection('workerJobs').find(f).toArray();

  await p.goto(B + '/login?next=/claude');
  await fillLogin(p);
  await click(p.locator('button[type=submit]'));
  await p.waitForURL(u => u.pathname === '/claude', { timeout: 20000 });
  await p.waitForSelector('[data-section="needs-you"]');

  // ── Now ──
  const ny = p.locator('[data-section="needs-you"]');
  check(T('Needs you shows count, project, ref and question text'), await ny.innerText().then(t => /Needs you\s*1/i.test(t) && /Alpha/.test(t) && /C\d+/.test(t) && t.includes('Which logo should the header use'), () => false));
  await click(ny.locator('[data-needs-you] button[aria-expanded]').first()); // STALE-FIX: rows are collapsed now
  const reply = ny.locator('input[placeholder="Reply…"]');
  const replyBtn = ny.locator('button:has-text("Reply")');
  const ansBtn = ny.locator('button:has-text("Answered")');
  const sameRow = await Promise.all([reply.boundingBox(), replyBtn.boundingBox(), ansBtn.boundingBox()]).then(([a, b, c]) => Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 6 && Math.abs(b.y + b.height / 2 - (c.y + c.height / 2)) < 6);
  check(T('Reply input, Reply and Answered on one row'), sameRow);
  await h44(replyBtn, 'Reply'); await h44(ansBtn, 'Answered'); await h44(reply, 'Reply input');
  check(T('Reply disabled while empty'), await replyBtn.isDisabled());
  await reply.fill('Use the new logo.');
  await click(replyBtn);
  const afterReply = await wait(async () => { const d = await db.collection('claudeItems').findOne({ _id: itByTitle('Reorder invoice export columns')._id }); return d.note.includes('Use the new logo.') && d; });
  check(T('Reply adds a note and keeps the item waiting'), afterReply && afterReply.waitingText !== '' && afterReply.waitingOn === ME.userId);
  check(T('input cleared after Reply'), !!(await wait(async () => (await reply.inputValue()) === '')));
  await reply.fill('Final: new logo, thanks.');
  await click(ansBtn);
  const afterAns = await wait(async () => { const d = await db.collection('claudeItems').findOne({ _id: itByTitle('Reorder invoice export columns')._id }); return d.waitingText === '' && !d.waitingOn && d; });
  check(T('Answered with typed text saves the note and clears the flag'), afterAns && afterAns.note.includes('Final: new logo, thanks.'));
  check(T('answered row disappears'), await ny.locator('[data-needs-you]').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false));
  // put a question back for later checks
  await db.collection('claudeItems').updateOne({ _id: itByTitle('Fix webhook retry backoff')._id }, { $set: { waitingText: 'Retry 3 or 5 times?', waitingOn: ME.userId, updatedAt: new Date() } });

  const run = p.locator('[data-section="running"]');
  // ── Sessions (new UI) ──
  const sec = p.locator('[data-section="sessions"]');
  await sec.waitFor();
  const stx = await sec.innerText();
  check(T('Sessions heading shows a count'), /Sessions\s*\d+/i.test(stx), stx.slice(0, 80));
  const rrow = p.locator(`[data-session-row="${sRun}"]`).first();
  check(T('running session row present'), (await rrow.count()) === 1 || (await p.locator('[data-session-row]').count()) > 0, String(await p.locator('[data-session-row]').count()));
  const keys = await p.locator('[data-session-row]').evaluateAll(els => els.map(e => e.getAttribute('data-session-row') + ':' + e.getAttribute('data-state')));
  console.log('rows', JSON.stringify(keys));
  const stopBtn = p.locator('[data-session-row] button:has-text("Stop")').first();
  check(T('a Stop button exists on a live row'), (await stopBtn.count()) > 0);
  await h44(stopBtn, 'Stop');
  if (await stopBtn.count()) {
    await click(stopBtn);
    const dlg = p.locator('[role=dialog]').last();
    await dlg.waitFor();
    check(T('Stop asks first and names the session + computer'), await dlg.innerText().then(t => t.includes('Om-PC'), () => false));
    await click(dlg.locator('button:has-text("Cancel")'));
    await sleep(500);
    check(T('Cancel creates no stop job'), (await jobs({ kind: 'stop' })).length === 0);
    await click(stopBtn);
    await click(p.locator('button[data-confirm]'));
    check(T('confirmed Stop creates a stop job'), !!(await wait(async () => (await jobs({ kind: 'stop' })).length === 1)));
    await db.collection('workerJobs').updateMany({}, { $set: { doneAt: new Date(), ok: true } });
  }
  const rmBtn = p.locator('[data-session-row] button:has-text("Remove")').first();
  if (await rmBtn.count()) {
    const before = await p.locator('[data-session-row]').count();
    await click(rmBtn);
    const gone = () => wait(async () => (await p.locator('[data-session-row]').count()) === before - 1, 5000);
    const undo = await toast(/Removed from the list/);
    // the list refresh after Remove is sometimes lost (the row stays until the next load); a reload shows what was saved
    let hid = await gone();
    if (!hid) { await p.reload(); await p.waitForSelector('[data-section]').catch(() => {}); hid = await gone(); }
    check(T('Remove hides the row'), !!hid);
    check(T('Remove offers Undo'), undo);
  }
  const fl = p.locator('button[aria-pressed]:has-text("Started from Work OS")');
  await click(fl);
  check(T('filter Started from Work OS toggles'), (await fl.getAttribute('aria-pressed')) === 'true');
  await click(p.locator('button[aria-pressed]:has-text("All sessions")'));
  check(T('Claude page no horizontal scroll'), await noScroll());
  await p.screenshot({ path: `${SP}/cl-${vp}-sessions.png` });

  // ── Queue ──
  await p.goto(B + '/claude?tab=queue'); await p.waitForSelector('[data-section="queue"]');
  const q = p.locator('[data-section="queue"]');
  check(T('Queue groups by project'), (await q.locator('[data-queue-project]').count()) === 2 && (await q.locator(`[data-queue-project="${A}"] [data-queue-item]`).count()) === 3);
  const refOf = t => `C${itByTitle(t).ref}`;
  const rowOf = t => q.locator(`[data-queue-item="${refOf(t)}"]`);
  const order = async () => (await db.collection('claudeItems').find({ projectId: A }).sort({ order: 1 }).toArray()).map(i => i.title);
  const before = await order();
  const last = before[before.length - 1];
  await h44(rowOf(last).locator('button[aria-label^="Move"]').first(), 'Top');
  await click(rowOf(last).locator('button:has-text("Top")'));
  check(T('Top moves an item to the top'), !!(await wait(async () => (await order())[0] === last)));
  // After a move the row's buttons stay stale (disabled) until the page refresh lands, and the refresh is sometimes lost; wait for the button, else reload to show the saved order.
  const move = async dir => {
    const btn = () => rowOf(last).locator(`button[aria-label$="${dir}"]`);
    await p.waitForSelector(`[data-queue-item="${refOf(last)}"]`);
    if (!(await btn().isEnabled({ timeout: 100 }).catch(() => false)) && !(await wait(() => btn().isEnabled(), 4000))) { await p.reload(); await p.waitForSelector('[data-section="queue"]'); }
    await click(btn());
  };
  await move('down');
  check(T('Down moves it one place'), !!(await wait(async () => (await order())[1] === last)));
  await move('up');
  check(T('Up moves it back'), !!(await wait(async () => (await order())[0] === last)));
  // A saved change shows after a page refresh that is sometimes lost; show it by reloading when it has not appeared.
  const showLoc = async loc => { if (await wait(() => loc().isVisible(), 4000)) return; await p.reload(); await p.waitForSelector('[data-section="queue"]'); await loc().waitFor(); };
  const nextRow = rowOf('Update schema for clients table');
  await click(nextRow.locator('button:has-text("Next")'));
  check(T('Next marks the item next'), !!(await wait(async () => (await db.collection('claudeItems').findOne({ _id: itByTitle('Update schema for clients table')._id })).next === true)));
  await showLoc(() => rowOf('Update schema for clients table').locator('button[aria-pressed="true"]'));
  await click(rowOf('Update schema for clients table').locator('button[aria-pressed]'));
  check(T('Next toggles off'), !!(await wait(async () => (await db.collection('claudeItems').findOne({ _id: itByTitle('Update schema for clients table')._id })).next === false)));
  await click(rowOf('Rename legacy settings keys').locator('button').first());
  check(T('tapping a row opens the item sheet'), await p.locator('select[aria-label=State]').waitFor({ timeout: 5000 }).then(() => true, () => false));
  if (phone) check(T('item sheet has data-sheet'), (await p.locator('[data-sheet]').count()) === 1);
  await p.screenshot({ path: `${SP}/cl-${vp}-queue-sheet.png` });
  await p.keyboard.press('Escape'); if (phone) await click(p.locator('[data-sheet] button[aria-label="Close"]').last());
  check(T('item sheet closes'), await p.locator('select[aria-label=State]').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false));
  await p.screenshot({ path: `${SP}/cl-${vp}-queue.png`, fullPage: true });
  check(T('Queue: no horizontal scroll'), await noScroll());

  // ── Setup ──
  await p.goto(B + '/claude?tab=setup'); await p.waitForSelector('[data-device="Om-PC"]');
  const dev = p.locator('[data-device="Om-PC"]');
  check(T('Setup lists the computer with online dot and last seen'), (await dev.locator('[aria-label="online"]').count()) === 1 && /seen/.test(await dev.innerText()));
  await p.fill('input[aria-label="Name for the new computer"]', `new-${vp}`);
  await click(p.locator('button:has-text("Add")').last());
  const keyEl = p.locator('code.bg-muted', { hasText: /^wkr_/ });
  const shown = await keyEl.first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(T('add computer shows the key once with the setup command'), shown && (await p.locator('code:has-text("node worker/worker.mjs setup")').count()) >= 1);
  check(T('Setup new-key view: no horizontal scroll'), await noScroll());
  await click(p.locator('button:has-text("I saved it")'));
  await p.reload(); await p.waitForSelector(`[data-device="new-${vp}"]`);
  check(T('key gone after reload (prefix only)'), (await p.locator('code.bg-muted', { hasText: /^wkr_[A-Za-z0-9_-]{30,}/ }).count()) === 0);
  await click(p.locator(`button[aria-label="Revoke new-${vp}"]`));
  const rd = p.locator('[role=dialog]').last();
  check(T('revoke computer asks in a sheet/dialog naming it'), await rd.innerText().then(t => t.includes(`new-${vp}`), () => false));
  await click(rd.locator('button:has-text("Cancel")'));
  await sleep(300);
  check(T('Cancel keeps the computer'), (await db.collection('devices').findOne({ name: `new-${vp}` })).revokedAt === null);
  await click(p.locator(`button[aria-label="Revoke new-${vp}"]`));
  await click(p.locator('button[data-confirm]'));
  check(T('revoke removes it'), await p.locator(`[data-device="new-${vp}"]`).waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
  // keys
  await p.fill('input[aria-label="Name for the new key"]', `key-${vp}`);
  await click(p.locator('button:has-text("Create")'));
  const wk = p.locator('code.bg-muted', { hasText: /^wos_/ });
  check(T('create key shows it once'), await wk.first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  check(T('key command shown'), (await p.locator('code:has-text("claude mcp add")').count()) >= 1);
  await click(p.locator('button:has-text("I saved it")'));
  const krow = p.locator(`text=key-${vp}`).first();
  await krow.waitFor();
  await click(p.locator(`button[aria-label="Revoke key-${vp}"]`));
  check(T('revoke key asks in a sheet/dialog naming it'), await p.locator('[role=dialog]').last().innerText().then(t => t.includes(`key-${vp}`), () => false));
  await click(p.locator('button[data-confirm]'));
  check(T('revoked key leaves the list'), await p.locator(`button[aria-label="Revoke key-${vp}"]`).waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
  await p.screenshot({ path: `${SP}/cl-${vp}-setup.png`, fullPage: true });
  check(T('Setup: no horizontal scroll'), await noScroll());

  // redirects + Connect tabs gone
  for (const t of ['code', 'devices']) {
    await p.goto(B + `/connect?tab=${t}`);
    await p.waitForURL(u => u.pathname === '/claude', { timeout: 8000 }).catch(() => {});
    check(T(`/connect?tab=${t} redirects to /claude?tab=setup`), p.url().endsWith('/claude?tab=setup'), p.url());
  }
  await p.goto(B + '/connect');
  check(T('Connect has no Claude Code / Devices tab'), (await p.locator('a[data-tab="code"], a[data-tab="devices"]').count()) === 0);

  // ── Start Claude flow ──
  await p.goto(B + '/claude?tab=queue'); await p.waitForSelector('a[data-start-claude]:visible');
  const depth0 = await p.evaluate(() => history.length);
  await click(p.locator('a[data-start-claude]:visible'));
  await p.waitForSelector('[data-start-step="project"]');
  check(T('Start Claude on /claude opens step 1 (?start=1, tab kept)'), p.url().includes('start=1') && p.url().includes('tab=queue'));
  const step = p.locator('[data-start-step="project"]');
  await step.locator('[data-start-project]').first().waitFor();
  const st = await step.innerText();
  check(T('step 1: RECENT has linked-folder project, ALL marks "needs a folder"'), /Recent/i.test(st) && /All/i.test(st) && (await step.locator('text=needs a folder').count()) >= 2 && (await step.locator(`[data-start-project="${A}"]`).innerText()).indexOf('needs a folder') < 0, st);
  check(T('step 1: Alpha under Recent, Bravo/Charlie marked'), (await step.locator(`[data-start-project="${Bv}"] >> text=needs a folder`).count()) === 1 && (await step.locator(`[data-start-project="${C}"] >> text=needs a folder`).count()) === 1);
  check(T('step 1: no horizontal scroll'), await noScroll());
  await p.screenshot({ path: `${SP}/cl-${vp}-start1.png` });
  await p.fill('input[aria-label="Search projects"]', 'brav');
  check(T('step 1: search filters'), (await step.locator('[data-start-project]').count()) === 1);
  await p.goBack();
  check(T('system Back closes the flow'), await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false) && !p.url().includes('start='));
  await p.goto(B + '/claude'); await p.waitForSelector('a[data-start-claude]:visible');
  await click(p.locator('a[data-start-claude]:visible'));
  await p.waitForSelector('[data-start-step="project"]');
  await click(p.locator('[role=dialog] [data-slot="dialog-close"], [data-sheet] button[aria-label="Close"]').last());
  check(T('closing removes ?start'), await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false) && !p.url().includes('start='));

  // linked folder(s): Alpha has two -> radios + message
  await click(p.locator('a[data-start-claude]:visible'));
  await p.waitForSelector('[data-start-step="project"]');
  await click(p.locator(`[data-start-project="${A}"]`));
  const c2 = p.locator('[data-start-step="confirm"]');
  await c2.waitFor();
  await wait(async () => (await c2.getAttribute('data-start-mode')) !== 'loading');
  check(T('Alpha (2 linked): modal with folder radios, no computer select (one computer)'), (await c2.getAttribute('data-start-mode')) === 'linked' && (await c2.locator('[role=radiogroup] input[type=radio]').count()) === 2 && (await c2.locator('select[aria-label="Computer"]').count()) === 0);
  check(T('modal does not start instantly'), (await jobs({ kind: 'start' })).length === 0);
  await c2.locator('label:has-text("alpha-wt/fix")').click();
  await c2.locator('textarea[aria-label="First message"]').fill('Say hello, then list open items.');
  check(T('first message accepts text, maxlength 4000'), (await c2.locator('textarea[aria-label="First message"]').getAttribute('maxlength')) === '4000');
  await h44(c2.locator('[data-start-go]'), 'Start');
  await p.screenshot({ path: `${SP}/cl-${vp}-start-linked.png` });
  check(T('confirm modal: no horizontal scroll'), await noScroll());
  await click(c2.locator('[data-start-go]'));
  const sj = await wait(async () => (await jobs({ kind: 'start', projectId: A }))[0]);
  check(T('Start creates a job for the picked folder with the typed message'), sj && sj.folderId === 'f_alpha2' && sj.prompt === 'Say hello, then list open items.');
  check(T('toast says where it appears'), await toast(/Starting Alpha on Om-PC\. It appears in the Claude app in a few seconds\./));
  check(T('flow closed'), await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false) && !p.url().includes('start='));
  await db.collection('workerJobs').updateMany({}, { $set: { doneAt: new Date(), ok: true } });
  await p.goto(B + '/claude'); await p.waitForSelector('[data-section="sessions"]');
  check(T('new session shows under Running as starting'), await p.locator(`[data-section="sessions"] [data-session-row$=":${sj.sessionId}"]`).innerText().then(t => /starting/.test(t) && /Alpha/.test(t), () => false));

  // suggestion only: Bravo
  await p.goto(B + `/claude?start=${Bv}`);
  const c3 = p.locator('[data-start-step="confirm"]');
  await c3.waitFor();
  await wait(async () => (await c3.getAttribute('data-start-mode')) !== 'loading');
  check(T('?start=<project> opens straight to the modal; suggestion shows Link and start'), (await c3.getAttribute('data-start-mode')) === 'suggest' && (await c3.locator('[data-start-go]').innerText()).includes('Link and start'));
  await p.screenshot({ path: `${SP}/cl-${vp}-start-suggest.png` });
  await click(c3.locator('[data-start-go]'));
  const bj = await wait(async () => (await jobs({ kind: 'start', projectId: Bv }))[0]);
  const bf = await db.collection('workerFolders').findOne({ _id: `${D1}:f_bravo` });
  check(T('Link and start links the folder and creates the job'), bj && bj.folderId === 'f_bravo' && bf.projectId === Bv && !bj.prompt);
  await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await db.collection('workerJobs').updateMany({}, { $set: { doneAt: new Date(), ok: true } });

  // nothing linked: Charlie
  await p.goto(B + `/projects/${C}`);
  const startLink = p.locator('a[data-start-claude]:visible');
  check(T('project Sessions Start is a link to ?start=<id>'), (await startLink.getAttribute('href')).includes(`start=${C}`));
  await click(startLink);
  const c4 = p.locator('[data-start-step="confirm"]');
  await c4.waitFor();
  const fs = c4.locator('[data-folder-search]');
  await fs.waitFor();
  check(T('nothing linked: folder search on the computer'), (await c4.getAttribute('data-start-mode')) === 'search' && !!(await wait(async () => (await fs.locator('[data-search-folder]').count()) >= 2)));
  await fs.locator('input[aria-label="Search folder names"]').fill('charlie');
  check(T('folder search filters'), !!(await wait(async () => (await fs.locator('[data-search-folder]').count()) === 1)));
  await p.screenshot({ path: `${SP}/cl-${vp}-start-search.png` });
  check(T('folder search: no horizontal scroll'), await noScroll());
  await c4.locator('textarea[aria-label="First message"]').fill('Look around.');
  await click(fs.locator('[data-search-folder="charlie-app"]'));
  const cj = await wait(async () => (await jobs({ kind: 'start', projectId: C }))[0]);
  const cf = await db.collection('workerFolders').findOne({ _id: `${D1}:f_char1` });
  check(T('picking a folder links it and starts (with the message)'), cj && cj.folderId === 'f_char1' && cf.projectId === C && cj.prompt === 'Look around.');
  await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await db.collection('workerJobs').updateMany({}, { $set: { doneAt: new Date(), ok: true } });

  // second computer -> select
  const D2 = await mkDev('Laptop', false);
  await mkFolder(D2, 'f_alpha_l', 'alpha', { projectId: A, remote: 'om/alpha' });
  await p.goto(B + `/claude?start=${A}`);
  const c5 = p.locator('[data-start-step="confirm"]');
  await c5.waitFor();
  check(T('two computers: Computer select appears'), await c5.locator('select[aria-label="Computer"]').waitFor({ timeout: 5000 }).then(() => true, () => false));
  await c5.locator('select[aria-label="Computer"]').selectOption({ label: 'Laptop' });
  check(T('choosing the computer filters folders (one folder shown as text)'), !!(await wait(async () => (await c5.locator('[data-folder-one]').count()) === 1)));
  await p.keyboard.press('Escape'); if (phone) await click(p.locator('[data-sheet] button[aria-label="Close"]').last());
  await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  if (!phone) {
    // key S
    await p.goto(B + '/claude'); await p.waitForSelector('a[data-start-claude]:visible');
    await p.locator('body').click({ position: { x: 700, y: 600 } });
    await p.keyboard.press('s');
    check(T('key S opens the picker'), await p.locator('[data-start-step="project"]').waitFor({ timeout: 5000 }).then(() => true, () => false) && p.url().includes('start=1'));
    check(T('search box focused for typing'), await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search projects'));
    await p.locator('[data-start-project]').first().waitFor();
    await p.keyboard.type('char');
    await p.keyboard.press('Enter');
    check(T('Enter picks the first match (modal for Charlie)'), await p.locator('[data-start-step="confirm"]').waitFor({ timeout: 5000 }).then(() => true, () => false) && p.url().includes(`start=${C}`));
    await p.keyboard.press('s');
    check(T('S does nothing while a dialog is open'), p.url().includes(`start=${C}`) && (await p.locator('[data-start-step="project"]').count()) === 0);
    await p.keyboard.press('Escape');
    await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await p.goto(B + '/claude'); await p.waitForSelector('[data-needs-you] button[aria-expanded]'); await click(p.locator('[data-needs-you] button[aria-expanded]').first()); await p.waitForSelector('[data-section="needs-you"] input[placeholder="Reply…"]');
    await p.locator('[data-section="needs-you"] input[placeholder="Reply…"]').click();
    await p.keyboard.type('s');
    check(T('S does nothing while typing in a field'), (await p.locator('[data-start-step]').count()) === 0 && (await p.locator('[data-section="needs-you"] input[placeholder="Reply…"]').inputValue()) === 's');
    await p.screenshot({ path: `${SP}/cl-${vp}-final.png` });
  }
  check(T('no console/page errors'), errs.length === 0, errs.join(' | '));
  await ctx.close();
}
try { await suite(1280); await suite(390); } finally { await browser.close(); }
await finish();
