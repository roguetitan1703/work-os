// A short working session in a real Chromium tab (tests/load/README.md), every request to the app recorded per step
// with the router headers that decide its cost. Used by patterns.mjs (to see and compare what a browser sends) and by
// the budgets suite (requests per step must stay under budget).
import { B, mcpAs } from '../e2e/lib.mjs';
import { signInPage, pageOf } from './clients.mjs';

const kindOf = (h, u) => (h['next-action'] ? 'action' : h['next-router-prefetch'] ? (h['next-router-segment-prefetch'] ? 'prefetch-tree' : 'prefetch') : h.rsc ? 'rsc' : u.pathname.startsWith('/api/') ? 'api' : 'page');

/**
 * Runs the steps in a new desktop context of `browser` as `person`; returns { steps: { name: { kind: n } }, log }.
 * A teammate (`teammate`, a team.json person) adds a Claude item while the tab is on /claude, as a push hint.
 */
export async function browserSession({ browser, team, person, teammate, wait = 5000 }) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  let step = 'sign-in';
  const log = [];
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin !== B || u.pathname.startsWith('/_next/') || /\.(js|css|png|svg|ico|webmanifest|woff2?)$/.test(u.pathname)) return;
    const h = r.headers();
    log.push({ step, kind: kindOf(h, u), method: r.method(), path: u.pathname + u.search, page: pageOf(u.pathname), segment: h['next-router-segment-prefetch'] ?? null, action: h['next-action'] ?? null, tree: h['next-router-state-tree'] ?? null, nextUrl: h['next-url'] ?? null, body: r.method() === 'POST' ? r.postData()?.slice(0, 400) ?? null : null });
  });
  const names = ['sign-in'];
  const at = async (name, fn, ms = wait) => {
    step = name;
    names.push(name);
    await fn();
    await page.waitForTimeout(ms);
  };
  await signInPage(page, person.email, team.password);
  await at('load /today', () => page.goto(B + '/today'));
  await at('idle on /today', async () => {}, 8000);
  await at('nav Tasks', () => page.click('aside a[href="/tasks"]'));
  await at('nav Projects', () => page.click('aside a[href="/projects"]'));
  await at('open a project', () => page.click('main a[href^="/projects/"]:visible'));
  await at('open a task', () => page.click('main a[href^="/tasks/"]:visible'));
  await at('nav Today', () => page.click('aside a[href="/today"]'));
  await at('complete a task on Today', () => page.locator('[data-variant=desk] button[title="Mark done"]').first().click(), wait + 1000);
  await at('nav Claude', () => page.click('aside a[href="/claude"]'), wait + 1000);
  await at('a teammate adds a Claude item (push hint)', async () => {
    const p = team.projects[0].id;
    await mcpAs(teammate.claudeKey, 'update_claude_items', { project: p, ops: [{ op: 'add', project: p, kind: 'idea', title: 'Session probe item', why: 'Recorded by the load session probe on the throwaway app only.', done_when: 'Nothing; it is a fixture for the probe run.' }] });
  }, wait + 1000);
  await at('a teammate edits a task (push hint)', async () => {
    const t = team.tasks.find(x => x.open && x.visibility === 'org');
    await mcpAs(teammate.claudeKey, 'update_task', { task: t.ref, priority: 'P1', note: 'session probe' });
  }, wait + 1000);
  await at('nav Notes', () => page.click('aside a[href="/notes"]'));
  await ctx.close();
  const steps = Object.fromEntries(names.map(n => [n, { total: 0 }])); // a step with no requests still shows
  for (const r of log) {
    const s = (steps[r.step] ??= { total: 0 });
    s[r.kind] = (s[r.kind] ?? 0) + 1;
    s.total++;
  }
  return { steps, log };
}
