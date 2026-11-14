// Flow N2 (docs/flows/plan-1-3.md slice 4, "Needs"): the addressed person answers in the app, and the asker reads it.
//   - answering on Today (desktop and phone) takes an option and an optional note, records who, how ("app") and when, and the wait time;
//   - the task shows its percent again and the card leaves "Needs you";
//   - the asker reads the answer through `needs` (with the wait time) and nothing else changed on the task;
//   - someone else sees a Need addressed to another person but can only read it (no buttons, no "Needs you" block).
// Seed profile: none. (No MCP path answers a Need: flow-n1 checks the tool list, leak-audit probes the rest.)
import { B, ME, MCP, check, finish, launch, login, makeUser, mkKey, rawDb, setProfile } from './lib.mjs';

let rid = 0;
async function as(key, name, args = {}, extraHeaders = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  let b;
  try { b = JSON.parse(line ? line.slice(5) : t); } catch { return { isError: true, text: t, json: null }; }
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!b.result?.isError || !!b.error || r.status >= 400, text, json };
}
const must = async (key, name, args) => {
  const r = await as(key, name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  return r.json;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); }
  return v;
}

const browser = await launch();
try {
  await setProfile(ME, { quietStart: 0, quietEnd: 0, checklistHidden: true });
  const bea = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const kBea = await mkKey({ agent: 'claude', userId: bea.userId, orgId: ME.orgId, name: 'bea chat' });
  const kCode = await mkKey({ agent: 'claude-code', name: 'om code' });
  await must(MCP, 'add_project', { name: 'Answer Proj' });
  const projId = (await rawDb.collection('projects').findOne({ name: 'Answer Proj' }))._id;
  const t1 = (await must(MCP, 'add_task', { title: 'Pick the quote wording', project: 'Answer Proj' })).created;
  const t2 = (await must(MCP, 'add_task', { title: 'Phone answer task', project: 'Answer Proj' })).created;
  await must(MCP, 'log_progress', { task: t1.ref, progress: 40, note: 'half way' });

  const n1 = (await must(kCode, 'ask', { project: 'Answer Proj', to: 'me', kind: 'decide', task: t1.ref, ask: 'Which wording for the quote?', options: [{ label: 'Short', means: 'One line.' }, { label: 'Long', means: 'Three paragraphs.' }], session: 'sess-A' })).need;
  const n2 = (await must(kCode, 'ask', { project: 'Answer Proj', to: 'me', kind: 'approve', task: t2.ref, ask: 'Send the invoice today?', app_only: true })).need;
  // The first has been waiting 3 hours.
  await rawDb.collection('needs').updateOne({ _id: n1.id }, { $set: { createdAt: new Date(Date.now() - 3 * 3_600_000) } });

  // ======== a teammate sees them read-only ========
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await login(p, { email: 'bea@example.test', next: '/today' });
    await p.waitForSelector('[data-variant=desk] [data-section="claude-card"]', { timeout: 20000 }).catch(() => {});
    check("teammate: Today has no \"Needs you\" for a Need addressed to someone else", (await p.locator('[data-section="needs-you"]').count()) === 0);
    await p.goto(`${B}/projects/${encodeURIComponent(projId)}?tab=needs`);
    await p.locator('[data-view="needs"] [data-need]').first().waitFor({ timeout: 20000 });
    check('teammate: the project Needs tab lists them, waiting on the owner, with no answer buttons', (await p.locator('[data-view="needs"] [data-need]').count()) === 2 && (await p.locator('[data-need-option]').count()) === 0 && (await p.locator('[data-need-waiting]').count()) === 2);
    await ctx.close();
  }

  // ======== desktop: answer with an option and a note ========
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await login(p, { next: '/today' });
    const V = p.locator('[data-variant=desk]');
    const card = V.locator(`[data-section="needs-you"] [data-need="${n1.ref}"]`);
    await card.waitFor({ timeout: 20000 });
    await card.locator('[data-need-text]').fill('Short, but keep the price line.');
    await card.locator('[data-need-option="b"]').click(); // "Long"
    await card.waitFor({ state: 'detached', timeout: 20000 });
    check('desktop: the answered card leaves "Needs you"', true);
    const d = await rawDb.collection('needs').findOne({ _id: n1.id });
    check('answer: status answered with the option, the note, who, how and when', d.status === 'answered' && d.answer.option === 'b' && d.answer.text === 'Short, but keep the price line.' && d.answer.by === ME.userId && d.answer.via === 'app' && !!d.answer.at, JSON.stringify(d.answer));
    check('answer: the wait time is recorded (about 3 hours)', typeof d.waitedMs === 'number' && d.waitedMs > 2.9 * 3_600_000 && d.waitedMs < 3.2 * 3_600_000 && !!d.answeredAt && !!d.closedAt, String(d.waitedMs));
    const task = await rawDb.collection('tasks').findOne({ orgId: ME.orgId, ref: t1.ref });
    check('task: the Need mark is gone; status and progress untouched', !task.need && task.status === 'In Progress' && task.progress === 40, JSON.stringify([task.need, task.status, task.progress]));
    // the asker reads the answer
    const read = await must(kCode, 'needs', { project: 'Answer Proj', status: 'answered' });
    const got = read.needs.find(n => n.id === n1.id);
    check('asker: `needs` shows the answer with option, note, who, how and the wait', got?.answer?.option === 'b' && got.answer.text === 'Short, but keep the price line.' && got.answer.by === 'me' && got.answer.via === 'app' && got.waitedMinutes >= 170 && got.waitedMinutes <= 190, JSON.stringify(got));
    const open = await must(kCode, 'needs', { project: 'Answer Proj' });
    check('asker: the default list still shows it (answered in the last 14 days) next to the open one', open.needs.some(n => n.id === n1.id && n.status === 'answered') && open.needs.some(n => n.id === n2.id && n.status === 'open'));
    // the task row: percent back
    await p.goto(`${B}/projects/${encodeURIComponent(projId)}?tab=tasks`);
    await p.locator('a[href^="/tasks/"]:visible').first().waitFor({ timeout: 20000 });
    const chips = await p.locator('[data-need-chip]:visible').allInnerTexts();
    check('desktop: the answered task shows no chip, the other still shows its Need', chips.length === 1 && /Send the invoice today\?/.test(chips[0]), JSON.stringify(chips));
    const row1 = await p.locator('div.group', { hasText: 'Pick the quote wording' }).first().innerText();
    check('desktop: the answered task shows its percent again', /40%/.test(row1), row1.replace(/\s+/g, ' '));
    // the project tab keeps the answered one as closed history
    await p.goto(`${B}/projects/${encodeURIComponent(projId)}?tab=needs`);
    const hist = p.locator(`[data-view="needs"] [data-need="${n1.ref}"] [data-need-closed]`);
    await hist.waitFor({ timeout: 20000 });
    check('desktop: the Needs tab shows it answered, with the option label, the note and the wait', /Answered: Long/.test(await hist.innerText()) && /keep the price line/.test(await hist.innerText()) && /waited 3 h/.test(await hist.innerText()), await hist.innerText());
    check('desktop: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ======== phone: answer the app-only approval ========
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await login(p, { phone: true, next: '/today' });
    const V = p.locator('[data-variant=phone]');
    const card = V.locator(`[data-section="needs-you"] [data-need="${n2.ref}"]`);
    await card.waitFor({ timeout: 20000 });
    check('phone: the card says it is answered in the app only', /answer in the app only/.test(await card.locator('[data-need-from]').innerText()));
    const optH = await card.locator('[data-need-option]').first().evaluate(e => e.getBoundingClientRect().height);
    check('phone: option buttons are at least 44px tall', optH >= 44, String(optH));
    const fs = await card.locator('[data-need-text]').evaluate(e => parseFloat(getComputedStyle(e).fontSize));
    check('phone: the note box text is 16px or more (no zoom on focus)', fs >= 16, String(fs));
    await card.locator('[data-need-option="no"]').tap();
    await card.waitFor({ state: 'detached', timeout: 20000 });
    const d = await rawDb.collection('needs').findOne({ _id: n2.id });
    check('phone: answered "no" without a note, via app', d.status === 'answered' && d.answer.option === 'no' && !d.answer.text && d.answer.via === 'app' && d.answer.by === ME.userId, JSON.stringify(d.answer));
    check('phone: nothing waits any more, so the block is gone', (await V.locator('[data-section="needs-you"]').count()) === 0);
    const sideways = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check('phone: no sideways scroll', !sideways);
    // The project's tab bar now has six tabs (Needs added): at 390px every label must fit its cell, and the cells be tappable.
    await p.goto(`${B}/projects/${encodeURIComponent(projId)}?tab=tasks`);
    await p.locator('nav[aria-label="Project sections"] a').first().waitFor({ timeout: 20000 });
    const tabs = await p.locator('nav[aria-label="Project sections"] a').evaluateAll(els => els.map(e => ({ t: e.textContent.trim(), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), clipped: e.scrollWidth > e.clientWidth + 1, font: parseFloat(getComputedStyle(e).fontSize) })));
    await p.screenshot({ path: `${process.env.E2E_SHOTS || '.'}/project-tabs-390.png`, clip: { x: 0, y: 0, width: 390, height: 300 } }).catch(() => {});
    check('phone: the six project tabs each fit their label at 390px (nothing clipped)', tabs.length === 6 && tabs.every(x => !x.clipped), JSON.stringify(tabs));
    check('phone: each project tab is at least 44px tall and 12px type or more', tabs.every(x => x.h >= 44 && x.font >= 12), JSON.stringify(tabs.map(x => [x.t, x.w, x.h, x.font])));
    check('phone: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ======== the answer happens once ========
  {
    const d = await rawDb.collection('needs').findOne({ _id: n1.id });
    const r = await as(kCode, 'withdraw_need', { id: n1.ref }, { 'x-work-os-session': 'sess-A' });
    check('closed: an answered Need cannot be withdrawn afterwards', r.isError && /already answered/.test(r.text), r.text.slice(0, 160));
    const d2 = await rawDb.collection('needs').findOne({ _id: n1.id });
    check('closed: it is unchanged', JSON.stringify(d.answer) === JSON.stringify(d2.answer) && d2.status === 'answered');
  }
  void kBea;
  void until;
} catch (e) {
  check('suite ran without an error', false, e?.stack || String(e));
}
await browser.close().catch(() => {});
await finish();
