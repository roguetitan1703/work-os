// Navigation: phone bar, header, menu, + sheet, Back rules; desktop sidebar, shortcuts, Back. Seed profile: nav.
import { launch, check, B, PW, finish, overflow, okO } from './lib.mjs';
const b = await launch();
async function login(p) {
  await p.goto(B + '/login?next=/today'); await p.fill('input[name=password]', PW);
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
  const want = ['/review', '/timetable', '/settings', '/settings?section=help']; // Review hub replaced the five history links; Connect and Recovery live in Settings
  for (const w of want) check(`menu links ${w}`, hrefs.includes(w));
  const mc = hrefs.filter(h => h?.startsWith('/tasks?mode='));
  check('menu has 8 mode chips', mc.length === 8, String(mc.length));
  check('menu Settings status dot', (await p.locator('main a[href="/settings"] [role=img]').count()) === 1);
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
  const geo = async () => aside.evaluate(a => { const r = a.getBoundingClientRect(); const nav = a.querySelector('nav'); return { bottom: r.bottom, h: r.height, navScroll: nav.scrollHeight > nav.clientHeight + 1 }; });
  let g = await geo();
  check('sidebar ends above the 40px time bar (<=760)', g.bottom <= 760.5, JSON.stringify(g));
  check('sidebar collapsed: nav does not need scrolling', !g.navScroll, JSON.stringify(g));
  const hit = async sel => p.evaluate(s => { const e = document.querySelector(s); if (!e) return 'none'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e.contains(t) || t?.contains(e) ? 'ok' : 'covered ' + t?.tagName; }, sel);
  check('footer: Settings clickable', (await hit('aside a[href="/settings"]')) === 'ok', await hit('aside a[href="/settings"]'));
  check('footer: Sign out clickable', (await hit('aside button[title="Sign out"]')) === 'ok');
  check('footer: theme clickable', (await hit('aside button:has(.sr-only)')) === 'ok');
  const order = await aside.locator('a, button').evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim().replace(/\s*[N1-5\/]$/, '').replace(/\d+$/, '').trim()).filter(Boolean));
  console.log('sidebar order:', JSON.stringify(order));
  check('sidebar order', JSON.stringify(order.slice(0, 13)) === JSON.stringify(['New task', 'Start Claude', 'Search', 'Today', 'Tasks', 'Projects', 'Notes', 'Claude', 'Inbox', 'Review', 'Schedule', 'Modes', 'Settings']), JSON.stringify(order));
  check('collapsed Modes shows no mode links', (await aside.locator('a[href^="/tasks?mode="]').count()) === 0);
  const dbadge = t => aside.locator(`a:has-text("${t}") span.rounded-full`).first().innerText({ timeout: 1000 }).catch(() => '0');
  check('Today badge 2, Claude badge 2', (await dbadge('Today')) === '2' && (await dbadge('Claude')) === '2', `${await dbadge('Today')} ${await dbadge('Claude')}`);
  check('Settings status dot present', (await aside.locator('a[href="/settings"] [role=img]').count()) === 1);
  await aside.locator('button:has-text("Modes")').click();
  check('Modes expands to 8', (await aside.locator('a[href^="/tasks?mode="]').count()) === 8);
  g = await geo();
  check('expanded: sidebar still above time bar, footer clickable', g.bottom <= 760.5 && (await hit('aside button[title="Sign out"]')) === 'ok', JSON.stringify(g));
  await aside.locator('a[href^="/tasks?mode="]').first().click(); await p.waitForURL(/mode=/); await settle(p);
  check('mode link -> /tasks?mode=', path(p).startsWith('/tasks?mode='), path(p));
  check('Tasks lit in sidebar for mode filter', (await aside.locator('a[aria-current=page]').first().innerText()).startsWith('Tasks'));
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
  check('no page errors (desktop)', errs.length === 0, errs.join(' | ').slice(0, 200));
  await ctx.close();
}
await b.close();
await finish();
