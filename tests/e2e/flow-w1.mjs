// Flow W1 (docs/flows/plan-1-3.md slice 7): the roster. Workers (present sessions) carry model, account, machine, branch
// and the task they are on; builders show under their orchestrator; a worker that stops calling shows as off within one
// cycle (its state is computed on every read, so there is no cycle to wait for) and its task as unheld; a quiet worker is
// idle; a worker with an open Need waits on a person; "could be running and isn't" lists projects with unblocked Next
// lines and no live worker. The Workers tab at 390 and 1280. lastSeen is backdated through the raw database.
// Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, EMAIL, PW, SP, check, finish, launch, login, makeUser, mkKey, overflow, okO, rawDb } from './lib.mjs';
import { createHash } from 'node:crypto';
import { mcpH, must, sleep } from './flow-lib.mjs';
// Another person's row is labelled by a one-way hash of its id (lib/data/roster.ts opaqueId).
const opq = id => createHash('sha256').update(`worker-row:${id}`).digest('hex').slice(0, 16);

const NAME = 'Flow Roster';
let PID = ''; // presence rows are keyed user:s:session:project
const REMOTE = 'acme/flow-roster';
const ago = min => new Date(Date.now() - min * 60_000);
const seen = (sid, min) => rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:${sid}:${PID}` }, { $set: { lastSeen: ago(min) } });

async function cookie() {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PW }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
const ck = await cookie();
const html = async p => { const r = await fetch(B + p, { headers: { cookie: ck } }); return r.text(); };
const unesc = s => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
/** The worker rows of the Workers tab, in page order: { id, depth, state, text, unheld }. */
function workers(h) {
  const starts = [...h.matchAll(/<li[^>]*data-worker="([^"]*)"[^>]*>/g)];
  return starts.map((m, i) => {
    const seg = h.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : h.indexOf('</ul>', m.index));
    return { id: m[1], depth: Number(/data-depth="(\d)"/.exec(m[0])?.[1]), state: /data-state="(\w+)"/.exec(m[0])?.[1], text: unesc(seg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')), unheld: /data-unheld/.test(seg), raw: seg.slice(0, 700) };
  });
}
// (a long page streams: the rest of a late row arrives after the first flush, so "unheld" is checked in the browser part below, where the page is whole)
const couldRun = h => [...h.matchAll(/data-could-run-project="([^"]*)"/g)].map(m => m[1]);
const row = (list, sid) => list.find(w => w.id === `${ME.userId}:s:${sid}:${PID}`);

try {
  const devId = randomUUID();
  await rawDb.collection('devices').insertOne({ _id: devId, name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: randomUUID(), prefix: 'wkr_w1', createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: REMOTE }] });
  PID = (await rawDb.collection('projects').findOne({ name: NAME }))._id;
  const t1 = (await must(MCP, 'add_task', { title: 'Orchestrate it', project: NAME })).created.ref;
  const t2 = (await must(MCP, 'add_task', { title: 'Build the first part', project: NAME })).created.ref;
  const t3 = (await must(MCP, 'add_task', { title: 'Build the second part', project: NAME })).created.ref;
  const cc = await mkKey({ agent: 'claude-code', name: 'Claude Code' });
  const ag = await mkKey({ agent: 'claude-code', name: 'Antigravity' });

  const empty = await html('/claude?tab=workers');
  check('W1: with nobody present the Workers tab says so', /data-workers-empty/.test(empty) && workers(empty).length === 0);

  await must(cc, 'start_work', { project: NAME, machine: 'om-pc', label: 'orchestrator', model: 'Opus 4.7', account: 'om-max', branch: 'master', session: 'w1-orch' });
  await must(cc, 'start_work', { project: NAME, machine: 'om-pc', label: 'builder A', model: 'Opus 4.7', account: 'om-max', branch: 'builder-a', parent: 'w1-orch', slot: 'A', session: 'w1-ba' });
  await must(ag, 'start_work', { project: NAME, machine: 'laptop-x', label: 'builder S', model: 'Sonnet 5.5', account: 'om-api', branch: 'builder-s', parent: 'w1-orch', slot: 'S', session: 'w1-bs' });
  for (const [k, sid, t] of [[cc, 'w1-orch', t1], [cc, 'w1-ba', t2], [ag, 'w1-bs', t3]]) await must(k, 'set_doing', { task: t, session: sid });

  const orchRow = await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-orch:${PID}` });
  check('W1: machine resolves to the device id when the name is one of the person’s devices, else stays the reported name', orchRow.machine === devId && orchRow.machineName === 'Om-PC' && (await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-bs:${PID}` })).machine === 'laptop-x', JSON.stringify([orchRow.machine, orchRow.machineName]));
  check('W1: start_work stores model, account, branch, parent and slot', orchRow.model === 'Opus 4.7' && orchRow.account === 'om-max' && orchRow.branch === 'master' && (await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-ba:${PID}` })).parent === 'w1-orch');

  let h = await html('/claude?tab=workers');
  let ws = workers(h);
  check('W1: three workers, all working', ws.length === 3 && ws.every(w => w.state === 'working'), JSON.stringify(ws.map(w => [w.id.slice(-8), w.state])));
  check('W1: the orchestrator comes first, its two builders right after it, indented (depth 1)', row(ws, 'w1-orch')?.depth === 0 && ws[0].id.includes(':w1-orch:') && ws.slice(1).every(w => w.depth === 1), JSON.stringify(ws.map(w => [w.id.slice(-8), w.depth])));
  const o = row(ws, 'w1-orch');
  // The row says state, label, what it is doing, project and computer; client, model, account, branch and slot are in its sheet (checked in the browser below).
  check('W1: a row has its label, machine (the device’s name), project and what it is doing', /orchestrator/.test(o.text) && /Om-PC/.test(o.text) && /Flow Roster/.test(o.text) && new RegExp(`#${t1} Orchestrate it`).test(o.text), o.text);
  check('W1: a builder row shows its own task', new RegExp(`#${t3}`).test(row(ws, 'w1-bs').text));
  check('W1: nothing is unheld while everyone works', !/data-unheld/.test(h));
  check('W1: set_doing is refused for a task that does not exist and for a caller who is not present', (await mcpH(cc, 'set_doing', { task: 99999, session: 'w1-orch' })).isError && (await mcpH(await mkKey({ agent: 'claude-code', name: 'Ghost' }), 'set_doing', { task: t1, session: 'nobody-here' })).isError);
  const sd = await must(cc, 'set_doing', { task: t1, session: 'w1-orch' });
  check('W1: set_doing answers with the task', sd.doing?.ref === t1, JSON.stringify(sd));

  // A builder stops calling: gone, its task unheld, still under its orchestrator
  await seen('w1-bs', 40);
  h = await html('/claude?tab=workers');
  ws = workers(h);
  const bs = row(ws, 'w1-bs');
  check('W1: a worker not seen for 40 minutes shows as off, still under its orchestrator (its task shows unheld: checked in the browser below)', bs.state === 'off' && bs.depth === 1 && ws.findIndex(w => w.id === bs.id) > 0, JSON.stringify(bs).slice(0, 900));
  await seen('w1-bs', 25);
  check('W1: seen 25 minutes ago it is idle, not off', row(workers(await html('/claude?tab=workers')), 'w1-bs').state === 'idle');
  await seen('w1-ba', 15);
  check('W1: seen 15 minutes ago is idle too', row(workers(await html('/claude?tab=workers')), 'w1-ba').state === 'idle');
  await seen('w1-bs', 40);

  // Where the daemon reports it, a process that still runs is not off however quiet it is
  await seen('w1-ba', 45);
  check('W1: 45 quiet minutes and no daemon report: off', row(workers(await html('/claude?tab=workers')), 'w1-ba').state === 'off');
  const rep = running => rawDb.collection('devices').updateOne({ _id: devId }, { $set: { claudeSessions: { at: new Date(), items: [{ sessionId: 'w1-ba', folder: 'f', title: 't', lastActiveAt: new Date(), subagentsActive: 0, startedByWorkOs: false, running }] } } });
  await rep(true);
  h = await html('/claude?tab=workers');
  const live = row(workers(h), 'w1-ba');
  check('W1: the daemon says its process runs: not off (idle), its task still held ', live.state === 'idle', JSON.stringify(live).slice(0, 300));
  await rep(false);
  check('W1: the daemon says the process is gone: off', row(workers(await html('/claude?tab=workers')), 'w1-ba').state === 'off');
  await seen('w1-ba', 1);

  // A session its own hook reports on: on (nothing asked yet, no "since"), idle with the time it stopped, waiting on a person
  const baId = `${ME.userId}:s:w1-ba:${PID}`;
  await rawDb.collection('devices').updateOne({ _id: devId }, { $unset: { claudeSessions: '' } });
  await rawDb.collection('presence').updateOne({ _id: baId }, { $set: { activity: { state: 'on', at: ago(2) } } });
  const onRow = row(workers(await html('/claude?tab=workers')), 'w1-ba');
  check('W1: a session its hook reports as on shows "On" and no "since" time', onRow.state === 'on' && / On /.test(onRow.text) && !/since/.test(onRow.text), onRow.text);
  await rawDb.collection('presence').updateOne({ _id: baId }, { $set: { activity: { state: 'idle', at: ago(3) } } });
  const idleRow = row(workers(await html('/claude?tab=workers')), 'w1-ba');
  check('W1: an idle session shows "since HH:MM"', idleRow.state === 'idle' && /since \d\d:\d\d/.test(idleRow.text), idleRow.text);
  await rawDb.collection('presence').updateOne({ _id: baId }, { $set: { activity: { state: 'waiting', at: ago(1), why: 'prompt' } } });
  const waitRow = row(workers(await html('/claude?tab=workers')), 'w1-ba');
  check('W1: a session waiting at its own prompt shows "Waiting on you" and "since HH:MM" to its owner', waitRow.state === 'waiting' && /Waiting on you/.test(waitRow.text) && /since \d\d:\d\d/.test(waitRow.text), waitRow.text);
  await rawDb.collection('presence').updateOne({ _id: baId }, { $unset: { activity: '' } });

  // A gone worker that calls again is back, and keeps what it reported before
  await must(ag, 'start_work', { project: NAME, machine: 'laptop-x', label: 'builder S', session: 'w1-bs' });
  const back = await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-bs:${PID}` });
  check('W1: an off worker that calls start_work again is working, with its model, account and parent kept', row(workers(await html('/claude?tab=workers')), 'w1-bs').state === 'working' && back.model === 'Sonnet 5.5' && back.account === 'om-api' && back.parent === 'w1-orch', JSON.stringify([back.model, back.account, back.parent]));

  // Waiting on a person: a Need the worker asked that is still open (lib/data/needs.ts; matched on its session, else on the client kind plus project)
  const st = sid => row(workers(htmlNow), sid)?.state;
  let htmlNow = '';
  const snap = async () => (htmlNow = await html('/claude?tab=workers'));
  const n1 = await must(cc, 'ask', { project: NAME, to: 'me', kind: 'approve', ask: 'Ship it tonight?', session: 'w1-orch' });
  await snap();
  check('W1: a worker with an open Need it asked (matched on its session) waits on a person, and its builders do not', st('w1-orch') === 'waiting' && st('w1-ba') === 'working' && st('w1-bs') === 'working', [st('w1-orch'), st('w1-ba'), st('w1-bs')].join());
  await must(cc, 'withdraw_need', { id: n1.need.ref, session: 'w1-orch' });
  await snap();
  check('W1: and works again once the Need is closed', st('w1-orch') === 'working');
  const n2 = await must(cc, 'ask', { project: NAME, to: 'me', kind: 'approve', ask: 'Which logo?' });
  await snap();
  check('W1: a Need with no session recorded makes the workers of that client kind on that project wait (key or client plus project)', ['w1-orch', 'w1-ba', 'w1-bs'].every(x => st(x) === 'waiting'), [st('w1-orch'), st('w1-ba'), st('w1-bs')].join());
  await must(cc, 'withdraw_need', { id: n2.need.ref });
  await snap();
  check('W1: all work again after it is withdrawn', ['w1-orch', 'w1-ba', 'w1-bs'].every(x => st(x) === 'working'));

  // Security: a session id is chosen by the client, so it never crosses people
  const tess = await makeUser({ email: 'w1-tess@example.test', name: 'Tess W1', orgId: ME.orgId, role: 'member' });
  const kT = await mkKey({ agent: 'claude-code', userId: tess.userId, name: 'Tess Claude Code' });
  await must(kT, 'start_work', { project: NAME, machine: 'tess-box', label: 'tess builder', parent: 'w1-ba', session: 'w1-tb' });
  await must(kT, 'start_work', { project: NAME, machine: 'tess-box', label: 'tess twin', session: 'w1-orch' });
  await snap();
  const tb = workers(htmlNow).find(w => w.id === opq(`${tess.userId}:s:w1-tb:${PID}`));
  check('W1: a builder whose parent names another person’s orchestrator stays top level', tb?.depth === 0, JSON.stringify(tb)?.slice(0, 300));
  const nT = await must(kT, 'ask', { project: NAME, to: EMAIL, kind: 'approve', ask: 'Tess asks: ship?', session: 'w1-orch' });
  await snap();
  check('W1: another person’s Need with the same session id does not make this person’s worker wait (only their own twin does)', st('w1-orch') === 'working' && workers(htmlNow).find(w => w.id === opq(`${tess.userId}:s:w1-orch:${PID}`))?.state === 'waiting', [st('w1-orch'), workers(htmlNow).find(w => w.id === opq(`${tess.userId}:s:w1-orch:${PID}`))?.state].join());
  await must(kT, 'withdraw_need', { id: nT.need.ref, session: 'w1-orch' });
  await rawDb.collection('presence').deleteMany({ userId: tess.userId }); // her rows must not keep the project busy in the cases below

  // set_doing names only a task of the project the worker started on; account must be a label, not a secret
  await must(MCP, 'add_project', { name: 'Flow Other Proj' });
  const otherTask = (await must(MCP, 'add_task', { title: 'Task of another project', project: 'Flow Other Proj' })).created.ref;
  const cross = await mcpH(cc, 'set_doing', { task: otherTask, session: 'w1-orch' });
  check('W1: set_doing refuses a task of another project', cross.isError && /project/i.test(cross.text), cross.text.slice(0, 200));
  await snap();
  check('W1: and the roster does not show it', !row(workers(htmlNow), 'w1-orch').text.includes('Task of another project'));
  const doingDoc = (await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-orch:${PID}` })).doing;
  check('W1: the worker row stores only the task id (no title)', doingDoc && Object.keys(doingDoc).sort().join() === 'at,taskId', JSON.stringify(doingDoc));
  for (const account of ['om@example.com', 'sk-ant-abcdef', 'wkr_abcdef', 'wos_abcdef', 'abcdefghijklmnopqrstuvwxyz0123456789']) {
    const r = await mcpH(cc, 'start_work', { project: NAME, machine: 'om-pc', label: 'x', account, session: 'w1-acct' });
    check(`W1: an account that looks like a secret (${account.slice(0, 8)}…) is refused`, r.isError, r.text.slice(0, 150));
  }

  // Could be running and isn't
  await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'add_next', text: 'Roster Next line one' }] });
  for (const n of ['Flow Idle Proj', 'Flow Waits Proj', 'Flow Done Proj', 'Flow Paused Proj']) await must(MCP, 'add_project', { name: n });
  const doneRef = (await must(MCP, 'add_task', { title: 'Already finished', project: 'Flow Done Proj' })).created.ref;
  await rawDb.collection('tasks').updateOne({ ref: doneRef }, { $set: { status: 'Done' } });
  await must(MCP, 'save_state', { project: 'Flow Idle Proj', ops: [{ op: 'add_next', text: 'Ready work with nobody on it' }, { op: 'add_next', text: 'Second ready line' }] });
  await must(MCP, 'save_state', { project: 'Flow Waits Proj', ops: [{ op: 'add_next', text: 'Needs Om first', waits_on: 'Om' }] });
  await must(MCP, 'save_state', { project: 'Flow Done Proj', ops: [{ op: 'add_next', text: 'Pointing at a finished task', ref: doneRef }] });
  await must(MCP, 'save_state', { project: 'Flow Paused Proj', ops: [{ op: 'add_next', text: 'Ready but paused' }] });
  await must(MCP, 'update_project', { project: 'Flow Paused Proj', status: 'paused' });
  const pid = async n => (await rawDb.collection('projects').findOne({ name: n }))._id;
  h = await html('/claude?tab=workers');
  const cr = couldRun(h);
  check('W1: "could be running and isn’t" lists the project with unblocked Next lines and nobody on it', cr.includes(await pid('Flow Idle Proj')), JSON.stringify(cr));
  check('W1: …not one whose Next lines all wait on someone, point at finished tasks, or whose project is paused', !cr.includes(await pid('Flow Waits Proj')) && !cr.includes(await pid('Flow Done Proj')) && !cr.includes(await pid('Flow Paused Proj')), JSON.stringify(cr));
  check('W1: …nor a project that has a live worker', !cr.includes(await pid(NAME)), JSON.stringify(cr));
  check('W1: the list comes before the workers and says how many lines', h.indexOf('data-could-run') < h.indexOf('data-workers-list') && /2 unblocked Next lines/.test(h));
  const ph = await html(`/projects/${await pid('Flow Idle Proj')}`);
  check('W1: the project page shows the same line for that project, and not for one with a worker', /data-could-run/.test(ph) && !/data-could-run/.test(await html(`/projects/${await pid(NAME)}`)));
  check('W1: the project page lists who is working on it', /data-card="workers"/.test(await html(`/projects/${await pid(NAME)}`)));
  for (const sid of ['w1-orch', 'w1-ba', 'w1-bs']) await seen(sid, 40);
  h = await html('/claude?tab=workers');
  check('W1: when every worker is gone the project joins the list', couldRun(h).includes(await pid(NAME)) && workers(h).every(w => w.state === 'off'), JSON.stringify(couldRun(h)));
  check('W1: the project page for it now shows the line and no one working', /data-could-run/.test(await html(`/projects/${await pid(NAME)}`)) && !/data-card="workers"/.test(await html(`/projects/${await pid(NAME)}`)));
  for (const sid of ['w1-orch', 'w1-ba', 'w1-bs']) await seen(sid, 1);

  // Lanes on the project page (Lanes step 5): the Now holder, a held line, a line left by a session, two lanes with a last result
  const hdrS = sid => ({ 'X-Work-OS-Session': sid });
  await must(cc, 'save_state', { project: NAME, session: 'w1-orch', base_version: (await must(cc, 'get_state', { project: NAME })).version, ops: [{ op: 'set_now', text: 'Ship the roster' }, { op: 'add_next', text: 'Held line for builder A' }, { op: 'add_next', text: 'Line a session left behind' }, { op: 'add_next', text: 'Plain line nobody holds' }] }, hdrS('w1-orch'));
  const stDoc = await rawDb.collection('states').findOne({ _id: PID });
  const baKey = (await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-ba:${PID}` })).key;
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'next.1.hold': { key: `${ME.userId}:${baKey}`, at: new Date() }, 'next.2.left': { label: 'builder S', branch: 'builder-s', log: 'half done, tests red', at: new Date() } } });
  await rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:w1-ba:${PID}` }, { $set: { lastResult: { text: 'Merged the roster change. All 12 checks pass, nothing left over, and a very long tail follows so the line has to be cut to one row on a phone screen.', at: new Date() } } });
  await rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:w1-orch:${PID}` }, { $set: { lastResult: { text: 'Plan written', at: new Date() } } });
  check('W1: Now is held by the session that set it', stDoc.now.hold?.key?.startsWith(`${ME.userId}:`), JSON.stringify(stDoc.now));

  // The Workers tab at 390 and 1280
  const browser = await launch();
  try {
    for (const vp of [390, 1280]) {
      const phone = vp === 390;
      const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push(e.message.slice(0, 120)));
      await login(p, { phone, next: '/claude?tab=workers' });
      await p.goto(B + '/claude?tab=workers');
      await p.waitForSelector('[data-section="workers"]');
      const T = s => `W1 [${vp}]: ${s}`;
      await rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:w1-bs:${PID}` }, { $set: { lastSeen: ago(40) } });
      await p.goto(B + '/claude?tab=workers');
      await p.waitForSelector('[data-section="workers"]');
      check(T('an off worker shows "Off" and its task "unheld"'), (await p.locator(`[data-worker="${ME.userId}:s:w1-bs:${PID}"][data-state="off"] [data-unheld]`).count()) === 1 && (await p.locator('[data-unheld]').count()) === 1);
      await rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:w1-bs:${PID}` }, { $set: { lastSeen: ago(1) } });
      await p.goto(B + '/claude?tab=workers');
      await p.waitForSelector('[data-section="workers"]');
      check(T('an old Workers link opens the Sessions tab, lit'), (await p.locator('a[data-tab="sessions"][aria-current="page"]').count()) === 1 && /Sessions/.test(await p.locator('a[data-tab="sessions"]').innerText()));
      check(T('one row per worker (3), the could-run list on top'), (await p.locator('[data-worker]').count()) === 3 && (await p.locator('[data-could-run]').count()) === 1);
      const top = await p.locator('[data-could-run]').boundingBox();
      const first = await p.locator('[data-worker]').first().boundingBox();
      check(T('the could-run list is above the workers'), top.y < first.y, `${top.y} ${first.y}`);
      const px = async l => (await p.locator(l).first().locator('[data-worker-person]').boundingBox()).x;
      const orchX = await px(`[data-worker="${ME.userId}:s:w1-orch:${PID}"]`);
      const bX = await px(`[data-worker="${ME.userId}:s:w1-ba:${PID}"]`);
      check(T('a builder is indented under its orchestrator'), bX > orchX + 8, `${orchX} ${bX}`);
      // A tap on a row opens its sheet: client, model, account, machine, branch, slot.
      const tapRow = async id => { const b = p.locator(`[data-worker="${id}"] button`).first(); await (phone ? b.tap() : b.click()); return p.locator(`[data-session-sheet="${id}"]`); };
      const closeSheet = async () => { if (phone) await p.getByRole('dialog').locator('button[aria-label="Close"]').first().tap(); else await p.keyboard.press('Escape'); await p.locator('[data-session-sheet]').waitFor({ state: 'detached', timeout: 6000 }).catch(() => {}); };
      const osh = await tapRow(`${ME.userId}:s:w1-orch:${PID}`);
      const ot = await osh.innerText().catch(() => '');
      check(T('the sheet has client name, model, account, machine, project, branch and the task'), /Claude Code/.test(ot) && /Opus 4\.7/.test(ot) && /om-max/.test(ot) && /Om-PC/.test(ot) && /Flow Roster/.test(ot) && /master/.test(ot) && new RegExp(`#\\d+ Orchestrate it`).test(ot), ot);
      await closeSheet();
      const bsh = await tapRow(`${ME.userId}:s:w1-bs:${PID}`);
      const bt = await bsh.innerText().catch(() => '');
      check(T("a builder's sheet shows its own client, model and slot"), /Antigravity/.test(bt) && /Sonnet 5\.5/.test(bt) && /slot S/.test(bt), bt);
      await closeSheet();
      const o2 = await overflow(p);
      check(T('no horizontal scroll'), okO(o2), JSON.stringify(o2));
      check(T('no script errors'), errs.length === 0, errs.join(' | '));
      await p.screenshot({ path: `${SP}/w1-workers-${vp}.png`, fullPage: true });
      // All five states side by side (a session its hook reports on), light and dark: looked at by eye, no overflow
      const orchDoc = await rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:w1-orch:${PID}` });
      const extra = [['w1-x1', 'on'], ['w1-x2', 'idle'], ['w1-x3', 'waiting'], ['w1-x4', 'off']];
      for (const [sid, st] of extra) await rawDb.collection('presence').insertOne({ ...orchDoc, _id: `${ME.userId}:s:${sid}:${PID}`, session: sid, key: sid, parent: undefined, label: `hook session ${st}`, doing: undefined, activity: { state: st, at: ago(st === 'off' ? 60 : 5), ...(st === 'waiting' ? { why: 'prompt' } : {}) } });
      await p.goto(B + '/claude?tab=workers');
      await p.waitForSelector('[data-section="workers"]');
      const states = await p.locator('[data-worker]').evaluateAll(els => els.map(e => e.getAttribute('data-state')));
      check(T('five states shown: on, idle, waiting, off beside the working ones'), ['on', 'idle', 'waiting', 'off', 'working'].every(x => states.includes(x)), states.join());
      check(T('idle and waiting rows say "since HH:MM", the on row does not'), (await p.locator('[data-worker-since]').count()) === 2);
      const o3 = await overflow(p);
      check(T('no horizontal scroll with five states'), okO(o3), JSON.stringify(o3));
      await p.screenshot({ path: `${SP}/w1-states-${vp}-light.png`, fullPage: true });
      await p.evaluate(() => document.documentElement.classList.add('dark'));
      await p.screenshot({ path: `${SP}/w1-states-${vp}-dark.png`, fullPage: true });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
      await rawDb.collection('presence').deleteMany({ _id: { $in: extra.map(([sid]) => `${ME.userId}:s:${sid}:${PID}`) } });

      // Lanes on the project page: Now holder, held mark, left text, lanes with last result
      await p.goto(B + `/projects/${PID}`);
      await p.waitForSelector('[data-card="state"]');
      const nowTxt = await p.locator('[data-card="purpose"]').innerText();
      check(T('the purpose header says "held by orchestrator (working)" for Now'), /held by orchestrator \(working\)/.test(nowTxt) && !nowTxt.includes('w1-orch'), nowTxt);
      check(T('a held line shows the holder label; an unheld line with left shows its left text; the plain line shows neither'), /builder A/.test(await p.locator('[data-next-id] [data-line-holder]').first().innerText()) && (await p.locator('[data-line-holder]').count()) === 1 && /left by builder S · builder-s · last: half done, tests red/.test(await p.locator('[data-line-left]').innerText()) && (await p.locator('[data-line-left]').count()) === 1);
      const lanes = await p.locator('[data-project-worker]').count();
      const resTxt = (await p.locator('[data-lane-result]').allInnerTexts()).join(' | ');
      check(T('Working on it now lists a lane per session with branch, slot, task link and last result on one line'), lanes === 3 && (await p.locator('[data-lane-task]').count()) === 3 && (await p.locator('[data-lane-result]').count()) === 2 && /last: Plan written/.test(resTxt) && /last: Merged the roster change\. All 12 checks/.test(resTxt) && /builder A/.test(await p.locator('[data-project-worker]').allInnerTexts().then(t => t.join(' '))), resTxt);
      // Who wrote the last line, as visible text: in the session's sheet (the row says "last:" and carries it as a title).
      const lb = p.locator(`[data-project-worker="${ME.userId}:s:w1-ba:${PID}"] button`).first();
      await (phone ? lb.tap() : lb.click());
      const lsh = p.locator(`[data-session-sheet="${ME.userId}:s:w1-ba:${PID}"]`);
      await lsh.waitFor({ timeout: 6000 }).catch(() => {});
      check(T('a last result names who wrote it as visible text, not only a hover title'), (await lsh.locator('[data-lane-result-by]').count()) === 1 && /written by .+ of .+, not checked/.test(await lsh.locator('[data-lane-result-by]').innerText()) && /builder-a/.test(await lsh.innerText()) && /slot A/.test(await lsh.innerText()));
      if (phone) await p.getByRole('dialog').locator('button[aria-label="Close"]').first().tap(); else await p.keyboard.press('Escape');
      await lsh.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
      const lr = await p.locator('[data-lane-result]').evaluateAll(els => els.map(e => e.getBoundingClientRect().height < 24 && e.scrollWidth >= 0));
      check(T('a last result is one line'), lr.length === 2 && lr.every(Boolean), JSON.stringify(lr));
      const o4 = await overflow(p);
      check(T('no horizontal scroll on the project page with lanes'), okO(o4), JSON.stringify(o4));
      await p.locator('[data-view="overview"] > div').first().screenshot({ path: `${SP}/w1-lanes-${vp}-light.png` });
      await p.evaluate(() => document.documentElement.classList.add('dark'));
      await p.locator('[data-view="overview"] > div').first().screenshot({ path: `${SP}/w1-lanes-${vp}-dark.png` });
      await p.evaluate(() => document.documentElement.classList.remove('dark'));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  check('flow-w1 (error)', false, e?.stack || String(e));
}
await finish();
