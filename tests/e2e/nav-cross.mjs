// Start Claude modal from every entry point (+ sheet, sidebar, key S), Back/Escape behaviour, redirects, no h-scroll at 390 and 1280. Seed profile: nav.
import { launch, check, B, PW, finish, overflow, okO, call, fillLogin } from './lib.mjs';
const b = await launch();
const path = p => new URL(p.url()).pathname + new URL(p.url()).search;
const errsAll = [];
async function mk(w, h, mobile) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  p.on('pageerror', e => errsAll.push(`${w}: PAGEERR ${e.message}`));
  p.on('console', m => m.type() === 'error' && !/Failed to load resource/i.test(m.text()) && errsAll.push(`${w}: ${m.text().slice(0, 160)}`));
  await p.goto(B + '/login?next=/today'); await fillLogin(p);
  await p.locator('button[type=submit]').click(); await p.waitForURL(u => u.pathname === '/today');
  return p;
}
const modal = p => p.locator('[role=dialog]:has-text("Start Claude")');
const projs = await call('list_projects', {});
const alpha = (Array.isArray(projs) ? projs : projs.projects).find(x => x.name === 'Alpha Client');
const A = alpha.id ?? alpha.projectId;
console.log('alpha id', A);

// ---------- PHONE ----------
{
  const p = await mk(390, 844, true); const bar = p.locator('nav[aria-label=Main]:visible');
  await p.goto(B + '/claude'); await p.waitForTimeout(800);
  const cur = await bar.locator('a[aria-current=page]').evaluateAll(e => e.map(x => (x.getAttribute('aria-label') || x.textContent).trim()));
  check('phone: Claude tab lit on /claude', cur.length === 1 && /Claude/.test(cur[0]), JSON.stringify(cur));
  const badge = (await bar.locator('[data-badge=claude]').count()) ? await bar.locator('[data-badge=claude]').innerText() : '0';
  const head = await p.locator('[data-section=needs-you] h2').innerText();
  const n = Number((head.match(/(\d+)\s*$/) || [])[1] ?? 0);
  check('phone: badge matches Needs you count', badge === String(n) && n > 0, `badge ${badge}, heading "${head}"`);
  for (const u of ['/claude?tab=queue', '/claude?tab=setup']) {
    await p.goto(B + u); await p.waitForTimeout(500);
    const lit = await bar.locator('a[aria-current=page]').evaluateAll(e => e.map(x => (x.getAttribute('aria-label') || x.textContent).trim()));
    check(`phone: Claude tab lit on ${u}`, lit.length === 1 && /Claude/.test(lit[0]), JSON.stringify(lit));
  }
  for (const u of ['/today', '/tasks', `/projects/${A}`, '/claude']) {
    await p.goto(B + u); await p.waitForTimeout(700);
    await p.locator('button[aria-label=Add]').tap();
    await p.waitForTimeout(500);
    await p.locator('[data-quick-add] [data-start-claude]').tap(); await p.waitForTimeout(900);
    check(`phone + sheet Start Claude opens modal from ${u}`, (await modal(p).isVisible()) && path(p).includes('start=1'), path(p));
    await p.goBack(); await p.waitForTimeout(700);
    check(`phone system Back closes modal on ${u}`, (await modal(p).count()) === 0 && !path(p).includes('start='), path(p));
  }
  for (const u of ['/today', '/tasks', '/projects', `/projects/${A}`, '/notes', '/claude', '/claude?tab=queue', '/claude?tab=setup', '/menu', '/claude?start=1', '/settings', '/connect']) {
    await p.goto(B + u); await p.waitForTimeout(900); const o = await overflow(p);
    check(`390 no h-scroll ${u}`, okO(o), JSON.stringify(o));
  }
  await p.close();
}
// ---------- DESKTOP ----------
{
  const p = await mk(1280, 800, false); const aside = p.locator('aside:visible').first();
  for (const u of ['/today', '/tasks', `/projects/${A}`, '/claude']) {
    await p.goto(B + u); await p.waitForTimeout(800);
    await aside.locator('button:has-text("Start Claude")').click(); await p.waitForTimeout(800);
    check(`sidebar Start Claude opens modal on ${u}`, (await modal(p).isVisible()) && path(p).includes('start=1'), path(p));
    await p.goBack(); await p.waitForTimeout(700);
    check(`desktop Back closes modal (sidebar) ${u}`, (await modal(p).count()) === 0 && !path(p).includes('start='), path(p));
    await p.locator('body').click({ position: { x: 1260, y: 400 } }); await p.keyboard.press('s'); await p.waitForTimeout(800);
    check(`key S opens modal on ${u}`, (await modal(p).isVisible()) && path(p).includes('start=1'), path(p));
    await p.goBack(); await p.waitForTimeout(700);
    check(`Back closes modal (key S) ${u}`, (await modal(p).count()) === 0 && !path(p).includes('start='), path(p));
    await p.keyboard.press('S'); await p.waitForTimeout(600); await p.keyboard.press('Escape'); await p.waitForTimeout(600);
    check(`Escape closes modal ${u}`, (await modal(p).count()) === 0 && !path(p).includes('start='), path(p));
  }
  await p.goto(B + '/today'); await p.waitForTimeout(500); await p.keyboard.press('s'); await p.waitForTimeout(800);
  await p.locator(`[data-start-project="${A}"]`).click(); await p.waitForTimeout(1000);
  check('modal step 2 via ?start=<id>', path(p).includes(`start=${A}`) && (await p.locator('[data-start-step=confirm]').count()) === 1, path(p));
  await p.goBack(); await p.waitForTimeout(700);
  check('Back from step 2 shows step 1 or closes (no stuck)', path(p).includes('start=') ? (await p.locator('[data-start-step=project]').count()) === 1 : (await modal(p).count()) === 0, path(p));
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  await p.goto(B + `/projects/${A}?start=${A}`); await p.waitForTimeout(1200);
  check('direct ?start=<id> shows confirm step', (await p.locator('[data-start-step=confirm]').count()) === 1);
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  await p.goto(B + '/menu'); await p.locator('body').click({ position: { x: 1260, y: 400 } }); await p.keyboard.press('5'); await p.waitForTimeout(900);
  check('shortcut 5 -> /claude', path(p).startsWith('/claude'), path(p));
  await p.keyboard.press('Shift+/'); await p.waitForTimeout(500);
  const help = await p.locator('[role=dialog]:has-text("Keyboard shortcuts")').innerText().catch(() => '');
  check('? help lists S Start Claude', /Start Claude/.test(help) && /\bS\b/.test(help), help.replace(/\n/g, ' | ').slice(0, 200));
  await p.keyboard.press('s'); await p.waitForTimeout(500);
  check('S inactive while help dialog open', !path(p).includes('start='), path(p));
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.goto(B + '/today'); await p.waitForTimeout(500); await p.keyboard.press('n'); await p.waitForTimeout(600);
  await p.keyboard.type('buy sausages'); await p.waitForTimeout(300);
  check('typing "s" in quick add does not open Start Claude', !path(p).includes('start='), path(p));
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  for (const [from, re] of [['/more', /^\/menu/], ['/board', /^\/tasks/], ['/modes/code-dev', /^\/tasks\?.*mode=/], ['/modes/growth', /^\/tasks\?.*mode=Growth/], ['/connect?tab=code', /^\/claude\?tab=setup/], ['/connect?tab=devices', /^\/claude\?tab=setup/]]) {
    await p.goto(B + from); await p.waitForTimeout(1800);
    check(`redirect ${from}`, re.test(path(p)), path(p));
  }
  await p.goto(B + '/today'); await p.waitForTimeout(800);
  const g = await p.evaluate(() => { const a = document.querySelector('aside'); const items = [...a.querySelectorAll('a, button')].filter(e => e.offsetParent !== null).map(e => e.getBoundingClientRect()); return { maxItem: Math.max(...items.map(i => i.bottom)), minItem: Math.min(...items.map(i => i.top)), vh: innerHeight, docScroll: document.documentElement.scrollWidth > innerWidth + 1 }; });
  console.log(JSON.stringify(g));
  check('sidebar fits 1280x800', g.maxItem <= g.vh + 0.5 && g.minItem >= -0.5 && !g.docScroll, JSON.stringify(g));
  const hit = async sel => p.evaluate(s => { const e = document.querySelector(s); if (!e) return 'missing'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e.contains(t) ? 'ok' : 'covered by ' + (t?.tagName + '.' + String(t?.className).slice(0, 40)); }, sel);
  check('footer Sign out clickable', (await hit('aside button[title="Sign out"]')) === 'ok', await hit('aside button[title="Sign out"]'));
  for (const u of ['/today', '/tasks', '/claude', '/claude?tab=queue', '/claude?tab=setup', '/projects', '/notes', '/menu']) {
    await p.goto(B + u); await p.waitForTimeout(700); const o = await overflow(p);
    check(`1280 no h-scroll ${u}`, okO(o), JSON.stringify(o));
  }
  // note with a parent: shown once
  const nl = await call('list_notes', { project: 'Alpha Client' }); const arr = Array.isArray(nl) ? nl : (nl.notes ?? []); const par = arr.find(n => n.title === 'Alpha notes');
  const mkn = await call('write_note', { title: 'Child page', body: 'child', parent_id: par?.id });
  console.log('child', JSON.stringify(mkn).slice(0, 200));
  const id = mkn?.created?.id;
  if (id) {
    await p.goto(B + `/notes/${id}`); await p.waitForTimeout(900);
    const cnt = await p.locator('main a[href^="/notes/"]:visible').evaluateAll(es => es.filter(e => /Alpha notes/.test(e.textContent)).length);
    check('note with parent shows parent once (desktop)', cnt === 1, String(cnt));
  } else check('child note created', false, JSON.stringify(mkn).slice(0, 200));
  await p.close();
}
check('no console errors', errsAll.length === 0, errsAll.slice(0, 5).join(' | '));
await b.close();
await finish();
