// H13 UI: Claude › Setup › Computers shows the "Not Work OS folders" list (hidden when empty, one Remove per row), and the
// Sessions list on Claude › Now reads "not filed" for a session whose folder no project owns, with a Link button that opens
// the same project picker as the folder list. Looked at in 390 and 1280 px, light and dark (shots in E2E_SHOTS).
// Seeds itself (device, folders and the computer's session list inserted directly). Seed profile: none.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { B, ME, SP, check, db, finish, launch, login, mcp, mkKey, pick, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => false); if (v) return v; await sleep(150); } return false; };

const browser = await launch();
try {
  const cc = await mkKey({ agent: 'claude-code', name: 'H13 ui' });
  const deviceId = randomUUID();
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  await db.collection('devices').insertOne({ _id: deviceId, name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
  const alpha = (await mcp('add_project', { name: 'Alpha' })).project.id;
  await mcp('add_project', { name: 'Cutroom' });
  const mkFolder = (folderId, name, projectId = null) => db.collection('workerFolders').insertOne({ _id: `${deviceId}:${folderId}`, deviceId, folderId, name, git: true, projectId, linkedAt: projectId ? new Date() : null, seenAt: new Date(), missing: false });
  await mkFolder('f_alpha', 'alpha', alpha);
  await mkFolder('f_newthing', 'new-thing');
  const CC1 = 'cc-' + randomUUID();
  const CC2 = 'cc-' + randomUUID();
  const CC3 = 'cc-' + randomUUID();
  const item = (id, folder, title) => ({ sessionId: id, folder, title, lastActiveAt: new Date(Date.now() - 3 * 60_000), subagentsActive: 0, startedByWorkOs: false, running: true });
  await db.collection('devices').updateOne({ _id: deviceId }, { $set: { claudeSessions: { at: new Date(), items: [item(CC1, 'alpha', 'Fixing the invoice export'), item(CC2, 'new-thing', 'Trying a new idea'), item(CC3, 'somewhere-else', 'Session in a folder the worker never scanned')] } } });
  // Two folders marked not Work OS, through the real tool
  await must(cc, 'start_work', { path: 'D:/Scratch/Thing', machine: 'Om-PC', not_work_os: true });
  await must(cc, 'start_work', { path: 'C:/Users/om/Desktop', machine: 'Om-PC', not_work_os: true });

  for (const vp of [390, 1280]) {
    const phone = vp === 390;
    const T = s => `[${vp}] ${s}`;
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } : { viewport: { width: 1280, height: 800 }, colorScheme: scheme });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push('PAGEERR ' + e.message.slice(0, 80)));
      const click = l => (phone ? l.tap() : l.click());
      const noScroll = () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth + 1);
      await login(p, { phone, next: '/claude?tab=setup' });
      await p.waitForSelector('[data-computers]');
      const tag = `${vp}-${scheme}`;

      // ── Setup › Computers: the Not Work OS folders list
      const quiet = p.locator('[data-quiet-folders]');
      await quiet.waitFor({ timeout: 8000 });
      const rows = quiet.locator('[data-quiet-folder]');
      check(T(`${scheme}: two Not Work OS folders listed, path as the name and the computer small`), (await rows.count()) === 2 && /d:\/scratch\/thing/i.test(await quiet.innerText()) && /om-pc/i.test(await rows.first().innerText()), await quiet.innerText());
      const removeBtn = rows.first().locator('button');
      check(T(`${scheme}: one Remove button per row, on the right`), (await rows.first().locator('button').count()) === 1 && (await removeBtn.getAttribute('aria-label')).startsWith('Remove '));
      if (phone) { const bb = await removeBtn.boundingBox(); check(T(`${scheme}: Remove target at least 44px`), bb && bb.width >= 43.5 && bb.height >= 43.5, JSON.stringify(bb)); }
      check(T(`${scheme}: Setup no horizontal scroll with the list`), await noScroll());
      await quiet.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${SP}/h13-${tag}-setup.png`, fullPage: true });

      // ── Claude › Now: the Sessions list
      await p.goto(B + '/claude');
      await p.waitForSelector('[data-section="sessions"]');
      const unfiled = p.locator(`[data-session-row="${deviceId}:${CC2}"]`);
      const filed = p.locator(`[data-session-row="${deviceId}:${CC1}"]`);
      const stray = p.locator(`[data-session-row="${deviceId}:${CC3}"]`);
      check(T(`${scheme}: a session in an unlinked folder reads "not filed" where the project goes`), /not filed/.test(await unfiled.innerText()) && !/not filed/.test(await filed.innerText()), await unfiled.innerText());
      check(T(`${scheme}: the filed session still shows its project`), /Alpha/.test(await filed.innerText()));
      check(T(`${scheme}: the unfiled session has a Link button; one in a folder the worker never scanned has none`), (await unfiled.locator('[data-link-folder]').count()) === 1 && (await stray.locator('[data-link-folder]').count()) === 0 && /not filed/.test(await stray.innerText()));
      if (phone) { const bb = await unfiled.locator('[data-link-folder]').boundingBox(); check(T(`${scheme}: Link target at least 44px`), bb && bb.height >= 43.5, JSON.stringify(bb)); }
      check(T(`${scheme}: Claude page no horizontal scroll with the not filed row`), await noScroll());
      await p.screenshot({ path: `${SP}/h13-${tag}-sessions.png` });

      if (scheme === 'light') {
        // The picker: Link needs a choice; choosing links the folder through relinkFolder
        await click(unfiled.locator('[data-link-folder]'));
        const dlg = p.locator('[data-link-session-folder]');
        await dlg.waitFor({ timeout: 6000 });
        const linkBtn = dlg.locator('button[data-confirm]');
        check(T('Link to project: Link is disabled until a project is chosen'), await linkBtn.isDisabled());
        await p.screenshot({ path: `${SP}/h13-${tag}-link-sheet.png` });
        await pick(p, dlg.locator('[aria-label="Link new-thing to project"]'), { label: 'Cutroom' });
        await click(linkBtn);
        const linked = await wait(async () => (await rawDb.collection('workerFolders').findOne({ _id: `${deviceId}:f_newthing` }))?.projectId);
        check(T('Link to project files the folder under the chosen project'), !!linked && (await rawDb.collection('projects').findOne({ _id: linked }))?.name === 'Cutroom', String(linked));
        await p.goto(B + '/claude');
        await p.waitForSelector('[data-section="sessions"]');
        check(T('after linking, the session shows the project and no Link button'), /Cutroom/.test(await unfiled.innerText()) && (await unfiled.locator('[data-link-folder]').count()) === 0, await unfiled.innerText());
        await rawDb.collection('workerFolders').updateOne({ _id: `${deviceId}:f_newthing` }, { $set: { projectId: null, linkedAt: null } }); // back to unfiled for the dark pass
      }

      // ── Remove: the folder asks again, the list shrinks; with none left it is hidden
      if (scheme === 'light') {
        await p.goto(B + '/claude?tab=setup');
        await p.waitForSelector('[data-quiet-folders]');
        const before = await p.locator('[data-quiet-folder]').count();
        await click(p.locator('[data-quiet-folder]').first().locator('button'));
        check(T('Remove takes the folder off the list'), !!(await wait(async () => (await p.locator('[data-quiet-folder]').count()) === before - 1)));
        const doc = await rawDb.collection('settings').findOne({ _id: `quietFolders:${ME.userId}` });
        check(T('Remove changed the saved list'), doc?.items?.length === before - 1, JSON.stringify(doc?.items));
        await click(p.locator('[data-quiet-folder]').first().locator('button'));
        check(T('with no folder left the section is hidden'), await p.locator('[data-quiet-folders]').waitFor({ state: 'detached', timeout: 6000 }).then(() => true, () => false));
        await p.screenshot({ path: `${SP}/h13-${tag}-setup-empty.png`, fullPage: true });
        // put them back for the dark pass
        await must(cc, 'start_work', { path: 'D:/Scratch/Thing', machine: 'Om-PC', not_work_os: true });
        await must(cc, 'start_work', { path: 'C:/Users/om/Desktop', machine: 'Om-PC', not_work_os: true });
      }
      check(T(`${scheme}: no page errors`), errs.length === 0, errs.join(' | '));
      await ctx.close();
    }
  }
} catch (e) {
  check('flow-h13-ui (error)', false, e?.stack || String(e));
}
await browser.close();
await finish();

