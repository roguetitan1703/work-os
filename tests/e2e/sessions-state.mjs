// The Sessions list tells live from gone (Om, 21 Nov; docs/HANDOVER.md section 8, "Sessions"): one Idle state (no On), a dot
// that is filled for live states and hollow for dead ones, a lead whose subagents run reads Working, a session that did nothing
// for 2 hours is Quiet, the title line is the name and the badge only, and the list shows the viewer's own active sessions by
// default with Everyone and Quiet and off as remembered chips. The Claude page, Today and a project page at 390 and 1280.
// Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, SP, check, finish, launch, fillLogin, makeUser, overflow, okO, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const ago = min => new Date(Date.now() - min * 60_000);

const devId = randomUUID();
await rawDb.collection('devices').insertOne({ _id: devId, name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: randomUUID(), prefix: 'wkr_ss', createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
await must(MCP, 'add_project', { name: 'Sessions State', code: [{ remote: 'acme/sessions-state' }] });
const PID = (await rawDb.collection('projects').findOne({ name: 'Sessions State' }))._id;
const akash = await makeUser({ email: 'akash-ss@example.test', name: 'Akash Patel', orgId: ME.orgId });
const proj = await rawDb.collection('projects').findOne({ _id: PID });
const rows = [];
const daemon = [];
const id = (uid, sid) => `${uid}:s:${sid}:${PID}`;
const mk = (sid, label, o) => {
  const cc = randomUUID();
  const uid = o.user ?? ME.userId;
  rows.push({
    _id: id(uid, sid), projectId: PID, userId: uid, key: sid, session: sid, label, labelSource: 'title', tool: o.tool ?? 'desktop',
    machine: o.machine ?? devId, machineName: o.machineName ?? 'Om-PC', ai: 'Claude Code', agent: 'claude-code', model: 'Opus 4.7', account: o.account ?? 'om', branch: 'dev',
    lastSeen: o.lastSeen ?? ago(0), createdAt: ago(60 * 24), forYouCursor: ago(0), named: [], writesSinceSave: 0, ccSession: cc, hook: 4,
    ...(o.activity ? { activity: o.activity } : {}), ...(o.activeAt ? { activeAt: o.activeAt } : {}), ...(o.promptAt ? { promptAt: o.promptAt } : {}),
    ...(o.endedAt ? { endedAt: o.endedAt } : {}), ...(o.parent ? { parent: o.parent, slot: o.slot } : {}),
    orgId: ME.orgId, ownerId: proj.visibility === 'org' ? uid : proj.ownerId, visibility: proj.visibility, sharedWith: proj.sharedWith ?? [],
  });
  if (uid === ME.userId && !o.endedAt) daemon.push({ sessionId: cc, folder: 'ss', title: label, lastActiveAt: o.daemonActive ?? o.activeAt ?? ago(1), subagentsActive: o.subagents ?? 0, startedByWorkOs: false, running: true });
};
mk('lead', 'SS lead', { activity: { state: 'idle', at: ago(20) }, activeAt: ago(20), subagents: 3 });
mk('wait', 'SS waiting', { activity: { state: 'waiting', at: ago(6), why: 'prompt' }, activeAt: ago(6) });
mk('idle', 'SS idle', { activity: { state: 'idle', at: ago(40) }, activeAt: ago(40), account: 'tools' });
mk('fresh', 'SS fresh start', { activity: { state: 'on', at: ago(2) }, activeAt: ago(2) });
mk('reopen', 'SS reopened', { activity: { state: 'on', at: ago(3) }, promptAt: ago(60 * 48), daemonActive: ago(3) });
mk('akash', 'SS teammate', { user: akash.userId, activity: { state: 'working', at: ago(2) }, activeAt: ago(2), machine: 'akash-laptop', machineName: 'Akash-Laptop', account: 'akash', tool: 'terminal' });
mk('ended', 'SS ended', { activity: { state: 'off', at: ago(10) }, activeAt: ago(12), endedAt: ago(10), lastSeen: ago(10) });
await rawDb.collection('presence').insertMany(rows);
await rawDb.collection('devices').updateOne({ _id: devId }, { $set: { claudeSessions: { at: new Date(), items: daemon } } });

const br = await launch();
try {
  for (const phone of [false, true]) {
    const vp = phone ? '390' : '1280';
    const T = s => `[${vp}] ${s}`;
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto(B + '/login?next=/claude');
    await fillLogin(p, { sessionFilter: null }); // the app's own default
    await p.locator('button[type=submit]').click();
    await p.waitForURL(u => u.pathname === '/claude', { timeout: 20000 });
    await p.waitForSelector('[data-section="sessions"]');
    const mine = sid => p.locator(`[data-worker="${id(ME.userId, sid)}"]`);
    const shown = async () => p.locator('[data-section="sessions"] [data-worker]').evaluateAll(els => els.map(e => e.getAttribute('data-worker')));

    // Default: own active sessions only.
    let ids = await shown();
    check(T('default: own active sessions only (lead, waiting, idle, fresh start); no quiet, ended or teammate rows'), ['lead', 'wait', 'idle', 'fresh'].every(s => ids.includes(id(ME.userId, s))) && !ids.includes(id(ME.userId, 'reopen')) && ids.length === 4 && (await p.locator('[data-section="finished"]').count()) === 0, JSON.stringify(ids));
    const ev = p.locator('[data-session-filter="everyone"]');
    const qo = p.locator('[data-session-filter="quiet"]');
    check(T('two chips with what each adds: Everyone 1, Quiet and off 2'), /Everyone\s*1/.test(await ev.innerText()) && /Quiet and off\s*2/.test(await qo.innerText()) && (await ev.getAttribute('aria-pressed')) === 'false');

    // States, words, dots, tones.
    const lead = mine('lead');
    check(T('an idle lead whose 3 subagents run reads "Working · 3 subagents", green, a pulsing dot, no since'), (await lead.getAttribute('data-state')) === 'working' && /Working · 3 subagents/.test(await lead.innerText()) && (await lead.locator('[data-worker-since]').count()) === 0 && (await lead.locator('[data-state-dot="pulse"]').count()) === 1 && /green/.test(await lead.locator('[data-worker-state]').getAttribute('class')), await lead.innerText());
    const fresh = mine('fresh');
    check(T('a fresh start with no prompt yet reads Idle (no On), sky, a filled dot, "since" on the subline'), (await fresh.getAttribute('data-state')) === 'idle' && /Idle/.test(await fresh.locator('[data-worker-state]').innerText()) && !/\bOn\b/.test(await fresh.innerText()) && (await fresh.locator('[data-state-dot="solid"]').count()) === 1 && /sky/.test(await fresh.locator('[data-worker-state]').getAttribute('class')) && (await fresh.locator('[data-worker-since]').count()) === 1, await fresh.innerText());
    const wait = mine('wait');
    check(T('waiting reads "Waiting on you" with a glowing dot'), /Waiting on you/.test(await wait.innerText()) && (await wait.locator('[data-state-dot="glow"]').count()) === 1);
    check(T('the badge holds the word only; the time sits on the subline'), (await p.locator('[data-worker-state] [data-worker-since]').count()) === 0);
    check(T('the account label is on the subline'), (await mine('idle').locator('[data-session-account]').innerText()) === 'tools');

    // Everyone: the teammate's row, the person on the subline, not on the title line.
    await (phone ? ev.tap() : ev.click());
    await p.waitForFunction(() => document.querySelectorAll('[data-section="sessions"] [data-worker]').length === 5);
    const tm = p.locator('[data-section="sessions"] [data-worker]').filter({ hasText: 'SS teammate' });
    check(T('Everyone adds the teammate row'), (await tm.count()) === 1);
    check(T("the teammate's name is on the subline, the title line is the name and the badge"), (await tm.locator('[data-session-label]').innerText()) === 'SS teammate' && (await tm.locator('[data-worker-person]').count()) === 1 && (await tm.locator('[data-worker-person]').innerText()).length > 0 && (await tm.locator('[data-session-label] [data-worker-person]').count()) === 0);
    // Quiet and off.
    await (phone ? qo.tap() : qo.click());
    await p.locator('[data-section="finished"]').waitFor({ timeout: 8000 });
    const re = mine('reopen');
    check(T('a reopened session with no prompt for 2 days reads Quiet, grey, a hollow dot, "last active 2 days ago"'), (await re.getAttribute('data-state')) === 'quiet' && /Quiet/.test(await re.locator('[data-worker-state]').innerText()) && (await re.locator('[data-state-dot="hollow"]').count()) === 1 && /last active 2 days ago/.test(await re.innerText()), await re.innerText().catch(() => 'no row'));
    check(T('the ended session is under Finished today with a hollow dot and "last active"'), /last active/.test(await p.locator('[data-section="finished"]').innerText()) && (await p.locator('[data-section="finished"] [data-state-dot="hollow"]').count()) >= 1);
    check(T('no horizontal scroll with every state'), okO(await overflow(p)));
    await p.screenshot({ path: `${SP}/sessions-state-${vp}.png`, fullPage: true });

    // Remembered: a reload keeps both chips on; Today and the project page follow it.
    await p.reload(); await p.waitForSelector('[data-section="sessions"]');
    check(T('the choice is remembered across a reload'), (await p.locator('[data-session-filter="everyone"][aria-pressed="true"]').count()) === 1 && (await p.locator('[data-session-filter="quiet"][aria-pressed="true"]').count()) === 1);
    await p.goto(B + `/projects/${PID}`);
    await p.locator('[data-card="workers"]').first().waitFor();
    check(T('the project page shows the same filter with the teammate and the quiet one'), (await p.locator('[data-card="workers"] [data-worker]').filter({ hasText: 'SS teammate' }).count()) >= 1 && (await p.locator('[data-card="workers"] [data-state="quiet"]').count()) >= 1);
    check(T('no script errors'), errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} finally {
  await br.close();
}
await finish();
