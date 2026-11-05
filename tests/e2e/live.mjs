// Live pages (push, components/live-refresh.tsx): Tasks, Today, Projects, a project page and a task page follow a
// change made elsewhere without a reload: a teammate over MCP, the person's own Claude over MCP, and the person in a
// second browser session. A burst of writes is one or two refreshes, not one each; a page waits while the person types
// in a field and catches up when they leave it; a hidden tab catches up when it is shown again; the unread badge
// follows an assignment. Phone (390, touch) and desktop (1280). Seed profile: none.
import { randomBytes } from 'node:crypto';
import { B, ME, MCP, check, finish, launch, login, makeUser, mkKey, rawDb, setProfile } from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn().catch(() => false);
    if (v) return v;
    await sleep(150);
  }
  return v;
}
let rid = 0;
async function as(key, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  if (b.result?.isError || b.error) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
const tag = () => randomBytes(3).toString('hex');
const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

const browser = await launch();
try {
  const kA = MCP;
  await setProfile(ME, { quietStart: 0, quietEnd: 0 });
  const Bea = await makeUser({ email: 'bea-live@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const kB = await mkKey({ agent: 'claude', userId: Bea.userId, orgId: ME.orgId, name: 'bea chat' });
  await as(kA, 'add_project', { name: 'Live Team' });

  for (const phone of [true, false]) {
    const vp = phone ? '390' : '1280';
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    let rsc = 0;
    p.on('request', r => { if (r.headers()['rsc'] && new URL(r.url()).origin === B) rsc++; });
    await login(p, { phone, next: '/tasks' });
    await p.goto(B + '/tasks');
    await p.waitForLoadState('networkidle').catch(() => {});
    // Set after each navigation; still there when a change shows means the page was not reloaded.
    const keep = () => p.evaluate(() => { window.__keep = 1; });
    const kept = () => p.evaluate(() => window.__keep === 1);
    const seen = async t => !!(await until(async () => (await p.getByText(t, { exact: false }).count()) > 0)) && (await kept());
    await keep();

    // ── Tasks list: a teammate's new task, then the person's own Claude renaming one ──
    const t1 = `Bea live task ${tag()}`;
    const made = (await as(kB, 'add_task', { title: t1, project: 'Live Team' })).created;
    check(`${vp} Tasks: a teammate's new task shows without a reload`, !!(await seen(t1)));
    const t1b = `Renamed by my Claude ${tag()}`;
    await as(kA, 'update_task', { task: made.ref, title: t1b });
    check(`${vp} Tasks: the person's own Claude (MCP) renaming it shows too`, !!(await seen(t1b)));

    // ── a burst of writes costs one or two refreshes ──
    await sleep(2500);
    rsc = 0;
    const burst = [];
    for (let i = 0; i < 6; i++) burst.push(as(kB, 'add_task', { title: `Burst ${i} ${tag()}`, project: 'Live Team' }));
    const bt = (await Promise.all(burst)).map(r => r.created.title);
    check(`${vp} Tasks: a burst of 6 writes shows all of them`, !!(await until(async () => (await Promise.all(bt.map(t => p.getByText(t).count()))).every(n => n > 0))));
    await sleep(2500);
    check(`${vp} Tasks: ...for at most 2 page refreshes`, rsc <= 2, `refreshes ${rsc}`);

    // ── a second session of the same person (another tab or device) ──
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p2 = await ctx2.newPage();
    await login(p2, { next: `/tasks/${made.ref}` });
    await p2.goto(B + `/tasks/${made.ref}`);
    const t1c = `Renamed in my other tab ${tag()}`;
    const titleBox = p2.locator('input.text-2xl').first();
    await titleBox.fill(t1c);
    await titleBox.blur();
    check(`${vp} Tasks: the person's change in another session shows too`, !!(await seen(t1c)));
    await ctx2.close();

    // ── the unread badge follows an assignment ──
    const unread = async () => {
      if (phone) {
        const l = await p.locator('a[aria-label$="new notifications"]').first().getAttribute('aria-label', { timeout: 500 }).catch(() => null);
        return l ? parseInt(l, 10) : 0;
      }
      const s = await p.locator('aside a:has-text("Inbox") span.rounded-full').first().innerText({ timeout: 500 }).catch(() => '0');
      return parseInt(s, 10) || 0;
    };
    const u0 = await unread();
    await as(kB, 'update_task', { task: made.ref, assignee: ME.userId });
    check(`${vp} badge: an assignment raises the unread count without a reload`, !!(await until(async () => (await unread()) > u0)), `before ${u0}, now ${await unread()}`);

    // ── a hidden tab waits, then catches up when shown ──
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const t2 = `While hidden ${tag()}`;
    await as(kB, 'add_task', { title: t2, project: 'Live Team' });
    await sleep(2500);
    check(`${vp} hidden: nothing is fetched while the tab is hidden`, (await p.getByText(t2).count()) === 0);
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    check(`${vp} hidden: shown again, the tab catches up`, !!(await seen(t2)));

    // ── Today: the person's own Claude adds a task due today ──
    await p.goto(B + '/today');
    await p.waitForLoadState('networkidle').catch(() => {});
    await keep();
    await sleep(800);
    const t3 = `Due today live ${tag()}`;
    await as(kA, 'add_task', { title: t3, project: 'Live Team', due: todayIST() });
    check(`${vp} Today: a task Claude adds for today shows without a reload`, !!(await seen(t3)));

    // ── Projects list and a project page ──
    await p.goto(B + '/projects');
    await p.waitForLoadState('networkidle').catch(() => {});
    await keep();
    await sleep(800);
    const pn = `Bea live project ${tag()}`;
    await as(kB, 'add_project', { name: pn });
    check(`${vp} Projects: a teammate's new project shows without a reload`, !!(await seen(pn)));
    const proj = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: 'Live Team' });
    await p.goto(B + `/projects/${proj._id}`);
    await p.waitForLoadState('networkidle').catch(() => {});
    await keep();
    await sleep(800);
    const t4 = `On the project page ${tag()}`;
    await as(kB, 'add_task', { title: t4, project: 'Live Team' });
    check(`${vp} project page: a teammate's new task shows without a reload`, !!(await seen(t4)));

    // ── a task page: follows a change, but waits while the person types ──
    await p.goto(B + `/tasks/${made.ref}`);
    await p.waitForLoadState('networkidle').catch(() => {});
    await keep();
    await sleep(800);
    const titleVal = () => p.locator(phone ? 'input, textarea' : 'input.text-2xl').evaluateAll(els => els.map(e => e.value));
    const t5 = `Teammate retitled ${tag()}`;
    await as(kB, 'update_task', { task: made.ref, title: t5 });
    check(`${vp} task page: a teammate's new title shows without a reload`, !!(await until(async () => (await titleVal()).includes(t5))) && (await kept()));
    const draft = `half-written note ${tag()}`;
    const box = p.locator(phone ? 'textarea[placeholder="What happened?"]' : 'textarea[placeholder^="Decision"]').first();
    await box.scrollIntoViewIfNeeded();
    await (phone ? box.tap() : box.click());
    await box.type(draft);
    const t6 = `Changed while typing ${tag()}`;
    await as(kB, 'update_task', { task: made.ref, title: t6 });
    await sleep(3000);
    check(`${vp} task page: no refresh while the person types`, !(await titleVal()).includes(t6));
    await p.evaluate(() => (document.activeElement)?.blur());
    check(`${vp} task page: catches up once they leave the field`, !!(await until(async () => (await titleVal()).includes(t6))));
    check(`${vp} task page: the half-written text is kept`, (await box.inputValue()) === draft, await box.inputValue());
    if (!phone) {
      // The person's own edit in this tab: the action's response carries the new page; its hint is not one more fetch.
      await sleep(2500);
      rsc = 0;
      const own = `My own edit here ${tag()}`;
      const tb = p.locator('input.text-2xl').first();
      await tb.fill(own);
      await tb.blur();
      await until(async () => (await p.getByText('Title saved').count()) > 0);
      await sleep(3000);
      check(`${vp} task page: an edit in this tab costs no extra page fetch`, rsc === 0, `page fetches ${rsc}`);
    }

    await ctx.close();
  }
} catch (e) {
  check('suite ran to the end', false, e.stack ?? String(e));
} finally {
  await browser.close();
}
await finish();
