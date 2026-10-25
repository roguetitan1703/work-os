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
  check('phone bar order', JSON.stringify(labels) === JSON.stringify(['Today', 'Projects', 'Add', 'Claude', 'Tasks']), JSON.stringify(labels));
  const badge = async k => (await bar.locator(`[data-badge=${k}]`).count()) ? (await bar.locator(`[data-badge=${k}]`).innerText()) : '0';
  check('Today badge = overdue (2)', (await badge('today')) === '2', await badge('today'));
  check('Claude badge = waiting (2)', (await badge('claude')) === '2', await badge('claude'));
  const sizes = await bar.locator('a, button').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check('bar targets >= 44px', sizes.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(sizes));
  const litOn = async url => { await p.goto(B + url); await settle(p); return bar.locator('a[aria-current=page]').evaluateAll(els => els.map(e => e.textContent.trim().replace(/^\d+/, ''))); };
  await p.goto(B + '/notes'); const noteHref = await p.locator('main a[href^="/notes/"]').first().getAttribute('href');
  const lit = {
    '/today': ['Today'], '/tasks': ['Tasks'], '/tasks/1': ['Tasks'], '/projects': ['Projects'], '/projects/alpha-client': ['Projects'],
    '/notes': ['Projects'], [noteHref]: ['Projects'], '/notifications': [], '/history': [], '/review': [], '/hidden': [], '/timetable': [], '/settings': [], '/menu': [], '/connect': [], '/recovery': [],
  };
  for (const [u, exp] of Object.entries(lit)) { const got = await litOn(u); check(`lit tab ${u} -> ${exp.join('') || 'nothing'}`, JSON.stringify(got) === JSON.stringify(exp), JSON.stringify(got)); }
  for (const u of ['/today', '/tasks', '/projects', '/notes', '/menu']) {
    await p.goto(B + u); await settle(p);
    const hdr = p.locator('header:visible').first();
    const hit = await hdr.locator('a, button').evaluateAll(els => els.map(e => [e.getAttribute('aria-label') || '', Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
    const need = u === '/menu' ? [/^Search/, /notification/i] : [/^Search/, /notification/i, /^Menu/]; // search is a button now (opens the global search sheet)
    check(`header ${u}: search, bell${u === '/menu' ? '' : ', menu'} at 44px`, need.every(n => hit.some(([l, w, h]) => n.test(l) && w >= 44 && h >= 44)), JSON.stringify(hit));
    const o = await overflow(p); check(`no horizontal scroll ${u}`, okO(o), JSON.stringify(o).slice(0, 200));
  }
  // + sheet
  await p.goto(B + '/tasks'); await settle(p);
  await p.locator('button[aria-label=Add]').tap();
  await p.locator('[data-quick-add] textarea').waitFor();
  check('+ sheet: Start Claude row visible', await p.locator('[data-start-claude]').isVisible());
  check('+ sheet: syntax hint visible', await p.locator('[data-quick-add] >> text=@project').isVisible());
  await p.locator('[data-quick-add] textarea').fill('hello');
  check('+ sheet: row hides once a title typed', !(await p.locator('[data-start-claude]').count()));
  await p.locator('[data-quick-add] textarea').fill('');
  check('+ sheet: row back when empty', await p.locator('[data-start-claude]').isVisible());
  await p.locator('[data-start-claude]').tap(); await p.waitForTimeout(800);
  check('Start Claude -> current URL + ?start=1', path(p) === '/tasks?start=1', path(p));
  check('sheet closed after Start Claude', !(await p.locator('[data-quick-add]').count()));
  // Menu
  await p.goto(B + '/menu'); await settle(p);
  const hrefs = await p.locator('main a').evaluateAll(els => els.map(e => e.getAttribute('href')));
  const want = ['/notifications', '/review', '/timetable', '/settings']; // Inbox, Review, Schedule, Settings; Connect lives in Settings
  for (const w of want) check(`menu links ${w}`, hrefs.includes(w));
  const mc = hrefs.filter(h => h?.startsWith('/tasks?mode='));
  check('menu has no mode chips and no Modes of work row', mc.length === 0 && !hrefs.includes('/settings?section=help'), String(mc.length));
  check('menu has exactly Inbox, Review, Schedule, Settings', JSON.stringify([...new Set(hrefs)].sort()) === JSON.stringify(['/notifications', '/review', '/settings', '/timetable']), JSON.stringify(hrefs));
  check('menu Settings status dot', (await p.locator('main a[href="/settings"] [role=img]').count()) === 1);
  await p.goto(B + '/tasks'); await settle(p);
  const mh = p.locator('[data-mode-help]:visible').first();
  const mhb = await mh.boundingBox();
  check('phone Tasks: "What are these?" chip at 44px', mhb && mhb.height >= 43.5 && /What are these\?/.test(await mh.innerText()), JSON.stringify(mhb));
  await mh.tap(); await p.locator('[data-mode-help-list]').waitFor();
  check('phone Tasks: What are these? lists the 8 kinds of work with definitions', (await p.locator('[data-mode-help-list] > div').count()) === 8);
  const oh = await overflow(p); check('phone Tasks: no horizontal scroll with the sheet open', okO(oh), JSON.stringify(oh).slice(0, 200));
  await p.locator('[data-sheet] button[aria-label=Close]').first().tap(); await p.waitForTimeout(300);
  // Task page (phone): core fields on top, the rest under More details
  await p.goto(B + '/tasks/1'); await settle(p);
  const mdb = p.locator('[data-more-details]:visible');
  const mdbb = await mdb.boundingBox();
  check('phone task: More details is collapsed, 44px, and Project / Kind of work are inside it', mdbb && mdbb.height >= 43.5 && (await p.locator('[data-more-details-body]:visible').count()) === 0 && !(await p.locator('main').innerText()).includes('Estimate'), JSON.stringify(mdbb));
  await mdb.tap();
  const mdtext = await p.locator('[data-more-details-body]:visible').innerText();
  check('phone task: More details holds project, Kind of work, start, estimate, repeats, tags (no "Mode")', /Project/.test(mdtext) && /Kind of work/.test(mdtext) && /Start/.test(mdtext) && /Estimate/.test(mdtext) && /Repeats/.test(mdtext) && /Tags/.test(mdtext) && !/Mode/.test(mdtext), mdtext.replace(/\n/g, ' | ').slice(0, 160));
  const ho = await overflow(p); check('phone task: no horizontal scroll with More details open', okO(ho), JSON.stringify(ho).slice(0, 200));
  const olds = ['/projects', '/projects?all=1', '/projects/alpha-client', '/modes/code-dev', '/history', '/hidden', '/review', '/timetable', '/recovery', '/notifications', '/settings', '/connect', '/archive'];
  for (const u of olds) { const r = await p.goto(B + u); await settle(p); check(`old More destination ${u} loads (${r.status()}) -> ${path(p)}`, r.status() === 200 && (await p.locator('h1:visible').count()) > 0); }
  await p.goto(B + '/projects'); await settle(p);
  check('Projects lists all 3 projects', (await p.locator('main a[href^="/projects/"]').count()) >= 3);
  check('Projects: Active/All chips', (await p.locator('main a[href="/projects?all=1"]').count()) >= 1);
  for (const [from, to] of [['/more', '/menu'], ['/board?due=overdue', '/tasks?due=overdue'], ['/modes/code-dev', '/tasks?mode=Code%20%26%20Dev'], ['/modes/business-admin', '/tasks?mode=Business%20Admin']]) {
    await p.goto(B + from); await settle(p); check(`redirect ${from} -> ${to}`, path(p) === to, path(p));
  }
  await p.goto(B + '/modes/code-dev'); await settle(p);
  const rows = await p.locator('main a[href^="/tasks/"]:visible').allInnerTexts();
  check('mode filter shows Code & Dev tasks only', rows.some(r => /ship build/.test(r)) && !rows.some(r => /Admin taxes/.test(r)), JSON.stringify(rows.map(r => r.slice(0, 30))));
  await p.goto(B + '/tasks'); await settle(p);
  await p.evaluate(() => { document.getElementById('app-main').firstElementChild.style.minHeight = '3000px'; document.getElementById('app-main').scrollTo(0, 400); });
  const before = await p.evaluate(() => document.getElementById('app-main').scrollTop);
  await bar.locator('a[href="/tasks"]').tap(); await p.waitForTimeout(900);
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
  const geo = async () => aside.evaluate(a => { const r = a.getBoundingClientRect(); const nav = a.querySelector('nav'); return { bottom: r.bottom, h: r.height, navScroll: (() => { const l = nav.querySelector('a[href="/timetable"]'); return !l || l.getBoundingClientRect().bottom > nav.getBoundingClientRect().bottom + 1; })() }; });
  let g = await geo();
  check('sidebar ends above the 40px time bar (<=760)', g.bottom <= 760.5, JSON.stringify(g));
  check('sidebar: all places are visible without scrolling (Recent may scroll)', !g.navScroll, JSON.stringify(g));
  const hit = async sel => p.evaluate(s => { const e = document.querySelector(s); if (!e) return 'none'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e.contains(t) || t?.contains(e) ? 'ok' : 'covered ' + t?.tagName; }, sel);
  check('footer: account button clickable', (await hit('aside [data-account-button]')) === 'ok', await hit('aside [data-account-button]'));
  check('top: collapse toggle clickable', (await hit('aside [data-sidebar-toggle]')) === 'ok', await hit('aside [data-sidebar-toggle]'));
  const order = await aside.locator('a, button').evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim().replace(/\s*[NS1-5\/]$/, '').replace(/\d+$/, '').trim()).filter(Boolean));
  console.log('sidebar order:', JSON.stringify(order));
  check('sidebar order', JSON.stringify(order.slice(0, 11)) === JSON.stringify(['New task', 'Search', 'Start Claude', 'Today', 'Tasks', 'Projects', 'Notes', 'Claude', 'Inbox', 'Review', 'Schedule']), JSON.stringify(order));
  check('sidebar has no Modes group or mode links', (await aside.locator('a[href^="/tasks?mode="]').count()) === 0 && (await aside.locator('button:has-text("Modes")').count()) === 0);
  const dbadge = t => aside.locator(`a:has-text("${t}") span.rounded-full`).first().innerText({ timeout: 1000 }).catch(() => '0');
  check('Today badge 2, Claude badge 2', (await dbadge('Today')) === '2' && (await dbadge('Claude')) === '2', `${await dbadge('Today')} ${await dbadge('Claude')}`);
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
  await keyTo('1', /^\/today/, 'Today'); await keyTo('2', /^\/tasks/, 'Tasks'); await keyTo('3', /^\/projects/, 'Projects'); await keyTo('4', /^\/notes/, 'Notes'); await keyTo('5', /^\/claude/, 'Claude');
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
  for (const u of ['/projects', '/tasks', '/modes/growth', '/history', '/hidden', '/review', '/timetable', '/recovery', '/notifications', '/settings', '/connect', '/menu']) {
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
  check('rail: count badges become dots', (await aside.locator('[data-badge-dot]').count()) >= 2 && (await aside.locator('a span.rounded-full', { hasText: /\d/ }).count()) === 0);
  check('rail: every control has an accessible name', await aside.locator('a, button').evaluateAll(els => els.every(e => (e.getAttribute('aria-label') || e.textContent || '').trim().length > 0)));
  await aside.locator('a[href="/tasks"]').hover(); await p.waitForTimeout(150);
  const tip = await p.locator('[role=tooltip]').innerText().catch(() => '');
  check('rail: tooltip shows label and shortcut', /Tasks/.test(tip) && /2/.test(tip), tip);
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
