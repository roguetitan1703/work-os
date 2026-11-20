// Navigation: phone bar, header, menu, + sheet, Back rules; desktop sidebar, shortcuts, Back. Seed profile: nav.
import { launch, check, B, PW, finish, overflow, okO, fillLogin, makeUser, ME, rawDb as db0 } from './lib.mjs';
const b = await launch();
async function login(p) {
  await p.goto(B + '/login?next=/today'); await fillLogin(p);
  await p.locator('button[type=submit]').click(); await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 });
}
const path = p => new URL(p.url()).pathname + new URL(p.url()).search;
const settle = p => p.waitForTimeout(700);

// ===== PHONE =====
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.setDefaultTimeout(8000); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await login(p); await settle(p);
  const bar = p.locator('nav[aria-label=Main]:visible');
  const labels = await bar.locator('a, button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent.trim()).replace(/^\d+/, '').trim()));
  check('phone bar order', JSON.stringify(labels) === JSON.stringify(['Today', 'Projects', 'Add', 'Needs', 'Claude']), JSON.stringify(labels));
  const badge = async k => (await bar.locator(`[data-badge=${k}]`).count()) ? (await bar.locator(`[data-badge=${k}]`).innerText()) : '0';
  check('Today badge = overdue (2)', (await badge('today')) === '2', await badge('today'));
  check('no Tasks tab: Tasks is first in the Menu', (await bar.locator('a[href="/tasks"]').count()) === 0);
  check('Needs badge = open Needs for me (none in this seed)', (await badge('needs')) === '0', await badge('needs'));
  check('header Menu dot: none while nothing is new (Claude items retired)', (await p.locator('header:visible [data-menu-dot]').count()) === 0);
  const sizes = await bar.locator('a, button').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check('bar targets >= 44px', sizes.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(sizes));
  const litOn = async url => { await p.goto(B + url); await settle(p); return bar.locator('a[aria-current=page]').evaluateAll(els => els.map(e => e.textContent.trim().replace(/^\d+/, ''))); };
  await p.goto(B + '/notes'); const noteHref = await p.locator('main a[href^="/notes/"]').first().getAttribute('href');
  const lit = {
    '/today': ['Today'], '/tasks': [], '/tasks/1': [], '/projects': ['Projects'], '/projects/alpha-client': ['Projects'],
    '/notes': ['Projects'], [noteHref]: ['Projects'], '/notifications': [], '/history': [], '/review': [], '/hidden': [], '/timetable': [], '/settings': [], '/menu': [], '/connect': [], '/recovery': [], '/needs': ['Needs'], '/claude': ['Claude'], '/claude?tab=workers': ['Claude'], '/whats-new': [],
  };
  for (const [u, exp] of Object.entries(lit)) { const got = await litOn(u); check(`lit tab ${u} -> ${exp.join('') || 'nothing'}`, JSON.stringify(got) === JSON.stringify(exp), JSON.stringify(got)); }
  // One header everywhere: pages reached from the Menu keep Search, the bell and Menu, and carry the one back link.
  for (const u of ['/today', '/tasks', '/projects', '/notes', '/claude', '/menu', '/review', '/timetable', '/whats-new', '/settings', '/settings?section=account', '/notifications']) {
    await p.goto(B + u); await settle(p);
    const hdr = p.locator('header:visible').first();
    const hit = await hdr.locator('a, button').evaluateAll(els => els.map(e => [e.getAttribute('aria-label') || '', Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
    const need = [/^Search/, ...(u === '/notifications' ? [] : [/notification/i]), ...(u === '/menu' ? [] : [/^Menu/])]; // search is a button (opens the global search sheet)
    check(`header ${u}: search${u === '/notifications' ? '' : ', bell'}${u === '/menu' ? '' : ', menu'} at 44px`, need.every(n => hit.some(([l, w, h]) => n.test(l) && w >= 44 && h >= 44)), JSON.stringify(hit));
    if (['/review', '/timetable', '/whats-new', '/settings', '/notifications'].includes(u)) {
      const back = hdr.locator('a[data-back]');
      check(`header ${u}: the one back link (Menu, blue chevron, 44px)`, (await back.count()) === 1 && /Back to Menu/.test(await back.getAttribute('aria-label')) && (await back.evaluate(e => Math.round(e.getBoundingClientRect().height))) >= 44, await back.getAttribute('aria-label').catch(() => 'none'));
    }
    const o = await overflow(p); check(`no horizontal scroll ${u}`, okO(o), JSON.stringify(o).slice(0, 200));
  }
  // The task page and a Menu page use the same back link (same colour and size).
  const backLook = async u => { await p.goto(B + u); await settle(p); return p.locator('a[data-back]:visible').first().evaluate(e => { const s = getComputedStyle(e); return [s.color, s.fontSize, Math.round(e.getBoundingClientRect().height)].join(' '); }); };
  const lookTask = await backLook('/tasks/1'); const lookReview = await backLook('/review');
  check('task page Back looks like the Menu pages\' Back', lookTask === lookReview, `${lookTask} vs ${lookReview}`);
  // + sheet
  await p.goto(B + '/tasks'); await settle(p);
  await p.locator('button[aria-label=Add]').tap();
  await p.locator('[data-quick-add] textarea').waitFor();
  check('+ sheet: Start Claude row visible', await p.locator('[data-start-claude]').isVisible());
  check('+ sheet: New note beside it', await p.locator('[data-quick-add] [data-new-note]').isVisible());
  check('+ sheet: syntax hint visible', await p.locator('[data-quick-add] >> text=@project').isVisible());
  await p.locator('[data-quick-add] textarea').fill('hello');
  check('+ sheet: row hides once a title typed', !(await p.locator('[data-start-claude]').count()));
  await p.locator('[data-quick-add] textarea').fill('');
  check('+ sheet: row back when empty', await p.locator('[data-start-claude]').isVisible());
  // every:week in quick add makes a recurring task, and its row shows the repeat icon
  await p.locator('[data-quick-add] textarea').fill('Water the plants every:week every:bogus');
  await p.locator('[data-quick-add] textarea').press('Enter'); await p.waitForTimeout(1500);
  const rec = await db0.collection('tasks').findOne({ title: 'Water the plants every:bogus' });
  check('quick add every:week -> weekly recurrence, unknown every:bogus stays in title', rec?.recurrence?.freq === 'weekly' && rec.recurrence.interval === 1, JSON.stringify(rec?.recurrence));
  await p.locator('[data-quick-add] button[aria-label=Close]').first().tap();
  await p.goto(B + '/tasks'); await settle(p);
  check('task row shows the Recurring icon', (await p.locator('a:has-text("Water the plants") [aria-label=Recurring], :has(> a:has-text("Water the plants")) [aria-label=Recurring]').count()) >= 1);
  await p.locator('button[aria-label=Add]').tap(); await p.locator('[data-quick-add] textarea').waitFor();
  await p.locator('[data-start-claude]').tap(); await p.waitForTimeout(800);
  check('Start Claude -> current URL + ?start=1', path(p) === '/tasks?start=1', path(p));
  check('sheet closed after Start Claude', !(await p.locator('[data-quick-add]').count()));
  // + > New note opens the New note sheet (Notes has no New pill any more)
  await p.goto(B + '/notes'); await settle(p);
  check('Notes header: no New pill', (await p.locator('header:visible button[aria-label="New note"]').count()) === 0);
  await p.locator('button[aria-label=Add]').tap(); await p.locator('[data-quick-add] [data-new-note]').tap(); await p.waitForTimeout(400);
  check('+ > New note: the quick add closes and the New note sheet opens', !(await p.locator('[data-quick-add]').count()) && (await p.locator('[role=dialog]:has-text("New note"), [data-sheet]:has-text("Create note")').count()) >= 1);
  await p.keyboard.press('Escape'); await p.goto(B + '/projects'); await settle(p);
  check('Projects header: no second + (New project is a labelled button)', (await p.locator('header:visible button[aria-label="New project"]').count()) === 0 && (await p.locator('main [data-new-project]:visible').count()) === 1);
  // Menu: one flat list, Tasks first
  await p.goto(B + '/menu'); await settle(p);
  const hrefs = await p.locator('main a').evaluateAll(els => els.map(e => e.getAttribute('href')));
  check("menu is Tasks, Notes, Review, Schedule, Inbox, What's new, Settings, in that order", JSON.stringify(hrefs) === JSON.stringify(['/tasks', '/notes', '/review', '/timetable', '/notifications', '/whats-new', '/settings']), JSON.stringify(hrefs));
  check('menu: one list, no group headings', (await p.locator('main h2').count()) === 0 && (await p.locator('main [data-menu]').count()) === 1);
  const mrows = await p.locator('main [data-menu] > div').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
  check('menu rows are 44px', mrows.length === 7 && mrows.every(h => h === 44), JSON.stringify(mrows));
  check('menu Settings status dot', (await p.locator('main a[href="/settings"] [role=img]').count()) === 1);
  await p.locator('main a[href="/tasks"]').tap(); await p.waitForURL(/\/tasks$/);
  check('Menu > Tasks opens Tasks', path(p) === '/tasks', path(p));
  await p.goto(B + '/tasks'); await settle(p);
  const mh = p.locator('[data-mode-help]:visible').first();
  const mhb = await mh.boundingBox();
  check('phone Tasks: "What are these?" chip at 44px', mhb && mhb.height >= 43.5 && /What are these\?/.test(await mh.innerText()), JSON.stringify(mhb));
  await mh.tap(); await p.locator('[data-mode-help-list]').waitFor();
  check('phone Tasks: What are these? lists the 8 kinds of work with definitions', (await p.locator('[data-mode-help-list] > div').count()) === 8);
  const oh = await overflow(p); check('phone Tasks: no horizontal scroll with the sheet open', okO(oh), JSON.stringify(oh).slice(0, 200));
  await p.locator('[data-sheet] [role=dialog] button[aria-label=Close]').first().tap(); await p.waitForTimeout(300);
  // Task page (phone): core fields on top, the rest under More details
  await p.goto(B + '/tasks/1'); await settle(p);
  const mdb = p.locator('[data-more-details]:visible');
  const mdbb = await mdb.boundingBox();
  check('phone task: More details is collapsed, 44px, and Project / Kind of work are inside it', mdbb && mdbb.height >= 43.5 && (await p.locator('[data-more-details-body]:visible').count()) === 0 && !(await p.locator('main').innerText()).includes('Estimate'), JSON.stringify(mdbb));
  await mdb.tap();
  const mdtext = await p.locator('[data-more-details-body]:visible').innerText();
  check('phone task: More details holds project, Kind of work, start, estimate, repeats, tags (no "Mode")', /Project/.test(mdtext) && /Kind of work/.test(mdtext) && /Start/.test(mdtext) && /Estimate/.test(mdtext) && /Repeats/.test(mdtext) && /Tags/.test(mdtext) && !/Mode/.test(mdtext), mdtext.replace(/\n/g, ' | ').slice(0, 160));
  const ho = await overflow(p); check('phone task: no horizontal scroll with More details open', okO(ho), JSON.stringify(ho).slice(0, 200));
  const olds = ['/projects', '/projects?all=1', '/projects/alpha-client', '/history', '/hidden', '/review', '/timetable', '/recovery', '/notifications', '/settings', '/connect', '/archive'];
  const go = async u => { const r = await p.goto(B + u); await p.waitForLoadState('load'); await settle(p); return r; };
  for (const u of olds) { const r = await go(u); check(`old More destination ${u} loads (${r.status()}) -> ${path(p)}`, r.status() === 200 && (await p.locator('h1:visible').count()) > 0); }
  await p.goto(B + '/projects'); await settle(p);
  check('Projects lists all 3 projects', (await p.locator('main a[href^="/projects/"]').count()) >= 3);
  check('Projects: Active/All chips', (await p.locator('main a[href="/projects?all=1"]').count()) >= 1);
  for (const [from, to] of [['/more', '/menu'], ['/board?due=overdue', '/tasks?due=overdue']]) {
    await go(from); check(`redirect ${from} -> ${to}`, path(p) === to, path(p));
  }
  const gone = await p.goto(B + '/modes/code-dev');
  check('/modes/<mode> is gone (404; the mode is a Tasks filter)', gone.status() === 404, String(gone.status()));
  await go('/tasks?mode=Code%20%26%20Dev');
  const rows = await p.locator('main a[href^="/tasks/"]:visible').allInnerTexts();
  check('mode filter shows Code & Dev tasks only', rows.some(r => /ship build/.test(r)) && !rows.some(r => /Admin taxes/.test(r)), JSON.stringify(rows.map(r => r.slice(0, 30))));
  await p.goto(B + '/projects'); await settle(p);
  await p.evaluate(() => { document.getElementById('app-main').firstElementChild.style.minHeight = '3000px'; document.getElementById('app-main').scrollTo(0, 400); });
  const before = await p.evaluate(() => document.getElementById('app-main').scrollTop);
  await bar.locator('a[href="/projects"]').tap(); await p.waitForTimeout(900);
  const after = await p.evaluate(() => document.getElementById('app-main').scrollTop);
  check('tapping lit tab scrolls to top', before > 100 && after < 5, `${before} -> ${after}`);
  await p.goto(B + '/today'); await settle(p);
  const h0 = await p.evaluate(() => history.length);
  await bar.locator('a[href="/projects"]').tap(); await p.waitForURL(/\/projects$/); await settle(p);
  const h1 = await p.evaluate(() => history.length);
  await p.locator('[role=tab]:has-text("Notes")').tap(); await p.waitForURL(/\/notes$/); await settle(p);
  const h2 = await p.evaluate(() => history.length);
  check('tab and segment switches use replace (history length unchanged)', h0 === h1 && h1 === h2, `${h0},${h1},${h2}`);
  check('Projects|Notes segment on /notes', (await p.locator('[role=tab]:has-text("Projects")').count()) === 1);
  await p.goto(B + '/today'); await settle(p);
  await p.locator('main a[href^="/tasks/"]:visible').first().tap(); await p.waitForURL(/\/tasks\/\d+/); await settle(p);
  await p.locator('a[data-back]:visible').first().tap(); await p.waitForTimeout(800);
  check('Back from task -> where I came from (Today)', path(p) === '/today', path(p));
  for (const [from, to, why] of [['/tasks/1', '/tasks', 'task -> Tasks'], ['/projects/alpha-client', '/projects', 'project -> Projects'], [noteHref, '/projects/', 'note -> its project'], ['/history', '/menu', 'review -> Menu'], ['/settings', '/menu', 'settings -> Menu'], ['/connect', '/settings', 'connect (redirects to a Settings section) -> Settings'], ['/timetable', '/menu', 'schedule -> Menu']]) {
    await p.goto(B + from); await settle(p);
    await p.locator('a[data-back]:visible').first().tap(); await p.waitForTimeout(900);
    check(`Back (deep link) ${why}`, to.endsWith('/') ? path(p).startsWith(to) : path(p) === to, path(p));
  }
  await p.goto(B + '/projects'); await settle(p);
  await p.locator('main a[href="/projects/beta-product"]').first().tap(); await p.waitForURL(/beta-product/); await settle(p);
  await p.locator('a[data-back]:visible').first().tap(); await p.waitForTimeout(800);
  check('Back project -> Projects (came from)', path(p) === '/projects', path(p));
  check('no page errors (phone)', errs.length === 0, errs.join(' | ').slice(0, 200));
  await ctx.close();
}

// ===== DESKTOP =====
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage(); p.setDefaultTimeout(8000); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await login(p); await settle(p);
  const aside = p.locator('aside');
  const geo = async () => aside.evaluate(a => { const r = a.getBoundingClientRect(); const nav = a.querySelector('nav'); return { bottom: r.bottom, h: r.height, navScroll: (() => { const l = nav.querySelector('a[href="/notes"]'); return !l || l.getBoundingClientRect().bottom > nav.getBoundingClientRect().bottom + 1; })() }; });
  let g = await geo();
  check('sidebar ends above the 40px time bar (<=760)', g.bottom <= 760.5, JSON.stringify(g));
  check('sidebar: all places are visible without scrolling (Recent may scroll)', !g.navScroll, JSON.stringify(g));
  const hit = async sel => p.evaluate(s => { const e = document.querySelector(s); if (!e) return 'none'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e.contains(t) || t?.contains(e) ? 'ok' : 'covered ' + t?.tagName; }, sel);
  check('footer: account button clickable', (await hit('aside [data-account-button]')) === 'ok', await hit('aside [data-account-button]'));
  check('top: collapse toggle clickable', (await hit('aside [data-sidebar-toggle]')) === 'ok', await hit('aside [data-sidebar-toggle]'));
  const order = await aside.locator('a, button').evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim().replace(/\s*[NS1-6\/]$/, '').replace(/\d+$/, '').trim()).filter(Boolean));
  console.log('sidebar order:', JSON.stringify(order));
  check('sidebar order', JSON.stringify(order.slice(0, 9)) === JSON.stringify(['Search', 'New task', 'Start Claude', 'Today', 'Projects', 'Claude', 'Needs', 'Tasks', 'Notes']), JSON.stringify(order));
  check('sidebar: Review, Schedule, What\'s new and Inbox rows are gone (account menu and bell)', (await aside.locator('nav a[href="/review"], nav a[href="/timetable"], nav a[href="/whats-new"], nav a[href="/notifications"]').count()) === 0);
  check('sidebar: the Inbox is the bell at the top', (await aside.locator('a[data-sidebar-bell][href="/notifications"]').count()) === 1);
  check('sidebar has no Modes group or mode links', (await aside.locator('a[href^="/tasks?mode="]').count()) === 0 && (await aside.locator('button:has-text("Modes")').count()) === 0);
  const dbadge = t => aside.locator(`a:has-text("${t}") span.rounded-full`).first().innerText({ timeout: 1000 }).catch(() => '0');
  check('Today badge 2, no Claude badge', (await dbadge('Today')) === '2' && (await dbadge('Claude')) === '0', `${await dbadge('Today')} ${await dbadge('Claude')}`);
  // One badge colour: every count in the sidebar is the same red (Today's overdue, Needs, the bell).
  const colours = await aside.locator('[data-count], [data-badge]').evaluateAll(els => [...new Set(els.map(e => getComputedStyle(e).backgroundColor))]);
  check('sidebar counts share one colour', colours.length <= 1, JSON.stringify(colours));
  check('operator: server status dot on the avatar', (await aside.locator('[data-account-button] [data-status-dot]').count()) === 1 && (await aside.locator('a[href="/settings"]').count()) === 0);
  // Kind of work filter on Tasks (the modes moved here from the sidebar), with the definitions behind "What are these?"
  await p.goto(B + '/tasks'); await settle(p);
  await p.locator('[data-slot=select-trigger][aria-label="Kind of work"]').click();
  await p.locator('[data-slot=select-content]').waitFor();
  check('Tasks: Kind of work filter lists All plus the 8 modes', (await p.locator('[data-slot=select-content] [role=option]').count()) === 9);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.locator('[data-mode-help]:visible').click();
  await p.locator('[data-mode-help-list]').waitFor();
  check('What are these? shows the 8 mode definitions', (await p.locator('[data-mode-help-list] > div').count()) === 8, await p.locator('[data-mode-help-list]').innerText().then(t => t.slice(0, 80)));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.goto(B + '/tasks?mode=Code%20%26%20Dev'); await settle(p);
  check('mode filter is still a URL filter on Tasks', /Code & Dev/.test(await p.locator('[data-slot=select-trigger][aria-label="Kind of work"]').innerText()));
  check('Tasks lit in sidebar for mode filter', (await aside.locator('a[aria-current=page]').first().innerText()).startsWith('Tasks'));
  // Task page (desktop): Delete lives in the "..." menu, away from Complete; More details holds the rest
  await p.goto(B + '/tasks/1'); await settle(p);
  const dtxt = await p.locator('main').innerText();
  check('desktop task: Delete is not on the page until the "..." menu opens', !/Delete/.test(dtxt) && (await p.locator('button:has-text("Complete")').count()) === 1 && (await p.locator('[data-task-options]').count()) === 1);
  check('desktop task: More details is collapsed; Due and Assigned to are on top', (await p.locator('[data-more-details-body]').count()) === 0 && /Due/.test(dtxt) && /Assigned to/.test(dtxt) && !/Estimate/.test(dtxt));
  await p.locator('[data-task-options]').click(); await p.locator('[data-task-options-menu]').waitFor();
  const otxt = await p.locator('[data-task-options-menu]').innerText();
  check('desktop task: "..." menu has Archive and Delete', /Archive/.test(otxt) && /Delete/.test(otxt), otxt);
  await p.locator('[data-task-options-menu] button:has-text("Delete")').click();
  check('desktop task: Delete asks first (modal confirm)', await p.locator('[role=dialog]:has-text("Move to trash")').waitFor({ timeout: 4000 }).then(() => true, () => false));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.locator('[data-more-details]:visible').click();
  const dmd = await p.locator('[data-more-details-body]:visible').innerText();
  check('desktop task: More details holds Project, Kind of work, Estimate, Start, Repeats, Tags', /Project/.test(dmd) && /Kind of work/.test(dmd) && /Estimate/.test(dmd) && /Start/.test(dmd) && /Repeats/.test(dmd) && /Tags/.test(dmd) && !/Mode/.test(dmd), dmd.replace(/\n/g, ' | ').slice(0, 120));
  await p.goto(B + '/today'); await settle(p);
  await aside.locator('button:has-text("Start Claude")').click(); await p.waitForTimeout(700);
  check('Start Claude button -> ?start=1', path(p) === '/today?start=1', path(p));
  await p.keyboard.press('Escape'); await p.waitForTimeout(400); // STALE-FIX: Start dialog is modal
  await aside.locator('button:has-text("Search")').click(); await p.locator('input[aria-controls=global-search-results]').waitFor(); // opens the global search, no page change
  check('Search button opens global search with the input focused', await p.evaluate(() => document.activeElement?.getAttribute('aria-controls') === 'global-search-results') && path(p) === '/today', path(p));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.goto(B + '/today'); await settle(p);
  await aside.locator('button:has-text("New task")').click(); check('New task button opens dialog', await p.locator('[role=dialog]').isVisible()); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  const keyTo = async (k, re, label) => { await p.goto(B + '/menu'); await settle(p); await p.locator('body').click({ position: { x: 1260, y: 300 } }); await p.keyboard.press(k); await p.waitForTimeout(900); check(`shortcut ${k} -> ${label}`, re.test(path(p)), path(p)); };
  await keyTo('1', /^\/today/, 'Today'); await keyTo('2', /^\/projects/, 'Projects'); await keyTo('3', /^\/claude/, 'Claude'); await keyTo('4', /^\/needs/, 'Needs'); await keyTo('5', /^\/tasks/, 'Tasks'); await keyTo('6', /^\/notes/, 'Notes');
  await p.goto(B + '/menu'); await settle(p); await p.locator('body').click({ position: { x: 1260, y: 300 } }); await p.keyboard.press('/'); await p.waitForTimeout(1200);
  check('shortcut / -> global search input focused (no page change)', path(p) === '/menu' && (await p.evaluate(() => document.activeElement?.getAttribute('aria-controls') === 'global-search-results')), path(p));
  await p.keyboard.type('2'); await p.waitForTimeout(400); check('typing "2" in search does not navigate', path(p) === '/menu');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.goto(B + '/menu'); await settle(p); await p.locator('body').click({ position: { x: 1260, y: 300 } }); await p.keyboard.press('Shift+/'); await p.waitForTimeout(500);
  check('? opens shortcut help dialog', await p.locator('[role=dialog]:has-text("Keyboard shortcuts")').isVisible());
  await p.keyboard.press('1'); await p.waitForTimeout(500); check('shortcut inactive while a dialog is open', path(p) === '/menu', path(p));
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.goto(B + '/tasks/1'); await settle(p);
  await p.locator('a[data-back]:visible').first().click(); await p.waitForTimeout(800); check('desktop task Back (deep link) -> Tasks', path(p) === '/tasks', path(p));
  await p.goto(B + '/projects'); await settle(p); await p.locator('main a[href="/projects/alpha-client"]').first().click(); await p.waitForURL(/alpha-client/); await settle(p);
  await p.locator('a[data-back]:visible').first().click(); await p.waitForTimeout(800); check('desktop project Back (came from Projects)', path(p) === '/projects', path(p));
  await p.goto(B + '/projects/alpha-client'); await settle(p);
  await p.locator('a[data-back]:visible').first().click(); await p.waitForTimeout(800); check('desktop project Back (deep link) -> Projects', path(p) === '/projects', path(p));
  for (const u of ['/projects', '/tasks', '/history', '/hidden', '/review', '/timetable', '/recovery', '/notifications', '/settings', '/connect', '/menu']) {
    const r = await p.goto(B + u); await settle(p); const o = await overflow(p);
    check(`desktop ${u} loads, no h-scroll`, r.status() === 200 && (!o.docScroll && !o.mainScroll), `${r.status()} ${JSON.stringify(o).slice(0, 150)}`);
  }
  // ── Sidebar: collapse, persistence, tooltips, Recent, account menu, shortcuts ──
  await p.goto(B + '/today'); await settle(p);
  const wOf = async () => Math.round((await aside.boundingBox()).width);
  check('sidebar expanded is 260px, labels shown', (await wOf()) === 260 && (await aside.getByText('Tasks', { exact: true }).isVisible()));
  check('sidebar top: mark, Work OS, collapse toggle', (await aside.locator('img[src="/icons/192"]').count()) === 1 && /Work OS/.test(await aside.innerText()) && (await aside.locator('[data-sidebar-toggle]').getAttribute('aria-label')) === 'Collapse sidebar');
  check('nav rows are 36px with an 18px icon', await aside.locator('nav a[href="/tasks"]').evaluate(a => Math.round(a.getBoundingClientRect().height) === 36 && Math.round(a.querySelector('svg').getBoundingClientRect().width) === 18));
  check('Recent lists the visible projects (links with a folder icon)', (await aside.locator('[data-recent-project]').count()) === 3 && (await aside.locator('[data-recent-project] svg').count()) >= 3);
  await aside.locator('[data-recent] button[aria-expanded]').click();
  check('Recent folds with its caret', (await aside.locator('[data-recent-project]').count()) === 0);
  await aside.locator('[data-recent] button[aria-expanded]').click();
  const recentHref = await aside.locator('[data-recent-project]').first().getAttribute('href');
  await aside.locator('[data-recent-project]').first().click(); await p.waitForURL(u => u.pathname === recentHref); await settle(p);
  check('a Recent link opens its project and is lit', (await aside.locator('[data-recent-project][aria-current=page]').count()) === 1, path(p));
  await p.goto(B + '/today'); await settle(p);
  await aside.locator('[data-sidebar-toggle]').click(); await p.waitForTimeout(400);
  check('collapsed is a 56px icon rail', (await wOf()) === 56 && (await aside.getByText('Tasks', { exact: true }).count()) === 0);
  check('rail: Recent is hidden', (await aside.locator('[data-recent]').count()) === 0);
  check('rail: count badges become dots', (await aside.locator('[data-badge-dot]').count()) >= 1 && (await aside.locator('nav a span.rounded-full', { hasText: /\d/ }).count()) === 0);
  check('rail: every control has an accessible name', await aside.locator('a, button').evaluateAll(els => els.every(e => (e.getAttribute('aria-label') || e.textContent || '').trim().length > 0)));
  await aside.locator('a[href="/tasks"]').hover(); await p.waitForTimeout(150);
  const tip = await p.locator('[role=tooltip]').innerText().catch(() => '');
  check('rail: tooltip shows label and shortcut', /Tasks/.test(tip) && /5/.test(tip), tip);
  const o1 = await overflow(p); check('rail: no horizontal scroll', okO(o1), JSON.stringify(o1).slice(0, 150));
  await p.reload(); await settle(p);
  check('collapsed choice is remembered after a reload', (await wOf()) === 56 && (await p.evaluate(() => localStorage.getItem('wos.sidebar'))) === 'collapsed');
  await p.locator('body').click({ position: { x: 900, y: 500 } }); await p.keyboard.press('Control+b'); await p.waitForTimeout(400);
  check('Ctrl+B expands it again', (await wOf()) === 260);
  await p.keyboard.press('Control+b'); await p.waitForTimeout(400);
  check('Ctrl+B collapses it', (await wOf()) === 56);
  await p.keyboard.press('Control+b'); await p.waitForTimeout(400);
  // account menu
  await aside.locator('[data-account-button]').click(); await p.locator('[data-menu=account]').waitFor();
  const am = await p.locator('[data-menu=account]').innerText();
  check('account menu: email, Settings (Ctrl+,), Theme, Server status, Sign out', /e2e-owner@example\.test/.test(am) && /Settings/.test(am) && /Ctrl\+,/.test(am) && /Theme/.test(am) && /Server: /.test(am) && /Sign out/.test(am), am.replace(/\n/g, ' | '));
  check("account menu: Review, Schedule, What's new, then Settings", /Review[\s\S]*Schedule[\s\S]*What's new[\s\S]*Settings/.test(am), am.replace(/\n/g, ' | '));
  await p.locator('[data-menu-review]').click(); await p.waitForURL(/\/review/);
  check('account menu: Review opens Review', path(p).startsWith('/review'), path(p));
  await aside.locator('[data-account-button]').click(); await p.locator('[data-menu-schedule]').click(); await p.waitForURL(/\/timetable/);
  check('account menu: Schedule opens Schedule', path(p).startsWith('/timetable'), path(p));
  await aside.locator('[data-account-button]').click(); await p.locator('[data-menu=account]').waitFor();
  check('account button shows the person and the organization', (await aside.locator('[data-account-button]').innerText()).trim().split('\n').length >= 2);
  await p.locator('[data-menu-theme]').hover(); await p.locator('[data-theme-option]').first().waitFor();
  check('account menu: Theme offers Light, Dark, System', (await p.locator('[data-theme-option]').count()) === 3);
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await aside.locator('[data-account-button]').click(); await p.locator('[data-menu-settings]').click(); await p.waitForURL(/\/settings/);
  check('account menu: Settings opens Settings', path(p).startsWith('/settings'), path(p));
  await p.goto(B + '/today'); await settle(p); await p.locator('body').click({ position: { x: 900, y: 500 } }); await p.keyboard.press('Control+,'); await p.waitForTimeout(800);
  check('Ctrl+, opens Settings', path(p).startsWith('/settings'), path(p));
  // a member is not the operator: no server status dot or line
  {
    const mem = await makeUser({ email: 'e2e-member-sidebar@example.test', name: 'Mia Member', orgId: ME.orgId, role: 'member' });
    const mctx = await b.newContext({ viewport: { width: 1280, height: 800 } }); const mp = await mctx.newPage();
    await mp.goto(B + '/login?next=/today'); await fillLogin(mp, { email: 'e2e-member-sidebar@example.test' }); await mp.locator('button[type=submit]').click(); await mp.waitForURL(u => u.pathname === '/today', { timeout: 20000 }); await mp.waitForTimeout(700);
    check('member: no server status dot on the avatar', (await mp.locator('[data-account-button] [data-status-dot]').count()) === 0 && /Mia/.test(await mp.locator('[data-account-button]').innerText()));
    await mp.locator('[data-account-button]').click(); await mp.locator('[data-menu=account]').waitFor();
    check('member: the menu has no Server line', !/Server: /.test(await mp.locator('[data-menu=account]').innerText()) && mem.userId.length > 0);
    await mctx.close();
  }
  // Set up Claude replaces Start Claude until a computer exists
  await db0.collection('devices').deleteMany({});
  await p.goto(B + '/today'); await settle(p);
  check('no computer: sidebar shows Set up Claude, not Start Claude', (await aside.locator('a[data-set-up-claude]').count()) === 1 && (await aside.locator('button:has-text("Start Claude")').count()) === 0);
  // sign out from the menu (last: it ends the session)
  await aside.locator('[data-account-button]').click(); await p.locator('[data-menu-sign-out]').click();
  await p.waitForURL(/\/login/, { timeout: 10000 }).catch(() => {});
  check('Sign out from the account menu returns to the login page', /\/login/.test(path(p)), path(p));
  check('no page errors (desktop)', errs.length === 0, errs.join(' | ').slice(0, 200));
  await ctx.close();
}
await b.close();
await finish();
