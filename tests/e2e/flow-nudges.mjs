// Nudges (note ce434ed759): the server half. (a) The stop event's answer for the turn-end check and the Declutter nudge:
// `nudge: { lines?, declutter? }`, for the token's own session only, only for a session that holds Now, a line or a task, up to 3 Next
// lines with no waits_on cut to 120 characters, nothing when the project switched nudges off. (b) The idle nudge in the idle wait
// (POST /api/agent/wait): a main session idle 20 minutes, not typed in, holding work, with a free Next line: a wake with the exact text;
// not when every line waits, not when the person typed lately, not for a dispatched run or a session that holds nothing; the backoff
// (1 h, 2 h, 4 h) and 4 a day on the presence row; an answered Need wakes as before and is not doubled. (c) The project's switch in the
// app (Info › Nudges), at 390 and 1280 px, light and dark. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, SP, check, finish, launch, login, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '4', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ago = min => new Date(Date.now() - min * 60_000);
const pause = ms => new Promise(r => setTimeout(r, ms));
const settled = async (p, ms) => { let v; const w = p.then(r => (v = r)); await Promise.race([w, pause(ms)]); return v; };
const NAME = 'NG One';
let PID = '';
const stateDoc = () => rawDb.collection('states').findOne({ _id: PID });

try {
  const kA = await mkKey({ agent: 'claude-code', name: 'NG Code' });
  PID = (await must(kA, 'add_project', { name: NAME, code: [{ remote: 'acme/ng-one' }] })).project.id;
  const pc = await mkDevice('ng-pc');
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:f1`, deviceId: pc.id, folderId: 'f1', name: 'C:/code/ng-one', git: true, remote: 'acme/ng-one', projectId: PID, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const newSession = async label => {
    const r = await call('/api/agent/start', pc.key, { remote: 'https://github.com/acme/ng-one.git', branch: 'main', path: 'C:/code/ng-one', label, ccSession: randomUUID(), source: 'startup' });
    return { token: r.json?.token ?? '', sid: r.json?.brief?.session ?? '', ok: r.status === 200 };
  };
  const S = await newSession('NG holder');
  const S2 = await newSession('NG other');
  check('setup: two hook sessions of the owner on the project', S.ok && S2.ok && /^wst_/.test(S.token) && S.sid !== S2.sid, JSON.stringify([S.ok, S2.ok]));
  const rowId = sid => `${ME.userId}:s:${sid}:${PID}`;
  const row = sid => rawDb.collection('presence').findOne({ _id: rowId(sid) });
  const setRow = (sid, set, unset) => rawDb.collection('presence').updateOne({ _id: rowId(sid) }, { ...(set ? { $set: set } : {}), ...(unset ? { $unset: unset } : {}) });
  const KEY = sid => `${ME.userId}:${sid}`;
  const idle = (sid, min = 25, extra = {}) => setRow(sid, { activity: { state: 'idle', at: ago(min) }, lastSeen: new Date(), promptAt: ago(min + 5), ...extra });
  const wait = tok => call('/api/agent/wait', tok, {});
  const ev = (tok, body) => call('/api/agent/event', tok, body);

  // State: Next with a line that waits, a long line, and plenty of lines that wait on nobody. Later with 30 lines (Declutter is due above 25).
  const LONG = 'ng long line ' + 'x'.repeat(200);
  await must(kA, 'save_state', { project: NAME, ops: [
    { op: 'add_next', text: 'ng line A' },
    { op: 'add_next', text: 'ng line B', waits_on: 'Om' },
    { op: 'add_next', text: LONG },
    { op: 'add_next', text: 'ng line D' },
    { op: 'add_next', text: 'ng line E' },
  ] });
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { now: { text: 'ng goal', hold: { key: KEY(S.sid), label: 'NG holder', at: new Date() }, by: ME.userId, at: new Date() } } });
  const A_LINES = ['ng line A', LONG.slice(0, 119) + '…', 'ng line D'];

  // ---- a) the stop event's answer ----
  const a1 = await ev(S.token, { event: 'stop', nudge: { asks: true } });
  check('a: the Now holder asking is answered with up to 3 Next lines that wait on nobody, 120 characters each, in order', a1.status === 200 && JSON.stringify(a1.json?.nudge) === JSON.stringify({ lines: A_LINES }) && a1.json.nudge.lines.every(l => l.length <= 120), a1.text.slice(0, 400));
  const a2 = await ev(S.token, { event: 'stop' });
  check('a: a stop with no nudge asked answers none', a2.status === 200 && !('nudge' in (a2.json ?? {})), a2.text);
  const a3 = await ev(S2.token, { event: 'stop', nudge: { asks: true, quiet: true } });
  check('a: a session that holds nothing gets no nudge, though lines wait (own session only)', a3.status === 200 && !('nudge' in (a3.json ?? {})), a3.text);
  await setRow(S2.sid, { doing: { taskId: 'ng-task', at: new Date() } });
  const a4 = await ev(S2.token, { event: 'stop', nudge: { asks: true, quiet: true } });
  check('a: a session on a task (set_doing) gets the lines but never Declutter (only the Now holder)', a4.status === 200 && JSON.stringify(a4.json?.nudge) === JSON.stringify({ lines: A_LINES }), a4.text.slice(0, 300));
  await setRow(S2.sid, null, { doing: '' });
  await rawDb.collection('states').updateOne({ _id: PID, 'next.text': 'ng line E' }, { $set: { 'next.$.hold': { key: KEY(S2.sid), at: new Date() } } });
  const a5 = await ev(S2.token, { event: 'stop', nudge: { asks: true } });
  check('a: a session holding a Next line gets the lines', a5.status === 200 && a5.json?.nudge?.lines?.length === 3, a5.text.slice(0, 300));
  await rawDb.collection('states').updateOne({ _id: PID, 'next.text': 'ng line E' }, { $unset: { 'next.$.hold': '' } });
  const a6 = await ev(S.token, { event: 'stop', nudge: { quiet: true } });
  check('a: Declutter is not due on a short State: no nudge', a6.status === 200 && !('nudge' in (a6.json ?? {})), a6.text);
  const later = Array.from({ length: 30 }, (_, i) => ({ id: `l_ng${i}`, text: `ng later ${i}`, by: ME.userId, at: new Date() }));
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { later } });
  const a7 = await ev(S.token, { event: 'stop', nudge: { quiet: true } });
  check('a: the Now holder on a quiet turn with 30 Later lines: the Declutter nudge, exact words', a7.status === 200 && a7.json?.nudge?.declutter === "Work OS: this project's State has 30 Later lines (Declutter is due). Call declutter: it proposes, your person approves on one Need." && !a7.json.nudge.lines, a7.text.slice(0, 400));
  const a8 = await ev(S.token, { event: 'stop', nudge: { asks: true, quiet: true } });
  check('a: both facts: lines and Declutter come together (the hook picks the order)', a8.status === 200 && a8.json?.nudge?.lines?.length === 3 && typeof a8.json.nudge.declutter === 'string', a8.text.slice(0, 200));
  check('a: nudge on a prompt or a tool event is a 400 (a stop only); an unknown key is a 400', (await ev(S.token, { event: 'tool', nudge: { asks: true } })).status === 400 && (await ev(S.token, { event: 'stop', nudge: { asks: true, text: 'x' } })).status === 400);
  await rawDb.collection('projects').updateOne({ _id: PID }, { $set: { nudges: false } });
  const a9 = await ev(S.token, { event: 'stop', nudge: { asks: true, quiet: true } });
  check('a: with the project switch off no nudge at all', a9.status === 200 && !('nudge' in (a9.json ?? {})), a9.text);
  await rawDb.collection('projects').updateOne({ _id: PID }, { $unset: { nudges: '' } });
  const a10 = await ev(S.token, { event: 'stop', nudge: { asks: true } });
  check('a: switched on again (the field removed): the lines are back', a10.json?.nudge?.lines?.length === 3, a10.text.slice(0, 200));
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { later: [] } });
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'next.$[l].waitsOn': 'Om' } }, { arrayFilters: [{ 'l.text': { $ne: 'ng line B' } }] });
  const a11 = await ev(S.token, { event: 'stop', nudge: { asks: true } });
  check('a: every Next line waits on someone: no lines, no nudge', a11.status === 200 && !('nudge' in (a11.json ?? {})), a11.text);
  await rawDb.collection('states').updateOne({ _id: PID }, { $unset: { 'next.$[l].waitsOn': '' } }, { arrayFilters: [{ 'l.text': { $ne: 'ng line B' } }] });

  // ---- b) the idle nudge ----
  await idle(S.sid, 25);
  const wk = await wait(S.token);
  check('b: idle 25 min, holds Now, free Next lines: the wait answers a wake with the exact text and no ack', wk.status === 200 && wk.json?.wake === true && JSON.stringify(wk.json.ack) === '[]' && wk.json.text === `Work OS: idle 25 min. Not waiting on anyone: "${A_LINES[0]}"; "${A_LINES[1]}"; "${A_LINES[2]}". Do the next one. If it really waits on someone, add \`waits_on\` to the line (save_state edit) and stop; that ends these nudges for it.`, wk.text.slice(0, 600));
  let r = await row(S.sid);
  check('b: the counters are on the row: one nudge today, the time', r.nudgeCount === 1 && r.nudgeDay === new Date().toISOString().slice(0, 10) && Date.now() - r.nudgeAt.getTime() < 20_000, JSON.stringify([r.nudgeCount, r.nudgeDay, r.nudgeAt]));
  check('b: no message was read and no wake was charged (wokeAt unset)', !r.wokeAt && !r.offered, JSON.stringify([r.wokeAt, r.offered]));
  const w2 = await settled(wait(S.token), 3000);
  check('b: a second wait right after is not nudged again (1 h backoff)', w2 === undefined, JSON.stringify(w2?.json));
  await setRow(S.sid, { nudgeAt: ago(61) });
  const w3 = await wait(S.token);
  check('b: 61 minutes after the first, the second nudge comes', w3.json?.wake === true && (await row(S.sid)).nudgeCount === 2, w3.text.slice(0, 200));
  await setRow(S.sid, { nudgeAt: ago(90) });
  const w4 = await settled(wait(S.token), 3000);
  check('b: after the second the gap is 2 h: 90 minutes is too soon', w4 === undefined && (await row(S.sid)).nudgeCount === 2, JSON.stringify(w4?.json));
  await setRow(S.sid, { nudgeAt: ago(121) });
  const w5 = await wait(S.token);
  check('b: 121 minutes after the second, the third', w5.json?.wake === true && (await row(S.sid)).nudgeCount === 3, w5.text.slice(0, 200));
  await setRow(S.sid, { nudgeAt: ago(200) });
  const w6 = await settled(wait(S.token), 3000);
  check('b: after the third the gap is 4 h: 200 minutes is too soon', w6 === undefined && (await row(S.sid)).nudgeCount === 3, JSON.stringify(w6?.json));
  await setRow(S.sid, { nudgeAt: ago(241) });
  const w7 = await wait(S.token);
  check('b: 241 minutes after the third, the fourth', w7.json?.wake === true && (await row(S.sid)).nudgeCount === 4, w7.text.slice(0, 200));
  await setRow(S.sid, { nudgeAt: ago(600) });
  const w8 = await settled(wait(S.token), 3000);
  check('b: at most 4 a day: no fifth however long it has been', w8 === undefined && (await row(S.sid)).nudgeCount === 4, JSON.stringify(w8?.json));
  await setRow(S.sid, { nudgeDay: '2020-01-01' });
  const w9 = await wait(S.token);
  check('b: the next day the count starts again', w9.json?.wake === true && (await row(S.sid)).nudgeCount === 1, w9.text.slice(0, 200));

  // not when ...
  const reset = extra => setRow(S.sid, { nudgeCount: 0, nudgeDay: '2020-01-01', ...extra }, { nudgeAt: '' });
  await reset({ activity: { state: 'idle', at: ago(15) }, promptAt: ago(30), lastSeen: new Date() });
  check('b: idle only 15 minutes: no nudge', (await settled(wait(S.token), 3000)) === undefined);
  await reset({ activity: { state: 'idle', at: ago(40) }, promptAt: ago(10), lastSeen: new Date() });
  check('b: the person typed 10 minutes ago (the last prompt event): no nudge', (await settled(wait(S.token), 3000)) === undefined);
  await reset({ activity: { state: 'idle', at: ago(40) }, promptAt: ago(40), lastSeen: new Date() });
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'next.$[].waitsOn': 'Om' } });
  check('b: every Next line waits on someone: no nudge', (await settled(wait(S.token), 3000)) === undefined);
  await rawDb.collection('states').updateOne({ _id: PID }, { $unset: { 'next.$[].waitsOn': '' } });
  await rawDb.collection('states').updateOne({ _id: PID, 'next.text': 'ng line B' }, { $set: { 'next.$.waitsOn': 'Om' } });
  await rawDb.collection('projects').updateOne({ _id: PID }, { $set: { nudges: false } });
  check('b: the project switch off: no nudge', (await settled(wait(S.token), 3000)) === undefined);
  await rawDb.collection('projects').updateOne({ _id: PID }, { $unset: { nudges: '' } });
  await idle(S2.sid, 40, { nudgeCount: 0 });
  await setRow(S2.sid, null, { doing: '' });
  check('b: a session that holds nothing: no nudge', (await settled(wait(S2.token), 3000)) === undefined);
  await setRow(S2.sid, { doing: { taskId: 'ng-task', at: new Date() } });
  const wd = await wait(S2.token);
  check('b: a session with a task set (set_doing) is nudged', wd.json?.wake === true && /^Work OS: idle 4\d min\./.test(wd.json.text ?? ''), wd.text.slice(0, 200));
  await setRow(S2.sid, { nudgeCount: 0, nudgeDay: '2020-01-01', dispatched: { taskId: 'ng-task', ref: 1 } }, { nudgeAt: '' });
  check('b: a dispatched run is never nudged', (await settled(wait(S2.token), 3000)) === undefined);
  await setRow(S2.sid, null, { dispatched: '', doing: '' });
  await setRow(S.sid, { activity: { state: 'working', at: new Date() } });
  const wb = await wait(S.token);
  check('b: a working session is busy, not nudged', wb.json?.busy === true, wb.text);

  // an answered Need still wakes through the old path, once, and is not doubled by a nudge
  await reset({ activity: { state: 'idle', at: ago(40) }, promptAt: ago(40), lastSeen: new Date() });
  const need = (await must(kA, 'ask', { project: NAME, to: 'E2E Owner', kind: 'decide', ask: 'NG which?', options: [{ label: 'One' }, { label: 'Two' }], session: S.sid }, { 'X-Work-OS-Session': S.sid })).need;
  if (need?.id) {
    await rawDb.collection('needs').updateOne({ _id: need.id }, { $set: { status: 'answered', answeredAt: new Date(), answer: { by: ME.userId, option: need.options?.[0]?.id ?? 'o1', via: 'app', at: new Date() }, 'from.session': S.sid, 'from.actor.userId': ME.userId } });
    const wn = await wait(S.token);
    check('b: an answered Need wakes with its own text, not the nudge', wn.json?.wake === true && /Need #\d+ was answered/.test(wn.json.text ?? '') && !/idle \d+ min/.test(wn.json.text) && (await row(S.sid)).nudgeCount === 0, wn.text.slice(0, 300));
  } else check('b: setup: a Need asked by the session', false, JSON.stringify(need));

  // ---- c) the app's switch ----
  const browser = await launch();
  try {
    for (const [kind, scheme] of [['phone', 'light'], ['phone', 'dark'], ['desktop', 'light'], ['desktop', 'dark']]) {
      const phone = kind === 'phone';
      const c = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } : { viewport: { width: 1280, height: 900 }, colorScheme: scheme });
      const p = await c.newPage();
      await login(p, { phone, next: `/projects/${PID}?tab=info` });
      const box = p.locator('[data-part="nudges"]');
      await box.waitFor({ timeout: 20000 });
      const nrow = box.locator('[data-nudges-row]');
      const prod = await p.locator('[data-part="production"] [data-production-row]').boundingBox();
      const mine = await nrow.boundingBox();
      const btn = await nrow.locator('[data-nudges-toggle]').boundingBox();
      check(`c: ${kind} ${scheme}: on by default, the row reads On with one button on the right (tap-sized on the phone), as tall as Production's row`, (await nrow.locator('[data-nudges-summary]').innerText()) === 'On' && !!btn && (!phone || btn.height >= 43.5) && btn.x > (phone ? 250 : 300) && Math.abs(mine.height - prod.height) < 2 && Math.abs(mine.x - prod.x) < 1 && Math.abs(mine.width - prod.width) < 1, JSON.stringify([mine, prod, btn]));
      check(`c: ${kind} ${scheme}: no horizontal scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await box.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${SP}/nudges-${kind}-${scheme}.png`, fullPage: false });
      if (scheme === 'light') {
        await nrow.locator('[data-nudges-toggle]').click();
        await p.waitForFunction(() => document.querySelector('[data-nudges-summary]')?.textContent === 'Off', null, { timeout: 15000 });
        check(`c: ${kind}: Turn off stores nudges: false on the project`, (await rawDb.collection('projects').findOne({ _id: PID })).nudges === false);
        const st = await ev(S.token, { event: 'stop', nudge: { asks: true } });
        check(`c: ${kind}: and the stop answer has no nudge at once`, st.status === 200 && !('nudge' in (st.json ?? {})), st.text);
        await p.screenshot({ path: `${SP}/nudges-${kind}-off.png`, fullPage: false });
        await nrow.locator('[data-nudges-toggle]').click();
        await p.waitForFunction(() => document.querySelector('[data-nudges-summary]')?.textContent === 'On', null, { timeout: 15000 });
        check(`c: ${kind}: Turn on removes the field (default on)`, (await rawDb.collection('projects').findOne({ _id: PID })).nudges === undefined);
      }
      await c.close();
    }
  } finally { await browser.close(); }
  const leak = JSON.stringify(await ev(S2.token, { event: 'stop', nudge: { asks: true } }));
  check('leak: the answer for the session that holds nothing names neither the holder nor a session id', !leak.includes(S.sid) && !leak.includes(KEY(S.sid)) && !leak.includes('NG holder'), leak.slice(0, 200));
} catch (e) {
  check('flow-nudges (error)', false, e?.stack || String(e));
}
await finish();
