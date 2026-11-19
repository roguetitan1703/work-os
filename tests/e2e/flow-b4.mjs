// Flow B4, the personal daily digest (docs/flows/plan-1-3.md slice 2; redesigned 18 Nov: Needs you, Today, Since yesterday, Agents), driven through the cron's ?at=. Seed profile: none.
// People (one organization): ME (default 09:00), Q (quiet hours 09-12), H (digest at 14:00), O (digest switched off) and Dee
// (quiet until 12, owner of a private project). Profiles are saved before the first cron run (the app caches them a minute).
import { call, check, cron, db, finish, makeUser, mcpAs, mkKey, ME, rawDb, setProfile } from './lib.mjs';

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
// P3: Today's top 3 takes overdue P1/P2 only, so this one is the "+1 overdue" line.
const over = await mk('B4 overdue one', { project: 'B4 Alpha', due: '2026-11-10', priority: 'P3' });
const today = await mk('B4 due today one', { due: '2026-11-18' });
const quiet = await mk('B4 gone quiet one', { project: 'B4 Alpha' });
await tasks.updateOne({ _id: quiet.doc._id }, { $set: { status: 'In Progress', updatedAt: D('2026-11-10T06:00:00Z') } });
const overP1 = await mk('B4 overdue P1', { project: 'B4 Alpha', due: '2026-11-10', priority: 'P1' });
// A fixture day: two projects whose State changed yesterday, a running worker on one and a stalled (gone) one on the other.
await call('add_project', { name: 'B4 Beta' });
// set_now and done_next need base_version (lib/data/states.ts); a refused save would leave the fixture day half made.
const saveOk = async args => { const r = await call('save_state', args); if (!r || r.ERROR || /stale/.test(r.message ?? '')) throw new Error('save_state refused: ' + JSON.stringify(r).slice(0, 300)); return r; };
// set_now needs a session Work OS knows (Lanes): a fixture session, whose row is removed again so the roster shows only the workers below.
await call('start_work', { project: 'B4 Alpha', session: 'b4-fixture' });
await saveOk({ project: 'B4 Alpha', base_version: 0, session: 'b4-fixture', ops: [{ op: 'set_now', text: 'B4 ship the alpha' }, { op: 'add_decision', text: 'B4 go with plan A' }] });
await rawDb.collection('presence').deleteMany({ session: 'b4-fixture' });
await saveOk({ project: 'B4 Beta', ops: [{ op: 'add_next', text: 'B4 beta first' }, { op: 'add_next', text: 'B4 beta second' }] });
await saveOk({ project: 'B4 Beta', base_version: (await call('get_state', { project: 'B4 Beta' })).version, ops: [{ op: 'done_next', find: 'B4 beta first' }] });
const projId = async name => (await rawDb.collection('projects').findOne({ orgId: ME.orgId, name }))._id;
// "Since yesterday" reads the Activity feed: the State lines were written through save_state, so their feed rows are moved to yesterday.
await rawDb.collection('states').updateMany({ projectId: { $in: [await projId('B4 Alpha'), await projId('B4 Beta')] } }, { $set: { 'log.$[].at': new Date('2026-11-17T08:00:00Z') } });
await rawDb.collection('activity').updateMany({ projectId: { $in: [await projId('B4 Alpha'), await projId('B4 Beta')] }, type: { $in: ['state_now', 'next_added', 'next_done', 'decision'] } }, { $set: { at: new Date('2026-11-17T08:00:00Z') } });
const wKey = await mkKey({ agent: 'claude-code', name: 'B4 worker' });
await mcpAs(wKey, 'start_work', { project: 'B4 Alpha', label: 'builder A', model: 'Opus', session: 'b4-run' });
await mcpAs(wKey, 'start_work', { project: 'B4 Beta', label: 'builder S', model: 'Sonnet', session: 'b4-stall' });
await rawDb.collection('presence').updateOne({ _id: `${ME.userId}:s:b4-stall:${await projId('B4 Beta')}` }, { $set: { lastSeen: new Date(Date.now() - 40 * 60_000) } });
await db.collection('alertQueue').insertOne({ _id: `claude_finished:${fin.doc._id}:b4`, userId: ME.userId, kind: 'claude_finished', taskId: fin.doc._id, byTaskId: fin.doc._id, createdAt: D('2026-11-17T20:00:00Z'), sentAt: D('2026-11-17T20:00:01Z'), detail: 'tests pass' });
const act = (task, type, at) => db.collection('activity').insertOne({ _id: `b4-${task.ref}-${type}`, taskId: task.doc._id, taskRef: task.ref, taskTitle: task.doc.title, at: D(at), actor: { type: 'user', userId: ME.userId, name: 'E2E' }, type });
await act(fin, 'completed', '2026-11-17T06:00:00Z');
await act(quiet, 'edit', '2026-11-17T07:00:00Z');

// Dee's private project that moved yesterday: nobody else may see it.
await rawDb.collection('projects').insertOne({ _id: 'b4-dee-proj', orgId: ME.orgId, ownerId: Dee.userId, visibility: 'private', name: 'B4 DEE SECRET', nameLower: 'b4 dee secret', client: '', description: '', status: 'Active' });
await tasks.insertOne({ _id: 'b4-dee-task', ref: 9001, orgId: ME.orgId, ownerId: Dee.userId, visibility: 'private', projectId: 'b4-dee-proj', title: 'B4 secret work', status: 'In Progress', archived: false, priority: 'P3', due: null, progress: 0, createdAt: D('2026-11-17T05:00:00Z'), updatedAt: D('2026-11-17T06:00:00Z'), assigneeIds: [] });
await rawDb.collection('activity').insertOne({ _id: 'b4-dee-act', orgId: ME.orgId, ownerId: Dee.userId, visibility: 'private', taskId: 'b4-dee-task', taskRef: 9001, taskTitle: 'B4 secret work', at: D('2026-11-17T06:00:00Z'), actor: { type: 'user', userId: Dee.userId, name: 'Dee' }, type: 'completed' });

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
const ix = ['Today', 'Since yesterday', 'Agents'].map(h => text.indexOf(h));
check('dry: Today, Since yesterday and Agents are there, in order (no Needs yet)', ix.every(i => i >= 0) && ix.every((v, i) => i === 0 || v > ix[i - 1]) && !/Needs you/.test(text), JSON.stringify(ix) + text.slice(0, 900));
check('dry: the old sections are gone', !/Due and overdue|Gone quiet|What agents finished|Moved yesterday|Idle with Next work/.test(text), text.slice(0, 600));
check('dry: the header line has the date and the counts', /📋 \*\*Wed 18 Nov · 3 for today/.test(text) && /2 projects moved/.test(text) && /1 running, 1 stalled/.test(text), text.slice(0, 300));
// The digest's first line is its header (📋 date and counts), one per digest in the preview.
check('dry: one digest for ME (Q and Dee are quiet, H waits for 14:00, O has it off)', (text.match(/📋 \*\*/g) ?? []).length === 1, String((text.match(/📋 \*\*/g) ?? []).length));
check('dry: Today names the overdue P1 and the due-today task, and counts the other overdue one', [overP1, today].every(t => text.includes(`/tasks/${t.ref}>`)) && /\+1 overdue, on Today/.test(text) && !text.includes(`/tasks/${over.ref}>`), text.slice(0, 900));
check('dry: Since yesterday has one line per project that changed (Next lines, Now, decision, tasks done)', /B4 Alpha · .*Now changed.*1 decision.*1 task done/.test(text) && /B4 Beta · .*1 Next line done.*2 added/.test(text), text.slice(0, 900));
check('dry: Agents has the running and the stalled worker', /Running: B4 Alpha · builder A/.test(text) && /Stalled: B4 Beta · builder S .*quiet 4\d min, 1 Next line ready/.test(text), text.slice(0, 900));
check('dry: the first digest says the morning alerts are now this digest', /New: your daily digest/.test(text));
check("dry: another person's private project is not in it", !/DEE SECRET/.test(text));
check('dry: nothing was claimed', (await rawDb.collection('alertLog').countDocuments({ kind: 'digest' })) === 0);

// 2. the real run: one digest in ME's inbox, no separate due/overdue/stalled for what it holds
await cron(at(AT));
check('run: ME has exactly one digest in the inbox', (await inbox(ME, 'digest')) === 1, String(await inbox(ME, 'digest')));
check('run: no separate overdue / due today / stalled alert for ME', (await inbox(ME, 'overdue')) + (await inbox(ME, 'due_today')) + (await inbox(ME, 'stalled')) === 0);
const row = await rawDb.collection('notifications').findOne({ userId: ME.userId, kind: 'digest' });
check('run: the digest opens Today and has a one-line summary', row?.url === '/today' && /^Wed 18 Nov · /.test(row.body) && /for today/.test(row.body) && /2 projects moved/.test(row.body) && /1 running, 1 stalled/.test(row.body), JSON.stringify(row));
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
check('the owner of the private project sees it moved in her own digest (3 projects: the two shared ones and hers)', /3 projects moved/.test(deeRow?.body ?? ''), JSON.stringify(deeRow));
check('digestHour: H (14:00) still has nothing at 13:30', (await inbox(H)) === 0);
await cron(at('2026-11-18T09:00:00Z'));
check('digestHour: H gets one digest at 14:30, no separate overdue', (await inbox(H, 'digest')) === 1 && (await inbox(H, 'overdue')) === 0, `${await titles(H)}`);

// 6. next day: a new digest, without the first-digest line and without yesterday's finished run
const dry2 = await cron('&dry=1' + at('2026-11-19T05:00:00Z'));
const t2 = (dry2.preview ?? []).join('\n');
check('next day: a digest with Today, but no first-digest line and nothing moved since the last one', /Today/.test(t2) && /Thu 19 Nov/.test(t2) && !/New: your daily digest/.test(t2) && !/Since yesterday/.test(t2), t2.slice(0, 500));
await cron(at('2026-11-19T05:00:00Z'));
check('next day: ME has two digests in all', (await inbox(ME, 'digest')) === 2, String(await inbox(ME, 'digest')));

// 7. A key clash must not cost the day's digest: the overdue key of a task that changed owner already belongs to the
// old owner (alertLog ids are shared), so claiming it for ME clashes.
const moved = await mk('B4 changed owner', { due: '2026-11-10' });
await rawDb.collection('alertLog').insertOne({ _id: `overdue:${moved.doc._id}:2026-11-10`, orgId: ME.orgId, userId: Dee.userId, kind: 'overdue', taskId: moved.doc._id, sentAt: D('2026-11-12T05:00:00Z') });
await cron(at('2026-11-20T05:00:00Z'));
check('key clash: ME still gets the digest of the day (3 in all)', (await inbox(ME, 'digest')) === 3, `${await inbox(ME, 'digest')}`);

// 8. two cron runs at once: exactly one digest
await Promise.all([cron(at('2026-11-21T05:00:00Z')), cron(at('2026-11-21T05:00:00Z'))]);
check('two concurrent runs: exactly one digest for the day (4 in all)', (await inbox(ME, 'digest')) === 4, `${await inbox(ME, 'digest')}`);

// 9. ?at= is validated
const badAt = await cron('&dry=1&at=not-a-date');
check('an invalid at is refused', !!badAt.error, JSON.stringify(badAt));

// 10. Needs you comes first in the digest (slice 6)
const codeKey = await mkKey({ agent: 'claude-code', name: 'B4 agent' });
const needR = await mcpAs(codeKey, 'ask', { project: 'B4 Alpha', to: 'me', kind: 'approve', ask: 'B4 may I ship the thing?' });
check('needs: the ask went through', !needR.isError, needR.text.slice(0, 200));
const dry3 = await cron('&dry=1' + at('2026-11-24T05:00:00Z'));
const t3 = (dry3.preview ?? []).join('\n');
const i3 = ['Needs you', 'Today'].map(h => t3.indexOf(h));
check('needs: "Needs you" is the first section of the digest, above Today, with its project and the buttons hint', i3[0] >= 0 && i3[1] > i3[0] && /B4 Alpha: B4 may I ship/.test(t3) && /\/today#need-/.test(t3) && /buttons below/.test(t3), t3.slice(0, 500));
await cron(at('2026-11-24T05:00:00Z'));
const row3 = await rawDb.collection('notifications').findOne({ userId: ME.userId, kind: 'digest' }, { sort: { createdAt: -1 } });
check('needs: the digest summary counts it', /1 needs? you/.test(row3?.body ?? ''), JSON.stringify(row3?.body));

// ...and only Needs the person can still act on: not an answered or withdrawn one, not one on a project they can no longer read
await mcpAs(codeKey, 'ask', { project: 'B4 Alpha', to: 'me', kind: 'do', ask: 'B4-WITHDRAWN-ASK' });
await mcpAs(codeKey, 'ask', { project: 'B4 Alpha', to: 'me', kind: 'chase', ask: 'B4-ANSWERED-ASK' });
await mcpAs(codeKey, 'add_project', { name: 'B4 Gone' });
await mcpAs(codeKey, 'ask', { project: 'B4 Gone', to: 'me', kind: 'approve', ask: 'B4-GONE-ASK' });
await rawDb.collection('needs').updateOne({ ask: 'B4-WITHDRAWN-ASK' }, { $set: { status: 'withdrawn', closedAt: new Date() } });
await rawDb.collection('needs').updateOne({ ask: 'B4-ANSWERED-ASK' }, { $set: { status: 'answered', answeredAt: new Date(), closedAt: new Date() } });
const goneP = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: 'B4 Gone' });
await rawDb.collection('projects').updateOne({ _id: goneP._id }, { $set: { visibility: 'private', ownerId: Dee.userId } });
await rawDb.collection('needs').updateMany({ projectId: goneP._id }, { $set: { visibility: 'private', ownerId: Dee.userId } });
const dry4 = await cron('&dry=1' + at('2026-11-25T05:00:00Z'));
const t4 = (dry4.preview ?? []).join('\n');
check('needs: the digest leaves out answered, withdrawn and unreadable-project Needs, and keeps the open one', /B4 may I ship/.test(t4) && !/B4-WITHDRAWN-ASK|B4-ANSWERED-ASK|B4-GONE-ASK/.test(t4), t4.slice(0, 600));

const prof = await rawDb.collection('settings').findOne({ _id: `profile:${H.userId}` });
check('digestHour is stored on the profile', prof?.digestHour === 14);
await finish();
