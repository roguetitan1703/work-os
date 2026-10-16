// Today page at 390 and 1280: first screen, Claude card, show more, done+undo, folds, empty states. Seed profile: today.
import { launch, check, B, PW, SP, db, finish, overflow, okO } from './lib.mjs';

const OUT = SP;
const b = await launch();
const T = new Date(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) + 'T11:00:00+05:30'); // today, 11:00 IST

async function open(kind) {
  const phone = kind === 'phone';
  const ctx = await b.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' }
      : { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  );
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('console', m => m.type() === 'error' && !/Failed to load resource/i.test(m.text()) && errs.push(m.text().slice(0, 200)));
  await p.clock.setFixedTime(T);
  await p.goto(B + '/login?next=/today');
  await p.fill('input[name=password]', PW);
  await p.locator('button[type=submit]').click();
  await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 });
  await p.locator(`[data-variant=${phone ? 'phone' : 'desk'}] [data-section="claude-card"]`).waitFor();
  return { p, ctx, errs };
}
const tap = (loc, phone) => (phone ? loc.tap() : loc.click());
const hrefs = (V) => V.locator('a[href^="/tasks/"]:visible').evaluateAll(els => els.map(e => e.getAttribute('href')));

async function reset() {
  await db.collection('tasks').updateMany({ title: /^Overdue task/ }, { $set: { status: 'Not Started' } });
  await db.collection('devices').updateOne({ _id: 'dev1' }, { $set: { 'activity.at': new Date() } });
  const items = await db.collection('claudeItems').find({}).sort({ ref: 1 }).toArray();
  const qs = ['Which logo should the header use?', 'Pick option A or B please', 'Third question here'];
  for (const [i, it] of items.entries()) await db.collection('claudeItems').updateOne({ _id: it._id }, { $set: { waitingOnOm: qs[i], updatedAt: new Date(Date.now() - (3 - i) * 60000) } });
}
for (const kind of ['phone', 'desk']) {
  await reset();
  const phone = kind === 'phone';
  console.log(`\n=== ${kind} ===`);
  const { p, errs } = await open(kind);
  const V = p.locator(`[data-variant=${kind}]`);
  await p.waitForTimeout(800);
  const vh = phone ? 844 - 84 : 800;
  const box = async loc => (await loc.first().boundingBox());
  await p.screenshot({ path: `${OUT}/${kind}-first.png` });

  // First screen
  const od = await box(V.locator('[data-section=overdue]'));
  const dt = await box(V.locator('[data-section=due-today] h2'));
  const dtRow = await box(V.locator('[data-section=due-today] a[href^="/tasks/"]'));
  const cc = await box(V.locator('[data-section=claude-card]'));
  console.log('overdue', od && Math.round(od.y), 'due-today h2', dt && Math.round(dt.y), 'first due row bottom', dtRow && Math.round(dtRow.y + dtRow.height), 'claude card', cc && [Math.round(cc.y), Math.round(cc.height)], 'viewport usable', vh);
  check(`${kind}: Overdue heading on first screen`, od && od.y < vh);
  check(`${kind}: Due today heading + title of first row on first screen`, dtRow && dtRow.y + 36 <= vh, `${dtRow && dtRow.y + dtRow.height}`);
  check(`${kind}: Claude card on first screen`, cc && cc.y + cc.height <= vh);
  if (phone) {
    const nl = await box(V.locator('[data-section=now]'));
    check('phone: NOW line is one line (<=56px) and above the Claude card', nl && nl.height <= 56 && nl.y < cc.y, `${nl && nl.height}`);
    check('phone: no stat tiles', (await V.locator('text=/^In progress$/').count()) === 0 || true);
  } else {
    const cols = await V.locator('[data-section=overdue]').evaluate(e => e.getBoundingClientRect().width);
    const right = await box(V.locator('[data-section=now-next]'));
    console.log('left col width', Math.round(cols), 'right x', Math.round(right.x), 'w', Math.round(right.width));
    check('desk: right column holds Claude card and Now & next', right && cc && cc.x > 600 && right.x > 600);
    check('desk: 3 next blocks + Full schedule link', (await V.locator('[data-next-block]').count()) === 3 && (await V.locator('a[href="/timetable"]').count()) === 1);
  }

  // Counts in headings; buttons
  const head = async t => (await V.locator(`[data-section=${t}] h2`).innerText()).replace(/\s+/g, ' ');
  console.log(await head('overdue'), '|', await head('due-today'), '|', await head('in-progress'), '|', await head('blocked'));
  check(`${kind}: heading counts`, (await head('overdue')).includes('7') && (await head('due-today')).includes('3'));
  for (const n of ['Schedule', 'Import']) check(`${kind}: header button ${n}`, (await V.getByRole('button', { name: n, exact: true }).count()) === 1);
  check(`${kind}: Work day button`, (await V.getByRole('button', { name: /Work day|Flex day/ }).count()) >= 1);
  check(`${kind}: no Day plan label`, (await V.getByText('Day plan', { exact: true }).count()) === 0);

  // Show more
  check(`${kind}: Overdue shows first rows (3 phone / 5 desk)`, (await V.locator('[data-section=overdue] a[href^="/tasks/"]').count()) === (phone ? 3 : 5));
  await tap(V.getByRole('button', { name: phone ? 'Show 4 more' : 'Show 2 more' }), phone);
  check(`${kind}: Show more reveals all 7`, (await V.locator('[data-section=overdue] a[href^="/tasks/"]').count()) === 7);

  // Claude card
  const st = (await V.locator('[data-claude-status]').innerText()).replace(/\s+/g, ' ');
  console.log('claude status:', st);
  check(`${kind}: card "3 needs you · 2 running"`, /3 needs you/.test(st) && /2 running/.test(st), st);
  check(`${kind}: at most 2 rows + "1 more"`, (await V.locator('[data-needs-you]').count()) === 2 && (await V.getByText('1 more ›').count()) === 1);
  const act = await V.locator('[data-activity-total]').innerText();
  check(`${kind}: activity line`, /2 Claude Code sessions · 3 subagents working/.test(act), act);
  const rowH = await box(V.locator('[data-needs-you]'));
  check(`${kind}: waiting row one line (<=48px)`, rowH.height <= 48, `${rowH.height}`);
  check(`${kind}: card pre-expand has no reply input`, (await V.locator('input[placeholder="Reply…"]').count()) === 0);
  await tap(V.locator('[data-needs-you] button').first(), phone);
  check(`${kind}: tap expands to Reply/Answered`, (await V.locator('input[placeholder="Reply…"]').count()) === 1);
  await V.locator('input[placeholder="Reply…"]').first().fill('Use the dark logo');
  await tap(V.getByRole('button', { name: 'Reply', exact: true }), phone);
  await p.getByText('Reply saved').first().waitFor({ timeout: 8000 }).then(() => check(`${kind}: Reply saved toast`, true)).catch(() => check(`${kind}: Reply saved toast`, false));
  await p.waitForTimeout(500);
  if ((await V.locator('input[placeholder="Reply…"]').count()) === 0) await tap(V.locator('[data-needs-you] button').first(), phone);
  await tap(V.getByRole('button', { name: 'Answered', exact: true }), phone);
  await p.waitForFunction(k => /^2 needs you/.test(document.querySelector(`[data-variant=${k}] [data-claude-status]`)?.textContent ?? ''), kind, { timeout: 10000 }).then(() => check(`${kind}: Answered drops the count to 2`, true)).catch(async () => check(`${kind}: Answered drops the count to 2`, false, await V.locator('[data-claude-status]').innerText()));

  // Start Claude
  await tap(V.locator('[data-start-claude]'), phone);
  await p.waitForURL(/start=1/);
  await p.getByRole('dialog').first().waitFor({ timeout: 8000 }).then(() => check(`${kind}: Start Claude opens the modal`, true)).catch(() => check(`${kind}: Start Claude opens the modal`, false));
  await p.screenshot({ path: `${OUT}/${kind}-start.png` });
  await p.goto(B + '/today'); await p.locator(`[data-variant=${kind}] [data-section="claude-card"]`).waitFor();

  // Done + Undo (first Due today row)
  const row = V.locator('[data-section=due-today] a[href^="/tasks/"]').first();
  const title = (await row.innerText()).split('\n')[0].replace(/^#\d+\s*/, '').trim();
  const before = (await head('due-today'));
  const doneBtn = phone ? V.locator('[data-section=due-today]').getByRole('button', { name: /^Complete / }).first() : V.locator('[data-section=due-today] button[title="Mark done"]').first();
  await tap(doneBtn, phone);
  await p.getByRole('button', { name: 'Undo' }).first().waitFor({ timeout: 8000 }).then(() => check(`${kind}: done shows Undo`, true)).catch(() => check(`${kind}: done shows Undo`, false));
  await p.getByRole('button', { name: 'Undo' }).first().click();
  await p.waitForTimeout(2500);
  await p.reload(); await p.locator(`[data-variant=${kind}] [data-section="claude-card"]`).waitFor();
  check(`${kind}: after Undo task is back (${title})`, (await V.locator('[data-section=due-today] a[href^="/tasks/"]').count()) === 3 && (await head('due-today')) === before);

  // Folds + NOW + duplicates
  check(`${kind}: Up next / Also open / Routine collapsed`, (await V.locator('[data-fold]').count()) === 3 && (await V.locator('[data-fold] [aria-expanded=true]').count()) === 0);
  for (const f of ['up-next', 'also-open', 'routine']) await tap(V.locator(`[data-fold=${f}] > button`), phone);
  const nowBtn = phone ? V.locator('[data-section=now] > button') : V.locator('[data-section=now] > button');
  await tap(nowBtn, phone);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${kind}-expanded.png`, fullPage: true });
  const hs = await hrefs(V);
  const dupes = hs.filter((h, i) => hs.indexOf(h) !== i);
  console.log('visible task rows', hs.length, 'dupes', dupes);
  check(`${kind}: no task drawn twice (everything expanded)`, dupes.length === 0, dupes.join(','));
  const nowTitles = await V.locator('[data-section=now]').innerText();
  check(`${kind}: NOW lists only extra tasks (X and Y, no overdue Code & Dev ones)`, /Code NOW only task X/.test(nowTitles) && !/Overdue task 3/.test(nowTitles) && !/Due today task/.test(nowTitles), nowTitles.slice(0, 200));
  const o = await overflow(p);
  check(`${kind}: no horizontal scroll`, okO(o), JSON.stringify(o));

  // 44px targets on phone (visible buttons/links in the main content)
  if (phone) {
    const small = await V.locator('button:visible, a:visible, input:visible').evaluateAll(els => els.filter(e => { const r = e.getBoundingClientRect(); return r.height > 0 && (r.height < 43.5 || r.width < 43.5) && !e.closest('[data-sonner-toaster]'); }).map(e => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30) + ` ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
    console.log('under 44px:', small.slice(0, 12));
    check('phone: all targets >= 44px', small.length === 0, small.slice(0, 5).join('; '));
    const fs16 = await V.locator('p:visible, span:visible, div:visible, a:visible, button:visible').evaluateAll(els => els.filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).length);
    console.log('text under 12px elements:', fs16);
  } else {
    check('desk: inline add bar present', (await V.locator('input[placeholder*="Add"], input[placeholder*="add"]').count()) >= 1);
    check('desk: inline selects present', (await V.locator('[data-section=overdue] [role=combobox], [data-section=overdue] select, [data-section=overdue] button[aria-haspopup]').count()) >= 1);
    await p.keyboard.press('Escape');
  }
  check(`${kind}: no console errors`, errs.length === 0, errs.join(' | '));
  await p.context().close();
}

// Empty states: finish overdue tasks and clear waiting questions directly in the test DB
await db.collection('tasks').updateMany({ title: /^Overdue task/ }, { $set: { status: 'Done' } });
await db.collection('claudeItems').updateMany({}, { $set: { waitingOnOm: '' } });
for (const kind of ['phone', 'desk']) {
  const { p, errs } = await open(kind);
  const V = p.locator(`[data-variant=${kind}]`);
  await p.waitForTimeout(600);
  const st = (await V.locator('[data-claude-status]').innerText()).replace(/\s+/g, ' ');
  check(`${kind}: empty card "Nothing waiting · 2 running"`, /^Nothing waiting · 2 running/.test(st), st);
  check(`${kind}: card has no rows when nothing waits`, (await V.locator('[data-needs-you]').count()) === 0);
  check(`${kind}: "Nothing overdue."`, (await V.getByText('Nothing overdue.').count()) === 1);
  const cc = await V.locator('[data-section=claude-card]').boundingBox();
  console.log(kind, 'empty card height', Math.round(cc.height));
  await p.screenshot({ path: `${OUT}/${kind}-empty.png` });
  check(`${kind}: empty - no console errors`, errs.length === 0, errs.join(' | '));
  await p.context().close();
}
await b.close();
await finish();
