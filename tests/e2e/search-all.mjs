// One search over everything (lib/search, components/global-search.tsx): each kind found (tasks by title, description
// and comment; projects and a State line; notes; sessions; Needs; folders and code; settings; pages and Claude's tools),
// words in any order, "#11" a task only, "N1" a Need, filters with counts (greyed at zero, Tab and Shift+Tab, Show all),
// keyboard (Ctrl+K, /, arrows, Enter, Ctrl+Enter, Esc clears then closes), the empty state (recent and pages), a State
// line opened in place, the list search buttons, 720px on desktop and the phone sheet at 390. A teammate never finds
// the owner's private project's items, and another organization finds nothing. Screenshots in light and dark.
// Seed profile: none.
import { B, EMAIL, ME, MCP, PW, SP, check, finish, launch, login, makeUser, mkKey, rawDb } from './lib.mjs';
import { cookieFor } from '../load/clients.mjs';
import { must } from './flow-lib.mjs';

const ZAN = 'Zanzibar Launch';
const VAULT = 'Vault Private';
const browser = await launch();
const input = p => p.locator('input[aria-controls=global-search-results]');
const options = p => p.locator('#global-search-results [role=option]');
/** Type a query and wait for the server's answer (the busy request settles). */
async function search(p, q, { wait = 900 } = {}) {
  await input(p).fill(q);
  await p.waitForTimeout(wait);
  return (await p.locator('#global-search-results').innerText().catch(() => '')).replace(/\n+/g, ' | ');
}
const kindHas = async (p, kind, text) => (await p.locator(`#global-search-results [role=option][data-kind=${kind}]`).allInnerTexts()).some(t => t.includes(text));
const openDesktop = async p => {
  await p.keyboard.press('Control+k');
  await input(p).waitFor();
};

try {
  const code = await mkKey({ agent: 'claude-code', name: 'search code' });
  const Bea = await makeUser({ email: 'bea-search@example.test', name: 'Bea', orgId: ME.orgId });
  const Cy = await makeUser({ email: 'cy-search@example.test', name: 'Cy', orgName: 'Other Search Org' });

  // ---- the owner's shared work ----
  await must(MCP, 'add_project', { name: ZAN, client: 'Acme Quokka', description: 'Marketing site for the festival' });
  for (let i = 1; i <= 10; i++) await must(MCP, 'add_task', { title: `Filler chore ${i}`, project: ZAN });
  const t11 = (await must(MCP, 'add_task', { title: 'Eleventh errand', project: ZAN })).created;
  check('fixture: task #11 exists', t11.ref === 11, JSON.stringify(t11));
  const tp = (await must(MCP, 'add_task', { title: 'Rewrite pricing page copy', project: ZAN, description: 'Mention the xylophone discount' })).created;
  await must(MCP, 'add_comment', { task: tp.ref, note: 'The yodel wording is final' });
  await must(MCP, 'write_note', { project: ZAN, title: 'Launch plan', body: 'Week 11 plans and the kumquat timeline.' });
  await must(code, 'start_work', { project: ZAN, session: 'srch1', label: 'Ocelot builder', machine: 'panda-pc', branch: 'feature/narwhal' });
  const st = await must(code, 'save_state', { project: ZAN, session: 'srch1', base_version: 0, ops: [{ op: 'set_now', text: 'Ship the zanzibar site' }, { op: 'add_next', text: 'Draft the vortex FAQ' }, { op: 'add_later', text: 'Try the plinth idea' }, { op: 'add_decision', text: 'Use the gumbo font' }] });
  check('fixture: State saved', !!st.saved || !!st.version, JSON.stringify(st).slice(0, 200));
  const need = (await must(code, 'ask', { project: ZAN, session: 'srch1', to: 'me', kind: 'approve', ask: 'Approve the tamarind colour for the header?' })).need;
  const zan = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: ZAN });
  await rawDb.collection('projects').updateOne({ _id: zan._id }, { $set: { code: [{ remote: 'acme/marsupial-site' }] } });
  await rawDb.collection('workerFolders').insertOne({ _id: 'wf-search-1', orgId: ME.orgId, ownerId: ME.userId, deviceId: 'dev-search', folderId: 'f1', name: 'wombat-repo', git: true, remote: 'acme/wombat-repo', branch: 'main', projectId: zan._id, linkedAt: new Date(), seenAt: new Date(), missing: false });

  // ---- the owner's private project: nothing of it for Bea ----
  await must(MCP, 'add_project', { name: VAULT, visibility: 'private' });
  await must(MCP, 'add_task', { title: 'Secret zorblat task', project: VAULT, description: 'zorblat plans' });
  await must(MCP, 'write_note', { project: VAULT, title: 'Zorblat memo', body: 'zorblat body' });
  await must(code, 'start_work', { project: VAULT, session: 'srch2', label: 'Zorblat session', machine: 'panda-pc' });
  await must(code, 'save_state', { project: VAULT, session: 'srch2', base_version: 0, ops: [{ op: 'set_now', text: 'Zorblat now line' }, { op: 'add_next', text: 'Zorblat next line' }] });
  await must(code, 'ask', { project: VAULT, session: 'srch2', to: 'me', kind: 'approve', ask: 'Zorblat question for the owner?' });
  const vault = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: VAULT });
  await rawDb.collection('projects').updateOne({ _id: vault._id }, { $set: { code: [{ remote: 'acme/zorblat-repo' }] } });
  // Cy's own organization has a task with the same words: never shown to the owner.
  const kCy = await mkKey({ agent: 'claude', userId: Cy.userId, orgId: Cy.orgId, name: 'cy chat' });
  await must(kCy, 'add_task', { title: 'Cy pricing page copy elsewhere' });

  // ================= desktop 1280, the owner =================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await login(p);
  await p.waitForTimeout(800);

  await openDesktop(p);
  const box = await p.locator('[data-global-search]').boundingBox();
  check('desktop: the dialog is 720px wide', !!box && box.width >= 700 && box.width <= 724, JSON.stringify(box));
  let t = await p.locator('#global-search-results').innerText();
  check('empty: shows the pages', /Pages/i.test(t) && t.includes('Today') && t.includes('New task'), t.slice(0, 200));

  // words in any order, best match on top, matched words bold
  t = await search(p, 'copy pricing');
  const first = await options(p).first().innerText();
  check('word order: "copy pricing" finds "Rewrite pricing page copy" as the best match', first.includes('Rewrite pricing page copy') && /Best match/i.test(t), t);
  check('word order: matched words are bold', (await options(p).first().locator('b').allInnerTexts()).join(' ').toLowerCase().includes('pricing'));
  check('another organization\'s task is never found', !t.includes('elsewhere'), t);
  check('word start only: "ricing" finds nothing', !(await search(p, 'ricing')).includes('Rewrite pricing'));

  // each kind
  const kinds = [
    ['xylophone', 'tasks', 'Rewrite pricing page copy', 'a task by its description'],
    ['yodel', 'tasks', 'Rewrite pricing page copy', 'a task by a comment'],
    ['quokka', 'projects', ZAN, 'a project by its client'],
    ['vortex', 'projects', 'Draft the vortex FAQ', 'a State Next line'],
    ['gumbo', 'projects', 'Use the gumbo font', 'a Decision'],
    ['kumquat', 'notes', 'Launch plan', 'a note by its text'],
    ['ocelot', 'sessions', 'Ocelot builder', 'a session by its label'],
    ['narwhal', 'sessions', 'Ocelot builder', 'a session by its branch'],
    ['tamarind', 'needs', 'tamarind colour', 'a Need by its question'],
    [`N${need.ref}`, 'needs', 'tamarind colour', 'a Need by N<ref>'],
    ['wombat', 'files', 'wombat-repo', 'a linked folder'],
    ['marsupial', 'files', 'acme/marsupial-site', 'a project\'s repository'],
    ['hours quiet', 'settings', 'Quiet hours', 'a setting by name'],
    ['discord', 'settings', 'Discord', 'Discord settings'],
    ['trash', 'pages', 'Trash', 'a Review tab'],
    ['daily_summary', 'pages', 'daily_summary', 'a Claude tool'],
  ];
  for (const [q, kind, want, what] of kinds) {
    const txt = await search(p, q);
    check(`kind ${kind}: ${what} ("${q}")`, await kindHas(p, kind, want), txt.slice(0, 300));
  }

  // "#11" is the task and nothing else; a plain 11 also finds the note's "week 11"
  t = await search(p, '#11');
  const k11 = await options(p).evaluateAll(es => es.map(e => e.getAttribute('data-kind')));
  check('"#11": only task #11', k11.length >= 1 && k11.every(k => k === 'tasks') && (await options(p).first().innerText()).includes('Eleventh errand'), `${k11} ${t}`);
  check('"#11": the note with "week 11" is not found', !t.includes('Launch plan'), t);
  t = await search(p, '11');
  check('plain "11": task #11 first, the note too', (await options(p).first().innerText()).includes('Eleventh errand') && t.includes('Launch plan'), t);

  // filters: counts, greyed at zero, Tab / Shift+Tab, Show all
  t = await search(p, 'filler');
  const tasksBtn = p.locator('[data-filter=tasks]');
  check('filters: Tasks counts 10', /10/.test(await tasksBtn.innerText()), await tasksBtn.innerText());
  check('filters: Settings greyed at zero', await p.locator('[data-filter=settings]').isDisabled());
  const more = p.locator('[data-more=tasks]');
  check('groups of 5: "Show all 10" under Tasks', (await more.count()) === 1 && /Show all 10/.test(await more.innerText()), t);
  await more.click();
  await p.waitForTimeout(800);
  check('Show all: switches to the Tasks filter with all 10', (await p.locator('[data-filter=tasks][aria-pressed=true]').count()) === 1 && (await options(p).count()) === 10, String(await options(p).count()));
  await input(p).press('Shift+Tab');
  check('Shift+Tab: back to All', (await p.locator('[data-filter=all][aria-pressed=true]').count()) === 1);
  await input(p).press('Tab');
  check('Tab: next filter with hits (Tasks)', (await p.locator('[data-filter=tasks][aria-pressed=true]').count()) === 1);
  await input(p).press('Shift+Tab');
  check('focus stays in the input while Tab moves filters', await p.evaluate(() => document.activeElement?.getAttribute('aria-controls') === 'global-search-results'));

  // keyboard: arrows, Esc clears then closes, Enter opens, Ctrl+Enter a new tab
  await search(p, 'zanzibar');
  await input(p).press('ArrowDown');
  check('ArrowDown moves the selection', (await p.locator('[role=option][aria-selected=true]').getAttribute('data-hit')) === '1');
  await input(p).press('Escape');
  await p.waitForTimeout(200);
  check('Esc with text: clears it, stays open', (await input(p).inputValue()) === '' && (await p.locator('[data-global-search]').count()) === 1);
  await input(p).press('Escape');
  await p.waitForTimeout(300);
  check('Esc again: closes', (await p.locator('[data-global-search]').count()) === 0);
  await p.keyboard.press('/');
  await input(p).waitFor();
  check('"/" opens it', true);
  await search(p, 'eleventh');
  const [tab] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), input(p).press('Control+Enter')]);
  await tab.waitForLoadState();
  check('Ctrl+Enter: opens the hit in a new tab', /\/tasks\/11$/.test(tab.url()), tab.url());
  await tab.close();
  await input(p).press('Enter');
  await p.waitForURL(/\/tasks\/11$/);
  check('Enter: opens the hit', true);

  // empty state: the last opened, then pages
  await openDesktop(p);
  t = await p.locator('#global-search-results').innerText();
  check('empty: Recent holds what was opened', /Recent/i.test(t) && t.includes('Eleventh errand'), t.slice(0, 200));

  // a State line opens the project there
  await search(p, 'vortex');
  await p.locator('[role=option][data-kind=projects]', { hasText: 'Draft the vortex FAQ' }).click();
  await p.waitForURL(/#state-next-/);
  await p.waitForTimeout(1200);
  const lit = await p.evaluate(() => [...document.querySelectorAll('[data-next-id]')].some(e => e.style.outline.includes('solid')));
  check('a State line hit opens the project with that line outlined', lit, p.url());
  await p.waitForTimeout(1200);

  // the lists' search buttons open search on their kind
  for (const [path, sel, kind] of [['/tasks', '[data-task-search]', 'tasks'], ['/notes', '[data-notes-search]', 'notes'], ['/settings', '[data-settings-search]', 'settings']]) {
    await p.goto(B + path);
    await p.locator(`${sel}:visible`).first().click();
    await input(p).waitFor();
    check(`${path}: its search opens on ${kind}`, (await p.locator(`[data-filter=${kind}][aria-pressed=true]`).count()) === 1);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
  }
  await p.goto(B + '/tasks?search=1');
  await input(p).waitFor({ timeout: 8000 });
  check('/tasks?search=1 opens search on Tasks', (await p.locator('[data-filter=tasks][aria-pressed=true]').count()) === 1);
  await p.keyboard.press('Escape');

  // screenshots for the eye check
  await p.goto(B + '/today');
  await p.waitForTimeout(600);
  await openDesktop(p);
  await search(p, 'zanzibar');
  for (const theme of ['light', 'dark']) {
    await p.evaluate(d => document.documentElement.classList.toggle('dark', d), theme === 'dark');
    await p.waitForTimeout(200);
    await p.screenshot({ path: `${SP}/search-all-1280-${theme}.png` });
  }
  await p.evaluate(() => document.documentElement.classList.remove('dark'));
  check('desktop: no page errors', errs.length === 0, errs.join('; '));
  await ctx.close();

  // ================= phone 390, the owner =================
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const m = await pctx.newPage();
  const merrs = [];
  m.on('pageerror', e => merrs.push(e.message));
  await login(m, { phone: true });
  await m.waitForTimeout(800);
  await m.locator('button[aria-label=Search]:visible').first().click();
  await input(m).waitFor();
  check('phone: one full sheet', (await m.locator('[data-sheet][data-global-search]').count()) === 1);
  check('phone: input 16px (no zoom)', (await input(m).evaluate(e => getComputedStyle(e).fontSize)) === '16px');
  await m.waitForTimeout(400); // the sheet slides in
  const ib = await input(m).boundingBox();
  check('phone: input pinned at the top', !!ib && ib.y < 70, JSON.stringify(ib));
  await search(m, 'pricing');
  check('phone: finds the task', await kindHas(m, 'tasks', 'Rewrite pricing page copy'));
  const chips = m.locator('[role=group][aria-label=Filter]');
  check('phone: filter chips in one swipeable row', (await chips.evaluate(e => getComputedStyle(e).overflowX)) === 'auto' && (await chips.evaluate(e => e.scrollWidth > e.clientWidth)));
  const hs = await options(m).evaluateAll(es => es.map(e => e.getBoundingClientRect().height));
  check('phone: rows at least 44px', hs.every(h => h >= 43.5), String(hs));
  check('phone: no horizontal overflow', !(await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  await m.locator('[data-filter=tasks]').tap();
  await m.waitForTimeout(700);
  check('phone: a chip picks the filter', (await m.locator('[data-filter=tasks][aria-pressed=true]').count()) === 1 && (await options(m).evaluateAll(es => es.every(e => e.getAttribute('data-kind') === 'tasks'))));
  for (const theme of ['light', 'dark']) {
    await m.evaluate(d => document.documentElement.classList.toggle('dark', d), theme === 'dark');
    await m.waitForTimeout(200);
    await m.screenshot({ path: `${SP}/search-all-390-${theme}.png` });
  }
  await m.evaluate(() => document.documentElement.classList.remove('dark'));
  await options(m).first().tap();
  await m.waitForURL(/\/tasks\/\d+$/);
  check('phone: a tap opens the hit and closes the sheet', (await m.locator('[data-sheet][data-global-search]').count()) === 0);
  await m.goto(B + '/today');
  await m.locator('button[aria-label=Search]:visible').first().click();
  await input(m).waitFor();
  await m.goBack();
  await m.waitForTimeout(400);
  check('phone: Back closes the sheet and stays on the page', (await m.locator('[data-global-search]').count()) === 0 && /\/today$/.test(m.url()), m.url());
  check('phone: no page errors', merrs.length === 0, merrs.join('; '));
  await pctx.close();

  // ================= Bea (same organization): shared yes, the owner's private project no =================
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const b = await bctx.newPage();
  await login(b, { email: 'bea-search@example.test' });
  await b.waitForTimeout(800);
  await openDesktop(b);
  t = await search(b, 'zorblat');
  check('Bea: nothing of the owner\'s private project ("zorblat")', (await options(b).count()) === 0 && /No matches/.test(t), t);
  t = await search(b, 'vault');
  check('Bea: the private project is not found by name', !t.includes(VAULT), t);
  t = await search(b, 'pricing copy');
  check('Bea: finds shared work', t.includes('Rewrite pricing page copy'), t);
  t = await search(b, 'wombat');
  check('Bea: the owner\'s folders are not hers', !t.includes('wombat-repo'), t);
  await bctx.close();

  // ================= an app-only Need's answer: only the addressee (Bea) and the asker's person (the owner) find it =================
  const Dee = await makeUser({ email: 'dee-search@example.test', name: 'Dee', orgId: ME.orgId });
  const secretNeed = (await must(code, 'ask', { project: ZAN, session: 'srch1', to: 'bea-search@example.test', kind: 'do', ask: 'Rotate the staging credentials please', app_only: true })).need;
  await rawDb.collection('needs').updateOne({ orgId: ME.orgId, ref: secretNeed.ref }, { $set: { status: 'answered', answeredAt: new Date(), answer: { option: 'done', text: 'Rotated with the quetzalmarimba vault', by: Bea.userId, via: 'app', at: new Date() } } });
  const apiSearch = async (cookie, q, kind) => { const r = await fetch(`${B}/api/search?q=${encodeURIComponent(q)}${kind ? '&kind=' + kind : ''}`, { headers: { cookie } }); return { status: r.status, text: await r.text() }; };
  for (const [who, email, sees] of [['Bea (addressee)', 'bea-search@example.test', true], ['the owner (asker)', EMAIL, true], ['Dee (same project, neither)', 'dee-search@example.test', false]]) {
    const ck = await cookieFor(email, PW);
    for (const kind of [undefined, 'needs']) {
      const r = await apiSearch(ck, 'quetzalmarimba', kind);
      const needs = JSON.parse(r.text).kinds?.needs ?? { hits: [], count: 0 };
      const found = needs.hits.some(h => h.id === secretNeed.id || h.title.includes('Rotate the staging'));
      const how = kind ? ' (Needs filter)' : '';
      if (sees) check(`app-only answer: ${who} finds it by a word of the answer${how}`, r.status === 200 && found && needs.count >= 1, r.text.slice(0, 300));
      else check(`app-only answer: ${who} gets no hit and count 0${how}`, r.status === 200 && !found && needs.count === 0 && !JSON.stringify(needs).includes('quetzalmarimba') /* the query itself is echoed in "q" */, r.text.slice(0, 300));
    }
  }
  // Dee still finds the Need by its question (the Need is readable; only the answer is not).
  { const r = await apiSearch(await cookieFor('dee-search@example.test', PW), 'rotate staging');
    check('app-only answer: Dee finds the Need by its question, with no answer text', r.status === 200 && (JSON.parse(r.text).kinds?.needs?.hits ?? []).some(h => h.title.includes('Rotate the staging')) && !r.text.includes('quetzal'), r.text.slice(0, 300)); }
  check('fixture: Dee is a member', !!Dee.userId);

  // ================= Cy (another organization): nothing =================
  const cctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const c = await cctx.newPage();
  await login(c, { email: 'cy-search@example.test' });
  await c.waitForTimeout(800);
  await openDesktop(c);
  t = await search(c, 'zanzibar');
  check('Cy: nothing of another organization', (await options(c).count()) === 0, t);
  t = await search(c, '#11');
  check('Cy: "#11" is not the other organization\'s task', !t.includes('Eleventh'), t);
  await cctx.close();
} catch (e) {
  check('suite ran without throwing', false, String(e?.stack ?? e));
}
await browser.close();
await finish();
