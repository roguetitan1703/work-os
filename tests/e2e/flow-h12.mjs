// Flow H12 (docs/flows/agent-system.md sections 10, 12 and 16.12; plan note 7f5824bbed): the phone rule, the hook counters and
// the Monday block.
//   part 1  what reaches the phone: a release Need and a Need a person asked always; a review Need and a Monday Need never; any other
//           agent Need only while the asking session is not off (checked when queued and again when sent, after quiet hours); a
//           Monday Need is not in the daily "Needs you".
// Seed profile: none.
import { check, cron, finish, makeUser, mkKey, rawDb, setProfile, ME, MCP } from './lib.mjs';
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
// The alert flush after an ask runs at the real time, so Q's quiet hours are the two hours that start now (IST, the default zone).
{
  const istHour = (new Date(Date.now() + 330 * 60_000)).getUTCHours();
  const qe = (istHour + 2) % 24;
  const later = (h, m) => new Date(Date.UTC(2026, 10, 24, h, m) - 330 * 60_000).toISOString(); // Tue 24 Nov, h:m IST
  const Q = await makeUser({ email: 'h12-q@example.test', name: 'H12 Quiet', orgId: ME.orgId, role: 'member' });
  await setProfile(Q, { quietStart: istHour, quietEnd: qe, digestHour: (qe + 1) % 24 });
  await live('h12-night');
  const nq = await must(kA, 'ask', { project: 'H12 Proj', to: 'H12 Quiet', kind: 'decide', ask: 'H12 NIGHT ASK', options: [{ label: 'One' }, { label: 'Two' }], session: 'h12-night' }, { 'x-work-os-session': 'h12-night' });
  await sleep(1500);
  const held = await queued(nq.need.id);
  check('quiet hours: the alert is held (queued, not sent, nothing in the inbox)', !!held && !held.sentAt && !(await notes(Q.userId)).length, JSON.stringify(held));
  await endSession('h12-night'); // the session ends while the alert is held
  await cron(AT(later((qe + 1) % 24, 0))); // quiet hours are over: the send-time check finds the session off
  check('send time: once quiet hours end the alert is dropped because the asking session is off', !(await notes(Q.userId)).length, JSON.stringify((await notes(Q.userId)).map(n => n.title)));
  const dry = await cron('&dry=1' + AT(later((qe + 1) % 24, 30)));
  const text = (dry.preview ?? []).join(String.fromCharCode(10));
  check("digest: the Need is in the digest's Needs you", /Needs you/.test(text) && /H12 NIGHT ASK/.test(text), text.slice(0, 600));
}

await finish();
