// What's new and the Needs page (docs/HANDOVER.md "What's new", "Needs page"). run.sh pins "today" to 2026-11-20
// (mode whatsnew): the four entries of 2026-11-15, the hook sign-in and digest of 2026-11-18 and Activity of
// 2026-11-19 are all new (Mail and the report intake are not set up here):
//   - Today's "New in Work OS" card (phone and desktop): three entries and "6 more"; Try it marks one seen; Dismiss all;
//   - the Menu row and the sidebar entry carry a dot while something is unseen; opening /whats-new clears it;
//   - /whats-new lists every entry newest first, one line and where to find it, "New" while new;
//   - the Needs row (Menu, sidebar) has a "New" badge and the open count; /needs lists the open Need, answers it with a
//     tap, then shows it under Answered recently and the empty state;
//   - empty states on Needs, the project State card, the project Inbox and Needs tabs;
//   - 390 and 1280, light and dark: no horizontal scroll; screenshots in E2E_SHOTS.
// whats-new-late.mjs checks the badges and the card are gone 14 days on. Seed profile: none.
import fs from 'node:fs';
import { B, ME, MCP, SP, check, finish, launch, login, makeUser, mkKey, overflow, okO, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const settle = (p, ms = 700) => p.waitForTimeout(ms);
const seenOf = async () => (await rawDb.collection('settings').findOne({ _id: `profile:${ME.userId}` }))?.whatsNewSeen ?? [];
const resetSeen = () => rawDb.collection('settings').updateOne({ _id: `profile:${ME.userId}` }, { $unset: { whatsNewSeen: '' } });
const shot = (p, name) => p.screenshot({ path: `${SP}/whats-new-${name}.png`, fullPage: true });
const ALL = ['end-work-handover', 'needs-typed-answer', 'activity-everything', 'digest-redesign', 'hook-device-key', 'needs', 'results', 'state', 'messages']; // newest first; the entries that need mail or the intake are not shown here

const b = await launch();
try {
  const bea = await makeUser({ email: 'bea-wn@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const kBea = await mkKey({ agent: 'claude-code', userId: bea.userId, orgId: ME.orgId, name: 'bea code' });
  await must(MCP, 'add_project', { name: 'WN Proj' });
  await must(MCP, 'add_project', { name: 'Quiet Proj' });
  const quiet = (await rawDb.collection('projects').findOne({ name: 'Quiet Proj' }))._id;
  // Four Needs for the owner: Tasks shows three of them and See all.
  const asks = [];
  for (const ask of ['Ship the release on Friday or Monday?', 'Approve the new logo?', 'Which host for staging?', 'Keep the old API one more month?']) asks.push((await must(kBea, 'ask', { project: 'WN Proj', to: 'E2E Owner', kind: 'decide', ask, options: [{ label: 'Yes' }, { label: 'No' }] })).need);
  const need = asks[0];
  check('setup: four Needs addressed to the owner', asks.every(n => n?.id), JSON.stringify(asks).slice(0, 200));
  const others = asks.slice(1).map(n => n.id);
  const setStatus = (ids, open) => rawDb.collection('needs').updateMany({ _id: { $in: ids } }, open ? { $set: { status: 'open', answeredAt: null, closedAt: null }, $unset: { answer: '' } } : { $set: { status: 'withdrawn', closedAt: new Date() } });

  // ======== PHONE ========
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
    const p = await ctx.newPage(); p.setDefaultTimeout(10000); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await resetSeen();
    await login(p, { phone: true }); await settle(p);
    const tag = `390-${scheme}`;

    if (scheme === 'light') {
      // Today's card
      const card = p.locator('[data-section="whats-new"]:visible');
      check('phone Today: the New in Work OS card shows', (await card.count()) === 1);
      const ids = await card.locator('[data-whats-new]').evaluateAll(els => els.map(e => e.getAttribute('data-whats-new')));
      check('phone Today card: three entries, newest first in list order', JSON.stringify(ids) === JSON.stringify(ALL.slice(0, 3)), JSON.stringify(ids));
      check(`phone Today card: "and ${ALL.length - 3} more" links to /whats-new`, new RegExp(`and ${ALL.length - 3} more`).test(await card.locator('[data-whats-new-more]').innerText()) && (await card.locator('[data-whats-new-more]').getAttribute('href')) === '/whats-new');
      const tryBox = await card.locator('[data-whats-new-try]').first().boundingBox();
      const disBox = await card.locator('[data-whats-new-dismiss]').boundingBox();
      check('phone Today card: Try it and Dismiss at 44px', tryBox.height >= 43.5 && disBox.height >= 43.5, JSON.stringify([tryBox, disBox]));
      check('phone header: the Menu button carries a dot (something new)', (await p.locator('header:visible [data-menu-dot]').count()) === 1);
      check('phone header: the Menu button says why', /something new/.test((await p.locator('header:visible a[href="/menu"]').getAttribute('aria-label')) ?? ''));
      await card.scrollIntoViewIfNeeded();
      await shot(p, `today-${tag}`);
      const o = await overflow(p); check(`no horizontal scroll /today ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));

      // Try it marks that one seen and goes there
      await card.locator('[data-whats-new-try="activity-everything"]').tap();
      await p.waitForURL(u => u.pathname === '/review', { timeout: 10000 });
      check('Try it: opens where the feature lives (/review)', new URL(p.url()).pathname === '/review');
      check('Try it: marks only that entry seen', JSON.stringify(await seenOf()) === JSON.stringify(['activity-everything']), JSON.stringify(await seenOf()));
      await p.goto(B + '/today'); await settle(p);
      const ids2 = await p.locator('[data-section="whats-new"]:visible [data-whats-new]').evaluateAll(els => els.map(e => e.getAttribute('data-whats-new')));
      check('phone Today card: the tried entry is gone, the rest stay', JSON.stringify(ids2) === JSON.stringify(ALL.filter(x => x !== 'activity-everything').slice(0, 3)), JSON.stringify(ids2));
      await resetSeen();
    }

    // The bar: Needs in place of Claude, with the open count
    const bar = p.locator('nav[aria-label=Main]:visible');
    const labels = await bar.locator('a, button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent.trim()).replace(/\d+$/, '').trim()));
    check(`bar ${tag}: Today, Projects, Add, Needs, Tasks`, JSON.stringify(labels) === JSON.stringify(['Today', 'Projects', 'Add', 'Needs', 'Tasks']), JSON.stringify(labels));
    check(`bar ${tag}: Needs counts the open Needs (4)`, (await bar.locator('[data-badge=needs]').innerText()).trim() === '4');

    // Menu: Claude row (Claude left the bar), What's new row (dot)
    await p.goto(B + '/menu'); await settle(p);
    check(`menu ${tag}: a Claude row`, (await p.locator('main a[href="/claude"]').count()) === 1);
    check(`menu ${tag}: What's new row has the dot`, (await p.locator('main a[href="/whats-new"] [data-new-dot]').count()) === 1);
    const rows = await p.locator('main section a').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    check(`menu ${tag}: every row is 56px like its neighbours`, rows.every(h => h === 56), JSON.stringify(rows));
    await shot(p, `menu-${tag}`);
    let o = await overflow(p); check(`no horizontal scroll /menu ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));

    // Tasks: Needs you on top, three of four, See all
    await p.goto(B + '/tasks'); await settle(p);
    const ny = p.locator('[data-section="needs-you"]:visible');
    check(`tasks ${tag}: Needs you on top with 3 of 4 and See all`, (await ny.count()) === 1 && (await ny.locator('[data-need]').count()) === 3 && /4\s*$/.test(await ny.locator('h2').innerText()) && (await ny.locator('[data-needs-see-all]').getAttribute('href')) === '/needs');
    await shot(p, `tasks-${tag}`);
    o = await overflow(p); check(`no horizontal scroll /tasks ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));

    // Needs page (the tab)
    await bar.locator('a[href="/needs"]').tap(); await p.waitForURL(u => u.pathname === '/needs'); await settle(p);
    check(`needs ${tag}: the Needs tab is lit`, (await bar.locator('a[href="/needs"][aria-current=page]').count()) === 1);
    check(`needs ${tag}: all four open Needs listed`, (await p.locator('[data-view="my-needs"] [data-need]').count()) === 4);
    const openCard = p.locator(`[data-view="my-needs"] [data-need="${need.ref}"]`);
    check(`needs ${tag}: the open Need is listed with its options`, (await openCard.count()) === 1 && (await openCard.locator('[data-need-option]').count()) >= 2);
    await shot(p, `needs-open-${tag}`);
    o = await overflow(p); check(`no horizontal scroll /needs ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));
    if (scheme === 'light') {
      await openCard.locator('[data-need-option]').first().tap();
      await p.waitForSelector('[data-needs-answered]', { timeout: 10000 }); await settle(p);
      check('needs: answering moves the Need under Answered recently', (await p.locator(`[data-needs-answered] [data-need="${need.ref}"]`).count()) === 1);
      check('needs: the Need is answered in the database', (await rawDb.collection('needs').findOne({ _id: need.id }))?.status === 'answered');
      await setStatus(others, false);
      await p.reload(); await settle(p);
      const empty = p.locator('[data-view="my-needs"] [data-needs-empty]');
      check('needs: empty state says what will appear and how', (await empty.count()) === 1 && /Nothing waits on you/.test(await empty.innerText()) && /Claude session or a teammate/.test(await empty.innerText()) && /Today/.test(await empty.innerText()), await empty.innerText().catch(() => ''));
      check('needs: no count on the tab once nothing waits', (await bar.locator('[data-badge=needs]').count()) === 0);
      await p.goto(B + '/tasks'); await settle(p);
      check('tasks: no Needs you section when nothing waits', (await p.locator('[data-section="needs-you"]').count()) === 0);
      await p.goto(B + '/needs'); await settle(p);
    }
    await shot(p, `needs-answered-${tag}`);

    // What's new page: lists every entry, newest first, with where; opening it clears the dot
    await p.goto(B + '/whats-new'); await settle(p);
    const listed = await p.locator('[data-whats-new-entry]').evaluateAll(els => els.map(e => e.getAttribute('data-whats-new-entry')));
    check(`whats-new ${tag}: every entry listed`, JSON.stringify(listed) === JSON.stringify(ALL), JSON.stringify(listed));
    check(`whats-new ${tag}: each says where to find it`, (await p.locator('[data-whats-new-where]').count()) === ALL.length && /Settings|Menu|project|Claude/i.test(await p.locator('[data-whats-new-where]').first().innerText()));
    check(`whats-new ${tag}: "New" on each while new`, (await p.locator('[data-whats-new-entry] [data-new-badge]').count()) === ALL.length);
    await shot(p, `page-${tag}`);
    o = await overflow(p); check(`no horizontal scroll /whats-new ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));
    await p.waitForTimeout(2500);
    check(`whats-new ${tag}: opening it marks everything seen`, JSON.stringify((await seenOf()).sort()) === JSON.stringify([...ALL].sort()), JSON.stringify(await seenOf()));
    await p.goto(B + '/menu'); await settle(p);
    check(`menu ${tag}: the dot is gone once seen`, (await p.locator('main a[href="/whats-new"] [data-new-dot]').count()) === 0);
    await p.goto(B + '/today'); await settle(p);
    check(`today ${tag}: no card once seen`, (await p.locator('[data-section="whats-new"]:visible').count()) === 0);
    check(`today ${tag}: no Menu dot (Need answered, nothing unseen)`, (await p.locator('header:visible [data-menu-dot]').count()) === 0);

    // Empty states on a project with nothing in it
    await p.goto(`${B}/projects/${quiet}`); await settle(p);
    const st = p.locator('[data-card="state"] [data-state-empty]');
    check(`project ${tag}: State empty state says how it fills`, (await st.count()) === 1 && /No State yet/.test(await st.innerText()) && /Claude sessions save/.test(await st.innerText()));
    await shot(p, `state-empty-${tag}`);
    await p.goto(`${B}/projects/${quiet}?tab=inbox`); await settle(p);
    const ib = p.locator('[data-inbox-empty]');
    check(`project ${tag}: Inbox empty state says who sends and that you can send`, (await ib.count()) === 1 && /No messages yet/.test(await ib.innerText()) && /send one above/.test(await ib.innerText()));
    await shot(p, `inbox-empty-${tag}`);
    o = await overflow(p); check(`no horizontal scroll project inbox ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));
    await p.goto(`${B}/projects/${quiet}?tab=needs`); await settle(p);
    const nt = p.locator('[data-view="needs"] [data-needs-empty]');
    check(`project ${tag}: Needs tab empty state says what appears`, (await nt.count()) === 1 && /hands in work for review/.test(await nt.innerText()));

    if (scheme === 'light') {
      // Dismiss hides every entry for good
      await resetSeen();
      await p.goto(B + '/today'); await settle(p);
      await p.locator('[data-section="whats-new"]:visible [data-whats-new-dismiss]').tap(); await settle(p, 1200);
      check('Dismiss: the card goes', (await p.locator('[data-section="whats-new"]:visible').count()) === 0);
      check('Dismiss: every entry is stored as seen', JSON.stringify((await seenOf()).sort()) === JSON.stringify([...ALL, 'mail-connect', 'mailloom-reports'].sort()), JSON.stringify(await seenOf()));
      await p.reload(); await settle(p);
      check('Dismiss: still gone after a reload', (await p.locator('[data-section="whats-new"]:visible').count()) === 0);
      // The four Needs open again for the dark pass
      await setStatus(asks.map(n => n.id), true);
    }
    check(`no page errors ${tag}`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ======== DESKTOP ========
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
    const p = await ctx.newPage(); p.setDefaultTimeout(10000); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await resetSeen();
    await login(p); await settle(p);
    const tag = `1280-${scheme}`;
    const aside = p.locator('aside');
    const needsItem = aside.locator('a[href="/needs"]');
    check(`sidebar ${tag}: Needs with a "New" badge and its count`, (await needsItem.locator('[data-new-badge]').count()) === 1 && /4$/.test((await needsItem.innerText()).trim()), await needsItem.innerText());
    check(`sidebar ${tag}: What's new has the dot`, (await aside.locator('a[href="/whats-new"] [data-new-dot]').count()) === 1);
    const heights = await aside.locator('nav a').evaluateAll(els => [...new Set(els.slice(0, 10).map(e => Math.round(e.getBoundingClientRect().height)))]);
    check(`sidebar ${tag}: Needs and What's new rows are the height of their neighbours`, heights.length === 1, JSON.stringify(heights));
    const card = p.locator('[data-section="whats-new"]:visible');
    check(`desktop Today ${tag}: the card shows beside Now & next`, (await card.count()) === 1 && (await card.locator('[data-whats-new]').count()) === 3);
    await shot(p, `today-${tag}`);
    let o = await overflow(p); check(`no horizontal scroll /today ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));

    await p.goto(B + '/tasks'); await settle(p);
    const ny = p.locator('[data-section="needs-you"]:visible');
    check(`desktop tasks ${tag}: Needs you on top with 3 of 4 and See all`, (await ny.count()) === 1 && (await ny.locator('[data-need]').count()) === 3 && (await ny.locator('[data-needs-see-all]').count()) === 1);
    await shot(p, `tasks-${tag}`);
    o = await overflow(p); check(`no horizontal scroll /tasks ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));
    await needsItem.click(); await p.waitForURL(u => u.pathname === '/needs'); await settle(p);
    check(`desktop needs ${tag}: lit in the sidebar`, (await aside.locator('a[href="/needs"][aria-current=page]').count()) === 1);
    check(`desktop needs ${tag}: four open Needs`, (await p.locator('[data-view="my-needs"] [data-need]').count()) === 4);
    check(`desktop needs ${tag}: the open Need with its options`, (await p.locator(`[data-view="my-needs"] [data-need="${need.ref}"] [data-need-option]`).count()) >= 2);
    await shot(p, `needs-${tag}`);
    o = await overflow(p); check(`no horizontal scroll /needs ${tag}`, okO(o), JSON.stringify(o).slice(0, 200));

    await aside.locator('a[href="/whats-new"]').click(); await p.waitForURL(u => u.pathname === '/whats-new'); await settle(p);
    check(`desktop whats-new ${tag}: every entry listed`, (await p.locator('[data-whats-new-entry]').count()) === ALL.length);
    await shot(p, `page-${tag}`);
    await p.waitForTimeout(2500);
    await p.goto(B + '/notes'); await settle(p);
    check(`sidebar ${tag}: the dot is gone once seen`, (await aside.locator('a[href="/whats-new"] [data-new-dot]').count()) === 0);

    await p.goto(`${B}/projects/${quiet}?tab=inbox`); await settle(p);
    check(`desktop project ${tag}: Inbox empty state`, /No messages yet/.test(await p.locator('[data-inbox-empty]').innerText()));
    await shot(p, `inbox-empty-${tag}`);
    await p.goto(`${B}/projects/${quiet}`); await settle(p);
    check(`desktop project ${tag}: State empty state`, (await p.locator('[data-state-empty]:visible').count()) === 1);
    await shot(p, `state-empty-${tag}`);
    check(`no page errors ${tag}`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} catch (e) {
  check('whats-new suite ran to the end', false, e.stack ?? String(e));
} finally {
  await b.close();
}
await finish();
