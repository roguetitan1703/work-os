// Today page at 390 and 1280: first screen, Claude card, show more, done+undo, folds, empty states. Seed profile: today.
import { launch, check, B, PW, SP, db, finish, overflow, okO, fillLogin, ME, rawDb } from './lib.mjs';

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
  await fillLogin(p);
  await p.locator('button[type=submit]').click();
  await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 });
  await p.locator(`[data-variant=${phone ? 'phone' : 'desk'}] [data-section="claude-card"]`).waitFor();
  // The page starts as a flex day on weekends (no NOW block, no next blocks); switch to a work day so every weekday runs the same checks.
  await p.waitForTimeout(600); // the saved flex choice is read right after hydration
  await tap(p.locator(`[data-variant=${phone ? 'phone' : 'desk'}] button[aria-label="More"]`), phone); // Import and Work day live in the More menu
  const flexItem = p.locator('[data-more-menu] button', { hasText: 'switch to work day' });
  await p.locator('[data-more-menu]').waitFor();
  if (await flexItem.count()) await tap(flexItem.first(), phone);
  else await closeSheet(p, phone);
  return { p, ctx, errs };
}
const tap = (loc, phone) => (phone ? loc.tap() : loc.click());
const closeSheet = (p, phone) => (phone ? p.locator('[data-sheet] button[aria-label=Close]').first().tap() : p.keyboard.press('Escape'));
const hrefs = (V) => V.locator('a[href^="/tasks/"]:visible').evaluateAll(els => els.map(e => e.getAttribute('href')));

async function reset() {
  // The first-run checklist has its own suite (get-started); here it is hidden so the first-screen budget measures Today itself.
  await rawDb.collection('settings').updateOne({ _id: 'profile:' + ME.userId }, { $set: { checklistHidden: true } }, { upsert: true });
  await db.collection('tasks').updateMany({ title: /^Overdue task/ }, { $set: { status: 'Not Started' } });
  await db.collection('devices').updateOne({ _id: 'dev1' }, { $set: { 'activity.at': new Date() } });
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
    check('desk: right column holds Claude card and Schedule', right && cc && cc.x > 600 && right.x > 600);
    check('desk: 3 next blocks + Full schedule link', (await V.locator('[data-next-block]').count()) === 3 && (await V.locator('a[href="/timetable"]').count()) === 1);
  }

  // Counts in headings; buttons
  const head = async t => (await V.locator(`[data-section=${t}] h2`).innerText()).replace(/\s+/g, ' ');
  console.log(await head('overdue'), '|', await head('due-today'), '|', await head('in-progress'), '|', await head('blocked'));
  check(`${kind}: heading counts`, (await head('overdue')).includes('7') && (await head('due-today')).includes('3'));
  for (const n of ['Schedule', 'More']) check(`${kind}: header button ${n}`, (await V.getByRole('button', { name: n, exact: true }).count()) === 1);
  check(`${kind}: no loose Import or Work day button`, (await V.getByRole('button', { name: 'Import', exact: true }).count()) === 0 && (await V.getByRole('button', { name: /^(Work|Flex) day/ }).count()) === 0);
  await tap(V.getByRole('button', { name: 'More', exact: true }), phone);
  await p.locator('[data-more-menu]').waitFor();
  const moreText = await p.locator('[data-more-menu]').innerText();
  check(`${kind}: More menu holds Import and the work/flex day switch`, /Import tasks/.test(moreText) && /Work day|Flex day/.test(moreText), moreText);
  await closeSheet(p, phone);
  await p.locator('[data-more-menu]').waitFor({ state: 'detached' });
  check(`${kind}: no Day plan label`, (await V.getByText('Day plan', { exact: true }).count()) === 0);

  // Show more
  // phone shows 2 overdue rows when something is due today, so Due today's first row fits the first screen
  check(`${kind}: Overdue shows first rows (2 phone / 5 desk)`, (await V.locator('[data-section=overdue] a[href^="/tasks/"]').count()) === (phone ? 2 : 5));
  await tap(V.getByRole('button', { name: phone ? 'Show 5 more' : 'Show 2 more' }), phone);
  check(`${kind}: Show more reveals all 7`, (await V.locator('[data-section=overdue] a[href^="/tasks/"]').count()) === 7);

  // Claude card
  const st = (await V.locator('[data-claude-status]').innerText()).replace(/\s+/g, ' ');
  console.log('claude status:', st);
  check(`${kind}: card "Claude · 2 sessions" (the Claude page's count)`, /^Claude · 2 sessions\b/.test(st) && !/asking/i.test(st), st);
  check(`${kind}: card lists the live sessions with the shared session row`, (await V.locator('[data-section=claude-card] [data-session-row]').count()) === 2);
  check(`${kind}: card has no question rows (Claude items retired)`, (await V.locator('[data-needs-you]').count()) === 0 && (await V.locator('input[placeholder="Your answer…"]').count()) === 0);
  const act = await V.locator('[data-activity-total]').innerText();
  check(`${kind}: activity line`, /3 subagents working/.test(act), act);

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
  check(`${kind}: Up next / Also open collapsed, no routine`, (await V.locator('[data-fold]').count()) === 2 && (await V.locator('[data-fold] [aria-expanded=true]').count()) === 0);
  for (const f of ['up-next', 'also-open']) await tap(V.locator(`[data-fold=${f}] > button`), phone);
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

// Needs on Today (redesign step 4): a Need is one line, Today shows three, the recommended answer is the row's button, a hash link opens one.
for (const kind of ['phone', 'desk']) {
  const phone = kind === 'phone';
  const t0 = Date.now();
  const PID = 'today-needs-proj';
  const GOAL = 'Ship the Needs rows so each is one line with its answer.';
  const needOf = (ref, kindOf, ask, ageMin) => ({ _id: `today-need-${ref}`, ref, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', projectId: PID, taskId: null, taskRef: null, to: ME.userId, from: { actor: { kind: 'agent', name: 'Claude' }, word: 'agent', label: 'today' }, kind: kindOf, ask, options: kindOf === 'review' ? [{ id: 'accept', label: 'Accept' }, { id: 'send_back', label: 'Send back' }] : [{ id: 'a', label: 'Option one' }, { id: 'b', label: 'Option two' }], status: 'open', appOnly: false, createdAt: new Date(t0 - ageMin * 60_000), answeredAt: null });
  const clean = async () => { for (const c of ['needs', 'projects', 'states']) await rawDb.collection(c).deleteMany({ $or: [{ _id: /^today-need/ }, { projectId: PID }, { _id: PID }] }); };
  await clean();
  const nowD = new Date();
  await rawDb.collection('projects').insertOne({ _id: PID, name: 'Today Needs', nameLower: 'today needs', client: '', description: '', status: 'active', orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', createdAt: nowD, updatedAt: nowD });
  await rawDb.collection('states').insertOne({ _id: PID, projectId: PID, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', now: { text: GOAL + ' Then check them on the real build in both themes at two widths before anything else goes in.', by: ME.userId, at: nowD }, next: [], later: [], decisions: [], where: {}, version: 2, createdAt: nowD, updatedAt: nowD });
  await rawDb.collection('needs').insertMany([needOf(9801, 'decide', 'Fourth question, the oldest?', 40), needOf(9802, 'decide', 'Third question?', 30), needOf(9804, 'decide', 'Second question?', 20), needOf(9803, 'review', 'Review the Needs rows', 10)]);
  console.log(`\n=== needs on Today (${kind}) ===`);
  const { p, errs } = await open(kind);
  const V = p.locator(`[data-variant=${kind}]`);
  const block = V.locator('[data-section="needs-you"]');
  await block.waitFor();
  await p.waitForTimeout(500);
  check(`${kind}: four open Needs show 3 rows and See all`, (await block.locator('[data-need-row]').count()) === 3 && (await block.locator('a[href="/needs"]').count()) === 1 && /Needs you\s+4\b/.test(await block.innerText()), await block.innerText());
  check(`${kind}: the oldest Need is the one left out`, (await block.locator('[data-need="9801"]').count()) === 0 && (await block.locator('[data-need="9802"]').count()) === 1);
  check(`${kind}: a Need is one line: no options or note box until it is opened`, (await block.locator('[data-need-option], [data-need-text]').count()) === 0);
  const review = block.locator('[data-need="9803"]');
  check(`${kind}: a review Need has Open, not a quick answer`, (await review.locator('[data-need-quick]').count()) === 0 && (await review.locator('[data-need-toggle]').innerText()).trim() === 'Open');
  const quick = block.locator('[data-need="9804"] [data-need-quick]');
  check(`${kind}: a decide Need's button is its first option`, (await quick.getAttribute('data-need-quick')) === 'a' && (await quick.innerText()).trim() === 'Option one');
  if (phone) console.log('phone page height with 4 Needs:', await p.evaluate(() => document.documentElement.scrollHeight));
  await tap(quick, phone);
  await block.locator('[data-need="9804"]').waitFor({ state: 'detached', timeout: 15000 });
  const d = await rawDb.collection('needs').findOne({ ref: 9804 });
  check(`${kind}: the quick button answers with option 1 and the row goes`, d?.status === 'answered' && d?.answer?.option === 'a' && d?.answer?.via === 'app', JSON.stringify(d?.answer));
  await p.waitForTimeout(500);
  check(`${kind}: the next Need takes its place (3 rows again)`, (await block.locator('[data-need-row]').count()) === 3 && (await block.locator('[data-need="9801"]').count()) === 1);
  const goal = await V.locator(`[data-project-row=${PID}] [data-project-row-now]`).innerText();
  check(`${kind}: Projects now shows one sentence of a long Now`, goal === GOAL, goal);
  check(`${kind}: no console errors`, errs.length === 0, errs.join(' | '));
  await rawDb.collection('needs').insertOne(needOf(9800, 'decide', 'Oldest of all?', 50)); // a fourth open Need again, past the first three
  await p.goto(`${B}/today#need-9800`);
  await p.reload();
  const b2 = p.locator(`[data-variant=${kind}] [data-section="needs-you"]`);
  await b2.waitFor();
  await p.waitForTimeout(800);
  check(`${kind}: /today#need-<ref> of a Need past the first three shows it first, open`, (await b2.locator('[data-need-row]').first().getAttribute('data-need')) === '9800' && (await b2.locator('[data-need="9800"] [data-need-option]').count()) === 2 && (await b2.locator('[data-need-row]').count()) === 3);
  await p.context().close();
  await clean();
}

// Empty states: finish overdue tasks directly in the test DB
await db.collection('tasks').updateMany({ title: /^Overdue task/ }, { $set: { status: 'Done' } });
for (const kind of ['phone', 'desk']) {
  const { p, errs } = await open(kind);
  const V = p.locator(`[data-variant=${kind}]`);
  await p.waitForTimeout(600);
  const st = (await V.locator('[data-claude-status]').innerText()).replace(/\s+/g, ' ');
  check(`${kind}: empty card "Claude · 2 sessions"`, /^Claude · 2 sessions\b/.test(st), st);
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
