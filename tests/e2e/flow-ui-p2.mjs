// UI revamp phase 2: Today's "Projects now" card (Now, first Next, "N sessions", amber dot for a Need, the cap of 5, hidden when
// empty, nothing of a project the caller cannot read) and the timetable's block label ("Deep work · 10:00-12:00", "Schedule").
// Seed profile: today (for its schedule; its projects and tasks are wiped first).
import fs from 'node:fs';
import { ME, B, SP, check, finish, launch, fillLogin, overflow, okO, rawDb } from './lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const T = new Date(new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) + 'T11:00:00+05:30'); // today, 11:00 IST
const now = new Date();
const LONG = 'Ship the new Today page so each project shows its goal first, clamped to two lines however long the goal is written, and check it on the real build at 390 and 1280 in both themes before anything else goes in.';
const proj = (id, name, extra = {}) => ({ _id: id, name, nameLower: name.toLowerCase(), client: '', description: '', status: 'active', orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', createdAt: now, updatedAt: now, ...extra });
const stateOf = (id, nowText, next, extra = {}) => ({ _id: id, projectId: id, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', now: nowText ? { text: nowText, by: ME.userId, at: now } : null, next: next.map((t, i) => ({ id: `n${i}`, text: t, by: ME.userId, at: now })), later: [], decisions: [], where: {}, version: 2, createdAt: now, updatedAt: now, ...extra });
const lane = (n, projectId, extra = {}) => ({ _id: `ui2-lane-${n}`, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', projectId, userId: ME.userId, key: `ui2-s${n}`, session: `ui2-s${n}`, label: `Lane ${n}`, machine: 'm', ai: 'Claude Code', agent: 'claude-code', lastSeen: new Date(), forYouCursor: new Date(), writesSinceSave: 0, activity: { state: 'working', at: new Date() }, ...extra });
const needOf = (id, ref, projectId) => ({ _id: id, ref, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', projectId, taskId: null, taskRef: null, to: ME.userId, from: { actor: { kind: 'agent', name: 'Claude' }, word: 'agent', label: 'ui2' }, kind: 'decide', ask: 'UI2 which way?', options: [{ id: 'a', label: 'A', means: 'first' }], status: 'open', appOnly: false, createdAt: now, answeredAt: null });
const wipe = async () => { for (const c of ['projects', 'states', 'presence', 'needs']) await rawDb.collection(c).deleteMany({}); };
const tap = (loc, phone) => (phone ? loc.tap() : loc.click());

try {
  const br = await launch();
  await rawDb.collection('settings').updateOne({ _id: 'profile:' + ME.userId }, { $set: { checklistHidden: true } }, { upsert: true });
  for (const phone of [true, false]) {
    const tag = phone ? '390' : '1280';
    const kind = phone ? 'phone' : 'desk';
    await wipe();
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.clock.setFixedTime(T);
    await p.goto(B + '/login?next=/today');
    await fillLogin(p);
    await p.locator('button[type=submit]').click();
    await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 });
    const V = p.locator(`[data-variant=${kind}]`);
    const card = V.locator('[data-section=projects-now]');
    const settle = async () => { await p.waitForLoadState('networkidle').catch(() => {}); await p.waitForTimeout(700); };
    const ready = async () => { await p.locator(`[data-variant=${kind}] [data-section="claude-card"]`).waitFor(); await settle(); };
    const shot = async (name, dark) => {
      await p.evaluate(d => document.documentElement.classList.toggle('dark', d), !!dark);
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${SP}/ui-p2-${name}-${tag}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    await ready();

    // Nothing to show: the card is hidden
    check(`ui-p2 (${tag}): no projects, no card`, (await card.count()) === 0);
    await rawDb.collection('projects').insertOne(proj('ui2-quiet', 'Quiet Project'));
    await rawDb.collection('states').insertOne(stateOf('ui2-quiet', 'Quiet goal', []));
    await p.reload(); await ready();
    check(`ui-p2 (${tag}): a project with no lane, Need or task of mine is not listed, so the card stays hidden`, (await card.count()) === 0);

    // Seven candidates: Alpha (2 sessions), Beta (a Need), Gamma (my task), four more with one session each
    const names = { 'ui2-a': 'Alpha', 'ui2-b': 'Beta', 'ui2-c': 'Gamma', 'ui2-d': 'Delta', 'ui2-e': 'Epsilon', 'ui2-f': 'Zeta', 'ui2-g': 'Eta' };
    await rawDb.collection('projects').insertMany(Object.entries(names).map(([id, n]) => proj(id, n)));
    await rawDb.collection('states').insertMany([
      stateOf('ui2-a', LONG, ['Check the clamp', 'Second line']),
      stateOf('ui2-b', 'Beta goal', ['Beta next']),
      stateOf('ui2-c', null, []),
      ...['d', 'e', 'f', 'g'].map(x => stateOf(`ui2-${x}`, `Goal ${x}`, [])),
    ]);
    await rawDb.collection('presence').insertMany([lane(1, 'ui2-a'), lane(2, 'ui2-a'), lane(3, 'ui2-d'), lane(4, 'ui2-e'), lane(5, 'ui2-f'), lane(6, 'ui2-g'), lane(7, 'ui2-g', { activity: { state: 'off', at: new Date() } })]);
    await rawDb.collection('needs').insertOne(needOf('ui2-need-1', 9701, 'ui2-b'));
    // two of the seeded tasks stand in for tasks (a full task document is the server's to make): one of mine in Gamma, one in the secret project
    await rawDb.collection('tasks').updateOne({ title: 'Plain P4 backlog' }, { $set: { projectId: 'ui2-c', assigneeIds: [ME.userId] } });
    // Another person's private project, with a lane, a goal and a task assigned to me: it must not show anywhere
    await rawDb.collection('projects').insertOne(proj('ui2-secret', 'Secret Other', { ownerId: 'someone-else', visibility: 'private' }));
    await rawDb.collection('states').insertOne(stateOf('ui2-secret', 'SECRET-GOAL-UI2', ['SECRET-NEXT-UI2'], { ownerId: 'someone-else', visibility: 'private' }));
    await rawDb.collection('presence').insertOne(lane(8, 'ui2-secret', { ownerId: 'someone-else', visibility: 'private', userId: 'someone-else' }));
    await rawDb.collection('tasks').updateOne({ title: 'Plain P1 up next' }, { $set: { projectId: 'ui2-secret', assigneeIds: [ME.userId], ownerId: 'someone-else', visibility: 'private' } });
    await p.reload(); await ready(); await card.waitFor({ timeout: 20000 });

    const rows = card.locator('[data-project-row]');
    const ids = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-project-row')));
    check(`ui-p2 (${tag}): at most 5 projects, a Need first, then most sessions`, ids.length === 5 && ids[0] === 'ui2-b' && ids[1] === 'ui2-a', ids.join(','));
    const body = await card.innerText();
    check(`ui-p2 (${tag}): every project here has a lane, a Need or a task of mine`, ids.every(i => i in names));
    check(`ui-p2 (${tag}): the card sits after Needs you and before the task sections`, await p.evaluate(k => {
      const v = document.querySelector(`[data-variant=${k}]`);
      const all = [...v.querySelectorAll('[data-section]')].map(e => e.getAttribute('data-section'));
      const i = all.indexOf('projects-now');
      return i >= 0 && (all.indexOf('needs-you') === -1 || all.indexOf('needs-you') < i) && (all.indexOf('overdue') === -1 || all.indexOf('overdue') > i);
    }, kind));
    const alpha = card.locator('[data-project-row=ui2-a]');
    check(`ui-p2 (${tag}): Alpha shows its Now, the first Next and "2 sessions"`, (await alpha.locator('[data-project-row-now]').innerText()).startsWith('Ship the new Today page') && (await alpha.locator('[data-project-row-next]').innerText()) === 'Next: Check the clamp' && (await alpha.locator('[data-project-sessions]').innerText()).includes('2 sessions'));
    const cl = await alpha.locator('[data-project-row-now]').evaluate(el => ({ clamp: getComputedStyle(el).webkitLineClamp, h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }));
    check(`ui-p2 (${tag}): a long Now is clamped to two lines`, cl.clamp === '2' && cl.h <= cl.lh * 2 + 1, JSON.stringify(cl));
    check(`ui-p2 (${tag}): only Beta has the amber dot`, (await card.locator('[data-project-need]').count()) === 1 && (await card.locator('[data-project-row=ui2-b] [data-project-need]').count()) === 1);
    check(`ui-p2 (${tag}): the ended session is not counted`, !ids.includes('ui2-g') || (await card.locator('[data-project-row=ui2-g] [data-project-sessions]').innerText()).includes('1 session'));
    check(`ui-p2 (${tag}): no other person's private project shows`, !/SECRET-|Secret Other/.test(await V.innerText()) && !ids.includes('ui2-secret'), body.slice(0, 200));
    check(`ui-p2 (${tag}): a row opens its project`, (await alpha.getAttribute('href')) === '/projects/ui2-a');
    const o = await overflow(p);
    check(`ui-p2 (${tag}): no sideways scroll`, okO(o), JSON.stringify(o));

    // The timetable: the block's own name and time, and "Schedule"
    await p.waitForTimeout(600);
    await tap(V.locator('button[aria-label="More"]'), phone);
    const flexItem = p.locator('[data-more-menu] button', { hasText: 'switch to work day' });
    await p.locator('[data-more-menu]').waitFor();
    if (await flexItem.count()) await tap(flexItem.first(), phone);
    else await (phone ? p.locator('[data-sheet] button[aria-label=Close]').first().tap() : p.keyboard.press('Escape'));
    await p.waitForTimeout(500);
    const nowBlock = V.locator('[data-section=now]');
    await nowBlock.waitFor({ timeout: 10000 });
    const label = (await nowBlock.locator('> button').first().innerText()).replace(/\s+/g, ' ');
    check(`ui-p2 (${tag}): the live block reads its own name and time, with no "NOW" word`, /\d\d:\d\d.\d\d:\d\d/.test(label) && !/\bNOW\b/.test(label) && /\w/.test(label.split('·')[0]), label);
    if (!phone) check('ui-p2 (1280): the side card is called Schedule', (await V.locator('[data-section=now-next] h2').textContent()).trim() === 'Schedule' && !/Now & next/i.test(await V.textContent()));
    else check('ui-p2 (390): no "Now & next" or "NOW" label is left', !/Now & next/i.test(await V.textContent()) && !/\bNOW\b/.test(await V.textContent()));
    await shot('today', false);
    await shot('today', true);
    await ctx.close();
  }
  await wipe();
  await br.close();
} catch (e) {
  check('flow-ui-p2 (error)', false, e?.stack || String(e));
}
await finish();
