// Settings (laid out like Claude's own): left list with search and groups, redirects of the old places, theme, Notifications
// (this device, alerts, quiet hours, Discord, in that order), the Connections table, Team (invite roles, kinds of work), and who
// sees Server and the health strip (the operator only). Phone: a list of rows with plain hints, then the section. Seed profile: none.
import { launch, B, SP, rawDb, ME, makeUser, login, runAssertSuite, assert, overflow, okO } from './lib.mjs';
await runAssertSuite('settings', async () => {
  const b = await launch();
  // real HTTP redirects, no browser
  for (const [from, to] of [
    ['/connect', 'section=connections'],
    ['/connect?tab=alerts', 'section=notifications'],
    ['/connect?tab=discord', 'section=notifications&open=discord'],
    ['/connect?tab=code', '/claude?tab=setup'],
    ['/connect?tab=chat', '/claude?tab=setup'],
    ['/recovery', 'section=team&open=modes'],
  ]) {
    const r = await fetch(B + from, { redirect: 'manual' });
    console.log(from, r.status, r.headers.get('location'));
    assert.ok([307, 308].includes(r.status));
    assert.ok(r.headers.get('location').includes(to), `${from} -> ${to}`);
  }
  const member = await makeUser({ email: 'set-member@example.test', name: 'Priya', orgId: ME.orgId, role: 'member' });
  const owner2 = await makeUser({ email: 'set-owner2@example.test', name: 'Second Owner', orgId: ME.orgId, role: 'owner' });
  void member; void owner2;

  for (const [label, vp, touch] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
    const ctx = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch, colorScheme: 'light' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await login(p, { phone: touch, next: '/settings' });
    const ready = () => p.waitForSelector('[data-settings]');
    const noOverflow = async what => assert.ok(okO(await overflow(p)), `overflow ${what}: ${JSON.stringify(await overflow(p))}`);
    // A link clicked while the page is still hydrating is sometimes swallowed by the client router; click again until the URL changes.
    const open = async (loc, url) => { for (let n = 0; n < 4; n++) { await loc.click(); try { await p.waitForURL(url, { timeout: 5000 }); return; } catch (e) { if (n === 3) throw e; } } };
    // A toggle saves through a server action; every click waits for the action's response before moving on.
    const toggle = async sw => { const done = p.waitForResponse(r => r.request().method() === 'POST' && r.url().startsWith(B + '/settings'), { timeout: 20000 }); await sw.click(); await done; };

    // old ?section= names go to where they live now
    for (const [from, want] of [
      ['device', /section=notifications/], ['alerts', /section=notifications/], ['security', /section=account/], ['members', /section=team/],
      ['usage', /section=server/], ['help', /section=team&open=modes/], ['connections&open=discord', /section=notifications&open=discord/],
    ]) {
      await p.goto(`${B}/settings?section=${from}`);
      await p.waitForURL(want, { timeout: 10000 });
    }
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = await p.goto(`${B}/settings?section=${bad}`);
      assert.ok(r.status() < 500 && p.url().includes('/settings') && !p.url().includes('section=' + bad + '&'), 'prototype name ' + bad + ' is not a section: ' + r.status() + ' ' + p.url());
      await p.waitForSelector('[data-settings-search]', { state: 'attached', timeout: 10000 });
    }
    await p.goto(`${B}/settings?section=connections&open=chat`);
    await p.waitForURL(u => u.pathname === '/claude' && u.search === '?tab=setup', { timeout: 10000 });
    await p.goto(`${B}/settings?section=help`); await p.waitForURL(/section=team/); await p.waitForSelector('[data-help]');
    assert.equal(await p.locator('[data-help] details[open]').count(), 1, 'the redirect from Modes of work opens the kinds-of-work list');
    console.log(label, 'old section names redirect');

    // overview: desktop = left list + the first section; phone = rows with plain hints
    await p.goto(B + '/settings'); await ready();
    if (label === 'phone') {
      assert.ok(await p.locator('[data-settings-rows]').isVisible(), 'phone list of rows');
      const txt = await p.locator('[data-settings-rows]').innerText();
      assert.ok(/You/.test(txt) && /Team/.test(txt) && /Server/.test(txt), 'group labels: ' + txt);
      assert.ok(/Alerts on your phone: (on|off)/.test(txt) && /Claude: (connected|not connected)/.test(txt) && /\d of \d done/.test(txt), 'plain hints: ' + txt);
      const hs = await p.locator('[data-settings-rows] a[data-row]').evaluateAll(es => es.map(e => e.getBoundingClientRect().height));
      assert.ok(hs.length >= 5 && hs.every(h => h >= 44), 'rows are 44px or more: ' + hs);
      assert.equal(await p.locator('[data-theme-radio], [role=radiogroup][aria-label=Theme]').isVisible().catch(() => false), false, 'no section body on the phone list');
    } else {
      const groups = await p.locator('[data-settings-group]').evaluateAll(es => es.map(e => e.getAttribute('data-settings-group')));
      assert.deepEqual(groups, ['You', 'Team', 'Server'], 'groups: ' + groups);
      assert.equal(await p.locator('[data-section=account]').getAttribute('aria-current'), 'page', 'Account is the open pill');
      assert.equal((await p.locator('[data-title-row] h1').innerText()).trim(), 'Account');
      const fs = await p.locator('[data-title-row] h1').evaluate(e => getComputedStyle(e).fontSize);
      assert.equal(fs, '24px', 'title is 24px');
      // search filters the list
      const q = p.locator('[data-settings-search]');
      await q.fill('quiet');
      assert.deepEqual(await p.locator('nav a[data-section]').evaluateAll(es => es.map(e => e.getAttribute('data-section'))), ['notifications'], 'search "quiet" leaves Notifications');
      await q.fill('invite');
      assert.deepEqual(await p.locator('nav a[data-section]').evaluateAll(es => es.map(e => e.getAttribute('data-section'))), ['team'], 'search "invite" leaves Team');
      await q.fill('zzzz');
      assert.equal(await p.locator('nav a[data-section]').count(), 0); assert.equal(await p.locator('[data-settings-nomatch]').count(), 1);
      await q.fill('');
      assert.equal(await p.locator('nav a[data-section]').count(), 6, 'all six sections for the operator');
      await q.fill('server'); await q.press('Enter'); await p.waitForURL(/section=server/);
      console.log('desktop search ok');
    }
    await noOverflow('settings root');

    // Account: theme, security, sign out
    await p.goto(B + '/settings?section=account'); await ready();
    await p.getByRole('radio', { name: 'Auto' }).click();
    await p.waitForTimeout(200);
    const before = await p.evaluate(() => document.documentElement.classList.contains('dark'));
    await p.getByRole('radio', { name: 'Dark' }).click();
    await p.waitForTimeout(200);
    assert.ok(await p.evaluate(() => document.documentElement.classList.contains('dark')), 'dark after one click');
    await p.getByRole('radio', { name: 'Light' }).click();
    assert.ok(!(await p.evaluate(() => document.documentElement.classList.contains('dark'))));
    console.log(label, 'theme ok (was dark:', before, ')');
    if (label === 'desktop') {
      // account menu theme pick from system
      await p.evaluate(() => localStorage.removeItem('theme')); await p.reload(); await ready();
      const was = await p.evaluate(() => document.documentElement.classList.contains('dark'));
      await p.locator('[data-account-button]').click(); await p.locator('[data-menu-theme]').hover(); await p.locator('[data-theme-option]').first().waitFor(); await p.locator(`[data-theme-option=${was ? 'light' : 'dark'}]`).click(); await p.waitForTimeout(300);
      const now = await p.evaluate(() => document.documentElement.classList.contains('dark'));
      assert.notStrictEqual(was, now, 'account menu theme changes on first pick'); console.log('account menu theme first pick ok', was, '->', now);
      await p.getByRole('radio', { name: 'Light' }).click();
    }
    await p.getByText('Passkeys', { exact: false }).first().waitFor();
    assert.ok((await p.locator('[data-settings]').innerText()).includes('Authenticator'), 'security is on Account');
    assert.equal(await p.locator('button[data-sign-out]').count(), 1, 'Sign out is the title row action');
    await p.screenshot({ path: `${SP}/${label}-account.png`, fullPage: true });
    await noOverflow('account');

    // Notifications: this device, what to be told about, quiet hours, Discord (in that order)
    if (label === 'phone') { await p.goto(B + '/settings'); await ready(); await open(p.locator('[data-row=notifications]'), /section=notifications/); } else { await open(p.locator('[data-section=notifications]'), /section=notifications/); }
    await p.waitForSelector('table[aria-label="Alerts by channel"]');
    const heads = await p.locator('[data-settings] section h2').evaluateAll(es => es.map(e => e.textContent.trim()));
    const order = ['This device', 'What to be told about', 'Quiet hours and time zone', 'Discord'].map(h => heads.indexOf(h));
    assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), 'Notifications order: ' + heads.join(' | '));
    assert.equal(await p.locator('#discord').count(), 1, 'Discord link lives in Notifications');
    assert.equal(await p.locator('[data-quiet-hours]').count(), 1);
    const sw = p.getByRole('switch', { name: 'Overdue', exact: true });
    const was = await sw.getAttribute('aria-checked');
    await toggle(sw);
    await p.reload(); await p.waitForSelector('table');
    const now = await p.getByRole('switch', { name: 'Overdue', exact: true }).getAttribute('aria-checked');
    assert.notStrictEqual(was, now, 'alert toggle persisted'); console.log(label, 'alerts toggle persisted', was, '->', now);
    await toggle(p.getByRole('switch', { name: 'Overdue', exact: true }));
    await p.screenshot({ path: `${SP}/${label}-notifications.png`, fullPage: true });
    await noOverflow('notifications');
    const small = await p.evaluate(() => [...document.querySelectorAll('table button')].filter(e => e.getBoundingClientRect().height < 31).length); assert.equal(small, 0);
    if (label === 'phone') { await open(p.locator('[data-back]').first(), u => u.pathname === '/settings' && !u.search); console.log('back to settings ok'); }
    if (label === 'desktop') {
      // push devices: mine are listed with a Remove; someone else's never show and cannot be removed from here
      const nowD = new Date();
      await rawDb.collection('pushSubs').insertMany([
        { _id: 'https://push.example.test/set-mine', orgId: ME.orgId, userId: ME.userId, keys: { p256dh: 'x', auth: 'y' }, device: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537', createdAt: new Date('2026-10-15T08:00:00Z'), updatedAt: nowD },
        { _id: 'https://push.example.test/set-other', orgId: ME.orgId, userId: 'someone-else', keys: { p256dh: 'x', auth: 'y' }, device: 'Mozilla/5.0 (iPhone) Safari', createdAt: nowD, updatedAt: nowD },
      ]);
      await p.goto(B + '/settings?section=notifications'); await p.waitForSelector('[data-push-devices]');
      await p.waitForSelector('[data-push-device]', { timeout: 10000 });
      const txt = await p.locator('[data-push-devices]').innerText();
      assert.ok(/Windows PC · Chrome/.test(txt) && /Added/.test(txt) && !/iPhone/.test(txt), 'push list: mine only: ' + txt.slice(0, 200));
      assert.equal(await p.locator('[data-push-device]').count(), 1);
      await p.locator('[data-push-device] button:has-text("Remove")').click();
      await p.waitForFunction(() => document.querySelectorAll('[data-push-device]').length === 0, null, { timeout: 10000 });
      assert.equal(await rawDb.collection('pushSubs').countDocuments({ _id: 'https://push.example.test/set-mine' }), 0, 'removed');
      assert.equal(await rawDb.collection('pushSubs').countDocuments({ _id: 'https://push.example.test/set-other' }), 1, 'the other person\'s stays');
      await rawDb.collection('pushSubs').deleteOne({ _id: 'https://push.example.test/set-other' });
      console.log('push devices ok');
    }

    // Connections: a table (Claude, Discord, Computers) with a Status column and a button each
    await p.goto(B + '/settings?section=connections'); await p.waitForSelector('[data-connections]');
    const rows = await p.locator('[data-connections] tbody tr').evaluateAll(es => es.map(e => e.getAttribute('data-connection')));
    assert.deepEqual(rows, ['claude', 'discord', 'computers'], 'connection rows');
    if (label === 'desktop') assert.ok(/Status/.test(await p.locator('[data-connections] thead').innerText()), 'Status column header');
    const claudeRow = p.locator('[data-connection=claude]');
    assert.ok(/Not connected|Not used yet|Connected/.test(await claudeRow.innerText()), 'Claude status');
    assert.equal(await claudeRow.locator('a').getAttribute('href'), '/claude?tab=setup', 'Claude button goes to Claude › Set up');
    assert.equal(await p.locator('[data-connection=computers] a').getAttribute('href'), '/claude?tab=setup');
    assert.ok(/Not available|Not linked|Linked/.test(await p.locator('[data-connection=discord]').innerText()), 'Discord status');
    if (label === 'phone') {
      const ah = await p.locator('[data-connections] a[data-connection-action]').evaluateAll(es => es.map(e => e.getBoundingClientRect().height));
      assert.ok(ah.length >= 2 && ah.every(h => h >= 44), 'Connect buttons are 44px: ' + ah);
    }
    await p.screenshot({ path: `${SP}/${label}-connections.png`, fullPage: true });
    await noOverflow('connections');

    // Team: people, invite with role hints, kinds of work (modes) behind "What are these?"
    await p.goto(B + '/settings?section=team'); await p.waitForSelector('[data-members]');
    assert.equal(await p.locator('[data-invite-role]').count(), 1);
    assert.equal(await p.locator('[data-role-hint=member]').count(), 1, 'Member is preselected with its meaning shown');
    assert.ok(/works on projects and tasks/.test(await p.locator('[data-role-hint]').innerText()));
    assert.equal(await p.locator('[data-title-action]').count(), 1, 'Invite is the title row action');
    assert.equal(await p.locator('[data-help] details[open]').count(), 0);
    assert.ok(/What are these\?/.test(await p.locator('[data-help]').innerText()), 'kinds of work under Team');
    await p.screenshot({ path: `${SP}/${label}-team.png`, fullPage: true });
    await noOverflow('team');

    // Server (the operator): health strip, Discord, scheduled checks, usage; the strip is nowhere else
    await p.goto(B + '/settings?section=server'); await p.waitForSelector('[data-server]');
    assert.equal(await p.locator('[role=status][data-settings-status]').count(), 1, 'the operator sees the health strip on Server');
    assert.equal(await p.locator('[data-usage]').count(), 1);
    await p.screenshot({ path: `${SP}/${label}-server.png`, fullPage: true });
    await noOverflow('server');
    await p.goto(B + '/settings?section=account'); await ready();
    assert.equal(await p.locator('[data-settings-status]').count(), 0, 'no health strip outside Server');

    await p.goto(B + '/menu');
    assert.equal(await p.locator('a[href="/connect"]').count(), 0);
    await noOverflow('menu');
    console.log(label, 'errors:', errs);
    await ctx.close();
  }

  // Who sees what. A member (not the operator, not an owner) and a second owner (not the operator).
  for (const [who, email] of [['member', 'set-member@example.test'], ['owner', 'set-owner2@example.test']]) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    const p = await ctx.newPage();
    await login(p, { next: '/settings', email });
    await p.waitForSelector('[data-settings]');
    const secs = await p.locator('nav a[data-section]').evaluateAll(es => es.map(e => e.getAttribute('data-section')));
    console.log(who, 'sections', secs);
    assert.equal(await p.locator('[data-settings-dot]').count(), 0, `${who}: no orange dot`);
    assert.equal(await p.locator('[data-settings-status]').count(), 0, `${who}: no health strip`);
    assert.ok(!/Needs a look|Push not set up|no check has run/.test(await p.locator('body').innerText()), `${who}: no server health text`);
    await p.goto(B + '/settings?section=server'); await p.waitForSelector('[data-settings]');
    assert.equal(await p.locator('[data-settings-status]').count(), 0, `${who}: no strip on Server either`);
    assert.equal(await p.locator('[data-usage]').count(), 0, `${who}: no Usage`);
    assert.equal(await p.locator('text=Setup and registration').count(), 0, `${who}: no Discord registration`);
    if (who === 'member') {
      assert.deepEqual(secs, ['account', 'notifications', 'connections', 'started', 'team'], 'a member has no Server');
      assert.equal(await p.locator('[data-server]').count(), 0, 'member: ?section=server shows the first section instead');
      await p.goto(B + '/settings?section=team'); await p.waitForSelector('[data-members]');
      assert.equal(await p.locator('[data-title-action]').count(), 0, 'member: no Invite');
      assert.equal(await p.locator('#invite').count(), 0);
    } else {
      assert.ok(secs.includes('server'), 'an owner sees Server (their Discord channels)');
      assert.equal(await p.locator('[data-server]').count(), 1);
    }
    await p.goto(B + '/menu');
    assert.equal(await p.locator('[data-menu-status]').count(), 0, `${who}: no dot on Settings in Menu`);
    await ctx.close();
  }
  await b.close();
  console.log('ALL OK');
});
