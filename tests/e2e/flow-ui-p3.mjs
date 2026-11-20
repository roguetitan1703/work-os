// UI revamp phase 3: the task header. Each of the four why sources (the project's Now names the task, a Next line, the parent, the
// description's first line), the project's Now as context, the phone's Description right under the header, no sideways scroll at
// 390 and 1280, and nothing of another person's private project. Seed profile: none.
import fs from 'node:fs';
import { ME, B, SP, check, finish, launch, login, overflow, okO, rawDb, mcp } from './lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const now = new Date();
const placed = { orgId: ME.orgId, ownerId: ME.userId, visibility: 'org' };
const proj = (id, name, extra = {}) => ({ _id: id, name, nameLower: name.toLowerCase(), client: '', description: '', status: 'active', ...placed, createdAt: now, updatedAt: now, ...extra });
const line = (id, text, ref) => ({ id, text, ...(ref ? { ref } : {}), by: ME.userId, at: now });
const stateOf = (id, nowText, next, extra = {}) => ({ _id: id, projectId: id, ...placed, now: nowText ? { text: nowText, by: ME.userId, at: now } : null, next, later: [], decisions: [], where: {}, version: 3, createdAt: now, updatedAt: now, ...extra });
const must = async (n, a) => { const r = await mcp(n, a); if (!r?.created) throw new Error(`${n} failed: ${JSON.stringify(r).slice(0, 200)}`); return r; };

try {
  for (const c of ['projects', 'states', 'tasks']) await rawDb.collection(c).deleteMany({});
  await rawDb.collection('projects').insertMany([proj('p3-main', 'P3 Main'), proj('p3-secret', 'P3 Secret', { ownerId: 'someone-else', visibility: 'private' }), proj('p3-quiet', 'P3 Quiet')]);
  const a = (await must('add_task', { title: 'Task that is Now', project: 'P3 Main' })).created.ref;
  const b = (await must('add_task', { title: 'Task on a Next line', project: 'P3 Main' })).created.ref;
  const c = (await must('add_task', { title: 'Task named in a Next text', project: 'P3 Main' })).created.ref;
  const par = await must('add_task', { title: 'The parent task', project: 'P3 Main', subtasks: [{ title: 'The child task' }] });
  const kid = par.subtasks[0].ref;
  const d = (await must('add_task', { title: 'Task with only a description', project: 'P3 Quiet', description: 'First line of the why\nSecond line' })).created.ref;
  const leak = (await must('add_task', { title: 'Task in a quiet project', project: 'P3 Quiet' })).created.ref;
  await rawDb.collection('states').insertMany([
    stateOf('p3-main', `Ship the thing (#${a}) end to end, then check the next steps listed after it.`, [line('n0', 'Other step'), line('n1', 'Do the second step', b), line('n2', `Polish it up for #${c}`)]),
    // Another person's private project: its Now names my task's number, and it must never show
    stateOf('p3-secret', `SECRET-NOW-UI3 mentions #${leak}`, [line('s0', 'SECRET-NEXT-UI3', leak)], { ownerId: 'someone-else', visibility: 'private' }),
  ]);

  const br = await launch();
  for (const phone of [true, false]) {
    const tag = phone ? '390' : '1280';
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await login(p, { phone, next: '/today' });
    const V = p.locator(phone ? '.md\\:hidden' : '.md\\:grid');
    const open = async ref => {
      await p.goto(`${B}/tasks/${ref}`);
      await V.locator('textarea, input').first().waitFor({ timeout: 20000 });
      await p.waitForLoadState('networkidle').catch(() => {});
      await p.waitForTimeout(500);
    };
    const why = async () => (await V.locator('[data-task-why]').first().innerText()).trim();
    const kindOf = async () => V.locator('[data-task-why]').first().getAttribute('data-task-why');
    const shot = async (name, dark) => {
      await p.evaluate(d => document.documentElement.classList.toggle('dark', d), !!dark);
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${SP}/ui-p3-${name}-${tag}-${dark ? 'dark' : 'light'}.png`, fullPage: true });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
    };

    await open(a);
    check(`ui-p3 (${tag}): the project's Now names the task: "This is the project's Now"`, (await why()) === "This is the project's Now" && (await kindOf()) === 'now', await why());
    check(`ui-p3 (${tag}): the project's Now shows as context`, (await V.locator('[data-task-project-now]').innerText()).includes('Ship the thing'));
    await shot('task', false);
    await shot('task', true);
    const o = await overflow(p);
    check(`ui-p3 (${tag}): no sideways scroll`, okO(o), JSON.stringify(o));
    await open(b);
    check(`ui-p3 (${tag}): a Next line with the task's ref: "Next 2: ..."`, (await why()) === 'Next 2: Do the second step' && (await kindOf()) === 'next', await why());
    await open(c);
    check(`ui-p3 (${tag}): a Next line that names #ref in its text`, (await why()) === `Next 3: Polish it up for #${c}`, await why());
    await open(kid);
    check(`ui-p3 (${tag}): the parent task`, (await why()) === `Part of #${par.created.ref} The parent task` && (await kindOf()) === 'parent', await why());
    await open(d);
    check(`ui-p3 (${tag}): the description's first line`, (await why()) === 'First line of the why' && (await kindOf()) === 'description', await why());
    check(`ui-p3 (${tag}): no project Now when the project has none`, (await V.locator('[data-task-project-now]').count()) === 0);
    await open(leak);
    const body = await p.locator('body').innerText();
    check(`ui-p3 (${tag}): nothing of another person's private project`, !/SECRET-/.test(body) && (await V.locator('[data-task-why]').count()) === 0, body.slice(0, 120));
    check(`ui-p3 (${tag}): a task with no why and no Now has no header`, (await V.locator('[data-card=task-purpose]').count()) === 0);

    if (phone) {
      await open(a);
      const order = await p.evaluate(() => {
        const root = document.querySelector('.md\\:hidden');
        const hs = [...root.querySelectorAll('h2')];
        const y = el => el.getBoundingClientRect().top;
        const find = t => hs.find(h => h.textContent.trim() === t);
        return { descIndex: hs.findIndex(h => h.textContent.trim() === 'Description'), headerY: y(root.querySelector('[data-card=task-purpose]')), descY: y(find('Description')), statusY: find('Status') ? y(find('Status')) : 1e9 };
      });
      check('ui-p3 (390): Description comes right after the header, before Status', order.descY > order.headerY && order.descY < order.statusY && order.descIndex === 0, JSON.stringify(order));
    }
    await ctx.close();
  }
  for (const col of ['projects', 'states', 'tasks']) await rawDb.collection(col).deleteMany({});
  await br.close();
} catch (e) {
  check('flow-ui-p3 (error)', false, e?.stack || String(e));
}
await finish();
