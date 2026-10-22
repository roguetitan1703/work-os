// Dispatcher UI: Give to Claude / Take back sheet, folder picker, refusals, row menus, Claude's tasks section, Setup switch, alerts table kinds at 1280 and 390. Seeds itself. Seed profile: none.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { launch, B, PW, SP, ME, db, mc, runAssertSuite, assert, check, fillLogin } from './lib.mjs';
const sha = s => createHash('sha256').update(s).digest('hex');

await runAssertSuite('dispatcher-ui', async () => {
  for (const n of ['tasks', 'activity', 'alertLog', 'alertQueue', 'notifications', 'workerSessions', 'workerJobs', 'workerFolders', 'devices', 'settings', 'projects', 'notes', 'trash', 'claudeItems']) await db.collection(n).deleteMany({});
  const now = new Date();
  await db.collection('projects').insertMany([
    { _id: 'p1', name: 'AKAR', nameLower: 'akar', client: 'Acme', description: '', status: 'active', createdAt: now, updatedAt: now },
    { _id: 'p2', name: 'Delpat Site', nameLower: 'delpat site', client: '', description: '', status: 'active', createdAt: now, updatedAt: now },
    { _id: 'p3', name: 'No Folder Co', nameLower: 'no folder co', client: '', description: '', status: 'active', createdAt: now, updatedAt: now },
  ]);
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  const dev = randomUUID();
  await db.collection('devices').insertOne({ _id: dev, name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: now, lastSeenAt: now, revokedAt: null, worker: { version: '0.1.0', os: 'win32', allowPrompts: true } });
  const fol = (id, name, projectId) => ({ _id: `${dev}:${id}`, deviceId: dev, folderId: id, name, git: true, branch: 'main', projectId, linkedAt: now, seenAt: now, missing: false });
  await db.collection('workerFolders').insertMany([fol('f_a1aa', 'akar-api', 'p1'), fol('f_a2aa', 'akar-web', 'p1'), fol('f_s1aa', 'delpat-site', 'p2')]);
  const base = { description: '', mode: null, priority: 'P2', status: 'Not Started', tags: [], due: null, start: null, estimateMins: null, progress: 0, checklist: [], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: 'me', createdAt: new Date(Date.now() - 864e5), updatedAt: new Date(Date.now() - 36e5), doneAt: null, doneOn: null, doneBy: null };
  const T = (ref, title, o = {}) => ({ ...base, _id: 'u' + ref, ref, title, ...o });
  const mark = (state, o = {}) => ({ state, markedAt: new Date(Date.now() - 3e5), markedBy: 'om', ...o });
  await db.collection('tasks').insertMany([
    T(10, 'Two folders task', { projectId: 'p1' }),
    T(11, 'One folder task', { projectId: 'p2' }),
    T(12, 'No folder task', { projectId: 'p3' }),
    T(13, 'No project task'),
    T(14, 'Queued first task', { projectId: 'p2', claude: mark('queued') }),
    T(15, 'Queued second task', { projectId: 'p1', claude: mark('queued', { markedAt: new Date(Date.now() - 2e5) }) }),
    T(16, 'Running task', { projectId: 'p1', status: 'In Progress', claude: mark('running', { claimedAt: new Date(Date.now() - 6e5), deviceId: dev, sessionId: randomUUID(), prevStatus: 'Not Started' }) }),
    T(17, 'Finished task', { projectId: 'p1', status: 'Done', doneAt: now, doneOn: '2026-10-16', doneBy: 'claude-code', claude: mark('finished', { endedAt: new Date(Date.now() - 36e5), claimedAt: new Date(Date.now() - 72e5), deviceId: dev }) }),
    T(18, 'Stopped task', { projectId: 'p2', status: 'In Progress', claude: mark('stopped', { endedAt: new Date(Date.now() - 18e5), note: 'blocked: needs prod credentials' }) }),
  ]);
  await db.collection('counters').updateOne({ _id: 'task' }, { $set: { seq: 50 } }, { upsert: true });
  await db.collection('notes').insertOne({ _id: 'nb', title: 'Claude Code boilerplate', blocks: [], body: 'rules', parentId: null, taskId: null, projectId: null, archived: false, createdBy: 'me', createdAt: now, updatedBy: 'me', updatedAt: now, deletedAt: null });
  const st = ref => db.collection('tasks').findOne({ ref });
  // the running session row so Stop has something
  const r16 = await st(16);
  await db.collection('workerSessions').insertOne({ _id: r16.claude.sessionId, deviceId: dev, folderId: 'f_a1aa', projectId: 'p1', state: 'running', startedAt: now, updatedAt: now, dispatched: true, taskId: 'u16' });

  const b = await launch();
  for (const [label, vp, touch] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const ctx = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(p.url() + ' ' + e.message.slice(0, 400)));
    await p.goto(B + '/login');
    await fillLogin(p);
    await p.click('button[type=submit]');
    await p.waitForURL(u => !u.pathname.startsWith('/login'));
    const phone = label === 'phone';
    const noScroll = async what => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label} ${what}: horizontal scroll`);
    const openMark = async () => {
      if (phone) { await p.locator('button[aria-label="More actions"]').click(); await p.getByRole('button', { name: /(Give to|Take back from) Claude/ }).click(); }
      else await p.locator('[data-claude-menu]').first().click();
      await p.locator('[data-claude-give], [data-claude-blocked], [data-claude-take-back]').first().waitFor();
    };
    const sheetOk = async () => { if (phone) assert.equal(await p.locator('[data-sheet]').count(), 1, 'phone mark sheet is a data-sheet'); };
    const btnH = async sel => { const hs = await p.locator(sel).evaluateAll(es => es.map(e => e.getBoundingClientRect().height)); if (phone) assert.ok(hs.length && hs.every(h => h >= 43.5), `${label} ${sel} heights ${hs}`); };

    // 1. one folder: give
    await p.goto(B + '/tasks/11'); await openMark(); await sheetOk();
    assert.ok(await p.locator('[data-folder-one]').innerText().then(t => /delpat-site/.test(t)), 'one folder shown, no picker');
    assert.equal(await p.locator('[role=radiogroup]').count(), 0, 'no picker for one folder');
    assert.ok(await p.locator('[data-claude-off]').count() === 1, 'dispatcher-off notice');
    await btnH('[data-claude-give]');
    await p.screenshot({ path: `${SP}/d-${label}-give.png` });
    await p.locator('[data-claude-give]').click();
    await p.waitForFunction(() => !document.querySelector('[data-claude-sheet]'));
    let t = await st(11); assert.equal(t.claude.state, 'queued'); assert.ok(!t.claude.folderKey, 'single folder: no folderKey');
    await p.waitForTimeout(600); await p.reload();
    assert.ok(await p.locator('[data-claude-badge=queued]').count() >= 1, 'queued badge on task page');
    console.log(label, 'give with one folder ok');
    // take back
    await openMark(); assert.equal(await p.locator('[data-claude-sheet=queued]').count(), 1);
    await btnH('[data-claude-take-back]');
    await p.locator('[data-claude-take-back]').click(); await p.waitForFunction(() => !document.querySelector('[data-claude-sheet]'));
    t = await st(11); assert.ok(!t.claude, 'taken back clears claude');
    console.log(label, 'take back queued ok');

    // 2. no folder
    await p.goto(B + '/tasks/12'); await openMark();
    assert.ok(/Link a folder first/.test(await p.locator('[data-claude-blocked]').innerText()), 'refuse: link a folder first');
    assert.equal(await p.locator('[data-claude-give]').count(), 0);
    await p.keyboard.press('Escape'); if (phone) await p.locator('button[aria-label=Close]').last().click().catch(() => {});
    await p.goto(B + '/tasks/13'); await openMark();
    assert.ok(/project first/.test(await p.locator('[data-claude-blocked]').innerText()), 'refuse: no project');
    console.log(label, 'refusals ok');

    // 3. two folders: picker
    await p.goto(B + '/tasks/10'); await openMark(); await sheetOk();
    assert.equal(await p.locator('[role=radiogroup] input[type=radio]').count(), 2, 'picker with two folders');
    assert.ok(await p.locator('[data-claude-give]').isDisabled(), 'give disabled until a folder is chosen');
    await p.locator('[role=radiogroup] label').nth(1).click();
    await p.screenshot({ path: `${SP}/d-${label}-picker.png` });
    await p.locator('[data-claude-give]').click(); await p.waitForFunction(() => !document.querySelector('[data-claude-sheet]'));
    t = await st(10); assert.equal(t.claude.folderKey, `${dev}:f_a2aa`, 'chosen folder stored');
    console.log(label, 'folder picker ok');
    await db.collection('tasks').updateOne({ ref: 10 }, { $set: { claude: null } });

    // 4. row menus
    if (phone) {
      await p.goto(B + '/tasks'); await p.waitForTimeout(600);
      const row = p.locator('button[aria-label="Actions for Two folders task"]');
      await row.scrollIntoViewIfNeeded(); await row.click();
      await p.locator('[data-claude-menu]').click(); await p.locator('[data-claude-give], [data-claude-blocked], [data-claude-take-back]').first().waitFor(); await sheetOk();
      assert.equal(await p.locator('[role=radiogroup] input').count(), 2);
      await p.keyboard.press('Escape'); await p.locator('button[aria-label=Close]').last().click();
      assert.ok(await p.locator('[data-claude-badge]').count() >= 2, 'badges on rows for queued/running tasks');
      console.log(label, 'phone row menu ok');
    } else {
      await p.goto(B + '/projects/p1'); await p.waitForTimeout(600);
      const row = p.locator('div.group', { hasText: 'Two folders task' }).first();
      await row.hover(); await row.locator('[data-claude-menu]').click(); await p.locator('[data-claude-give], [data-claude-blocked], [data-claude-take-back]').first().waitFor();
      assert.equal(await p.locator('[role=radiogroup] input').count(), 2);
      await p.keyboard.press('Escape');
      assert.ok(await p.locator('[data-claude-badge]').count() >= 2, 'badges on rows');
      console.log(label, 'desktop row menu ok');
    }

    // 5. Claude page: Claude's tasks
    await p.goto(B + '/claude'); await p.locator('[data-section=claude-tasks]').waitFor();
    const sec = await p.locator('[data-section=claude-tasks]').innerText();
    console.log(label, 'section text:', sec.replace(/\n/g, ' | '));
    assert.ok(/Working 1 of 2/.test(sec) && /Running task/.test(sec) && /Queued, in order/.test(sec) && /#1 in line/.test(sec) && /#2 in line/.test(sec), 'groups');
    assert.ok(sec.indexOf('Queued first task') < sec.indexOf('Queued second task'), 'queue in marked order');
    assert.ok(/Recently finished or stopped/.test(sec) && /Finished task/.test(sec) && /needs prod credentials/.test(sec), 'recent');
    assert.ok(await p.locator('[data-dispatcher-off]').count() === 1, 'off banner');
    await btnH('[data-section=claude-tasks] button');
    await noScroll('claude now');
    await p.screenshot({ path: `${SP}/d-${label}-now.png`, fullPage: true });
    // take back a queued one from the page
    await p.getByRole('button', { name: 'Take back #14' }).click();
    await p.locator('[data-confirm]').click();
    await p.waitForFunction(() => !document.querySelector('[data-claude-task="14"]'), null, { timeout: 8000 });
    assert.ok(!(await st(14)).claude, '14 taken back from the page');
    console.log(label, 'claude tasks section ok');

    // 6. Setup
    await p.goto(B + '/claude?tab=setup'); await p.locator('[data-dispatcher-setup]').waitFor();
    await noScroll('setup');
    const en = p.locator('[data-dispatcher-enabled]');
    await en.check(); await p.waitForTimeout(800);
    assert.ok(!(await db.collection('settings').findOne({ _id: 'dispatcher' }))?.enabled, 'cannot enable without a note');
    assert.equal(await en.isChecked(), false, 'switch rolled back');
    await p.locator('[data-dispatcher-note]').selectOption('nb'); await p.waitForTimeout(800);
    await p.locator('[data-dispatcher-cap]').selectOption('3'); await p.waitForTimeout(800);
    await en.check(); await p.waitForTimeout(1000);
    let s = await db.collection('settings').findOne({ _id: 'dispatcher' });
    assert.ok(s.enabled === true && s.maxConcurrent === 3 && s.boilerplateNoteId === 'nb', JSON.stringify(s));
    const fs = await p.locator('[data-dispatcher-note]').evaluate(e => getComputedStyle(e).fontSize);
    if (phone) assert.equal(fs, '16px', 'select font 16px');
    await p.screenshot({ path: `${SP}/d-${label}-setup.png`, fullPage: true });
    // reset for the second viewport pass
    await db.collection('settings').deleteMany({});
    await db.collection('tasks').updateOne({ ref: 14 }, { $set: { claude: mark('queued') } });
    console.log(label, 'setup ok');
    assert.deepEqual(errs, [], 'page errors ' + errs);
    await ctx.close();
  }
  // settings alerts table lists the new kinds
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(B + '/login'); await fillLogin(p); await p.click('button[type=submit]'); await p.waitForURL(u => !u.pathname.startsWith('/login'));
  await p.goto(B + '/settings?section=alerts'); await p.waitForTimeout(800);
  const txt = await p.locator('main').innerText();
  assert.ok(/Claude finished/.test(txt) && /Claude stopped/.test(txt) && /may be stuck/.test(txt), 'alerts table shows claude kinds: ' + txt.slice(0, 300));
  await p.screenshot({ path: `${SP}/d-desktop-alerts.png` });
  console.log('alerts table ok');
  await b.close();
  console.log('UI ALL OK');
});
