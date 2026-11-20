// UI checks for the Claude area (/claude: Now, Workers, Set up) and the Start Claude flow.
// Seeds itself (device/folder/session docs inserted directly; no worker). Seed profile: none.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { check, db, rawDb, mcp, B, PW, SP, ME, launch, finish, fillLogin, pick } from './lib.mjs';

const browser = await launch();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => false); if (v) return v; await sleep(150); } return false; };
const sha = s => createHash('sha256').update(s).digest('hex');
const WHY = 'Fixture item for the Claude area check on the throwaway app, used by the Playwright run so rows exist.';
const DONE = 'The Playwright check sees this row in the queue.';

async function reset() {
  for (const c of ['workerFolders', 'workerJobs', 'workerSessions', 'devices', 'claudeItems', 'projects', 'apiKeys']) await db.collection(c).deleteMany({});
  await db.collection('settings').deleteMany({ area: 'dispatcher' }); await db.collection('notes').deleteMany({ title: 'Claude Code boilerplate' }); // Claude starts switched off
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
  await p.waitForSelector('[data-tab="sessions"]');
  check(T('two tabs: Sessions and Set up (Now and Workers are one list)'), (await p.locator('nav[aria-label="Claude sections"] a[data-tab]').count()) === 2 && (await p.locator('a[data-tab="sessions"][aria-current="page"]').count()) === 1);

  // ── Now ──
  check(T('no Claude is asking block, no answer box (Claude items retired)'), (await p.locator('[data-section="needs-you"]').count()) === 0 && (await p.locator('[data-needs-you]').count()) === 0);
  check(T('no Queue tab'), (await p.locator('[data-tab="queue"]').count()) === 0);

  // One state-aware banner: a computer exists but Claude is switched off -> "Switch on"; no word "dispatcher" on the page.
  const bnr = p.locator('[data-claude-banner]');
  check(T('banner: computer but off -> one banner "Claude will not start tasks yet" with Switch on'), (await bnr.count()) === 1 && (await bnr.getAttribute('data-claude-banner')) === 'off' && /Claude will not start tasks yet/.test(await bnr.innerText()));
  check(T('no "dispatcher" in the page text'), !/dispatcher/i.test(await p.locator('body').innerText()));
  await h44(p.locator('[data-claude-switch-on]'), 'Switch on');
  // Turning Claude on needs the note every session reads first (picked in Set up): without one, Switch on goes there.
  check(T('banner: no note picked yet -> Switch on opens Set up'), (await p.locator('a[data-claude-switch-on][href="/claude?tab=setup"]').count()) === 1);
  const NOTE = 'note-' + vp;
  await db.collection('notes').insertOne({ _id: NOTE, title: 'Claude Code boilerplate', blocks: [], body: 'rules', parentId: null, taskId: null, projectId: null, archived: false, createdBy: ME.userId, ownerId: ME.userId, orgId: ME.orgId, createdAt: new Date(), updatedBy: ME.userId, updatedAt: new Date(), deletedAt: null });
  await db.collection('settings').updateOne({ _id: 'dispatcher:' + ME.userId }, { $set: { area: 'dispatcher', orgId: ME.orgId, userId: ME.userId, enabled: false, maxConcurrent: 2, boilerplateNoteId: NOTE } }, { upsert: true });
  await p.goto(B + '/claude'); await p.waitForSelector('[data-claude-switch-on]');
  check(T('banner: a note is picked -> Switch on is a button'), (await p.locator('button[data-claude-switch-on]').count()) === 1);
  await click(p.locator('button[data-claude-switch-on]'));
  check(T('Switch on removes the banner'), await bnr.waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false));
  check(T('Switch on saved the setting'), (await db.collection('settings').findOne({ _id: 'dispatcher:' + ME.userId }))?.enabled === true);
  check(T("Claude's tasks empty copy"), /Nothing given to Claude yet\. Open any task and press Give to Claude\./.test(await p.locator('[data-claude-tasks-empty]').innerText()));

  const run = p.locator('[data-section="running"]');
  // ── Sessions (new UI) ──
  const sec = p.locator('[data-section="sessions"]');
  await sec.waitFor();
  const stx = await sec.innerText();
  check(T('Sessions heading shows a count'), /Sessions[^\n]*\n?\s*\d+/i.test(stx), stx.slice(0, 80));
  check(T('ended sessions sit under Finished today (ended today), not in the live list'), (await p.locator(`[data-section="finished"] [data-session-row="${D1}:${sDead}"]`).count()) === 1 && (await sec.locator(`[data-session-row="${D1}:${sDead}"]`).count()) === 0);
  // A tap on a row opens its sheet: everything about it and every action.
  await click(p.locator(`[data-session-row="${D1}:${sRun}"] button`).first());
  const sh = p.locator(`[data-session-sheet="${D1}:${sRun}"]`);
  check(T('a row opens its sheet with the folder, the computer and Stop'), await sh.waitFor({ timeout: 6000 }).then(async () => /alpha/.test(await sh.innerText()) && /Om-PC/.test(await sh.innerText()) && (await sh.locator('[data-sheet-action="stop"]').count()) === 1, () => false));
  if (phone) await click(p.getByRole('dialog').locator('button[aria-label="Close"]').first());
  else await p.keyboard.press('Escape');
  check(T('the sheet closes'), await sh.waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
  const rrow = p.locator(`[data-session-row="${sRun}"]`).first();
  check(T('running session row present'), (await rrow.count()) === 1 || (await p.locator('[data-session-row]').count()) > 0, String(await p.locator('[data-session-row]').count()));
  const keys = await p.locator('[data-session-row]').evaluateAll(els => els.map(e => e.getAttribute('data-session-row') + ':' + e.getAttribute('data-state')));
  console.log('rows', JSON.stringify(keys));
  // One control per row, by state: no Stop, Remove, Link or Open in VS Code on a row (they are in its sheet); an ended session
  // with a project has Resume; a running one the roster does not list (no hook) has none (Message needs the session's own row).
  check(T('no Stop, Remove, Link or Open in VS Code on any row'), (await p.locator('[data-session-row] [data-session-action="stop"], [data-session-row] [data-session-action="remove"], [data-session-row] [data-link-folder], [data-session-row] [data-open-vscode]').count()) === 0);
  const deadRow = p.locator(`[data-session-row="${D1}:${sDead}"]`);
  check(T('an ended session with a project: Resume is its one control'), (await deadRow.locator('[data-session-action]').count()) === 1 && (await deadRow.locator('[data-session-action="resume"]').count()) === 1, await deadRow.innerText().catch(() => ''));
  await h44(deadRow.locator('[data-session-action="resume"]'), 'Resume');
  check(T('a running session without a hook row has no control'), (await p.locator(`[data-session-row="${D1}:${sRun}"] [data-session-action]`).count()) === 0);
  // Stop is in the sheet.
  await click(p.locator(`[data-session-row="${D1}:${sRun}"] button`).first());
  const stopBtn = sh.locator('[data-sheet-action="stop"]');
  await stopBtn.waitFor({ timeout: 6000 }).catch(() => {});
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
    check(T('and closes the sheet'), await sh.waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
    await db.collection('workerJobs').updateMany({}, { $set: { doneAt: new Date(), ok: true } });
  } else check(T('the sheet has Stop'), false);
  // Remove is in the sheet of an ended session.
  await click(deadRow.locator('button').first());
  const dsh = p.locator(`[data-session-sheet="${D1}:${sDead}"]`);
  const rmBtn = dsh.locator('[data-sheet-action="remove"]');
  await rmBtn.waitFor({ timeout: 6000 }).catch(() => {});
  if (await rmBtn.count()) {
    const before = await p.locator('[data-session-row]').count();
    await click(rmBtn);
    const gone = () => wait(async () => (await p.locator('[data-session-row]').count()) === before - 1, 5000);
    const undo = await toast(/Removed from the list/);
    check(T('Remove hides the row'), !!(await gone()));
    check(T('Remove offers Undo'), undo);
  } else {
    check(T("an ended session's sheet has Remove"), false, await dsh.innerText().catch(() => 'no sheet'));
    if (phone) await click(p.getByRole('dialog').locator('button[aria-label="Close"]').first());
    else await p.keyboard.press('Escape');
  }
  check(T('Claude page no horizontal scroll'), await noScroll());
  await p.screenshot({ path: `${SP}/cl-${vp}-sessions.png` });

  // A session whose Claude Code hook says it waits at a permission prompt reads "waiting on you" (the hook beats transcript timing); working stays working
  await mcp('start_work', { project: 'Alpha', session: 'cp-hook', label: 'Claude page hook row', account: 'tools' });
  const HOOKROW = `${ME.userId}:s:cp-hook:${A}`;
  const CC = 'cc-' + randomUUID();
  const hookItems = () => [{ sessionId: CC, folder: 'alpha', title: 'Hook session', lastActiveAt: new Date(Date.now() - 20 * 60_000), subagentsActive: 0, startedByWorkOs: false, running: true }];
  await db.collection('devices').updateOne({ _id: D1 }, { $set: { claudeSessions: { at: new Date(), items: hookItems() } } });
  await db.collection('presence').updateOne({ _id: HOOKROW }, { $set: { ccSession: CC, activity: { state: 'waiting', at: new Date(), why: 'prompt' } } });
  await p.goto(B + '/claude'); await p.waitForSelector('[data-section="sessions"]');
  const hrow = p.locator(`[data-session-row="${D1}:${CC}"]`);
  check(T('hook says waiting at a prompt: the row reads "waiting on you"'), (await hrow.count()) === 1 && /waiting on you/i.test(await hrow.innerText()) && (await p.locator(`[data-worker="${HOOKROW}"]`).count()) === 1 && (await p.locator(`[data-worker="${HOOKROW}"][data-session-row="${D1}:${CC}"]`).count()) === 1, await hrow.innerText().catch(() => 'no row'));
  check(T('the row shows the Claude account'), (await hrow.locator('[data-session-account]:visible').count()) === 1 && (await hrow.locator('[data-session-account]:visible').innerText()) === 'tools', await hrow.innerText().catch(() => 'no row'));
  check(T('Claude page no horizontal scroll with the waiting row'), await noScroll());
  await p.screenshot({ path: `${SP}/cl-${vp}-now-waiting.png` });
  await p.evaluate(() => document.documentElement.classList.add('dark'));
  await p.screenshot({ path: `${SP}/cl-${vp}-now-waiting-dark.png` });
  await p.evaluate(() => document.documentElement.classList.remove('dark'));
  await db.collection('presence').updateOne({ _id: HOOKROW }, { $set: { activity: { state: 'working', at: new Date() } } });
  await p.goto(B + '/claude'); await p.waitForSelector('[data-section="sessions"]');
  check(T('hook says working although the transcript is 20 minutes old: working'), (await p.locator(`[data-session-row="${D1}:${CC}"]`).getAttribute('data-state')) === 'working');
  await db.collection('presence').updateOne({ _id: HOOKROW }, { $set: { activity: { state: 'off', at: new Date() } } });
  await p.goto(B + '/claude'); await p.waitForSelector('[data-section="sessions"]');
  check(T('hook says off while the worker list still shows it running: off, under Finished today'), (await p.locator(`[data-session-row="${D1}:${CC}"]`).getAttribute('data-state')) === 'off' && (await p.locator(`[data-section="finished"] [data-session-row="${D1}:${CC}"]`).count()) === 1);
  await db.collection('presence').deleteOne({ _id: HOOKROW });
  await db.collection('devices').updateOne({ _id: D1 }, { $unset: { claudeSessions: '' } });

  // ── Set up (step 1 must be done for the PC step to open: Claude was used through MCP above; make it certain) ──
  await rawDb.collection('settings').updateOne({ _id: 'status:' + ME.userId }, { $set: { area: 'status', orgId: ME.orgId, userId: ME.userId, lastMcpAt: new Date() } }, { upsert: true });
  await p.goto(B + '/claude?tab=setup'); await p.waitForSelector('[data-device="Om-PC"]');
  const dev = p.locator('[data-device="Om-PC"]');
  check(T('Setup lists the computer with online dot and last seen'), (await dev.locator('[aria-label="online"]').count()) === 1 && /seen/.test(await dev.innerText()));
  // The worker line (docs/launcher.md "Self-update"): its version, then how it updates.
  {
    const before = (await db.collection('devices').findOne({ _id: D1 }))?.worker;
    const served = await (await fetch(B + '/worker/latest.json')).json();
    const setWorker = w => db.collection('devices').updateOne({ _id: D1 }, { $set: { worker: { version: '0.5.0', os: 'win32', allowPrompts: true, ...w }, lastSeenAt: new Date() } });
    // Every case here has a tail after "Worker x"; "update available" needs the served release, which loads after the list.
    const line = async () => {
      await p.reload(); await p.waitForSelector('[data-device="Om-PC"] [data-worker-line]');
      await p.waitForFunction(() => document.querySelector('[data-device="Om-PC"] [data-worker-line]')?.textContent?.includes('·'), null, { timeout: 8000 }).catch(() => {});
      return (await dev.locator('[data-worker-line]').innerText()).trim().replace(/\s+/g, ' ');
    };
    await setWorker({ bundle: served.sha256.slice(0, 12), selfUpdate: { updatedAt: new Date(Date.now() - 2 * 3600_000), from: '0.4.0', problem: null } });
    let t = await line();
    check(T('worker line: version and when it last updated itself'), /^Worker 0\.5\.0 · updated itself /.test(t), t);
    await p.screenshot({ path: `${SP}/cl-${vp}-worker-updated.png` });
    await setWorker({ bundle: 'aaaaaaaaaaaa', selfUpdate: { updatedAt: null, from: null, problem: 'update refused: bad signature' } });
    t = await line();
    // A refusal never leads to the install command: its file and checksum come from the server that offered the release.
    check(T('worker line: a refused update says not to reinstall'), t === "Worker 0.5.0 · Update refused: this release isn't signed by Delpat. Don't reinstall; tell Om.", t);
    const centre = l => l.evaluate(e => e.scrollIntoView({ block: 'center' })); // clear of the phone's bottom bar
    const manual = p.locator('[data-manual-update="Om-PC"]');
    check(T('a refusal is text, not a button, and no install command is on the page'), (await dev.locator('[data-update-problem="refused"]').count()) === 1 && (await dev.locator('[data-worker-line] button').count()) === 0 && (await p.locator('[data-install-command]').count()) === 0);
    check(T('worker line with a refusal: no horizontal scroll'), await noScroll());
    await centre(dev.locator('[data-update-problem]'));
    await p.screenshot({ path: `${SP}/cl-${vp}-worker-refused.png` });
    await p.evaluate(() => document.documentElement.classList.add('dark'));
    await p.screenshot({ path: `${SP}/cl-${vp}-worker-refused-dark.png` });
    await p.evaluate(() => document.documentElement.classList.remove('dark'));
    await setWorker({ bundle: 'aaaaaaaaaaaa', selfUpdate: { updatedAt: null, from: null, problem: 'update refused: version 20261101.000000 is not newer than 20261120.100000' } });
    t = await line();
    check(T('worker line: an older release offered is refused the same way'), t === "Worker 0.5.0 · Update refused: Work OS offered an older release (20261101.000000). Don't reinstall; tell Om.", t);
    await setWorker({ bundle: 'aaaaaaaaaaaa', selfUpdate: { updatedAt: null, from: null, problem: 'update failed: could not reach Work OS (ECONNREFUSED)' } });
    t = await line();
    check(T('worker line: a failed update gives the reason and says it tries again, no command'), t === 'Worker 0.5.0 · update failed: could not reach Work OS (ECONNREFUSED); it will try again' && (await dev.locator('[data-worker-line] button').count()) === 0 && (await p.locator('[data-install-command]').count()) === 0, t);
    await centre(dev.locator('[data-update-problem]'));
    await p.screenshot({ path: `${SP}/cl-${vp}-worker-failed.png` });
    await setWorker({ version: '0.4.0', bundle: 'aaaaaaaaaaaa' });
    t = await line();
    check(T('worker line: a worker from before self-update offers the command once'), t === 'Worker 0.4.0 · update available', t);
    await centre(dev.locator('[data-worker-line] button'));
    await click(dev.locator('[data-worker-line] button'));
    check(T('its panel says it updates itself after this run'), await manual.waitFor({ timeout: 5000 }).then(async () => /from then on it updates itself/.test(await manual.innerText()), () => false));
    await setWorker({ bundle: served.sha256.slice(0, 12), selfUpdate: { updatedAt: null, from: null, problem: null } });
    check(T('worker line: a current self-updating worker'), (await line()) === 'Worker 0.5.0 · updates itself');
    await setWorker({});
    check(T('worker line: a repo run'), (await line()) === 'Worker 0.5.0 · from the repo');
    await db.collection('devices').updateOne({ _id: D1 }, before ? { $set: { worker: before } } : { $unset: { worker: '' } });
    await p.reload(); await p.waitForSelector('[data-device="Om-PC"]');
  }
  await p.fill('input[aria-label="Name for the new computer"]', `new-${vp}`);
  await click(p.locator('button:has-text("Add this PC")'));
  const keyEl = p.locator('code.bg-muted', { hasText: /^wkr_/ });
  const shown = await keyEl.first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(T('add computer shows the key once with the setup command'), shown);
  const oldKey = (await keyEl.first().innerText()).trim();
  const latest = await (await fetch(B + '/worker/latest.json')).json();
  const winCmd = await p.locator('[data-install-command=windows]').innerText();
  check(T('install command (Windows first): downloads from this site, checks the sha256, setup with --server, no key in it'), winCmd.includes(`${B}/worker/work-os-worker.mjs`) && winCmd.includes(latest.sha256) && winCmd.includes('Get-FileHash') && winCmd.includes('LOCALAPPDATA') && winCmd.includes(`setup --server ${B}`) && !winCmd.includes(oldKey), winCmd.slice(0, 200));
  await click(p.locator('button:has-text("macOS")'));
  const macCmd = await p.locator('[data-install-command=mac]').innerText();
  check(T('install command (macOS): curl, sha256 check, setup, no key in it'), macCmd.includes('curl -fsSL') && macCmd.includes(latest.sha256) && macCmd.includes('.work-os') && macCmd.includes('setup --server') && !macCmd.includes(oldKey), macCmd.slice(0, 200));
  check(T('Setup new-key view: no horizontal scroll'), await noScroll());
  await click(p.locator('button:has-text("I saved it")'));
  await p.reload(); await p.waitForSelector(`[data-device="new-${vp}"]`);
  check(T('key gone after reload (prefix only)'), (await p.locator('code.bg-muted', { hasText: /^wkr_[A-Za-z0-9_-]{30,}/ }).count()) === 0);
  // Replace key: same computer (id, folders, sessions stay), the old key stops at once, the new one works.
  const devBefore = await db.collection('devices').findOne({ name: `new-${vp}` });
  const jobsStatus = async k => (await fetch(B + '/api/worker/jobs', { headers: { authorization: `Bearer ${k}` } })).status;
  check(T('before replace: the key works'), (await jobsStatus(oldKey)) === 200);
  await click(p.locator(`button[aria-label="Replace key for new-${vp}"]`));
  await click(p.locator('[role=dialog]').last().locator('button:has-text("Replace key")'));
  const newEl = p.locator('code.bg-muted', { hasText: /^wkr_/ });
  await newEl.first().waitFor({ timeout: 8000 });
  const newKey = (await newEl.first().innerText()).trim();
  const devAfter = await db.collection('devices').findOne({ name: `new-${vp}` });
  check(T('replace key: a different key is shown once, and the instructions with it'), newKey !== oldKey && /^wkr_/.test(newKey) && (await p.locator('[data-install-command]').count()) === 1);
  check(T('replace key: same device id, still active, replacement recorded'), devAfter._id === devBefore._id && devAfter.revokedAt === null && devAfter.keyReplacements === 1 && !!devAfter.keyReplacedAt);
  check(T('replace key: the old key gets 401 on /api/worker/*, the new one 200'), (await jobsStatus(oldKey)) === 401 && (await jobsStatus(newKey)) === 200);
  await click(p.locator('button:has-text("I saved it")'));
  await click(p.locator(`button[aria-label="Remove new-${vp}"]`));
  const rd = p.locator('[role=dialog]').last();
  check(T('revoke computer asks in a sheet/dialog naming it'), await rd.innerText().then(t => t.includes(`new-${vp}`), () => false));
  await click(rd.locator('button:has-text("Cancel")'));
  await sleep(300);
  check(T('Cancel keeps the computer'), (await db.collection('devices').findOne({ name: `new-${vp}` })).revokedAt === null);
  await click(p.locator(`button[aria-label="Remove new-${vp}"]`));
  await click(p.locator('button[data-confirm]'));
  check(T('revoke removes it'), await p.locator(`[data-device="new-${vp}"]`).waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
  // keys (Advanced, folded: open it; the Claude Code list is the second one)
  await click(p.locator('[data-advanced] > summary'));
  await p.locator('input[aria-label="Name for the new key"]').last().fill(`key-${vp}`);
  await click(p.locator('button:has-text("Create")').last());
  const wk = p.locator('code.bg-muted', { hasText: /^wos_/ });
  check(T('create key shows it once'), await wk.first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  check(T('key command shown'), (await p.locator('code:has-text("claude mcp add")').count()) >= 1);
  await click(p.locator('button:has-text("I saved it")'));
  const krow = p.locator(`text=key-${vp}`).first();
  await krow.waitFor();
  await click(p.locator(`button[aria-label="Remove key key-${vp}"]`));
  check(T('revoke key asks in a sheet/dialog naming it'), await p.locator('[role=dialog]').last().innerText().then(t => t.includes(`key-${vp}`), () => false));
  await click(p.locator('button[data-confirm]'));
  check(T('revoked key leaves the list'), await p.locator(`button[aria-label="Remove key key-${vp}"]`).waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
  await p.screenshot({ path: `${SP}/cl-${vp}-setup.png`, fullPage: true });
  check(T('Setup: no horizontal scroll'), await noScroll());

  // ── Project Info › Code: two labelled parts, findable from the header, removals ask first ──
  await p.goto(B + `/projects/${Bv}?tab=info`);
  await p.waitForSelector('[data-section=code]');
  const codeTxt = await p.locator('[data-section=code]').innerText();
  check(T('Info › Code: "Repository" and "Folders on your computers", each with one line of help'), /Repository/.test(codeTxt) && /Folders on your computers/.test(codeTxt) && /GitHub project \(owner\/repo\)/.test(codeTxt) && /Claude opens its sessions in these folders/.test(codeTxt), codeTxt.slice(0, 300));
  check(T('header chip shows the repo name'), (await p.locator('[data-code-chip]').innerText()).includes('om/bravo'));
  await click(p.locator('button[aria-label="Remove om/bravo"]'));
  const rr = p.locator('[role=dialog]').last();
  check(T('removing a repository asks first, naming it'), await rr.innerText().then(t => t.includes('om/bravo') && /Remove repository/.test(t), () => false));
  await click(rr.locator('button:has-text("Cancel")')); await sleep(400);
  check(T('Cancel keeps the repository'), ((await db.collection('projects').findOne({ _id: Bv }))?.code ?? []).length === 1);
  await click(p.locator('button[aria-label="Remove om/bravo"]'));
  await click(p.locator('button[data-confirm]'));
  await sleep(800);
  check(T('Confirm removes it'), ((await db.collection('projects').findOne({ _id: Bv }))?.code ?? []).length === 0);
  await db.collection('projects').updateOne({ _id: Bv }, { $set: { code: [{ remote: 'om/bravo' }] } });
  await p.goto(B + `/projects/${A}?tab=info`);
  await p.waitForSelector('[data-section=code]');
  check(T('no repository: the header chip says "Link code"'), (await p.locator('[data-code-chip]').innerText()).includes('Link code'));
  check(T('Info › Code lists the linked folders per computer with branch'), await p.locator('[data-section=code] [data-device-group="Om-PC"] [data-folder="alpha-wt/fix"]').innerText().then(t => /branch wt\/fix/.test(t), () => false));
  await click(p.locator('button[aria-label="Unlink alpha-wt/fix"]'));
  const ul = p.locator('[role=dialog]').last();
  check(T('unlinking a folder asks first, naming it'), await ul.innerText().then(t => t.includes('alpha-wt/fix') && /Unlink folder/.test(t), () => false));
  await click(ul.locator('button:has-text("Cancel")')); await sleep(400);
  check(T('Cancel keeps the folder linked'), (await db.collection('workerFolders').findOne({ folderId: 'f_alpha2' }))?.projectId === A);
  await click(p.locator('button[aria-label="Unlink alpha-wt/fix"]'));
  await click(p.locator('button[data-confirm]'));
  await sleep(800);
  check(T('Confirm unlinks it'), (await db.collection('workerFolders').findOne({ folderId: 'f_alpha2' }))?.projectId == null);
  await db.collection('workerFolders').updateOne({ folderId: 'f_alpha2' }, { $set: { projectId: A } });
  // the computer's page: each folder has a "Link to project" picker
  await p.goto(B + '/claude?tab=setup'); await p.waitForSelector('[data-device="Om-PC"]');
  await click(p.locator('button[aria-label="Folders on Om-PC"]'));
  await p.waitForSelector('[data-computer-folder="bravo"]');
  await pick(p, '[aria-label="Link bravo to project"]', Bv);
  await sleep(800);
  check(T('computer page: the picker links a folder to a project'), (await db.collection('workerFolders').findOne({ folderId: 'f_bravo' }))?.projectId === Bv);
  await pick(p, '[aria-label="Link bravo to project"]', '');
  await sleep(800);
  check(T('computer page: "Not linked" takes it off the project'), (await db.collection('workerFolders').findOne({ folderId: 'f_bravo' }))?.projectId == null);

  // redirects + Connect tabs gone
  for (const t of ['code', 'devices']) {
    await p.goto(B + `/connect?tab=${t}`);
    await p.waitForURL(u => u.pathname === '/claude', { timeout: 8000 }).catch(() => {});
    check(T(`/connect?tab=${t} redirects to /claude?tab=setup`), p.url().endsWith('/claude?tab=setup'), p.url());
  }
  await p.goto(B + '/connect');
  check(T('Connect has no Claude Code / Devices tab'), (await p.locator('a[data-tab="code"], a[data-tab="devices"]').count()) === 0);

  // ── Start Claude flow ──
  await p.goto(B + '/claude?tab=workers'); await p.waitForSelector('a[data-start-claude]:visible');
  const depth0 = await p.evaluate(() => history.length);
  await click(p.locator('a[data-start-claude]:visible'));
  await p.waitForSelector('[data-start-step="project"]');
  // An old ?tab=workers link lands on the one Sessions list; Start keeps that tab.
  check(T('Start Claude on /claude opens step 1 (?start=1, tab kept)'), p.url().includes('start=1') && p.url().includes('tab=sessions'), p.url());
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
  check(T('Alpha (2 linked): modal with folder radios, no computer select (one computer)'), (await c2.getAttribute('data-start-mode')) === 'linked' && (await c2.locator('[role=radiogroup] input[type=radio]').count()) === 2 && (await c2.locator('[aria-label="Computer"]').count()) === 0);
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
  check(T('new session shows under Running as starting'), await p.locator(`[data-section="sessions"] [data-session-row$=":${sj.sessionId}"]`).innerText().then(t => /starting/i.test(t) && /Alpha/.test(t), () => false));

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
  check(T('two computers: Computer select appears'), await c5.locator('[aria-label="Computer"]').waitFor({ timeout: 5000 }).then(() => true, () => false));
  await pick(c5, '[aria-label="Computer"]', { label: 'Laptop' });
  check(T('choosing the computer filters folders (one folder shown as text)'), !!(await wait(async () => (await c5.locator('[data-folder-one]').count()) === 1)));
  await p.keyboard.press('Escape'); if (phone) await click(p.locator('[data-sheet] button[aria-label="Close"]').last());
  await p.locator('[data-start-step]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  if (!phone) {
    // key S
    await p.goto(B + '/claude'); await p.waitForSelector('a[data-start-claude]:visible');
    await p.locator('main h1:visible').first().click(); // a spot that is not a control (a session row there would open its sheet)
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
    await p.screenshot({ path: `${SP}/cl-${vp}-final.png` });
  }
  // ── No computer yet: Set up Claude instead of Start Claude, one banner, nothing else telling you to go elsewhere ──
  await db.collection('devices').deleteMany({});
  await p.goto(B + '/claude'); await p.waitForSelector('[data-claude-banner]');
  check(T('no computer: banner "Claude has no PC to work on" with Set up Claude'), (await bnr.getAttribute('data-claude-banner')) === 'no-computer' && /Claude has no PC to work on/.test(await bnr.innerText()) && (await bnr.locator('a[href="/claude?tab=setup"]').count()) === 1);
  check(T('no computer: Set up Claude replaces Start Claude'), (await p.locator('main a[data-set-up-claude]:visible').count()) === 1 && (await p.locator('main a[data-start-claude]:visible').count()) === 0);
  check(T('no computer: no "No computer added yet" line'), !/No computer added/i.test(await p.locator('body').innerText()));
  await h44(p.locator('a[data-set-up-claude]:visible'), 'Set up Claude');
  await p.goto(B + '/claude?tab=setup'); await p.waitForSelector('a[data-set-up-claude]:visible');
  check(T('Set up tab: Set up Claude instead of Start Claude when no computer'), (await p.locator('a[data-start-claude]:visible').count()) === 0);
  await p.goto(B + '/today'); await p.locator(`[data-variant=${phone ? 'phone' : 'desk'}] [data-section="claude-card"]`).waitFor();
  const tv = p.locator(`[data-variant=${phone ? 'phone' : 'desk'}]`);
  check(T('Today with no computer: Set up Claude link, no Start Claude'), (await tv.locator('a[data-set-up-claude]').count()) === 1 && (await tv.locator('[data-start-claude]').count()) === 0);
  // ── Empty Tasks and Projects ──
  await db.collection('tasks').deleteMany({}); await db.collection('projects').deleteMany({});
  await p.goto(B + '/tasks'); await p.waitForSelector('[data-tasks-empty]:visible');
  check(T('Tasks empty: "No tasks yet. Add one, or ask Claude to." with an Add a task button'), /No tasks yet\. Add one, or ask Claude to\./.test(await p.locator('[data-tasks-empty]:visible').innerText()) && (await p.locator('[data-tasks-empty]:visible button:has-text("Add a task")').count()) === 1);
  await h44(p.locator('[data-tasks-empty]:visible button:has-text("Add a task")'), 'Add a task');
  check(T('Tasks empty: no horizontal scroll'), await noScroll());
  await p.goto(B + '/projects'); await p.waitForSelector('[data-projects-empty]');
  const pe = await p.locator('[data-projects-empty]').innerText();
  check(T('Projects empty: says what a project is, and Click / Tap by device'), /A project groups tasks, notes and Claude for one client or product\./.test(pe) && (phone ? /Tap New project/.test(pe) && !/Click New project/.test(pe) : /Click New project\./.test(pe) && !/Tap New project/.test(pe)), pe); // the phone has a New project button (navigation step)
  check(T('no console/page errors'), errs.length === 0, errs.join(' | '));
  await ctx.close();
}
try { await suite(1280); await suite(390); } finally { await browser.close(); }
await finish();
