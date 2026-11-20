// What's new, 14 days on (docs/HANDOVER.md "What's new"). run.sh pins "today" (mode whatsnewlate) to 14 days after
// the newest entry in lib/whats-new.ts, so it is 14 days old, so nothing is new any more even though nobody has seen them:
//   - no card on Today, no dot on the Menu row, the Menu button or the sidebar, no "New" badge on Needs;
//   - /whats-new still lists every entry, without "New". Seed profile: none.
import fs from 'node:fs';
import { B, check, finish, launch, login } from './lib.mjs';

const settle = (p, ms = 700) => p.waitForTimeout(ms);
const b = await launch();
try {
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage(); p.setDefaultTimeout(10000);
    await login(p, { phone: true }); await settle(p);
    check('phone Today: no New in Work OS card after 14 days', (await p.locator('[data-section="whats-new"]').count()) === 0);
    check('phone header: no Menu dot', (await p.locator('header:visible [data-menu-dot]').count()) === 0);
    await p.goto(B + '/menu'); await settle(p);
    check("menu: no dot on What's new", (await p.locator('main a[href="/whats-new"] [data-new-dot]').count()) === 0);
    await p.goto(B + '/whats-new'); await settle(p);
    // Every entry in lib/whats-new.ts except the two whose feature is not set up here (Mail and the report intake).
    const all = (fs.readFileSync(new URL('../../lib/whats-new.ts', import.meta.url), 'utf8').match(/^\s+date: '\d{4}-\d{2}-\d{2}',$/gm) || []).length;
    check("whats-new: still lists every entry", (await p.locator('[data-whats-new-entry]').count()) === all - 2);
    check('whats-new: none marked "New"', (await p.locator('[data-new-badge]').count()) === 0);
    await ctx.close();
  }
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage(); p.setDefaultTimeout(10000);
    await login(p); await settle(p);
    const aside = p.locator('aside');
    check('sidebar: no "New" badge on Needs after 14 days', (await aside.locator('a[href="/needs"] [data-new-badge]').count()) === 0);
    check("sidebar: no dot on What's new", (await aside.locator('a[href="/whats-new"] [data-new-dot]').count()) === 0);
    check('desktop Today: no card', (await p.locator('[data-section="whats-new"]').count()) === 0);
    await ctx.close();
  }
} catch (e) {
  check('whats-new-late suite ran to the end', false, e.stack ?? String(e));
} finally {
  await b.close();
}
await finish();
