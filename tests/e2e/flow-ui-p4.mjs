// UI revamp phase 4: sessions. A project's lane row reads "#N <task title>" and, when a State Next line carries that task,
// the line it serves ("Next 2: ..."); Claude > Now's session row shows what the session is doing (its set_doing task, else its last
// reported result) before folder and computer; one line each, no sideways scroll at 390, nothing of another person's private
// task. Seed profile: none.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ME, B, SP, check, finish, launch, login, overflow, okO, rawDb, mcp, mkDevice } from './lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const now = new Date();
const placed = { orgId: ME.orgId, ownerId: ME.userId, visibility: 'org' };
const proj = (id, name) => ({ _id: id, name, nameLower: name.toLowerCase(), client: '', description: '', status: 'active', ...placed, createdAt: now, updatedAt: now });
const line = (id, text, ref) => ({ id, text, ...(ref ? { ref } : {}), by: ME.userId, at: now });
const must = async (n, a) => { const r = await mcp(n, a); if (r?.ERROR || (n === 'add_task' && !r?.created)) throw new Error(`${n} failed: ${JSON.stringify(r).slice(0, 200)}`); return r; };
const LONG = 'A very long task title that goes on and on so that it cannot possibly fit on one line of a phone screen at 390 pixels wide';

try {
  for (const c of ['projects', 'states', 'tasks', 'presence', 'devices']) await rawDb.collection(c).deleteMany({});
  await rawDb.collection('projects').insertMany([proj('p4-main', 'P4 Main')]);
  const a = (await must('add_task', { title: 'Build the roster page', project: 'P4 Main' })).created.ref;
  const b = (await must('add_task', { title: LONG, project: 'P4 Main' })).created.ref;
  const sec = await must('add_task', { title: 'SECRET-TASK-UI4', project: 'P4 Main' });
  const secId = (await rawDb.collection('tasks').findOne({ ref: sec.created.ref }))._id;
  await rawDb.collection('tasks').updateOne({ _id: secId }, { $set: { ownerId: 'someone-else', visibility: 'private' } });
  await rawDb.collection('states').insertOne({ _id: 'p4-main', projectId: 'p4-main', ...placed, now: { text: 'Ship phase four', by: ME.userId, at: now }, next: [line('n0', 'Other step'), line('n1', 'Show the lane purpose', a)], later: [], decisions: [], where: {}, version: 3, createdAt: now, updatedAt: now });

  await must('start_work', { project: 'P4 Main', session: 'p4-a', label: 'builder A' });
  await must('set_doing', { task: a, session: 'p4-a' });
  await must('start_work', { project: 'P4 Main', session: 'p4-b', label: 'builder B' });
  await must('set_doing', { task: b, session: 'p4-b' });
  await must('start_work', { project: 'P4 Main', session: 'p4-c', label: 'builder C' });
  await must('start_work', { project: 'P4 Main', session: 'p4-d', label: 'builder D' });
  await rawDb.collection('presence').updateOne({ session: 'p4-d' }, { $set: { doing: { taskId: secId, at: new Date() } } });

  // Claude > Now: a computer reporting four sessions, joined to the presence rows by Claude Code's session id
  const dev = await mkDevice('P4 Laptop');
  const CC = [1, 2, 3, 4].map(() => 'cc-' + randomUUID());
  const sess = (id, title) => ({ sessionId: id, folder: 'p4main', title, lastActiveAt: new Date(Date.now() - 60_000), subagentsActive: 0, startedByWorkOs: false, running: true });
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { lastSeenAt: new Date(), claudeSessions: { at: new Date(), items: [sess(CC[0], 'Session A'), sess(CC[1], 'Session B'), sess(CC[2], 'Session C'), sess(CC[3], 'Session D')] } } });
  for (const [i, s] of ['p4-a', 'p4-b', 'p4-c', 'p4-d'].entries()) await rawDb.collection('presence').updateOne({ session: s }, { $set: { ccSession: CC[i], activity: { state: 'working', at: new Date() } } });
  await rawDb.collection('presence').updateOne({ session: 'p4-c' }, { $set: { lastResult: { text: 'Wrote the migration and ran it on the copy', at: new Date() } } });

  const br = await launch();
  for (const phone of [true, false]) {
    const tag = phone ? '390' : '1280';
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await login(p, { phone, next: '/today' });
    const shot = async (name, dark, sel) => {
      await p.evaluate(d => document.documentElement.classList.toggle('dark', d), !!dark);
      await p.waitForTimeout(250);
      await p.locator(sel).first().screenshot({ path: `${SP}/ui-p4-${name}-${tag}-${dark ? 'dark' : 'light'}.png` });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    const oneLine = loc => loc.evaluate(e => e.getBoundingClientRect().height < 24 && e.scrollWidth >= 0);

    await p.goto(`${B}/projects/p4-main`);
    await p.waitForSelector('[data-card="workers"]', { timeout: 20000 });
    await p.waitForLoadState('networkidle').catch(() => {});
    const lane = s => p.locator(`[data-project-worker]:has-text("${s}")`).first();
    const laneA = lane('builder A');
    check(`ui-p4 (${tag}): a lane reads "#${a} <task title>"`, (await laneA.locator('[data-lane-task]').innerText()).trim() === `#${a} Build the roster page`, await laneA.locator('[data-lane-task]').innerText());
    check(`ui-p4 (${tag}): the lane shows the Next line it serves`, (await laneA.locator('[data-lane-serves]').innerText()).trim() === 'Next 2: Show the lane purpose', await laneA.innerText());
    check(`ui-p4 (${tag}): a task no Next line carries has no served line`, (await lane('builder B').locator('[data-lane-serves]').count()) === 0);
    check(`ui-p4 (${tag}): a long title stays on one line`, await oneLine(lane('builder B').locator('[data-lane-task]').locator('..')));
    check(`ui-p4 (${tag}): the served line is one line`, await oneLine(laneA.locator('[data-lane-serves]')));
    check(`ui-p4 (${tag}): a lane with no task has no task line`, (await lane('builder C').locator('[data-lane-task]').count()) === 0);
    check(`ui-p4 (${tag}): a private task of another person is not named on its lane`, (await lane('builder D').locator('[data-lane-task]').count()) === 0 && !/SECRET-/.test(await p.locator('body').innerText()));
    let o = await overflow(p);
    check(`ui-p4 (${tag}): project page, no sideways scroll`, okO(o), JSON.stringify(o));
    await shot('lanes', false, '[data-card="workers"]');
    await shot('lanes', true, '[data-card="workers"]');

    await p.goto(`${B}/claude`);
    await p.waitForSelector('[data-section="sessions"]', { timeout: 20000 });
    await p.waitForLoadState('networkidle').catch(() => {});
    const row = i => p.locator(`[data-session-row="${dev.id}:${CC[i]}"]`);
    const doing = i => row(i).locator('[data-session-doing]');
    check(`ui-p4 (${tag}): a session shows its task "#${a} title"`, (await doing(0).innerText()).trim() === `#${a} Build the roster page`, await row(0).innerText());
    check(`ui-p4 (${tag}): a session with no task shows its last reported result`, (await doing(2).innerText()).trim() === 'Wrote the migration and ran it on the copy', await row(2).innerText());
    check(`ui-p4 (${tag}): a long task title is one line`, await oneLine(doing(1)));
    check(`ui-p4 (${tag}): the doing line comes before the computer (the folder is in the sheet)`, await row(0).evaluate(r => { const t = r.innerText; return t.indexOf('#') >= 0 && t.indexOf('#') < t.indexOf('P4 Laptop'); }), await row(0).innerText());
    check(`ui-p4 (${tag}): a private task of another person is not named on its session`, (await doing(3).count()) === 0 && !/SECRET-/.test(await p.locator('body').innerText()));
    o = await overflow(p);
    check(`ui-p4 (${tag}): Claude Now, no sideways scroll`, okO(o), JSON.stringify(o));
    await shot('now', false, '[data-section="sessions"]');
    await shot('now', true, '[data-section="sessions"]');
    await ctx.close();
  }
  for (const col of ['projects', 'states', 'tasks', 'presence', 'devices']) await rawDb.collection(col).deleteMany({});
  await br.close();
} catch (e) {
  check('flow-ui-p4 (error)', false, e?.stack || String(e));
}
await finish();
