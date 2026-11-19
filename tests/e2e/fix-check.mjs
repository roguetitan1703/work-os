// Sidebar footer, theme toggle, Day plan dialog/sheet, named switches, the Old Claude items fold at 1280 and 390.
import { launch, check, B, PW, call, finish, fillLogin, pick, mkClaudeItem } from './lib.mjs';
const PN = 'Fix ' + Date.now();
const pr = await call('add_project', { name: PN });
const pid = pr.project.id;
console.log('project', JSON.stringify(pr).slice(0, 150));
const mk = async t => mkClaudeItem({ project: PN, kind: 'bug', title: t, why: 'Fixture item for the sheet check, on the project page of the throwaway app, used by the Playwright run.', doneWhen: 'The check passes with no reopen of the sheet needed.' });
console.log(JSON.stringify(await mk('Fixture item one for sheet')).slice(0, 200));
const browser = await launch();
for (const vp of [{ w: 1280, h: 800 }, { w: 390, h: 844 }]) {
  const phone = vp.w < 500, T = s => `[${vp.w}] ${s}`;
  const ctx = await browser.newContext(phone ? { viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true } : { viewport: { width: vp.w, height: vp.h } });
  const p = await ctx.newPage(); const click = l => phone ? l.tap() : l.click();
  await p.goto(B + '/login?next=/today'); await fillLogin(p); await click(p.locator('button[type=submit]'));
  await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 });
  // sidebar
  if (!phone) {
    const probe = async sel => p.evaluate(s => { const e = document.querySelector(s); if (!e) return 'none'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e.contains(t) || t?.contains(e) ? 'ok' : 'blocked:' + t?.tagName; }, sel);
    await p.waitForTimeout(1500); await p.locator('[data-account-button]').click(); await p.locator('[data-menu=account]').waitFor();
    check(T('account menu: Sign out is reachable'), (await probe('[data-menu-sign-out]')) === 'ok', await probe('[data-menu-sign-out]'));
    const isDark = () => p.evaluate(() => document.documentElement.classList.contains('dark'));
    const before = await isDark();
    await p.locator('[data-menu-theme]').hover(); await p.locator('[data-theme-option]').first().waitFor(); await p.locator(`[data-theme-option=${before ? 'light' : 'dark'}]`).click(); await p.waitForTimeout(500);
    check(T('account menu: Theme flips the look on the first pick'), (await isDark()) !== before);
    await p.waitForTimeout(500); await p.locator('[data-account-button]').click(); await p.locator('[data-menu=account]').waitFor(); await p.locator('[data-menu-theme]').hover(); await p.locator('[data-theme-option]').first().waitFor(); await p.locator(`[data-theme-option=${before ? 'dark' : 'light'}]`).click(); await p.waitForTimeout(500);
    check(T('account menu: Theme flips it back'), (await isDark()) === before);
    await p.click('button:visible:has-text("Schedule")'); await p.waitForSelector('[role=dialog]');
    const d = await p.evaluate(() => { const e = document.querySelector('[role=dialog]'); const r = e.getBoundingClientRect(); return { l: r.left, w: r.width, sw: e.scrollWidth, cw: e.clientWidth }; });
    check(T('Day plan dialog fits content'), d.w > 600 && d.sw <= d.cw + 1 && d.l >= 0, JSON.stringify(d));
    await p.keyboard.press('Escape');
  } else {
    await click(p.locator('button:has-text("Schedule")').first()); await p.waitForSelector('[role=dialog], [data-sheet]');
    const ov = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(T('phone Day plan sheet opens, no h-scroll'), !ov); await p.reload();
  }
  // switches
  await p.goto(B + '/settings?section=notifications'); await p.waitForSelector('[role=switch]'); // the alert switches moved into the Alerts section
  const sw = await p.$$eval('[role=switch]', els => els.map(e => e.getAttribute('aria-label') || e.textContent.trim()));
  check(T(`switches named (${sw.length})`), sw.length >= 3 && sw.every(Boolean), JSON.stringify(sw));
  // old Claude items: a read-only fold on the project's Claude tab (no sheet, no controls)
  await p.goto(B + '/projects/' + pid + '?tab=claude');
  const fold = p.locator('[data-card="old-claude-items"]');
  check(T('Old Claude items fold shows for a project that has items'), (await fold.count()) === 1 && /old claude items/i.test(await fold.innerText()));
  await click(fold.locator('summary'));
  check(T('the fold lists the item read-only (no State select, no note box)'), (await fold.locator('[data-claude-item]').count()) === 1 && (await p.locator('[aria-label=State]').count()) === 0 && (await p.locator('input[aria-label="Add note"]').count()) === 0);
  const ov = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check(T('fold: no h-scroll'), !ov);
  await ctx.close();
}
await browser.close();
await finish();
