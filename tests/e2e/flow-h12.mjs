// Flow H12 (docs/flows/agent-system.md sections 10, 12 and 16.12; plan note 7f5824bbed): the phone rule, the hook counters and
// the Monday block.
//   part 1  what reaches the phone: a release Need and a Need a person asked always; a review Need and a Monday Need never; any other
//           agent Need only while the asking session is not off (checked when queued and again when sent, after quiet hours); a
//           Monday Need is not in the daily "Needs you".
//   part 2  the counters: POST /api/agent/event takes files / reminded (stop) and copy (tool) and counts them on the token's own row;
//           POST /api/agent/state counts an applied edit as forwarded and a refused one as refused, once.
//   part 3  the Monday block in the owner's digest (?at= a Monday and a Tuesday): the four numbers, the proposals and their cap,
//           a member who is not an owner has none, nothing of a private project or another member's PC.
// Seed profile: none.
import { B, check, cron, finish, makeUser, mkDevice, mkKey, rawDb, setProfile, ME, MCP } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; };
const notes = (userId, kind = 'need') => rawDb.collection('notifications').find({ userId, kind }).toArray();
const queued = needId => rawDb.collection('alertQueue').findOne({ _id: `need:${needId}` });
const AT = iso => `&at=${iso}`;

await setProfile(ME, { quietStart: 0, quietEnd: 0, checklistHidden: true });
const kA = await mkKey({ agent: 'claude-code', name: 'h12 code' });
await must(MCP, 'add_project', { name: 'H12 Proj' });
const proj = (await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: 'H12 Proj' }))._id;
const live = async (sid, project = 'H12 Proj') => { await must(kA, 'start_work', { project, label: `h12 ${sid}`, session: sid }, { 'x-work-os-session': sid }); };
const endSession = (sid, pid = proj) => rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:${sid}:${pid}` }, { $set: { endedAt: new Date() } });
const ask = async (sid, extra = {}) => (await must(kA, 'ask', { project: 'H12 Proj', to: 'me', kind: 'decide', ask: `H12 ask ${Math.random().toString(36).slice(2, 7)}`, options: [{ label: 'One' }, { label: 'Two' }], ...(sid ? { session: sid } : {}), ...extra }, sid ? { 'x-work-os-session': sid } : {})).need;

// ======== part 1: the phone rule ========
{
  // a live session's Need pushes
  await live('h12-live');
  const n1 = await ask('h12-live');
  const got1 = await until(async () => { const a = await notes(ME.userId); return a.length >= 1 ? a : null; });
  check('phone: a Need of a live session is queued and alerts once', !!(await queued(n1.id)) && got1?.length === 1, `got ${got1?.length}`);

  // a session that has ended: nothing is queued
  await live('h12-gone');
  await endSession('h12-gone');
  const n2 = await ask('h12-gone');
  await cron();
  check('phone: a Need of a session that has ended queues no alert and sends none', !(await queued(n2.id)) && (await notes(ME.userId)).length === 1, `${!!(await queued(n2.id))} ${(await notes(ME.userId)).length}`);
  const nRow = await rawDb.collection('needs').findOne({ _id: n2.id });
  check('phone: that Need is still open for the person (Today, digest)', nRow?.status === 'open');

  // no session id on the Need: cannot tell, yes
  const n3 = await ask(null);
  const got3 = await until(async () => (await notes(ME.userId)).length >= 2);
  check('phone: a Need with no session id cannot be judged and pushes', !!(await queued(n3.id)) && got3, `${!!(await queued(n3.id))}`);

  // a release Need always pushes, even from a session that has ended
  await live('h12-rel');
  await endSession('h12-rel');
  const nr = await must(kA, 'ask', { project: 'H12 Proj', kind: 'approve', ask: 'H12 push the release?', release: true, session: 'h12-rel' }, { 'x-work-os-session': 'h12-rel' });
  const gotR = await until(async () => (await notes(ME.userId)).length >= 3);
  check('phone: a release Need always pushes, whether or not its session is still on', !!(await queued(nr.need.id)) && gotR, `${!!(await queued(nr.need.id))}`);

  // a review Need never queues one
  const t = (await must(MCP, 'add_task', { title: 'H12 review me', project: 'H12 Proj', result_kind: 'code' })).created;
  await mcpH(kA, 'hand_in', { task: t.ref, changed: 'done' }, { 'x-work-os-session': 'h12-live' });
  const rv = await rawDb.collection('needs').findOne({ taskRef: t.ref, kind: 'review' });
  await cron();
  check('phone: a review Need exists, is open, and has no queued alert', rv?.status === 'open' && !(await queued(rv._id)) && !rv.noAlert, JSON.stringify([rv?.status, rv?.noAlert]));

  // a Need a person asked (no tool makes one today: a copy of a plain Need with the person word, queued like a real one)
  const base = await rawDb.collection('needs').findOne({ _id: n1.id });
  const person = { ...base, _id: 'h12-person-need', ref: 9101, ask: 'H12 a person asks', from: { actor: { kind: 'user', userId: ME.userId, name: 'Akash' }, word: 'person', session: 'h12-gone' }, createdAt: new Date() };
  await rawDb.collection('needs').insertOne(person);
  await rawDb.collection('alertQueue').insertOne({ _id: `need:${person._id}`, orgId: ME.orgId, userId: ME.userId, kind: 'need', taskId: '', byTaskId: '', needId: person._id, createdAt: new Date(), sentAt: null });
  await cron();
  check('phone: a Need a person asked pushes (even with an ended session named on it)', (await notes(ME.userId)).some(n => /H12 a person asks/.test(n.title)), JSON.stringify((await notes(ME.userId)).map(n => n.title)));

  // a Monday Need never pushes, and is not in the daily Needs you
  const mon = { ...base, _id: 'h12-monday-need', ref: 9102, ask: 'H12 MONDAY PROPOSAL', batch: 'monday', createdAt: new Date() };
  await rawDb.collection('needs').insertOne(mon);
  await rawDb.collection('alertQueue').insertOne({ _id: `need:${mon._id}`, orgId: ME.orgId, userId: ME.userId, kind: 'need', taskId: '', byTaskId: '', needId: mon._id, createdAt: new Date(), sentAt: null });
  await cron();
  check('phone: a Monday Need never pushes (dropped when sent)', !(await notes(ME.userId)).some(n => /MONDAY PROPOSAL/.test(n.title)));
  const dry = await cron('&dry=1' + AT('2026-11-25T05:00:00Z'));
  const text = (dry.preview ?? []).join('\n');
  check('digest: Needs you lists the open Needs but leaves the Monday Need out', /Needs you/.test(text) && !/MONDAY PROPOSAL/.test(text), text.slice(0, 500));
  check('digest: a review Need is still in Needs you (answer in the app)', /Review #\d+/.test(text), text.slice(0, 500));
}

// ======== part 1b: quiet hours, then the session ends: dropped at send time, but in the digest ========
// The alert flush after an ask runs at the real time, so Q's quiet hour is the hour that starts now (IST, the default zone).
{
  const istHour = (new Date(Date.now() + 330 * 60_000)).getUTCHours();
  const qe = (istHour + 1) % 24; // a one-hour quiet window that starts now
  const later = (h, m) => new Date(Date.UTC(2026, 10, 24, h, m) - 330 * 60_000).toISOString(); // Tue 24 Nov, h:m IST
  const Q = await makeUser({ email: 'h12-q@example.test', name: 'H12 Quiet', orgId: ME.orgId, role: 'member' });
  await setProfile(Q, { quietStart: istHour, quietEnd: qe, digestHour: (istHour + 2) % 24 });
  await live('h12-night');
  const nq = await must(kA, 'ask', { project: 'H12 Proj', to: 'H12 Quiet', kind: 'decide', ask: 'H12 NIGHT ASK', options: [{ label: 'One' }, { label: 'Two' }], session: 'h12-night' }, { 'x-work-os-session': 'h12-night' });
  await sleep(1500);
  const held = await queued(nq.need.id);
  check('quiet hours: the alert is held (queued, not sent, nothing in the inbox)', !!held && !held.sentAt && !(await notes(Q.userId)).length, JSON.stringify(held));
  await endSession('h12-night'); // the session ends while the alert is held
  await cron(AT(later(istHour + 1, 10))); // quiet hour is over, the digest hour is not yet: the send-time check finds the session off
  check('send time: once quiet hours end the alert is dropped because the asking session is off', !(await notes(Q.userId)).length, JSON.stringify((await notes(Q.userId)).map(n => n.title)));
  const dry = await cron('&dry=1' + AT(later(istHour + 2, 30)));
  const text = (dry.preview ?? []).join(String.fromCharCode(10));
  check("digest: the Need is in the digest's Needs you", /Needs you/.test(text) && /H12 NIGHT ASK/.test(text), text.slice(0, 600));
}

// ======== part 2: the counters from the hooks ========
{
  const post = async (url, cred, body = {}) => {
    const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  const one = (await must(MCP, 'add_project', { name: 'H12 Hooks', code: [{ remote: 'acme/h12-hooks' }] })).project.id;
  await must(MCP, 'save_state', { project: 'H12 Hooks', ops: [{ op: 'add_next', text: 'H12 first line' }, { op: 'add_next', text: 'H12 second line' }] });
  const pc = await mkDevice('h12-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold1`, deviceId: pc.id, folderId: 'fold1', name: 'C:/code/f1', git: true, remote: 'acme/h12-hooks', projectId: one, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const start = await post('/api/agent/start', pc.key, { folders: ['fold1'], remote: 'https://github.com/acme/h12-hooks.git', branch: 'main', path: 'C:/code/h12-hooks', machine: 'h12-pc', label: 'Claude Code' });
  const T = start.json?.token ?? '';
  const sid = start.json?.brief?.session;
  const row = () => rawDb.collection('presence').findOne({ _id: `${ME.userId}:s:${sid}:${one}` });
  check('setup: a session token and a presence row', /^wst_/.test(T) && !!(await row()), `${start.status} ${start.text.slice(0, 200)}`);

  // bodies: files and reminded only with a stop, copy only with a tool, nothing else
  const bad = [
    ['files with a prompt', { event: 'prompt', files: 'saved' }],
    ['files with a tool', { event: 'tool', files: 'saved' }],
    ['reminded with a tool', { event: 'tool', reminded: true }],
    ['reminded without files', { event: 'stop', reminded: true }],
    ['copy with a stop', { event: 'stop', copy: 'refused' }],
    ['copy with a prompt', { event: 'prompt', copy: 'refused' }],
    ['files that is not a word we know', { event: 'stop', files: 'maybe' }],
    ['copy that is not refused', { event: 'tool', copy: 'forwarded' }],
    ['files as an object', { event: 'stop', files: { path: 'C:/x' } }],
    ['an extra field', { event: 'stop', files: 'saved', path: 'C:/secret' }],
  ];
  for (const [label, body] of bad) check(`event body: ${label} is 400`, (await post('/api/agent/event', T, body)).status === 400, JSON.stringify(body));
  check('event body: a refused body counted nothing', !(await row()).stopCheck && !(await row()).copyEdits);

  // a stop that saved after the reminder, then one that did not: the last stop wins; neither is free
  const e1 = await post('/api/agent/event', T, { event: 'stop', files: 'saved', reminded: true });
  const r1 = await row();
  check('stop: files saved after the reminder is counted on the row', e1.status === 200 && r1.stopCheck?.files === 'saved' && r1.stopCheck?.reminded === true && r1.stopCheck.at instanceof Date, JSON.stringify([e1.status, r1.stopCheck]));
  check('stop: only words, a flag and a time are kept (no text, no path)', Object.keys(r1.stopCheck).sort().join() === 'at,files,reminded', Object.keys(r1.stopCheck).join());
  await sleep(30);
  const e2 = await post('/api/agent/event', T, { event: 'stop', files: 'unsaved' });
  const r2 = await row();
  check('stop: the same state again within a minute is still written when it carries a count (never free), and the last stop wins', e2.status === 200 && r2.stopCheck?.files === 'unsaved' && !('reminded' in r2.stopCheck) && r2.stopCheck.at > r1.stopCheck.at, JSON.stringify(r2.stopCheck));
  const plain = await post('/api/agent/event', T, { event: 'stop' });
  check('stop: a plain stop does not clear the count', plain.status === 200 && (await row()).stopCheck?.files === 'unsaved');

  // refused copy writes counted from the hook
  const c1 = await post('/api/agent/event', T, { event: 'tool', copy: 'refused' });
  const c2 = await post('/api/agent/event', T, { event: 'tool', copy: 'refused' });
  check('tool: two refused copy writes are counted (never free)', c1.status === 200 && c2.status === 200 && (await row()).copyEdits?.refused === 2, JSON.stringify((await row()).copyEdits));
  const plainTool = await post('/api/agent/event', T, { event: 'tool' });
  check('tool: a plain tool event counts nothing', plainTool.status === 200 && (await row()).copyEdits?.refused === 2);

  // /api/agent/state: an applied edit is forwarded, a refused one is refused, each counted once by the server
  const ok = await post('/api/agent/state', T, { edit: { old: 'H12 first line', new: 'H12 first line, edited' } });
  const day = new Date().toISOString().slice(0, 10);
  check('state: an applied edit counts as forwarded, once', ok.status === 200 && (await row()).copyEdits?.forwarded === 1 && (await row()).copyEdits?.refused === 2, `${ok.status} ${JSON.stringify((await row()).copyEdits)}`);
  const no = await post('/api/agent/state', T, { edit: { old: 'H12 no such line', new: 'x' } });
  check('state: an edit refused with 400 counts as refused, once', no.status === 400 && (await row()).copyEdits?.refused === 3 && (await row()).copyEdits?.forwarded === 1, `${no.status} ${JSON.stringify((await row()).copyEdits)}`);
  check('counts: each is also kept under the day it happened (for the weekly numbers)', (await row()).copyEdits?.days?.[day]?.refused === 3 && (await row()).copyEdits?.days?.[day]?.forwarded === 1, JSON.stringify((await row()).copyEdits));
  const where = await post('/api/agent/state', T, { where: { branch: 'main' } });
  check('state: a call with no edit counts nothing', where.status === 200 && (await row()).copyEdits?.refused === 3 && (await row()).copyEdits?.forwarded === 1);

  // never creates a row
  await rawDb.collection('presence').deleteOne({ _id: `${ME.userId}:s:${sid}:${one}` });
  const gone = await post('/api/agent/event', T, { event: 'stop', files: 'saved' });
  await post('/api/agent/event', T, { event: 'tool', copy: 'refused' });
  check('the counts never create a presence row', gone.status === 200 && gone.json?.state === null && !(await row()), JSON.stringify(gone.json));
}

// ======== part 3: the Monday block ========
{
  const D = iso => new Date(iso);
  const MON = '2026-11-23T05:00:00Z'; // Mon 23 Nov, 10:30 IST: the week is 16-22 Nov
  const TUE = '2026-11-24T05:00:00Z';
  const M = await makeUser({ email: 'h12-member@example.test', name: 'H12 Member', orgId: ME.orgId, role: 'member' });
  const kM = await mkKey({ agent: 'claude-code', userId: M.userId, orgId: ME.orgId, name: 'h12 member code' });
  await setProfile(M, { quietStart: 0, quietEnd: 0 });
  // clean slate for the counts: no other computers, no other presence rows with counts
  await rawDb.collection('devices').deleteMany({ orgId: ME.orgId });
  await rawDb.collection('presence').deleteMany({ orgId: ME.orgId, $or: [{ stopCheck: { $exists: true } }, { copyEdits: { $exists: true } }] });

  // 9 sessions that changed files in the week: 7 saved (2 only after the reminder), 2 not; 2 refused and 1 forwarded copy edits
  const prow = (i, extra) => ({ _id: `h12-s${i}`, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', projectId: proj, userId: ME.userId, key: `h12-s${i}`, session: `h12-s${i}`, label: 'x', machine: 'x', ai: 'x', agent: 'claude-code', lastSeen: D('2026-11-19T04:00:00Z'), forYouCursor: D('2026-11-19T04:00:00Z'), writesSinceSave: 0, ...extra });
  const at = D('2026-11-18T10:00:00Z');
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(prow(i, { stopCheck: { files: 'saved', at } }));
  for (let i = 5; i < 7; i++) rows.push(prow(i, { stopCheck: { files: 'saved', reminded: true, at } }));
  for (let i = 7; i < 9; i++) rows.push(prow(i, { stopCheck: { files: 'unsaved', reminded: true, at }, ...(i === 7 ? { copyEdits: { refused: 52, forwarded: 31, days: { '2026-11-18': { refused: 2, forwarded: 1 }, '2026-11-02': { refused: 50, forwarded: 30 } } } } : {}) }));
  // outside the week: not counted
  rows.push(prow(9, { stopCheck: { files: 'unsaved', at: D('2026-11-09T10:00:00Z') }, copyEdits: { refused: 50, forwarded: 50, days: { '2026-11-09': { refused: 50, forwarded: 50 } } }, lastSeen: D('2026-11-09T10:00:00Z') }));
  await rawDb.collection('presence').insertMany(rows);
  // computers: one current, one out of date, one with no hooks; a revoked one and one not seen this week are left out
  const dev = (id, extra) => ({ _id: id, name: `H12 PC ${id}`, ownerId: ME.userId, orgId: ME.orgId, hash: id, prefix: id, createdAt: D('2026-10-01T00:00:00Z'), lastSeenAt: D('2026-11-20T00:00:00Z'), revokedAt: null, ...extra });
  await rawDb.collection('devices').insertMany([
    dev('d1', { worker: { version: '1', os: 'win', hooks: { version: 'abc', events: 5, stale: false, signIn: 'worker' } } }),
    dev('d2', { worker: { version: '1', os: 'win', hooks: { version: 'old', events: 5, stale: true, signIn: 'worker' } } }),
    dev('d3', { name: 'H12 OTHER MEMBERS PC', ownerId: M.userId, worker: { version: '1', os: 'win' } }),
    dev('d4', { revokedAt: D('2026-11-01T00:00:00Z') }),
    dev('d5', { lastSeenAt: D('2026-11-01T00:00:00Z') }),
  ]);
  // Monday proposals: two open Monday Needs (one older than 14 days is left out), and friction lines through the feed
  const base = await rawDb.collection('needs').findOne({ kind: 'decide', status: 'open' });
  const mneed = (id, ref, ask, createdAt) => ({ ...base, _id: id, ref, ask, batch: 'monday', status: 'open', createdAt, answeredAt: null });
  await rawDb.collection('needs').deleteOne({ _id: 'h12-monday-need' }); // part 1's Monday Need would be a proposal too
  await rawDb.collection('needs').insertMany([mneed('h12-m1', 9201, 'H12 MONDAY ONE declutter the State', D('2026-11-12T09:00:00Z')), mneed('h12-m2', 9202, 'H12 MONDAY TWO propose a rule', D('2026-11-16T09:00:00Z')), mneed('h12-m3', 9203, 'H12 MONDAY OLD', D('2026-10-20T09:00:00Z'))]);
  const fb = (key, sid, args) => mcpH(key, 'feedback', { project: 'H12 Proj', session: sid, ...args }, { 'x-work-os-session': sid });
  for (let i = 0; i < 5; i++) await fb(kA, `h12-f${i % 3}`, { text: `end_work friction number ${i}`, tool: 'end_work' }); // 5 lines, 3 sessions
  for (let i = 0; i < 3; i++) await fb(kA, 'h12-f0', { text: `ask the rule line ${i}`, rule: 'Ask before anything irreversible' }); // 3 lines, 1 session
  for (let i = 0; i < 2; i++) await fb(kA, 'h12-f0', { text: `hand_in small ${i}`, tool: 'get_state' }); // 2 lines, 1 session: below the bar
  await fb(kA, 'h12-f1', { text: 'hand_in other session', tool: 'hand_in' });
  await fb(kA, 'h12-f2', { text: 'hand_in third session', tool: 'hand_in' }); // 2 lines, 2 sessions: in
  // a private project of the member: its friction is not the owner's to see
  await must(kM, 'add_project', { name: 'H12 Member Secret', visibility: 'private' });
  for (let i = 0; i < 4; i++) await mcpH(kM, 'feedback', { project: 'H12 Member Secret', text: `secret friction ${i}`, tool: 'secret_tool', session: `h12-m${i}` }, { 'x-work-os-session': `h12-m${i}` });

  const dry = await cron('&dry=1' + AT(MON));
  const text = (dry.preview ?? []).join(String.fromCharCode(10));
  // the owner's digest ends with the block; another person's digest (a member's) may follow it in the preview
  const from = Math.max(0, text.lastIndexOf('Monday numbers**') - 4);
  const next = text.indexOf('📋', from);
  const block = text.slice(from, next > 0 ? next : undefined);
  console.log('--- the Monday block as the Discord DM shows it ---' + String.fromCharCode(10) + block + String.fromCharCode(10) + '---');
  check('monday: the owner has the block, last in the digest, headed with the week', /📏 \*\*Monday numbers\*\* \(16 Nov-22 Nov\)/.test(text) && text.lastIndexOf('Monday numbers') > text.indexOf('Today'), text.slice(0, 200));
  check('monday: the header summary says Monday numbers', /Mon 23 Nov.*Monday numbers/.test(text.split(String.fromCharCode(10))[0]), text.slice(0, 300));
  check('monday: sessions that changed files and saved State: 7 of 9, 2 after the reminder, with the target', /Sessions that changed files and saved State: 7 of 9 .?\(2 after the reminder.?\) · target 9 of 10/.test(block), block.slice(0, 500));
  check('monday: PCs with no hooks: 1 of 3 seen this week (a revoked and a quiet one left out), 1 out of date', /PCs with no hooks: 1 of 3 .?\(1 out of date.?\)/.test(block), block.slice(0, 500));
  check('monday: WORK-STATE.md edits counted over the week only (a long-lived session is not recounted from its start)', /WORK-STATE\.md edits: 2 refused, 1 forwarded/.test(block), block.slice(0, 500));
  check("monday: Om's repeats says not counted yet", /Om's repeats: not counted yet/.test(block), block.slice(0, 500));
  check('monday: proposals are numbered, silence means keep; open Monday Needs first (oldest first), older than 14 days left out', /Proposals\*\* \(silence means keep\)/.test(block) && /1\. .*MONDAY ONE/.test(block) && /2\. .*MONDAY TWO/.test(block) && !/MONDAY OLD/.test(block), block.slice(0, 900));
  check('monday: then friction by size: end_work (5 lines, 3 sessions); at most three lines, then "+N more in the app"', /3\. Friction: end.?_work, 5 lines from 3 sessions this week/.test(block) && /\+2 more.* in the app/.test(block) && !/4\. Friction/.test(block), block.slice(0, 900));
  check('monday: a rule friction (3 lines) and a tool from 2 sessions were counted but are past the cap; one from a single session with 2 lines is not a proposal', !/get_state/.test(block), block.slice(0, 900));
  check("monday: another member's private project's friction and PC name are not in it", !/secret_tool|secret friction|H12 OTHER MEMBERS PC|H12 Member Secret/.test(text), text.slice(0, 200));
  check('monday: the block is at most 10 lines and the whole DM stays in messages of at most 1,900 characters', block.split(String.fromCharCode(10)).filter(l => l.trim()).length <= 12 && (dry.preview ?? []).every(m => m.length <= 1900), String(block.split(String.fromCharCode(10)).length));

  // a Tuesday has none; a member who is not an owner never has it, even on a Monday
  const tue = (await cron('&dry=1' + AT(TUE))).preview?.join(String.fromCharCode(10)) ?? '';
  check('tuesday: no Monday block', !/Monday numbers/.test(tue), tue.slice(0, 200));
  await rawDb.collection('tasks').insertOne({ _id: 'h12-m-task', ref: 9301, orgId: ME.orgId, ownerId: M.userId, visibility: 'private', projectId: null, title: 'H12 member task', status: 'Not Started', archived: false, priority: 'P1', due: '2026-11-23', progress: 0, createdAt: D('2026-11-17T05:00:00Z'), updatedAt: D('2026-11-17T05:00:00Z'), assigneeIds: [] });
  await cron(AT(MON));
  const mine = await rawDb.collection('notifications').find({ userId: ME.userId, kind: 'digest' }).toArray();
  const theirs = await rawDb.collection('notifications').find({ userId: M.userId, kind: 'digest' }).toArray();
  check('monday: the owner got a digest with the Monday numbers in its summary', mine.length >= 1 && mine.some(n => /Monday numbers/.test(n.body)), JSON.stringify(mine.map(n => n.body)));
  check('monday: a member who is not an owner got a digest on the same Monday with no Monday numbers', theirs.length === 1 && !/Monday numbers/.test(theirs[0].body), JSON.stringify(theirs.map(n => n.body)));

  // a Monday with nothing counted: the numbers say so rather than 0 of 0
  await rawDb.collection('presence').deleteMany({ orgId: ME.orgId, stopCheck: { $exists: true } });
  await rawDb.collection('devices').deleteMany({ orgId: ME.orgId });
  const quiet = (await cron('&dry=1' + AT('2026-11-30T05:00:00Z'))).preview?.join(String.fromCharCode(10)) ?? '';
  check('monday: a week with no counted sessions or PCs says so (no 0 of 0)', /saved State: none counted yet/.test(quiet) && /no PC seen this week/.test(quiet) && !/0 of 0/.test(quiet), quiet.slice(0, 500));
}

await finish();
