// Global search: auth, results, literal regex chars, #ref, project hits, keyboard (desktop), phone sheet and Back at 390 and 1280. Seed profile: base.
import { launch, B, PW, SP, db, mc, runAssertSuite, assert, check, fillLogin } from './lib.mjs';
await runAssertSuite('search', async () => {
  const b = await launch();
  // unauthenticated: page and action POST are blocked
  const r = await fetch(B + '/today', { redirect: 'manual' }); assert.equal(r.status, 307);
  const r2 = await fetch(B + '/today', { method: 'POST', headers: { 'Next-Action': 'abc', 'content-type': 'text/plain' }, body: '[]', redirect: 'manual' }); assert.ok([307, 401, 303].includes(r2.status), 'post ' + r2.status);
  console.log('unauth ok', r2.status);
  for (const [label, vp, touch] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1280, height: 800 }, false]]) {
    const ctx = await b.newContext({ viewport: vp, hasTouch: touch, isMobile: touch });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(B + '/login'); await fillLogin(p); await p.click('button[type=submit]');
    await p.waitForURL(u => !u.pathname.startsWith('/login'));
    await p.goto(B + '/today'); await p.waitForTimeout(800);
    const input = () => p.locator('input[aria-controls=global-search-results]');
    if (label === 'phone') await p.locator('button[aria-label=Search]:visible').first().click();
    else await p.locator('aside button:has-text("Search")').click();
    await input().waitFor();
    await input().fill('webhook'); await p.getByRole('option').first().waitFor();
    const txt = await p.locator('[role=listbox]').innerText(); console.log(label, 'webhook ->', txt.replace(/\n/g, ' | '));
    assert.ok(txt.includes('Fix webhook retries') && txt.includes('Call notes'));
    await p.screenshot({ path: `${SP}/s-${label}.png` });
    if (label === 'phone') { const hs = await p.locator('[role=option]').evaluateAll(es => es.map(e => e.getBoundingClientRect().height)); assert.ok(hs.every(h => h >= 43.5), 'rows 44 ' + hs); assert.ok(await p.locator('[data-sheet]').count() === 1); const fs = await input().evaluate(e => getComputedStyle(e).fontSize); assert.equal(fs, '16px'); }
    // regex chars are literal, no crash
    for (const bad of ['(', '[draft', '.*', String.fromCharCode(92), 'a{2', '(v2)']) { await input().fill(bad); await p.waitForTimeout(500); }
    assert.ok((await p.locator('[role=listbox]').innerText()).includes('Call notes'), 'literal (v2) found'); // last query "(v2)"
    await input().fill('#2'); await p.waitForTimeout(500);
    assert.ok((await p.locator('[role=option]').first().innerText()).includes('#2'), 'ref first');
    await input().fill('C12'); await p.getByText('Reorder invoice export').waitFor();
    await input().fill('akar'); await p.locator('section[aria-label=Projects]').waitFor();
    const t2 = await p.locator('[role=listbox]').innerText(); assert.ok(/projects/i.test(t2) && t2.includes('AKAR'), t2);
    if (label === 'desktop') {
      await input().fill('a'); await p.waitForTimeout(600);
      const n = await p.getByRole('option').count(); assert.ok(n >= 2);
      await input().press('ArrowDown'); assert.equal(await p.locator('[role=option][aria-selected=true]').getAttribute('data-hit'), '1');
      await input().press('ArrowUp'); await input().press('ArrowUp'); assert.equal(await p.locator('[role=option][aria-selected=true]').getAttribute('data-hit'), String(n - 1));
      await input().fill('webhook'); await p.getByRole('option', { name: /Fix webhook/ }).waitFor(); await p.waitForTimeout(100); await input().press('Enter'); await p.waitForURL(/\/tasks\/1$/);
      console.log('enter navigated', p.url());
      // shortcuts: / and ctrl+k
      await p.goto(B + '/today'); await p.waitForTimeout(800); await p.keyboard.press('/'); await input().waitFor(); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      assert.equal(await p.locator('[data-global-search]').count(), 0);
      await p.keyboard.press('Control+k'); await input().waitFor(); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      // ctrl+k while typing in a field
      await p.locator('input:visible').first().focus().catch(() => {}); await p.keyboard.press('Control+k'); await input().waitFor();
      console.log('shortcuts ok');
    } else {
      await input().fill('webhook'); await p.getByRole('option', { name: /Fix webhook/ }).waitFor(); await p.getByRole('option').first().click(); await p.waitForURL(/\/tasks\/1$/); assert.equal(await p.locator('[data-sheet]').count(), 0);
      console.log('tap navigated', p.url());
      assert.ok(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
    }
    assert.deepEqual(errs, []); console.log(label, 'ok');
  }
  await b.close();
});
