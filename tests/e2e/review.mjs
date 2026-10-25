// Review hub: redirects from old pages, five views (Weekly removed: ?view=weekly shows Done), trash/archive/stale, unarchive + undo, nav entries at 390 and 1280. Seed profile: base.
import { launch, B, PW, SP, db, mc, runAssertSuite, assert, check, fillLogin } from './lib.mjs';
await runAssertSuite('review', async () => {
  const b = await launch();
  for (const [from, to] of [['/history', 'view=done'], ['/history?tab=activity&actor=claude', 'view=activity'], ['/history?tab=archived', 'view=archive'], ['/history?tab=trash', 'view=trash'], ['/hidden', 'view=stale'], ['/archive', 'view=archive']]) {
    const r = await fetch(B + from, { redirect: 'manual' }); const loc = r.headers.get('location');
    console.log(from, r.status, loc); assert.equal(r.status, 307); assert.ok(loc.includes(to));
  }
  for (const [label, vp, touch] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
    const ctx = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B + '/login'); await fillLogin(p); await p.click('button[type=submit]');
    await p.waitForURL(u => !u.pathname.startsWith('/login'));
    for (const v of ['done', 'activity', 'weekly', 'stale', 'archive', 'trash']) { // weekly: removed, falls back to Done
      await p.goto(B + '/review?view=' + v); await p.waitForSelector('nav[aria-label=Review]');
      assert.equal(await p.locator('nav[aria-label=Review] [aria-current=page]').innerText(), { done: 'Done', activity: 'Activity', weekly: 'Done', stale: 'Stale', archive: 'Archive', trash: 'Trash' }[v]);
      assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'overflow ' + v);
      await p.screenshot({ path: `${SP}/rv-${label}-${v}.png`, fullPage: true });
    }
    // segment click changes URL
    await p.goto(B + '/review'); await p.getByRole('link', { name: 'Trash' }).click(); await p.waitForURL(/view=trash/);
    // trash restore
    assert.ok((await p.locator('body').innerText()).includes('Deleted draft'));
    const hts = await p.evaluate(() => [...document.querySelectorAll('main button, main a')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 43 && e.closest('nav[aria-label=Review]') === null).map(e => e.textContent.trim() + ':' + e.getBoundingClientRect().height));
    console.log(label, 'small targets in trash', hts);
    // archive: restore and undo
    await p.goto(B + '/review?view=archive'); await p.waitForSelector('[data-archived-row]');
    assert.equal(await p.locator('[data-archived-row]').count(), 2);
    const row = p.locator('[data-archived-row]', { hasText: 'Archived research' });
    const bh = (await row.getByRole('button', { name: 'Restore' }).boundingBox()).height; console.log(label, 'restore height', bh);
    if (label === 'phone') assert.ok(bh >= 44);
    await row.getByRole('button', { name: 'Restore' }).click();
    await p.getByText('Restored #7').waitFor(); await p.waitForTimeout(500);
    assert.equal(await p.locator('[data-archived-row]').count(), 1);
    await p.getByRole('button', { name: 'Undo' }).click(); await p.waitForTimeout(1200);
    assert.equal(await p.locator('[data-archived-row]').count(), 2); console.log(label, 'unarchive + undo ok');
    // stale
    await p.goto(B + '/review?view=stale'); assert.ok((await p.locator('body').innerText()).includes('Old stale idea'));
    assert.deepEqual(errs, []);
    // nav entries
    if (label === 'desktop') { await p.goto(B + '/today'); await p.locator('aside a[href="/review"]').click(); await p.waitForURL(/\/review/); }
    else { await p.goto(B + '/menu'); const vis = p.locator('a[href="/review"]:visible'); assert.equal(await vis.count(), 1); await vis.click(); await p.waitForURL(/\/review/); }
    console.log(label, 'ok', p.url());
  }
  await b.close();
});
