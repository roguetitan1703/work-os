// Notes search: a word that is only in a note's body (not its title) is found from every search entry point.
//   - desktop 1280 and phone 390: the Notes list's search button opens the global search on Notes, which finds the
//     note and not the other one;
//   - global search (from the sidebar) finds the note by its body.
// Seed profile: none.
import { check, finish, launch, login, call } from './lib.mjs';

const W1 = 'zorbulax', W2 = 'quenfibble';
const browser = await launch();
try {
  await call('add_project', { name: 'NS Proj' });
  const n1 = (await call('write_note', { project: 'NS Proj', title: 'Alpha page', body: `The ${W1} appears only in the body.` }))?.created?.id;
  const n2 = (await call('write_note', { project: 'NS Proj', title: 'Beta page', body: `Here the ${W2} lives.` }))?.created?.id;
  check('two notes created', !!n1 && !!n2, JSON.stringify([n1, n2]));

  // The Notes list has no text box of its own: its search button opens the global search on Notes.
  const viaNotes = async (p, word) => {
    await p.locator('[data-notes-search]:visible').first().click();
    const gi = p.locator('input[aria-controls=global-search-results]');
    await gi.waitFor();
    const onNotes = (await p.locator('[data-filter=notes][aria-pressed=true]').count()) === 1;
    await gi.fill(word);
    await p.waitForTimeout(1500);
    const t = (await p.locator('#global-search-results [role=option]').allInnerTexts()).join(' | ');
    return { onNotes, t };
  };

  // ---- desktop ----
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const d = await dctx.newPage();
  const derrs = []; d.on('pageerror', e => derrs.push(e.message));
  await login(d, { next: '/notes' });
  let r = await viaNotes(d, W1);
  check('desktop: the Notes search opens on Notes', r.onNotes);
  check('desktop: finds the body-only note', r.t.includes('Alpha page'), r.t);
  check('desktop: not the other note', !r.t.includes('Beta page'), r.t);
  check('desktop: no page errors', derrs.length === 0, derrs.join(';'));
  await dctx.close();

  // ---- phone ----
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await pctx.newPage();
  await login(p, { phone: true, next: '/notes' });
  await p.waitForTimeout(500);
  r = await viaNotes(p, W2);
  check('phone: the Notes search opens on Notes', r.onNotes);
  check('phone: finds the body-only note', r.t.includes('Beta page') && !r.t.includes('Alpha page'), r.t);
  await p.locator('#global-search-results [role=option]').first().tap();
  await p.waitForURL(/\/notes\/[^/]+$/);
  check('phone: a tap opens the note', true);
  await pctx.close();

  // ---- global search ----
  const gctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const g = await gctx.newPage();
  await login(g);
  await g.waitForTimeout(800);
  await g.locator('aside button:has-text("Search")').click();
  const gi = g.locator('input[aria-controls=global-search-results]');
  await gi.waitFor();
  await gi.fill(W1);
  await g.getByRole('option').first().waitFor({ timeout: 8000 }).catch(() => {});
  const gt = await g.locator('[role=listbox]').innerText().catch(() => '');
  check('global search finds the note by body', gt.includes('Alpha page'), gt);
  await gctx.close();
} catch (e) {
  check('suite ran without throwing', false, String(e?.stack ?? e));
}
await browser.close();
await finish();
