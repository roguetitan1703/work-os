// Flow B4, the personal daily digest (docs/flows/plan-1-3.md slice 2), driven through the cron's ?at=. Seed profile: none.
// People (one organization): ME (default 09:00), Q (quiet hours 09-12), H (digest at 14:00), O (digest switched off) and Dee
// (quiet until 12, owner of a private project). Profiles are saved before the first cron run (the app caches them a minute).
import { call, check, cron, db, finish, makeUser, ME, rawDb, setProfile } from './lib.mjs';

const mkPerson = async (email, name) => makeUser({ email, name, orgId: ME.orgId, role: 'member' });
const Q = await mkPerson('b4-q@example.test', 'B4 Quiet');
const H = await mkPerson('b4-h@example.test', 'B4 Late');
const O = await mkPerson('b4-o@example.test', 'B4 Off');
const Dee = await mkPerson('b4-dee@example.test', 'B4 Dee');
await setProfile(Q, { quietStart: 9, quietEnd: 12 });
await setProfile(Dee, { quietStart: 9, quietEnd: 12 });
await setProfile(H, { digestHour: 14 });
await rawDb.collection('settings').insertOne({ _id: `notify:${O.userId}`, area: 'notify', orgId: ME.orgId, userId: O.userId, notify: { kinds: { digest: false } } });

const tasks = rawDb.collection('tasks');
const D = iso => new Date(iso);
const AT = '2026-11-18T05:00:00Z'; // Wed 10:30 IST
const mk = async (title, extra = {}) => {
  const r = (await call('add_task', { title, ...extra })).created;
  return { ref: r.ref, doc: await tasks.findOne({ orgId: ME.orgId, ref: r.ref }) };
};
const give = (t, who) => tasks.updateOne({ _id: t.doc._id }, { $set: { ownerId: who.userId, visibility: 'private' } });

// ME: a finished run, an overdue task, a due-today task, a quiet task, and a visible project that moved yesterday.
await call('add_project', { name: 'B4 Alpha' });
const fin = await mk('B4 agent result', { project: 'B4 Alpha' });
const over = await mk('B4 overdue one', { project: 'B4 Alpha', due: '2026-11-10' });
const today = await mk('B4 due today one', { due: '2026-11-18' });
const quiet = await mk('B4 gone quiet one', { project: 'B4 Alpha' });
await tasks.updateOne({ _id: quiet.doc._id }, { $set: { status: 'In Progress', updatedAt: D('2026-11-10T06:00:00Z') } });
await db.collection('alertQueue').insertOne({ _id: `claude_finished:${fin.doc._id}:b4`, userId: ME.userId, kind: 'claude_finished', taskId: fin.doc._id, byTaskId: fin.doc._id, createdAt: D('2026-11-17T20:00:00Z'), sentAt: D('2026-11-17T20:00:01Z'), detail: 'tests pass' });
const act = (task, type, at) => db.collection('activity').insertOne({ _id: `b4-${task.ref}-${type}`, taskId: task.doc._id, taskRef: task.ref, taskTitle: task.doc.title, at: D(at), actor: { type: 'user', userId: ME.userId, name: 'E2E' }, type });
await act(fin, 'completed', '2026-11-17T06:00:00Z');
await act(quiet, 'edit', '2026-11-17T07:00:00Z');

// Dee's private project that moved yesterday: nobody else may see it.
await rawDb.collection('projects').insertOne({ _id: 'b4-dee-proj', orgId: ME.orgId, ownerId: Dee.userId, visibility: 'private', name: 'B4 DEE SECRET', nameLower: 'b4 dee secret', client: '', description: '', status: 'Active' });
await tasks.insertOne({ _id: 'b4-dee-task', ref: 9001, orgId: ME.orgId, ownerId: Dee.userId, visibility: 'private', projectId: 'b4-dee-proj', title: 'B4 secret work', status: 'In Progress', archived: false, priority: 'P3', due: null, progress: 0, createdAt: D('2026-11-17T05:00:00Z'), updatedAt: D('2026-11-17T06:00:00Z'), assigneeIds: [] });
await rawDb.collection('activity').insertOne({ _id: 'b4-dee-act', orgId: ME.orgId, ownerId: Dee.userId, visibility: 'private', taskId: 'b4-dee-task', taskRef: 9001, taskTitle: 'B4 secret work', at: D('2026-11-17T06:00:00Z'), actor: { type: 'user', userId: Dee.userId, name: 'Dee' }, type: 'status' });

// Q, H and O each have one overdue task of their own.
const qT = await mk('B4 Q overdue', { due: '2026-11-10' }); await give(qT, Q);
const hT = await mk('B4 H overdue', { due: '2026-11-10' }); await give(hT, H);
const oT = await mk('B4 O overdue', { due: '2026-11-10' }); await give(oT, O);

const inbox = (who, kind) => rawDb.collection('notifications').countDocuments({ userId: who.userId, ...(kind ? { kind } : {}) });
const titles = async who => JSON.stringify((await rawDb.collection('notifications').find({ userId: who.userId }).sort({ createdAt: 1 }).toArray()).map(n => `${n.kind}:${n.title}`));
const at = iso => `&at=${iso}`;

// 1. dry run at 10:30: exactly one digest for ME, the four sections in order, first-digest line, nothing of Dee's project
const dry = await cron('&dry=1' + at(AT));
const text = (dry.preview ?? []).join('\n');
const ix = ['What agents finished', 'Due and overdue', 'Gone quiet', 'Moved yesterday'].map(h => text.indexOf(h));
check('dry: the four sections are all there, in order', ix.every(i => i >= 0) && ix.every((v, i) => i === 0 || v > ix[i - 1]), JSON.stringify(ix) + text.slice(0, 600));
check('dry: one digest for ME (Q and Dee are quiet, H waits for 14:00, O has it off)', (text.match(/Your daily digest/g) ?? []).length === 1, String((text.match(/Your daily digest/g) ?? []).length));
check('dry: finished, overdue, due today, quiet and the project are named', [fin, over, today, quiet].every(t => text.includes(`/tasks/${t.ref}>`)) && /B4 Alpha/.test(text), text.slice(0, 600));
check('dry: the first digest says the morning alerts are now this digest', /New: your daily digest/.test(text));
check("dry: another person's private project is not in it", !/DEE SECRET/.test(text));
check('dry: nothing was claimed', (await rawDb.collection('alertLog').countDocuments({ kind: 'digest' })) === 0);

// 2. the real run: one digest in ME's inbox, no separate due/overdue/stalled for what it holds
await cron(at(AT));
check('run: ME has exactly one digest in the inbox', (await inbox(ME, 'digest')) === 1, String(await inbox(ME, 'digest')));
check('run: no separate overdue / due today / stalled alert for ME', (await inbox(ME, 'overdue')) + (await inbox(ME, 'due_today')) + (await inbox(ME, 'stalled')) === 0);
const row = await rawDb.collection('notifications').findOne({ userId: ME.userId, kind: 'digest' });
check('run: the digest opens Today and has a one-line summary', row?.url === '/today' && /1 finished/.test(row.body) && /due or overdue/.test(row.body) && /quiet/.test(row.body) && /1 project moved/.test(row.body), JSON.stringify(row));
check('run: the digest is claimed once for the day', (await rawDb.collection('alertLog').countDocuments({ userId: ME.userId, _id: `digest:2026-11-18:${ME.userId}` })) === 1);
check('run: Q (quiet 09-12), H (14:00) and Dee (quiet) have nothing yet', (await inbox(Q)) === 0 && (await inbox(H)) === 0 && (await inbox(Dee)) === 0, `${await inbox(Q)} ${await inbox(H)} ${await inbox(Dee)}`);
check('run: O has the digest off: no digest, and the old morning alert (overdue) as before', (await inbox(O, 'digest')) === 0 && (await inbox(O, 'overdue')) === 1, `${await inbox(O, 'digest')} ${await inbox(O, 'overdue')}`);

// 3. the same day again sends nothing more to ME
const before = await inbox(ME);
await cron(at('2026-11-18T05:15:00Z'));
await cron(at('2026-11-18T05:30:00Z'));
check('same day: a second and third run send ME nothing', (await inbox(ME)) === before, `${before} -> ${await inbox(ME)} ${await titles(ME)}`);

// 4. a task that turns overdue after the digest hour alerts on its own
const late = await mk('B4 turned overdue later', { due: '2026-11-17' });
await cron(at('2026-11-18T06:15:00Z')); // 11:45 IST
check('after the digest: a task that became overdue alerts on its own, once', (await rawDb.collection('notifications').countDocuments({ userId: ME.userId, kind: 'overdue', title: new RegExp(`#${late.ref} `) })) === 1);
check('after the digest: no second digest, and the morning ones stay quiet', (await inbox(ME, 'digest')) === 1 && (await inbox(ME, 'overdue')) === 1);
await cron(at('2026-11-18T06:25:00Z')); // 11:55 IST
check('after the digest: that alert is not repeated', (await inbox(ME, 'overdue')) === 1);
check('quiet hours: Q (09-12) at 11:45 still holds the digest', (await inbox(Q)) === 0);

// 5. quiet hours end: Q and Dee get theirs at 13:30; H waits for 14:00, then gets it at 14:30
await cron(at('2026-11-18T08:00:00Z'));
check('quiet hours held it: Q gets one digest after 12:00', (await inbox(Q, 'digest')) === 1 && (await inbox(Q, 'overdue')) === 0, await titles(Q));
const deeRow = await rawDb.collection('notifications').findOne({ userId: Dee.userId, kind: 'digest' });
check('the owner of the private project sees it moved in her own digest (2 projects: the shared one and hers)', /2 projects moved/.test(deeRow?.body ?? ''), JSON.stringify(deeRow));
check('digestHour: H (14:00) still has nothing at 13:30', (await inbox(H)) === 0);
await cron(at('2026-11-18T09:00:00Z'));
check('digestHour: H gets one digest at 14:30, no separate overdue', (await inbox(H, 'digest')) === 1 && (await inbox(H, 'overdue')) === 0, `${await titles(H)}`);

// 6. next day: a new digest, without the first-digest line and without yesterday's finished run
const dry2 = await cron('&dry=1' + at('2026-11-19T05:00:00Z'));
const t2 = (dry2.preview ?? []).join('\n');
check('next day: a digest with Due and overdue, but no first-digest line and no finished section', /Due and overdue/.test(t2) && !/New: your daily digest/.test(t2) && !/What agents finished/.test(t2), t2.slice(0, 500));
await cron(at('2026-11-19T05:00:00Z'));
check('next day: ME has two digests in all', (await inbox(ME, 'digest')) === 2, String(await inbox(ME, 'digest')));

const prof = await rawDb.collection('settings').findOne({ _id: `profile:${H.userId}` });
check('digestHour is stored on the profile', prof?.digestHour === 14);
await finish();
