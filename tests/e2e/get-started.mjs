// First-run checklist on Today (and Settings › Get started): rows tick from real data, owner rows for owners, server-health rows for the
// operator only, "Hide this" and bringing it back, it goes away when everything is done, the welcome line after Join, phone layout. Seed profile: none.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { launch, B, SP, ME, rawDb, makeUser, mkKey, mcpAs, login, setProfile, runAssertSuite, assert, overflow, okO } from './lib.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');

await runAssertSuite('get-started', async () => {
  const b = await launch();
  const settingsDoc = (who, area, set) => rawDb.collection('settings').updateOne({ _id: `${area}:${who.userId}` }, { $set: { area, orgId: who.orgId, userId: who.userId, ...set } }, { upsert: true });

  // ── the owner (also the operator): owner rows first, server rows last ──
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await login(p, { next: '/today' });
    const card = p.locator('[data-variant=desk] [data-checklist=today]');
    await card.waitFor();
    const rows = async () => {
      if ((await card.locator('[data-checklist-toggle]').getAttribute('aria-expanded')) === 'false') await card.locator('[data-checklist-toggle]').click();
      return card.locator('[data-checklist-row]').evaluateAll(es => es.map(e => e.getAttribute('data-checklist-row') + ':' + e.getAttribute('data-done')));
    };
    let r = await rows();
    assert.deepEqual(r.map(x => x.split(':')[0]), ['invite', 'project', 'task', 'alerts', 'discord', 'claude', 'pc', 'server-push', 'server-alerts'], 'owner + operator rows in order: ' + r);
    assert.ok(r.every(x => x.endsWith(':0')), 'nothing done on an empty organization: ' + r);
    assert.ok(/0 of 9 done/.test(await card.locator('[data-checklist-count]').innerText()));
    assert.ok(/Optional/.test(await card.locator('[data-checklist-row=discord]').innerText()) && /Optional/.test(await card.locator('[data-checklist-row=pc]').innerText()), 'Discord and PC are marked optional');
    // buttons go where they say
    assert.equal(await card.locator('[data-checklist-row=claude] a').getAttribute('href'), '/claude?tab=setup');
    assert.equal(await card.locator('[data-checklist-row=alerts] a').getAttribute('href'), '/settings?section=notifications');
    assert.equal(await card.locator('[data-checklist-row=invite] a').getAttribute('href'), '/settings?section=team#invite');
    assert.equal(await card.locator('[data-checklist-row=server-push] a').getAttribute('href'), '/settings?section=server');
    // Add a task opens the quick add
    await card.locator('[data-checklist-row=task] button').click();
    await p.getByRole('dialog').waitFor({ timeout: 8000 });
    assert.ok(/Quick add/.test(await p.getByRole('dialog').innerText()), 'Add a task opens quick add');
    await p.keyboard.press('Escape');
    await p.screenshot({ path: `${SP}/today-checklist-desktop.png`, fullPage: true });

    // each row ticks from real data
    await mcpAs(await mkKey({ agent: 'claude' }), 'add_task', { title: 'First real task' });
    await mcpAs(await mkKey({ agent: 'claude' }), 'add_project', { name: 'First project' });
    await makeUser({ email: 'gs-second@example.test', name: 'Second', orgId: ME.orgId, role: 'member' });
    await rawDb.collection('pushSubs').insertOne({ _id: 'https://push.example.test/gs-owner', orgId: ME.orgId, userId: ME.userId, keys: { p256dh: 'x', auth: 'y' }, device: 'Chrome', createdAt: new Date(), updatedAt: new Date() });
    await settingsDoc(ME, 'status', { lastMcpAt: new Date() });
    await p.reload(); await card.waitFor();
    r = await rows();
    const done = Object.fromEntries(r.map(x => x.split(':')));
    assert.deepEqual([done.task, done.project, done.invite, done.alerts, done.discord, done.claude, done.pc, done['server-push'], done['server-alerts']], ['1', '1', '1', '1', '0', '1', '0', '0', '0'], 'ticks from data (Discord is in the next block: profiles are cached a minute): ' + r);
    assert.ok(/5 of 9 done/.test(await card.locator('[data-checklist-count]').innerText()));
    // the PC row needs both: a computer that has checked in and the switch on
    const devKey = 'wkr_' + randomBytes(32).toString('base64url');
    await rawDb.collection('devices').insertOne({ _id: randomUUID(), name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: sha(devKey), prefix: devKey.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
    await p.reload(); await card.waitFor();
    assert.equal(Object.fromEntries((await rows()).map(x => x.split(':'))).pc, '0', 'a computer alone does not tick the PC row');
    await rawDb.collection('notes').insertOne({ _id: 'gs-note', title: 'Standing', blocks: [], body: 'x', parentId: null, taskId: null, projectId: null, archived: false, createdBy: ME.userId, ownerId: ME.userId, orgId: ME.orgId, createdAt: new Date(), updatedBy: ME.userId, updatedAt: new Date(), deletedAt: null });
    await settingsDoc(ME, 'dispatcher', { enabled: true, maxConcurrent: 2, boilerplateNoteId: 'gs-note' });
    await p.reload(); await card.waitFor();
    // the card folds to one line once a task exists, and opens again
    assert.equal(await card.locator('[data-checklist-toggle]').getAttribute('aria-expanded'), 'false', 'folded once the person is under way');
    assert.equal(Object.fromEntries((await rows()).map(x => x.split(':'))).pc, '1', 'computer + switch on ticks the PC row');
    assert.equal(await card.locator('[data-checklist-row]').count(), 9);

    // Hide this: gone from Today, still in Settings › Get started, and it can come back
    await card.locator('[data-checklist-hide]').click();
    await card.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await p.reload(); await p.waitForSelector('[data-variant=desk]');
    assert.equal(await p.locator('[data-checklist=today]').count(), 0, 'hidden on Today');
    assert.equal((await rawDb.collection('settings').findOne({ _id: 'profile:' + ME.userId })).checklistHidden, true);
    await p.goto(B + '/settings?section=started'); await p.waitForSelector('[data-checklist=settings]');
    assert.ok(/5 of 9|6 of 9/.test(await p.locator('[data-checklist=settings] [data-checklist-count]').innerText()));
    await p.locator('[data-checklist-show]').click();
    await p.waitForFunction(() => true);
    await p.waitForTimeout(800);
    assert.equal((await rawDb.collection('settings').findOne({ _id: 'profile:' + ME.userId })).checklistHidden, false, 'Show on Today brings it back');
    await p.goto(B + '/today'); await p.locator('[data-variant=desk] [data-checklist=today]').waitFor();
    // the welcome line after Join (?welcome=1)
    await p.goto(B + '/today?welcome=1'); await p.locator('[data-variant=desk] [data-welcome]').waitFor();
    assert.ok(/^Welcome, E2E\./.test((await p.locator('[data-variant=desk] [data-welcome]').innerText()).trim()), await p.locator('[data-variant=desk] [data-welcome]').innerText());
    assert.deepEqual(errs, [], 'page errors');
    await ctx.close();
  }

  const member = await makeUser({ email: 'gs-member@example.test', name: 'Priya Rao', orgId: ME.orgId, role: 'member' });
  // ── a member: no owner rows, no server health; five rows; goes away when everything is done ──
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    const p = await ctx.newPage();
    await setProfile(member, { discordId: '555000222' });
    await login(p, { next: '/today?welcome=1', email: 'gs-member@example.test' });
    const card = p.locator('[data-variant=desk] [data-checklist=today]');
    await card.waitFor();
    const rows = async () => card.locator('[data-checklist-row]').evaluateAll(es => es.map(e => e.getAttribute('data-checklist-row') + ':' + e.getAttribute('data-done')));
    let r = await rows();
    assert.deepEqual(r.map(x => x.split(':')[0]), ['task', 'alerts', 'discord', 'claude', 'pc'], 'a member has five rows, no owner rows, no server health: ' + r);
    assert.ok(!/Server|Invite your team|Create your first project/.test(await card.innerText()), 'no owner or server text for a member');
    assert.ok(/^Welcome, Priya\. \d things to do first\.$/.test((await p.locator('[data-variant=desk] [data-welcome]').innerText()).trim()), await p.locator('[data-variant=desk] [data-welcome]').innerText());
    assert.equal(Object.fromEntries(r.map(x => x.split(':'))).discord, '1', 'a linked Discord ticks its row');
    // tick all five
    const mk = await mkKey({ agent: 'claude', userId: member.userId, orgId: member.orgId });
    await mcpAs(mk, 'add_task', { title: 'Priya task' });
    await rawDb.collection('pushSubs').insertOne({ _id: 'https://push.example.test/gs-member', orgId: ME.orgId, userId: member.userId, keys: { p256dh: 'x', auth: 'y' }, device: 'Chrome', createdAt: new Date(), updatedAt: new Date() });
    await settingsDoc(member, 'status', { lastMcpAt: new Date() });
    const devKey = 'wkr_' + randomBytes(32).toString('base64url');
    await rawDb.collection('devices').insertOne({ _id: randomUUID(), name: 'Priya-PC', ownerId: member.userId, orgId: ME.orgId, hash: sha(devKey), prefix: devKey.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
    await rawDb.collection('notes').insertOne({ _id: 'gs-note-m', title: 'Standing', blocks: [], body: 'x', parentId: null, taskId: null, projectId: null, archived: false, createdBy: member.userId, ownerId: member.userId, orgId: ME.orgId, createdAt: new Date(), updatedBy: member.userId, updatedAt: new Date(), deletedAt: null });
    await settingsDoc(member, 'dispatcher', { enabled: true, maxConcurrent: 2, boilerplateNoteId: 'gs-note-m' });
    await p.goto(B + '/today');
    await p.waitForSelector('[data-variant=desk] [data-section="claude-card"]');
    assert.equal(await p.locator('[data-variant=desk] [data-checklist=today]').count(), 0, 'all done: the card is gone for good');
    await p.goto(B + '/settings?section=started'); await p.waitForSelector('[data-checklist=settings]');
    assert.ok(/5 of 5 done/.test(await p.locator('[data-checklist=settings] [data-checklist-count]').innerText()));
    assert.equal(await p.locator('[data-checklist=settings] [data-checklist-row][data-done="1"]').count(), 5);
    await ctx.close();
  }

  // ── phone: the card on Today, 44px buttons, no sideways scroll ──
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' });
    const p = await ctx.newPage();
    await rawDb.collection('settings').updateOne({ _id: 'profile:' + ME.userId }, { $set: { checklistHidden: false } });
    await rawDb.collection('tasks').deleteMany({}); // day one again: open
    await login(p, { phone: true, next: '/today' });
    const card = p.locator('[data-variant=phone] [data-checklist=today]');
    await card.waitFor();
    if ((await card.locator('[data-checklist-toggle]').getAttribute('aria-expanded')) !== 'true') await card.locator('[data-checklist-toggle]').tap();
    const hs = await card.locator('[data-checklist-row] a, [data-checklist-row] button').evaluateAll(es => es.map(e => e.getBoundingClientRect().height));
    assert.ok(hs.length >= 3 && hs.every(h => h >= 43.5), 'phone buttons are 44px: ' + hs);
    assert.ok(okO(await overflow(p)), 'no sideways scroll: ' + JSON.stringify(await overflow(p)));
    await p.screenshot({ path: `${SP}/today-checklist-phone.png`, fullPage: true });
    await ctx.close();
  }
  await b.close();
  console.log('ALL OK');
});
