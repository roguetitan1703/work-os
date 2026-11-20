// UI revamp phase 5: chips. A task row says where the task sits in its project's State: "Now" (Now names its #ref), "Next n"
// (a Next line carries it, by ref or by #ref in its text) or "Later"; no chip when none. #9012 is not matched by #90123.
// Rows stay on their own lines at 390 (no sideways scroll); a project the viewer cannot read gives no chip and no text.
// Seed profile: none.
import fs from 'node:fs';
import { ME, B, SP, check, finish, launch, login, overflow, okO, rawDb, mcp } from './lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const now = new Date();
const placed = { orgId: ME.orgId, ownerId: ME.userId, visibility: 'org' };
const proj = (id, name, extra = {}) => ({ _id: id, name, nameLower: name.toLowerCase(), client: '', description: '', status: 'active', ...placed, ...extra, createdAt: now, updatedAt: now });
const line = (id, text, ref) => ({ id, text, ...(ref ? { ref } : {}), by: ME.userId, at: now });
const must = async (n, a) => { const r = await mcp(n, a); if (r?.ERROR || (n === 'add_task' && !r?.created)) throw new Error(`${n} failed: ${JSON.stringify(r).slice(0, 200)}`); return r; };
const COLS = ['projects', 'states', 'tasks'];
const LONG = 'A very long task title that goes on and on so that it cannot possibly fit on one line of a phone screen at 390 pixels wide';
const setRef = async (r, to) => { await rawDb.collection('tasks').updateOne({ ref: r }, { $set: { ref: to } }); return to; };

try {
  for (const c of COLS) await rawDb.collection(c).deleteMany({});
  await rawDb.collection('projects').insertMany([proj('p5-main', 'P5 Main'), proj('p5-secret', 'P5 Secret', { ownerId: 'someone-else', visibility: 'private' })]);
  const mk = async (title, project = 'P5 Main') => (await must('add_task', { title, project })).created.ref;
  const rNow = await setRef(await mk(LONG), 9011);
  const rNext = await setRef(await mk('Task by Next text'), 9012);
  const rBig = await setRef(await mk('Task whose number starts the same'), 90123);
  const rByRef = await setRef(await mk('Task by Next ref'), 9013);
  const rLater = await setRef(await mk('Task in Later'), 9014);
  const rNone = await setRef(await mk('Task in nothing'), 9015);
  const rHid = await setRef(await mk('Task in a project I cannot read'), 9016);
  await rawDb.collection('tasks').updateOne({ ref: rHid }, { $set: { projectId: 'p5-secret' } });
  await rawDb.collection('states').insertMany([
    { _id: 'p5-main', projectId: 'p5-main', ...placed, now: { text: `Ship #${rNow} first`, by: ME.userId, at: now }, next: [line('n0', 'Other step'), line('n1', `Then #${rNext} soon`), line('n2', 'Third by ref', rByRef)], later: [line('l0', `Maybe #${rLater} one day`)], decisions: [], where: {}, version: 1, createdAt: now, updatedAt: now },
    { _id: 'p5-secret', projectId: 'p5-secret', ...placed, ownerId: 'someone-else', visibility: 'private', now: { text: `SECRET-STATE-UI5 #${rHid}`, by: 'someone-else', at: now }, next: [], later: [], decisions: [], where: {}, version: 1, createdAt: now, updatedAt: now },
  ]);
  // #90123 only appears as a prefix of nothing here; #9012 must not match it, and the line "#90123" below must not give #9012 a second chip.
  await rawDb.collection('states').updateOne({ _id: 'p5-main' }, { $push: { later: line('l1', `Also #${rBig} later`) } });

  const expected = { [rNow]: 'Now', [rNext]: 'Next 2', [rByRef]: 'Next 3', [rLater]: 'Later', [rBig]: 'Later', [rNone]: null, [rHid]: null };
  const br = await launch();
  for (const phone of [true, false]) {
    const tag = phone ? '390' : '1280';
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await login(p, { phone, next: '/tasks' });
    const rowOf = ref => p.locator(phone ? `a[href="/tasks/${ref}"]:visible` : `div:is(.group, [draggable=true]):has(a[href="/tasks/${ref}"]):visible`).first();
    const chipOf = async ref => { const c = rowOf(ref).locator('[data-place-chip]'); return (await c.count()) ? (await c.first().innerText()).trim() : null; };
    const checkRows = async where => {
      for (const [ref, want] of Object.entries(expected)) check(`ui-p5 (${tag}, ${where}): #${ref} chip is ${want ?? 'none'}`, (await chipOf(ref)) === want, String(await chipOf(ref)));
      check(`ui-p5 (${tag}, ${where}): #${rNext} (9012) is not matched by #${rBig} (90123)`, (await rowOf(rNext).locator('[data-place-chip]').count()) === 1);
      check(`ui-p5 (${tag}, ${where}): nothing of a project I cannot read`, !/SECRET-STATE/.test(await p.locator('body').innerText()));
      const o = await overflow(p);
      check(`ui-p5 (${tag}, ${where}): no sideways scroll`, okO(o), JSON.stringify(o));
    };
    const shot = async (name, dark) => {
      await p.evaluate(d => document.documentElement.classList.toggle('dark', d), !!dark);
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${SP}/ui-p5-${name}-${tag}-${dark ? 'dark' : 'light'}.png` });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
    };
    const settle = async sel => { await p.waitForSelector(sel, { timeout: 20000 }); await p.waitForLoadState('networkidle').catch(() => {}); };

    await settle(`a[href="/tasks/${rNow}"]:visible`);
    await checkRows('Tasks');
    await shot('tasks', false); await shot('tasks', true);

    await p.goto(`${B}/projects/p5-main?tab=tasks`);
    await settle(`a[href="/tasks/${rNow}"]:visible`);
    await checkRows('project Tasks tab');
    await shot('project', false); await shot('project', true);

    await rawDb.collection('tasks').updateMany({ ref: { $in: [rNow, rNext, rLater] } }, { $set: { due: new Date().toISOString().slice(0, 10), assigneeIds: [ME.userId] } });
    await p.goto(`${B}/today`);
    await settle('main');
    const some = ['Now', 'Next 2', 'Later'].filter(l => true);
    for (const l of some) check(`ui-p5 (${tag}): Today has a "${l}" chip`, (await p.locator('[data-place-chip]', { hasText: new RegExp(`^${l}$`) }).count()) > 0);
    const o = await overflow(p);
    check(`ui-p5 (${tag}): Today, no sideways scroll`, okO(o), JSON.stringify(o));
    await shot('today', false); await shot('today', true);

    await p.goto(`${B}/projects/p5-main`);
    await settle('[data-card="tasks"]');
    check(`ui-p5 (${tag}): Overview task list shows chips`, (await p.locator('[data-card="tasks"] [data-place-chip]').count()) > 0);
    await ctx.close();
  }
  for (const c of COLS) await rawDb.collection(c).deleteMany({});
  await br.close();
} catch (e) {
  check('flow-ui-p5 (error)', false, e?.stack || String(e));
}
await finish();
