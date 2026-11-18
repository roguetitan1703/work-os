// Recurring tasks repeat on the calendar (Om, 18 Nov): the alerts cron makes a series' next copy on the day its head
// (the latest copy) is due, in the owner's timezone, whether or not the head is done. Completing makes no copy. Checks:
// nothing before the due date; the copy on the due date, done or not (due moved on, start kept the same distance before
// it, checklist unticked, same owner, assignees kept without an "assigned" notice, history by the system); no second
// copy from a second run or from overlapping runs; a series that fell behind makes one copy, not a backlog; a head with
// no due date counts from the day it was made; Never, archive and trash end the series; the owner's timezone decides
// the day. Times are simulated with the cron's ?at= (CRON_ALLOW_AT on the e2e database). Seed profile: none.
import { B, CRON, ME, call, check, finish, makeUser, mcpAs, mkKey, rawDb, setProfile } from './lib.mjs';

const T = rawDb.collection('tasks');
const cronAt = iso => fetch(`${B}/api/cron/alerts?at=${encodeURIComponent(iso)}`, { headers: { authorization: `Bearer ${CRON}` } }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const byTitle = title => T.find({ orgId: ME.orgId, title }).sort({ ref: 1 }).toArray();
const add = async args => {
  const r = await call('add_task', args);
  if (!r?.created?.ref) throw new Error(`add_task ${args.title}: ${JSON.stringify(r)}`);
  return r.created.ref;
};

// A teammate to assign, and a teammate in Los Angeles (profile set before the app ever reads it: it caches a minute).
const bea = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: ME.orgId });
const lee = await makeUser({ email: 'lee@example.test', name: 'Lee', orgId: ME.orgId });
await setProfile(lee, { timezone: 'America/Los_Angeles' });
const kLee = await mkKey({ agent: 'claude', userId: lee.userId, orgId: ME.orgId, name: 'lee chat' });

await call('add_project', { name: 'Ops' });
// The owner is in Asia/Kolkata (UTC+5:30). Every series below is due Monday 2030-01-07 unless it says otherwise.
const weekly = await add({ title: 'Weekly report', project: 'Ops', assignees: ['me', 'bea@example.test'], due: '2030-01-07', start: '2030-01-05', checklist: ['Collect numbers', 'Send'], recurrence: { freq: 'weekly', interval: 1 } });
const standup = await add({ title: 'Standup notes', due: '2030-01-07', recurrence: { freq: 'daily', interval: 1 } });
const never = await add({ title: 'Stopped series', due: '2030-01-07', recurrence: { freq: 'daily', interval: 1 } });
const archived = await add({ title: 'Archived series', due: '2030-01-07', recurrence: { freq: 'daily', interval: 1 } });
const trashed = await add({ title: 'Trashed series', due: '2030-01-07', recurrence: { freq: 'daily', interval: 1 } });
const behind = await add({ title: 'Fell behind', due: '2029-12-04', recurrence: { freq: 'weekly', interval: 1 } });
const undated = await add({ title: 'Undated weekly', recurrence: { freq: 'weekly', interval: 1 } });
check('setup: seven recurring tasks made', [weekly, standup, never, archived, trashed, behind, undated].every(Number.isInteger));
check('setup: the teammate was told about the original assignment (the control for the quiet copy)', (await rawDb.collection('alertQueue').countDocuments({ kind: 'assigned', userId: bea.userId })) === 1);

// ---- the day before: nothing, even when done early ----
await call('update_checklist', { task: weekly, check: [1] });
let r = await cronAt('2030-01-06T12:00:00Z'); // 17:30 on the 6th in Kolkata
// Only the two series already due make a copy: the one that fell behind and the undated one.
check('cron the day before the due date: copies only what is already due', r.status === 200 && r.body?.copies === 2, JSON.stringify(r.body));
check('the day before: no copy of a series due tomorrow', (await byTitle('Weekly report')).length === 1 && (await byTitle('Standup notes')).length === 1);

// A series that fell behind (due 2029-12-04, five weeks missed): one copy, due on the next beat that is today or later.
let fb = await byTitle('Fell behind');
check('fell behind: one copy, not a backlog', fb.length === 2 && fb[0].nextRef === fb[1].ref, JSON.stringify(fb.map(t => [t.ref, t.due])));
check('fell behind: the copy is due on the next beat on or after today', fb[1]?.due === '2030-01-08', fb[1]?.due);

// A head with no due date counts from the day it was made (in the owner's timezone): its copy is due on the first
// weekly beat from that day that is on or after the run's day (the 6th).
const ud = await byTitle('Undated weekly');
const madeDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(ud[0].createdAt);
const dayDiff = d => Math.round((Date.parse(d) - Date.parse(madeDay)) / 86_400_000);
check('undated head: one copy, due on its weekly beat from the day it was made', ud.length === 2 && ud[1].due >= '2030-01-06' && ud[1].due < '2030-01-13' && dayDiff(ud[1].due) % 7 === 0, JSON.stringify(ud.map(t => [t.ref, t.due]).concat([madeDay])));

const done = await call('complete_task', { task: weekly, note: 'sent early' });
check('complete_task on a recurring task works', !done?.ERROR, JSON.stringify(done).slice(0, 300));
let wk = await byTitle('Weekly report');
check('completing a recurring task makes no copy', wk.length === 1 && wk[0].status === 'Done' && wk[0].nextRef == null, JSON.stringify(wk.map(t => [t.ref, t.status, t.nextRef])));

// ---- the ends: Never, archive, trash ----
await call('update_task', { task: never, recurrence: null, note: 'stop it' });
await call('apply_changes', { ops: [{ op: 'archive_task', task: archived }, { op: 'delete_task', task: trashed, title: 'Trashed series' }] });
check('setup: archived and trashed', (await T.findOne({ ref: archived, orgId: ME.orgId }))?.archived === true && !(await T.findOne({ ref: trashed, orgId: ME.orgId })));

// ---- the due date: the copy, done or not ----
r = await cronAt('2030-01-06T19:00:00Z'); // 00:30 on the 7th in Kolkata (still the 6th in UTC)
check('cron on the due date answers 200', r.status === 200, JSON.stringify(r.body));
wk = await byTitle('Weekly report');
const [head, copy] = wk;
check('done head: one copy on its due date', wk.length === 2 && head.nextRef === copy?.ref, JSON.stringify(wk.map(t => [t.ref, t.due, t.nextRef])));
check('copy: open, same title, project and recurrence', copy?.status === 'Not Started' && copy.projectId === head.projectId && copy.recurrence?.freq === 'weekly' && copy.recurrence.interval === 1, JSON.stringify(copy));
check('copy: due one week on, start the same 2 days before', copy?.due === '2030-01-14' && copy.start === '2030-01-12', JSON.stringify({ due: copy?.due, start: copy?.start }));
check('copy: checklist copied and all unticked', copy?.checklist?.length === 2 && copy.checklist.every(i => !i.done) && copy.checklist.map(i => i.text).join() === 'Collect numbers,Send', JSON.stringify(copy?.checklist));
check('copy: same owner and assignees', copy?.ownerId === head.ownerId && [...(copy?.assigneeIds ?? [])].sort().join() === [...(head.assigneeIds ?? [])].sort().join() && copy.assigneeIds.includes(bea.userId), JSON.stringify([copy?.assigneeIds, head.assigneeIds]));
check('copy: the assignees get no "assigned to you" notice', (await rawDb.collection('alertQueue').countDocuments({ kind: 'assigned', taskId: copy?._id })) === 0);
const made = await rawDb.collection('activity').findOne({ taskId: copy?._id, type: 'created' });
check('copy: history says "Next occurrence of #N", by the system', made?.note === `Next occurrence of #${weekly}` && made.actor?.kind === 'system', JSON.stringify(made));
const sd = await byTitle('Standup notes');
check('open head: the copy comes anyway, the head stays open', sd.length === 2 && sd[0].status === 'Not Started' && sd[0].nextRef === sd[1].ref && sd[1].due === '2030-01-08', JSON.stringify(sd.map(t => [t.ref, t.status, t.due, t.nextRef])));
const sdDone = await call('complete_task', { task: standup });
check('complete_task on a head that has its copy: the answer names it, no further copy', sdDone?.nextOccurrence?.ref === sd[1]?.ref && (await byTitle('Standup notes')).length === 2, JSON.stringify(sdDone).slice(0, 300));

check('repeat set to Never: no copy', (await byTitle('Stopped series')).length === 1);
check('archived head: no copy', (await byTitle('Archived series')).length === 1);
check('trashed head: no copy', (await byTitle('Trashed series')).length === 0);
fb = await byTitle('Fell behind');
check('fell behind: its copy (due the 8th) is not due yet, nothing more', fb.length === 2, JSON.stringify(fb.map(t => [t.ref, t.due])));

// ---- a second run, then overlapping runs: never a second copy ----
const before = await T.countDocuments({ orgId: ME.orgId });
r = await cronAt('2030-01-06T19:30:00Z');
check('a second run the same day makes no copy', r.body?.copies === 0 && (await T.countDocuments({ orgId: ME.orgId })) === before, JSON.stringify(r.body));
const race = await add({ title: 'Overlap check', due: '2030-01-07', checklist: ['One'], recurrence: { freq: 'daily', interval: 1 } });
const runs = await Promise.all(Array.from({ length: 4 }, () => cronAt('2030-01-06T20:00:00Z')));
const rc = await byTitle('Overlap check');
check('four overlapping runs: exactly one copy', rc.length === 2 && rc[0].ref === race && rc[0].nextRef === rc[1].ref, JSON.stringify(rc.map(t => [t.ref, t.nextRef])));
check('four overlapping runs: one of them counted it, none failed', runs.reduce((n, x) => n + (x.body?.copies ?? 0), 0) === 1 && runs.every(x => x.status === 200), JSON.stringify(runs.map(x => [x.status, x.body?.copies, x.body?.error])));
check('no claim is left behind (no nextRef 0)', (await T.countDocuments({ orgId: ME.orgId, nextRef: 0 })) === 0);

// Completing the copy before its due date still makes nothing; its own due date does.
await call('complete_task', { task: copy.ref });
check('completing the copy early makes no copy', (await byTitle('Weekly report')).length === 2);
await cronAt('2030-01-13T19:00:00Z'); // the 14th in Kolkata
wk = await byTitle('Weekly report');
check('the copy\'s own due date brings the third, due a week on', wk.length === 3 && wk[1].nextRef === wk[2].ref && wk[2].due === '2030-01-21' && wk[2].start === '2030-01-19', JSON.stringify(wk.map(t => [t.ref, t.due, t.start, t.nextRef])));
check('the series still ends where it was stopped', (await byTitle('Stopped series')).length === 1 && (await byTitle('Archived series')).length === 1);

// ---- the owner's timezone decides the day ----
const la = (await mcpAs(kLee, 'add_task', { title: 'LA daily', due: '2030-01-20', recurrence: { freq: 'daily', interval: 1 } })).json?.created?.ref;
check('setup: a recurring task of a teammate in Los Angeles', Number.isInteger(la));
await cronAt('2030-01-20T06:00:00Z'); // 11:30 on the 20th in Kolkata, but 22:00 on the 19th in Los Angeles
check('timezone: not yet the due date in the owner\'s timezone, no copy', (await byTitle('LA daily')).length === 1);
await cronAt('2030-01-20T08:30:00Z'); // 00:30 on the 20th in Los Angeles
const lad = await byTitle('LA daily');
check('timezone: on the due date in the owner\'s timezone, the copy', lad.length === 2 && lad[1].due === '2030-01-21' && lad[1].ownerId === lee.userId, JSON.stringify(lad.map(t => [t.ref, t.due, t.ownerId === lee.userId])));

await finish();
