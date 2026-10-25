// Settings: redirects from /connect and /recovery, theme, status strip, alerts table, security, connections, help, phone Back at 390 and 1280. Seed profile: none.
import { launch, B, PW, SP, db, mc, ME, rawDb, runAssertSuite, assert, check, fillLogin } from './lib.mjs';
await runAssertSuite('settings', async () => {
  const b = await launch();
  // real HTTP redirects, no browser
  for (const [from, to] of [['/connect', '/settings?section=connections'], ['/connect?tab=alerts', '/settings?section=alerts'], ['/connect?tab=discord', '/settings?section=connections&open=discord'], ['/connect?tab=code', '/claude?tab=setup'], ['/recovery', '/settings?section=help']]) {
    const r = await fetch(B + from, { redirect: 'manual' });
    console.log(from, r.status, r.headers.get('location'));
    assert.ok([307, 308].includes(r.status));
    assert.ok(to.split('?')[1].split('&').every(kv => r.headers.get('location').includes(kv)), 'loc');
  }
  for (const [label, vp, touch] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
    const ctx = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch, colorScheme: 'light' });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B + '/login');
    await fillLogin(p);
    await p.click('button[type=submit]');
    await p.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 15000 });
    await p.goto(B + '/settings'); await p.waitForSelector('[role=status]');
    const strip = await p.locator('[role=status]').innerText();
    console.log(label, 'strip:', strip.replace(/\n/g, ' | '));
    // theme first click: choose Auto first so it is "system"
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
      // sidebar toggle first click from system
      await p.evaluate(() => localStorage.removeItem('theme')); await p.reload(); await p.waitForSelector('[role=status]');
      const was = await p.evaluate(() => document.documentElement.classList.contains('dark'));
      await p.locator('aside button:has(.sr-only)').first().click(); await p.waitForTimeout(200);
      const now = await p.evaluate(() => document.documentElement.classList.contains('dark'));
      assert.notStrictEqual(was, now, 'sidebar toggle changes on first click'); console.log('sidebar toggle first click ok', was, '->', now);
      await p.getByRole('radio', { name: 'Light' }).click();
    }
    await p.screenshot({ path: `${SP}/${label}-root.png`, fullPage: true });
    assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'overflow root');
    // A toggle saves through a server action; a navigation started while it is in flight waits behind it
    // (30 s timeouts under load), so every click waits for the action's response before moving on.
    const toggle = async sw => { const done = p.waitForResponse(r => r.request().method() === 'POST' && r.url().startsWith(B + '/settings'), { timeout: 20000 }); await sw.click(); await done; };
    // A link clicked while the page is still hydrating (right after a reload or goto) is sometimes swallowed by the client router; click again until the URL changes.
    const open = async (loc, url) => { for (let n = 0; n < 4; n++) { await loc.click(); try { await p.waitForURL(url, { timeout: 5000 }); return; } catch (e) { if (n === 3) throw e; } } };
    // alerts
    if (label === 'phone') {
      await open(p.locator('[data-row=alerts]'), /section=alerts/);
    } else {
      await open(p.locator('[data-section=alerts]'), /section=alerts/);
    }
    await p.waitForSelector('table[aria-label="Alerts by channel"]');
    const sw = p.getByRole('switch', { name: 'Overdue', exact: true });
    const was = await sw.getAttribute('aria-checked');
    await toggle(sw);
    await p.reload(); await p.waitForSelector('table');
    const now = await p.getByRole('switch', { name: 'Overdue', exact: true }).getAttribute('aria-checked');
    assert.notStrictEqual(was, now, 'alert toggle persisted'); console.log(label, 'alerts toggle persisted', was, '->', now);
    await toggle(p.getByRole('switch', { name: 'Overdue', exact: true }));
    await p.screenshot({ path: `${SP}/${label}-alerts.png`, fullPage: true });
    assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'overflow alerts');
    // target size
    const small = await p.evaluate(() => [...document.querySelectorAll('table button')].filter(e => e.getBoundingClientRect().height < 31).length); assert.equal(small, 0);
    if (label === 'phone') {
      await open(p.locator('[data-back]').first(), u => u.pathname === '/settings' && !u.search);
      console.log('back to settings ok');
      await open(p.locator('[data-row=security]'), /section=security/);
    } else { await open(p.locator('[data-section=security]'), /section=security/); }
    await p.getByText('Passkeys', { exact: false }).first().waitFor();
    await p.screenshot({ path: `${SP}/${label}-security.png`, fullPage: true });
    console.log(label, 'security reachable:', (await p.locator('main, body').first().innerText()).includes('Authenticator'));
    // connections
    await p.goto(B + '/connect?tab=chat'); await p.waitForURL(/section=connections/);
    await p.waitForSelector('[data-connections]');
    assert.ok(await p.locator('[data-connection=chat]').evaluate(e => e.open), 'chat open');
    console.log(label, 'redirected to', p.url());
    assert.equal(await p.locator('[data-connection=computers] a[href="/claude?tab=setup"]').count(), 1, 'Connections lists computers with a manage link');
    assert.ok(/Om-PC|No computer connected yet/.test(await p.locator('[data-connection=computers]').innerText()), 'computers group text');
    await p.screenshot({ path: `${SP}/${label}-connections.png`, fullPage: true });
    if (label === 'desktop') {
      // push devices: mine are listed with a Remove; someone else's never show and cannot be removed from here
      const now = new Date();
      await rawDb.collection('pushSubs').insertMany([
        { _id: 'https://push.example.test/set-mine', orgId: ME.orgId, userId: ME.userId, keys: { p256dh: 'x', auth: 'y' }, device: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537', createdAt: new Date('2026-10-15T08:00:00Z'), updatedAt: now },
        { _id: 'https://push.example.test/set-other', orgId: ME.orgId, userId: 'someone-else', keys: { p256dh: 'x', auth: 'y' }, device: 'Mozilla/5.0 (iPhone) Safari', createdAt: now, updatedAt: now },
      ]);
      await p.goto(B + '/settings?section=device'); await p.waitForSelector('[data-push-devices]');
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
    await p.goto(B + '/settings?section=help'); await p.waitForSelector('[data-help]');
    assert.equal(await p.locator('[data-help] details[open]').count(), 0);
    await p.goto(B + '/menu');
    assert.equal(await p.locator('a[href="/connect"]').count(), 0);
    assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'overflow menu');
    console.log(label, 'errors:', errs);
    await ctx.close();
  }
  await b.close();
  console.log('ALL OK');
});
