// UI revamp phase 1: the purpose header on every project tab (Now clamped to two lines, tap to read it all, holder and first Next
// line, no-Now fallback with a Set Now action, the edit moved off the State card), the Now line on the Projects list cards
// (in place of the completion bar), no sideways scroll at 390 and 1280. Seed profile: none.
import fs from 'node:fs';
import { ME, B, SP, check, finish, launch, login, overflow, okO, rawDb } from './lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const LONG = 'Ship the new phone interface for the project pages so that the correct purpose of the work always comes up first, on every tab, and an agent or a teammate opening the project knows the goal before anything else, then check it on the real build at 390 and 1280 in both themes and fix what looks off. Nothing else goes in before this.';
const now = new Date();
const proj = (id, name, description) => ({ _id: id, name, nameLower: name.toLowerCase(), client: '', description, status: 'active', orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', createdAt: now, updatedAt: now });
const placed = { orgId: ME.orgId, ownerId: ME.userId, visibility: 'org' };
const line = (id, text) => ({ id, text, by: ME.userId, at: now });
const stateOf = (id, nowText, nextTexts) => ({ _id: id, projectId: id, ...placed, now: nowText ? { text: nowText, by: ME.userId, at: now } : null, next: nextTexts.map((t, i) => line(`n${i}`, t)), later: [], decisions: [], where: {}, version: 3, createdAt: now, updatedAt: now });

try {
  for (const c of ['projects', 'states', 'tasks']) await rawDb.collection(c).deleteMany({});
  await rawDb.collection('projects').insertMany([proj('ui-long', 'Ui Long', 'Description that must not show while Now is set'), proj('ui-desc', 'Ui Desc', 'A client portal for the sheds, with orders and invoices.'), proj('ui-none', 'Ui None', '')]);
  await rawDb.collection('states').insertMany([stateOf('ui-long', LONG, ['Check the clamp at both widths', 'Second line']), stateOf('ui-desc', null, ['Draft the brief'])]);

  const br = await launch();
  for (const phone of [true, false]) {
    const tag = phone ? '390' : '1280';
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await login(p, { phone, next: '/today' });
    const settle = async () => { await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(600); };
    const head = p.locator('[data-card=purpose]');
    const shot = async (name, dark) => {
      await p.evaluate(d => document.documentElement.classList.toggle('dark', d), !!dark);
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${SP}/ui-p1-${name}-${tag}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
    };

    // The header shows on every tab, with the Now text
    for (const t of ['overview', 'tasks', 'claude', 'needs', 'notes', 'info']) {
      await p.goto(`${B}/projects/ui-long?tab=${t}`);
      await head.waitFor({ timeout: 20000 });
      await settle();
      check(`ui-p1 (${tag}): the purpose header shows Now on the ${t} tab`, (await head.locator('[data-state-now]').innerText()).startsWith('Ship the new phone interface'));
      const o = await overflow(p);
      check(`ui-p1 (${tag}): no sideways scroll on the ${t} tab`, okO(o), JSON.stringify(o));
      if (t === 'overview' || t === 'tasks') { await shot(`project-${t}`, false); await shot(`project-${t}`, true); }
    }

    // The clamp: two lines at most, the whole text one tap away; holder-less sub line shows Next
    await p.goto(`${B}/projects/ui-long`);
    await head.waitFor();
    await settle();
    const m = await head.locator('[data-purpose-text]').evaluate(el => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight); return { lines: Math.round(el.getBoundingClientRect().height / lh), clamp: cs.webkitLineClamp, fs: cs.fontSize, full: el.scrollHeight > el.clientHeight + 1 }; });
    check(`ui-p1 (${tag}): a long Now is clamped to two lines`, m.clamp === '2' && m.lines <= 2 && m.full, JSON.stringify(m));
    check(`ui-p1 (${tag}): Now is ${phone ? 15 : 17}px`, m.fs === (phone ? '15px' : '17px'), m.fs);
    check(`ui-p1 (${tag}): Next shows beneath, one line`, (await head.locator('[data-purpose-next]').innerText()) === 'Next: Check the clamp at both widths');
    await head.locator('[data-purpose-toggle]').click();
    await p.waitForTimeout(600);
    if (phone) {
      const full = await p.locator('[data-sheet] [data-purpose-full]').innerText();
      check('ui-p1 (390): tapping Now opens a sheet with all of it', full === LONG);
      await shot('now-sheet', false);
      await p.locator('[data-sheet] button[aria-label=Close]').last().click();
      await p.waitForTimeout(400);
    } else {
      const h = await head.locator('[data-purpose-text]').evaluate(el => ({ ok: el.scrollHeight <= el.clientHeight + 1, clamp: getComputedStyle(el).webkitLineClamp }));
      check('ui-p1 (1280): clicking Now shows all of it', h.ok && h.clamp !== '2', JSON.stringify(h));
      await head.locator('[data-purpose-toggle]').click();
    }

    // The edit lives on the header (the State card no longer has Now), with the State's version rule
    check(`ui-p1 (${tag}): the State card has no Now block, the header has the pencil`, (await p.locator('[data-card=state] [data-part=now]').count()) === 0 && (await head.locator('[data-state-edit-now]').count()) === 1);
    check(`ui-p1 (${tag}): the pencil is a 44px tap target on the phone`, !phone || (await head.locator('[data-state-edit-now]').evaluate(e => e.getBoundingClientRect().height >= 44)));
    await head.locator('[data-state-edit-now]').click();
    await head.locator('[aria-label=Now]').fill(`Edited at ${tag}`);
    await head.locator('button:has-text("Save")').click();
    await p.waitForFunction(t => document.querySelector('[data-card=purpose] [data-state-now]')?.textContent === t, `Edited at ${tag}`, { timeout: 15000 });
    const d = await rawDb.collection('states').findOne({ _id: 'ui-long' });
    check(`ui-p1 (${tag}): saving writes Now through the State (version bumped)`, d.now.text === `Edited at ${tag}` && d.version === (phone ? 4 : 5), `${d.version}`);
    await p.waitForFunction(() => /version \d+/.test(document.querySelector('[data-card=state] [data-state-version-label]')?.textContent ?? ''), null, { timeout: 8000 });

    // No Now: the description, then Set Now; with neither, a plain prompt
    await p.goto(`${B}/projects/ui-desc?tab=tasks`);
    await head.waitFor();
    await settle();
    check(`ui-p1 (${tag}): no Now shows the description and a Set Now button`, (await head.locator('[data-purpose-description]').innerText()).startsWith('A client portal') && (await head.locator('[data-state-set-now]').count()) === 1);
    await shot('no-now-description', false);
    await p.goto(`${B}/projects/ui-none`);
    await head.waitFor();
    await settle();
    check(`ui-p1 (${tag}): with no Now and no description it still offers Set Now`, (await head.locator('[data-purpose-description]').count()) === 0 && (await head.locator('[data-state-set-now]').count()) === 1);
    await head.locator('[data-state-set-now]').click();
    await head.locator('[aria-label=Now]').fill(`First goal ${tag}`);
    await head.locator('button:has-text("Save")').click();
    await p.waitForFunction(t => document.querySelector('[data-card=purpose] [data-state-now]')?.textContent === t, `First goal ${tag}`, { timeout: 15000 });
    check(`ui-p1 (${tag}): Set Now saves the first Now`, (await rawDb.collection('states').findOne({ _id: 'ui-none' }))?.now?.text === `First goal ${tag}`);
    await rawDb.collection('states').deleteOne({ _id: 'ui-none' });

    // The Projects list: the Now line replaces the completion bar
    await p.goto(`${B}/projects`);
    await p.locator('[data-project-now]').first().waitFor({ timeout: 20000 });
    await settle();
    const card = name => p.locator('main a[href^="/projects/"]', { hasText: name }).filter({ has: p.locator('[data-project-now], [data-project-description], .font-semibold') }).first();
    const edited = await card('Ui Long').locator('[data-project-now]').innerText();
    const cm = await card('Ui Long').locator('[data-project-now]').evaluate(el => ({ clamp: getComputedStyle(el).webkitLineClamp, h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }));
    check(`ui-p1 (${tag}): a Projects card shows Now, clamped to two lines`, edited === `Edited at ${tag}` && cm.clamp === '2', JSON.stringify([edited, cm]));
    check(`ui-p1 (${tag}): a Projects card with no Now shows its description`, (await card('Ui Desc').locator('[data-project-description]').innerText()).startsWith('A client portal'));
    check(`ui-p1 (${tag}): the completion bar is gone, the counts row stays`, (await p.locator('.bg-green-500[style*="width"]').count()) === 0 && /\d+ done · \d+ open/.test(await card('Ui Long').innerText()));
    const ol = await overflow(p);
    check(`ui-p1 (${tag}): no sideways scroll on the Projects list`, okO(ol), JSON.stringify(ol));
    await shot('projects', false);
    await shot('projects', true);
    // restore for the next width
    await rawDb.collection('states').updateOne({ _id: 'ui-long' }, { $set: { 'now.text': LONG } });
    await ctx.close();
  }
  await br.close();
} catch (e) {
  check('flow-ui-p1 (error)', false, e?.stack || String(e));
}
await finish();
