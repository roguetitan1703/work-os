// Notes search: a word that is only in a note's body (not its title) is found from every search entry point.
//   - desktop 1280: the Filter button and Enter in the search box; the URL carries q; the list shows the note and hides the other;
//   - phone 390: live search (debounced) re-renders the list; clearing the box brings the full list back;
//   - global search finds the note by its body.
// Seed profile: none.
import { B, MCP, ME, check, finish, launch, login, call } from './lib.mjs';

const W1 = 'zorbulax', W2 = 'quenfibble';
const browser = await launch();
try {
  await call('add_project', { name: 'NS Proj' });
  const n1 = (await call('write_note', { project: 'NS Proj', title: 'Alpha page', body: `The ${W1} appears only in the body.` }))?.created?.id;
  const n2 = (await call('write_note', { project: 'NS Proj', title: 'Beta page', body: `Here the ${W2} lives.` }))?.created?.id;
  check('two notes created', !!n1 && !!n2, JSON.stringify([n1, n2]));
  const listed = async p => (await p.locator('a[href^="/notes/"]:visible').allInnerTexts()).join(' | ');

  // ---- desktop ----
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const d = await dctx.newPage();
  const derrs = []; d.on('pageerror', e => derrs.push(e.message));
  await login(d, { next: '/notes' });
  await d.waitForSelector('input[name=q]:visible');
  await d.fill('input[name=q]:visible', W1);
  await d.click('form button:has-text("Filter")');
  await d.waitForURL(/q=/);
  console.log('desktop filter url', d.url());
  await d.waitForTimeout(600);
  let t = await listed(d);
  check('desktop Filter: finds the body-only note', t.includes('Alpha page'), t);
  check('desktop Filter: hides the other note', !t.includes('Beta page'), t);
  await d.goto(B + '/notes'); await d.waitForSelector('input[name=q]:visible');
  await d.fill('input[name=q]:visible', W2);
  await d.press('input[name=q]:visible', 'Enter');
  await d.waitForURL(/q=/);
  console.log('desktop enter url', d.url());
  await d.waitForTimeout(600);
  t = await listed(d);
  check('desktop Enter: finds the body-only note', t.includes('Beta page') && !t.includes('Alpha page'), t);
  check('desktop: no page errors', derrs.length === 0, derrs.join(';'));
  await dctx.close();

  // ---- phone ----
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await pctx.newPage();
  await login(p, { phone: true, next: '/notes' });
  const box = p.locator('input[placeholder="Search notes"]');
  await box.waitFor();
  await p.waitForTimeout(500);
  await box.fill(W1);
  await p.waitForTimeout(1500);
  console.log('phone url', p.url());
  t = await listed(p);
  check('phone live search: URL has q', p.url().includes('q=' + W1), p.url());
  check('phone live search: list shows the body-only note', t.includes('Alpha page'), t);
  check('phone live search: list hides the other note', !t.includes('Beta page'), t);
  await box.fill('');
  await p.waitForTimeout(1500);
  t = await listed(p);
  check('phone: clearing the box brings both back', t.includes('Alpha page') && t.includes('Beta page'), t);
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
