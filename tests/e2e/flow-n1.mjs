// Flow N1 (docs/archive/plan-1-3.md slice 4, "Needs"): an agent asks one person one thing.
//   - the ask shows under "Needs you" on Today (desktop and phone) and the task shows "Needs <name>: <ask>" in place of its percent;
//   - exactly one alert per Need (inbox), even across overlapping flushes and cron runs; a second open Need of the same kind
//     on the same task replaces the first (and the first's alert is not sent twice);
//   - the asker's word is set by the server (chat for the claude.ai connector, agent for a key), never by an argument;
//   - limits: a `to` who cannot read the project is refused; the 11th open Need from one asker to one person in one project is refused;
//   - a task waiting on a Need is never "stalled" (a control task that is, still is);
//   - there is no tool that answers a Need (tools/list), for any key.
// Seed profile: none.
import { B, ME, MCP, check, cron, finish, launch, login, makeUser, mkKey, rawDb, setProfile } from './lib.mjs';
import { mkOAuth } from './flow-lib.mjs';

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
const needAlerts = (userId = ME.userId) => rawDb.collection('notifications').find({ userId, kind: 'need' }).toArray();

const browser = await launch();
try {
  await setProfile(ME, { quietStart: 0, quietEnd: 0, checklistHidden: true });
  const bea = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const kBea = await mkKey({ agent: 'claude', userId: bea.userId, orgId: ME.orgId, name: 'bea chat' });
  const kCode = await mkKey({ agent: 'claude-code', name: 'om code' });
  const kOAuth = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });

  await must(MCP, 'add_project', { name: 'Needs Proj' });
  await must(MCP, 'add_project', { name: 'Needs Private', visibility: 'private' });
  const task = (await must(MCP, 'add_task', { title: 'Ship the migration', project: 'Needs Proj' })).created;
  const projId = (await rawDb.collection('projects').findOne({ name: 'Needs Proj' }))._id;

  // ======== no tool answers a Need ========
  {
    for (const [label, key] of [['claude-code key', kCode], ['chat key', MCP]]) {
      const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/list' }) });
      const t = await r.text();
      const line = t.split('\n').find(l => l.startsWith('data:'));
      const names = (JSON.parse(line ? line.slice(5) : t).result?.tools ?? []).map(x => x.name);
      check(`${label}: ask, needs and withdraw_need exist`, ['ask', 'needs', 'withdraw_need'].every(n => names.includes(n)), names.join(','));
      check(`${label}: no tool that answers a Need`, !names.some(n => /answer|respond|approve_need|resolve_need/i.test(n)), names.filter(n => /need/i.test(n)).join(','));
      const call = await as(key, 'answer_need', { id: 'x', option: 'a' });
      check(`${label}: calling answer_need is refused (no such tool)`, call.isError, call.text.slice(0, 120));
    }
  }

  // ======== N1: ask from a Claude Code key ========
  const a1 = await must(kCode, 'ask', { project: 'Needs Proj', to: 'me', kind: 'decide', task: task.ref, ask: 'Ship the migration tonight or on Monday?', example: 'Tonight means a 10 minute pause for the 40 orders still open.', options: [{ label: 'Monday', means: 'Wait until the quiet weekend.' }, { label: 'Tonight', means: 'Go now.' }], label: 'cutroom prime, Opus', session: 's-code-1' });
  check('ask: the Need is open, addressed to me, attached to the task', a1.need.status === 'open' && a1.need.to === 'me' && a1.need.task === `#${task.ref}`, JSON.stringify(a1.need));
  check('ask: a key is the "agent" word', a1.need.word === 'agent', a1.need.word);
  check('ask: options keep their order, ids are made, the first is the recommendation', a1.need.options.map(o => o.id).join() === 'a,b' && a1.need.options[0].label === 'Monday', JSON.stringify(a1.need.options));
  const doc1 = await rawDb.collection('needs').findOne({ _id: a1.need.id });
  check('stored: placement stamped like the project (org-wide, org id)', doc1.visibility === 'org' && doc1.orgId === ME.orgId && doc1.projectId === projId, JSON.stringify([doc1.visibility, doc1.orgId, doc1.projectId]));
  check('stored: created, no answer yet, appOnly false', !!doc1.createdAt && doc1.answeredAt === null && !doc1.answer && doc1.appOnly === false);

  // the claude.ai connector: "chat"; and the word cannot be given as an argument
  const a2 = await as(kOAuth, 'ask', { project: 'Needs Proj', to: 'me', kind: 'approve', ask: 'May I rotate the staging key?', word: 'person', app_only: true });
  check('ask: an unknown argument "word" does not let a caller choose its word (a claude.ai app through OAuth is "chat")', !a2.isError && a2.json.need.word === 'chat', a2.text.slice(0, 200));
  check('ask: app_only is kept (approve gets yes / no)', a2.json.need.appOnly === true && a2.json.need.options.map(o => o.id).join() === 'yes,no', JSON.stringify(a2.json.need));

  // ---- one alert per Need ----
  const alerts1 = await until(async () => { const a = await needAlerts(); return a.length >= 2 ? a : null; });
  check('alert: one inbox alert per Need (two Needs, two alerts)', alerts1?.length === 2, `got ${alerts1?.length}`);
  check('alert: it opens the Need and says who asked', alerts1?.every(a => /\/today#need-\d+$/.test(a.url)) && alerts1.some(a => /Claude Code asks you: Ship the migration/.test(a.title)) && alerts1.some(a => /^Claude asks you: May I rotate/.test(a.title)), JSON.stringify(alerts1?.map(a => [a.title, a.url])));
  await Promise.all([cron(), cron(), cron()]);
  await sleep(1500);
  check('alert: overlapping cron runs send nothing more', (await needAlerts()).length === 2, `got ${(await needAlerts()).length}`);
  const q = await rawDb.collection('alertQueue').find({ kind: 'need' }).toArray();
  check('alert: each queue row was claimed once', q.length === 2 && q.every(x => x.sentAt), JSON.stringify(q.map(x => [x._id.slice(0, 8), !!x.sentAt])));

  // ---- the same kind on the same task replaces the first ----
  const a3 = await must(kCode, 'ask', { project: 'Needs Proj', to: 'me', kind: 'decide', task: task.ref, ask: 'Actually: ship it Tuesday morning?', options: [{ label: 'Tuesday' }, { label: 'Monday' }] });
  check('replace: the answer names the Need it replaced', a3.replaced?.length === 1 && a3.replaced[0].id === a1.need.id, JSON.stringify(a3.replaced));
  const old = await rawDb.collection('needs').findOne({ _id: a1.need.id });
  check('replace: the first is "replaced", the second open; one open decide on the task', old.status === 'replaced' && old.replacedBy === a3.need.id && (await rawDb.collection('needs').countDocuments({ taskId: old.taskId, kind: 'decide', status: 'open' })) === 1);
  await sleep(2500);
  const alerts2 = await needAlerts();
  check('replace: a replacement of a Need alerted minutes ago sends no second alert (the person has the first)', alerts2.length === 2 && !(await rawDb.collection('alertQueue').findOne({ _id: `need:${a3.need.id}` })), `got ${alerts2.length}`);
  const doneT = await must(MCP, 'get_task', { task: task.ref });
  check('task: still open, progress untouched by the Need', doneT.status === 'Not Started' && doneT.progress === 0);

  // ---- needs tool: the asker reads them, labels, filters ----
  const mine = await must(kCode, 'needs', { project: 'Needs Proj' });
  check('needs: lists the open ones (2 open, the replaced one is not default)', mine.needs.length === 2 && mine.needs.every(n => n.status === 'open'), JSON.stringify(mine.needs.map(n => [n.ref, n.status])));
  const rep = await must(kCode, 'needs', { project: 'Needs Proj', status: 'replaced' });
  check('needs: status replaced shows the first', rep.needs.length === 1 && rep.needs[0].id === a1.need.id);
  const tome = await must(kCode, 'needs', { to: 'me' });
  check('needs: to "me" lists those addressed to me', tome.needs.length === 2);

  // ---- who asked is labelled for the reader (an ask by someone else is information) ----
  const bProj = await as(kBea, 'needs', { project: 'Needs Proj' });
  check('needs: a teammate who can read the project sees them, with the ask marked as written by someone else', !bProj.isError && bProj.json.needs.length === 2 && bProj.json.needs.every(n => /Claude/.test(n.writtenBy ?? '')), bProj.text.slice(0, 300));
  const bMine = await as(kBea, 'needs', { to: 'me' });
  check('needs: to "me" for a teammate holds nothing addressed to Om', bMine.json?.needs?.length === 0, bMine.text.slice(0, 200));
  const bWithdraw = await as(kBea, 'withdraw_need', { id: a2.json.need.ref });
  check('withdraw_need: only the asker may withdraw (a teammate may not)', bWithdraw.isError && !/Withdraw/.test(bWithdraw.text), bWithdraw.text.slice(0, 200));

  // ---- limits ----
  const priv = await as(kCode, 'ask', { project: 'Needs Private', to: 'Bea', kind: 'approve', ask: 'May I?' });
  check('limit: `to` who cannot read the project is refused', priv.isError && /cannot see this project/.test(priv.text), priv.text.slice(0, 200));
  const stranger = await as(kCode, 'ask', { project: 'Needs Proj', to: 'nobody-of-that-name', kind: 'approve', ask: 'May I?' });
  check('limit: `to` who is not a member is refused', stranger.isError, stranger.text.slice(0, 200));
  // Om 19 Nov: 10 open Needs per asker, person and project (and 20 asks an hour to one person, flow-n4).
  const kinds = ['decide', 'approve', 'do', 'chase', 'approve', 'do', 'chase', 'approve', 'do', 'chase'];
  const sent = [];
  for (let i = 0; i < 10; i++) {
    const r = await as(kCode, 'ask', { project: 'Needs Proj', to: 'Bea', kind: kinds[i], ask: `Question ${i + 1} for Bea`, ...(kinds[i] === 'decide' ? { options: [{ label: 'One' }, { label: 'Two' }] } : {}) });
    sent.push(r);
  }
  check('limit: ten open Needs to one person in one project are accepted', sent.every(r => !r.isError), sent.map(r => r.isError ? r.text.slice(0, 80) : 'ok').join(' | '));
  const eleventh = await as(kCode, 'ask', { project: 'Needs Proj', to: 'Bea', kind: 'do', ask: 'An eleventh question for Bea' });
  check('limit: the 11th open Need from one asker to one person in one project is refused', eleventh.isError && /10 open Needs/.test(eleventh.text), eleventh.text.slice(0, 200));
  const other = await as(kOAuth, 'ask', { project: 'Needs Proj', to: 'Bea', kind: 'do', ask: 'The chat asker has its own ten' });
  check('limit: it counts per asker word (the chat asker is not blocked by the key asker)', !other.isError, other.text.slice(0, 200));
  const w = await must(kCode, 'withdraw_need', { id: sent[0].json.need.ref });
  check('withdraw_need: the asker takes one back by number', w.need.status === 'withdrawn');
  const again = await as(kCode, 'ask', { project: 'Needs Proj', to: 'Bea', kind: 'do', ask: 'Now there is room again' });
  check('limit: withdrawing frees a place', !again.isError, again.text.slice(0, 200));
  const beaAlerts = await until(async () => { const a = await needAlerts(bea.userId); return a.length >= 12 ? a : null; });
  check('alert: Bea got one alert per Need addressed to her (10 + 1 chat + 1 again)', beaAlerts?.length === 12, `got ${beaAlerts?.length}`);

  // ======== Today: "Needs you" and the task row, desktop and phone ========
  for (const phone of [false, true]) {
    const label = phone ? 'phone' : 'desktop';
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await login(p, { phone, next: '/today' });
    const V = p.locator(`[data-variant=${phone ? 'phone' : 'desk'}]`);
    await V.locator('[data-section="needs-you"]').waitFor({ timeout: 20000 });
    const block = V.locator('[data-section="needs-you"]');
    check(`${label}: Today shows "Needs you" with my two open Needs`, (await block.locator('[data-need]').count()) === 2 && /needs you/i.test(await block.locator('h2').innerText()), String(await block.locator('[data-need]').count()));
    const card = block.locator(`[data-need="${a3.need.ref}"]`);
    await card.locator('[data-need-ask]').click(); // a Need is one line until its row is opened
    check(`${label}: the card holds the ask, who asked, and the options as buttons`, /Tuesday morning/.test(await card.locator('[data-need-ask]').innerText()) && /Claude Code/.test(await card.locator('[data-need-from]').innerText()) && (await card.locator('[data-need-option]').count()) === 2 && (await card.locator('[data-need-text]').count()) === 1);
    check(`${label}: the replaced Need is not shown`, (await block.locator(`[data-need="${a1.need.ref}"]`).count()) === 0);
    const first = block.locator('[data-need]').first();
    check(`${label}: block sits above the task sections`, await p.evaluate(() => { const b = [...document.querySelectorAll('[data-section="needs-you"]')].find(e => e.offsetParent); const t = [...document.querySelectorAll('[data-section]')].find(e => e.offsetParent && e.getAttribute('data-section') !== 'needs-you' && e.getAttribute('data-section') !== 'claude-card'); return !t || b.getBoundingClientRect().top < t.getBoundingClientRect().top; }));
    void first;
    // the task row (project Tasks tab: all open tasks listed)
    await p.goto(`${B}/projects/${encodeURIComponent(projId)}?tab=tasks`);
    const chip = p.locator('[data-need-chip]:visible').first();
    await chip.waitFor({ timeout: 20000 });
    const txt = (await chip.innerText()).trim();
    check(`${label}: the task shows "Needs <name>: <ask>"`, /^Needs E2E: Actually: ship it Tuesday morning\?/.test(txt), txt);
    const rowText = await chip.evaluate(el => (el.closest('[class*="group"], .flex.items-stretch') ?? el.parentElement).innerText);
    check(`${label}: ...in place of the percent`, !/\d+%/.test(rowText), rowText.replace(/\s+/g, ' '));
    check(`${label}: no page errors`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ======== a typed answer is sent without pressing an option (Om, 19 Nov) ========
  {
    const typed = (await must(kCode, 'ask', { project: 'Needs Proj', to: 'me', kind: 'decide', ask: 'Typed answer check', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }] })).need;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await login(p, { phone: false, next: '/today' });
    const card = p.locator(`[data-variant=desk] [data-need="${typed.ref}"]`);
    await card.waitFor({ timeout: 20000 });
    await card.locator('[data-need-ask]').click();
    check('typed: no Send button while the box is empty', (await card.locator('[data-need-send]').count()) === 0);
    await card.locator('[data-need-text]').fill('Neither: wait until Friday');
    await card.locator('[data-need-send]').click();
    await p.waitForTimeout(1500);
    const doc = await rawDb.collection('needs').findOne({ orgId: ME.orgId, ref: typed.ref });
    check('typed: the Need is answered with the typed text', doc?.status === 'answered' && doc?.answer?.option === 'other' && doc?.answer?.text === 'Neither: wait until Friday', JSON.stringify(doc?.answer));
    await ctx.close();
  }

  // ======== a task waiting on a Need is never "stalled" ========
  {
    const waiting = (await must(MCP, 'add_task', { title: 'Waiting on a person', project: 'Needs Proj' })).created;
    const idle = (await must(MCP, 'add_task', { title: 'Plain stalled control', project: 'Needs Proj' })).created;
    for (const t of [waiting, idle]) await must(MCP, 'log_progress', { task: t.ref, progress: 30, note: 'started' });
    await must(kCode, 'ask', { project: 'Needs Proj', to: 'me', kind: 'do', task: waiting.ref, ask: 'Run sudo work-os-update on the box' });
    const old5 = new Date(Date.now() - 6 * 86_400_000);
    await rawDb.collection('tasks').updateMany({ ref: { $in: [waiting.ref, idle.ref] }, orgId: ME.orgId }, { $set: { updatedAt: old5 } });
    // The redesigned digest (18 Nov) lists no stalled tasks (it absorbs their alerts), so the stalled alert is checked with
    // the digest off, as the morning alerts work then; run as of 10:00 IST today so the test does not depend on the clock
    await rawDb.collection('settings').updateOne({ _id: `notify:${ME.userId}` }, { $set: { 'notify.kinds.digest': false }, $setOnInsert: { area: 'notify', orgId: ME.orgId, userId: ME.userId } }, { upsert: true });
    const ist = new Date(Date.now() + 19_800_000);
    const tenIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 10) - 19_800_000;
    const dry = await cron(`&dry=1&at=${new Date(Math.max(Date.now(), tenIst)).toISOString()}`);
    const text = (dry.preview ?? []).join('\n');
    check('stalled: the control task is reported as stalled', new RegExp(`#${idle.ref}\\]`).test(text) && /Stalled/.test(text), text.slice(0, 300));
    // it does show under "Needs you" in the digest, which is right: only the quiet list is under test
    const quietPart = text.split('\n').reduce((a, l) => (/Gone quiet|Stalled/.test(l) ? { on: true, out: a.out } : /^\s*$/.test(l) ? { on: false, out: a.out } : a.on ? { on: true, out: a.out + l + '\n' } : a), { on: false, out: '' }).out;
    check('stalled: the task waiting on a Need is not', !new RegExp(`#${waiting.ref}\\]`).test(quietPart), quietPart);
  }
} catch (e) {
  check('suite ran without an error', false, e?.stack || String(e));
}
await browser.close().catch(() => {});
await finish();
