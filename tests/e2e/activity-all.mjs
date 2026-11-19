// Activity shows everything that changed (Work OS note e56029b458): State, notes, messages, Needs and projects in the
// one feed next to tasks, each row placed like its subject.
//   - every new kind is written (recent_activity, the What filter, Review › Activity, the project page);
//   - a note edit makes one row per editor per hour; a message's body and a Need's answer text are never in a row;
//     text someone else wrote is labelled writtenBy, a title or old name someone else wrote titleWrittenBy;
//   - a private project's rows are unseen by a teammate (T) and by a second organization (X): MCP and pages;
//   - a visibility change hides and shows the rows: org → private → org → chosen people without T → with T;
//   - a task moved from a shared to a private project takes its note's rows and its Need's rows along; a task taken
//     out of every project leaves the project behind, so sharing that project later does not share its Need;
//   - trash and restore: a deleted note's rows leave every feed (get_project too) and come back on restore; a deleted
//     task takes its note's rows to the trash and brings them back;
//   - a page of the feed is full even when the newest rows drop out after the query (notes in the trash);
//   - after every change, each row is placed exactly like its subject (State, project, note, message, Need, task).
// Needs the built app (server actions are called by their manifest id). Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { B, EMAIL, ME, MCP, PW, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = n => randomBytes(n).toString('hex');
const mark = tag => `actq${tag}${hex(4)}`;

// ── calls (the same helpers as leak-audit.mjs) ──
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
const ACTIONS = {};
for (const [id, v] of Object.entries(MANIFEST)) {
  const workers = Object.keys(v.workers);
  const w = v.exportedName ? v : v.workers[workers[0]];
  const page = workers.map(p => '/' + p.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(s => !/^\(.*\)$/.test(s)).join('/')).sort((a, b) => (/\[/.test(a) - /\[/.test(b)) || (a === '/menu' ? -1 : b === '/menu' ? 1 : a.length - b.length))[0];
  ACTIONS[`${w.filename}#${w.exportedName}`] = { id, page: page.replace(/\[[^\]]+\]/g, 'x') || '/' };
}
function rsc(text) {
  const rows = new Map();
  for (const line of text.split('\n')) { const m = line.match(/^([0-9a-f]+):(.*)$/); if (m) rows.set(m[1], m[2]); }
  let head = null;
  try { head = JSON.parse(rows.get('0') ?? 'null'); } catch { /* not a result */ }
  const a = head?.a;
  if (typeof a === 'string' && a.startsWith('$@')) {
    const row = rows.get(a.slice(2)) ?? '';
    if (row.startsWith('E')) return { error: true, value: null };
    try { return { value: JSON.parse(row) }; } catch { return { value: row }; }
  }
  return { value: a === undefined ? null : a, error: head === null };
}
async function action(name, args, cookie) {
  const a = ACTIONS[name];
  if (!a) return { value: null, missing: true };
  const r = await fetch(B + a.page, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  const text = await r.text();
  return r.headers.get('content-type')?.includes('text/x-component') ? rsc(text) : { error: true, value: null };
}
const page = async (p, cookie) => {
  const r = await fetch(B + p, { redirect: 'manual', headers: { cookie } });
  return { status: r.status, text: await r.text() };
};
const feed = async (key, args = {}) => {
  const r = await mcpH(key, 'recent_activity', { since: '1d', limit: 300, ...args });
  return { ok: !r.isError, text: r.text, events: r.json?.events ?? [] };
};

// ── placement: every row is placed like its subject ──
const place = d => JSON.stringify([d.orgId, d.ownerId, d.visibility, d.visibility === 'members' ? [...new Set([d.ownerId, ...(d.sharedWith ?? [])])].sort() : []]);
const COLL = { state: 'states', project: 'projects', note: 'notes', message: 'messages', need: 'needs' };
async function placedLikeSubjects(label) {
  const rows = await rawDb.collection('activity').find({ subject: { $exists: true } }).toArray();
  const bad = [];
  for (const r of rows) {
    // A task's note rows carry the task and are placed like it; every other row like its own subject.
    const subj = r.taskId ? await rawDb.collection('tasks').findOne({ _id: r.taskId }) : await rawDb.collection(COLL[r.subject.kind]).findOne({ _id: r.subject.id });
    if (!subj) bad.push(`${r.type} ${r.subject.kind}: subject missing`);
    else if (place(subj) !== place(r)) bad.push(`${r.type} ${r.subject.kind}: row ${place(r)} subject ${place(subj)}`);
  }
  check(`placement: each of the ${rows.length} rows is placed like its subject (${label})`, rows.length > 0 && bad.length === 0, bad.slice(0, 4).join(' | '));
}

try {
  // ── people ──
  const A = { userId: ME.userId, orgId: ME.orgId, email: EMAIL, chat: MCP };
  const mk = async (tag, o) => { const email = `actq${tag}${hex(3)}@example.test`; return { email, ...(await makeUser({ email, name: `Actq ${tag}`, ...o })) }; };
  const T = await mk('t', { orgId: A.orgId, role: 'member' });
  const U = await mk('u', { orgId: A.orgId, role: 'member' });
  const X = await mk('x', { orgName: 'Actq other org' });
  for (const p of [T, U, X]) p.chat = await mkKey({ agent: 'claude', userId: p.userId, orgId: p.orgId, name: 'actq' });
  A.code = await mkKey({ agent: 'claude-code', userId: A.userId, orgId: A.orgId, name: 'actq code' });
  for (const p of [A, T, U, X]) p.cookie = await signIn(p.email);
  check('setup: everyone is signed in', [A, T, U, X].every(p => p.cookie.includes('workos.')));
  const pidOf = async name => (await rawDb.collection('projects').findOne({ orgId: A.orgId, name }))._id;
  const tidOf = async ref => (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref }))._id;

  // ── a shared project (SP) and a private one (PP) ──
  const spName = mark('shared');
  const ppName = mark('private');
  await must(A.chat, 'add_project', { name: spName });
  await must(A.chat, 'add_project', { name: ppName, visibility: 'private' });
  const SP = await pidOf(spName);
  const PP = await pidOf(ppName);

  // State: Now, Next, Later, a decision; T marks A's Next line done (T's row, A's words)
  const S = { now: mark('now'), next: mark('next'), later: mark('later'), decision: mark('decision') };
  await must(A.chat, 'save_state', { project: SP, base_version: 0, ops: [{ op: 'set_now', text: S.now }, { op: 'add_next', text: S.next }, { op: 'add_later', text: S.later }, { op: 'add_decision', text: S.decision }] });
  const v = (await must(T.chat, 'get_state', { project: SP })).state.version;
  await must(T.chat, 'save_state', { project: SP, base_version: v, ops: [{ op: 'done_next', find: S.next }] });

  // Notes: a project note made by A and edited by A twice and T twice; a task's note
  const N = { title: mark('notetitle'), body: mark('notebody'), taskNoteTitle: mark('tasknote') };
  const note = (await must(A.chat, 'write_note', { project: SP, title: N.title, body: N.body })).created.id;
  for (const who of [A, A, T, T]) await must(who.chat, 'write_note', { note_id: note, append: `more ${hex(2)}` });
  const task = (await must(A.chat, 'add_task', { title: mark('task'), project: SP })).created;
  task.id = await tidOf(task.ref);
  const taskNote = (await must(A.chat, 'write_note', { task: task.ref, title: N.taskNoteTitle, body: 'x' })).created.id;

  // A message (its body never goes in a row)
  const MSG = mark('msgbody');
  await must(A.chat, 'send_message', { to: 'Actq t', project: SP, kind: 'fyi', body: MSG });

  // Needs: one answered in the app (with words: never copied), one withdrawn, one on the task (stays open)
  const Q = { answered: mark('needans'), withdrawn: mark('needwd'), onTask: mark('needtask') };
  const ANS = mark('answertext');
  const nAns = (await must(A.code, 'ask', { project: SP, to: 'me', kind: 'approve', ask: Q.answered })).need;
  const nWd = (await must(A.code, 'ask', { project: SP, to: 'me', kind: 'do', ask: Q.withdrawn })).need;
  const nTask = (await must(A.code, 'ask', { project: SP, to: 'me', kind: 'approve', ask: Q.onTask, task: task.ref })).need;
  const ans = await action('app/(app)/needs/actions.ts#answerNeedAction', [nAns.id, 'yes', ANS], A.cookie);
  check('needs: the owner answers a Need in the app', ans.value?.ok === true, JSON.stringify(ans.value ?? ans).slice(0, 200));
  await must(A.code, 'withdraw_need', { id: nWd.id });

  // Project renamed
  const spName2 = mark('renamed');
  await must(A.chat, 'update_project', { project: SP, name: spName2 });

  // ── every kind is in the owner's feed ──
  {
    const f = await feed(A.chat);
    const types = new Set(f.events.map(e => e.type));
    for (const t of ['state_now', 'next_added', 'next_done', 'later_added', 'decision', 'note_created', 'note_edited', 'message_sent', 'need_asked', 'need_answered', 'need_withdrawn', 'project_created', 'project_renamed']) check(`kinds: ${t} is in recent_activity`, types.has(t), [...types].join(','));
    check('kinds: the State rows carry the State text', [S.now, S.next, S.later, S.decision].every(s => f.text.includes(s)), f.text.slice(0, 200));
    check('kinds: the Need rows carry the ask', [Q.answered, Q.withdrawn, Q.onTask].every(s => f.text.includes(s)));
    check('kinds: a task note row names its task', f.events.some(e => e.type === 'note_created' && e.task?.startsWith(`#${task.ref}`)), JSON.stringify(f.events.filter(e => e.type === 'note_created')).slice(0, 300));
    const edits = await rawDb.collection('activity').find({ 'subject.id': note, type: 'note_edited' }).toArray();
    check('notes: one edit row per editor per hour (A’s edits fold into the creation; T gets one)', edits.length === 1 && edits[0].actor.userId === T.userId, JSON.stringify(edits.map(e => e.actor)));
    const raw = JSON.stringify(await rawDb.collection('activity').find({}).toArray());
    check('text: no row holds a message body', !raw.includes(MSG));
    check('text: no row holds a Need answer’s words', !raw.includes(ANS));
    check('text: no row holds a note body', !raw.includes(N.body));
    // What filter
    for (const what of ['state', 'notes', 'messages', 'needs', 'projects']) {
      const w = await feed(A.chat, { what });
      check(`what=${what}: only ${what} rows, and some`, w.ok && w.events.length > 0 && w.events.every(e => e.what === what), JSON.stringify(w.events.map(e => e.what)).slice(0, 200));
    }
    const wt = await feed(A.chat, { what: 'tasks' });
    check('what=tasks: only task rows', wt.ok && wt.events.length > 0 && wt.events.every(e => !e.what || e.what === 'tasks'), JSON.stringify(wt.events.map(e => e.type)).slice(0, 200));
    const byProj = await feed(A.chat, { project: SP });
    check('project filter: the project’s own rows (State, Needs, messages) and its tasks', [S.now, Q.answered].every(s => byProj.text.includes(s)) && byProj.events.some(e => e.type === 'message_sent') && byProj.events.some(e => e.task?.startsWith(`#${task.ref}`)), byProj.text.slice(0, 200));
    // T's view: text written by someone else is labelled; T's own done_next row carries A's words
    const tf = await feed(T.chat);
    const done = tf.events.find(e => e.type === 'next_done');
    check('writtenBy: T reads A’s State text with writtenBy, and a textRule', !!tf.events.find(e => e.type === 'state_now')?.writtenBy && !!tf.text.includes('textRule'), JSON.stringify(tf.events.find(e => e.type === 'state_now')));
    check('writtenBy: the Next line T marked done is labelled A’s words for T', !!done?.writtenBy, JSON.stringify(done));
    const tEdit = tf.events.find(e => e.type === 'note_edited');
    check('titleWrittenBy: T’s edit of A’s note labels the title as A’s for T', !!tEdit?.titleWrittenBy, JSON.stringify(tEdit));
    const aEdit = f.events.find(e => e.type === 'note_edited');
    check('titleWrittenBy: …and for A, whose title it is, it is unlabelled', !!aEdit && !aEdit.titleWrittenBy, JSON.stringify(aEdit));
    const tRen = tf.events.find(e => e.type === 'project_renamed');
    // A wrote the old name and renamed it: the row's writtenBy (A) covers its whole text, so no separate titleWrittenBy
    // (logChange stores titleBy only when it is not the actor's; T renaming A's name would carry it).
    check('titleWrittenBy: a rename shows T who wrote the old name', (tRen?.titleWrittenBy ?? tRen?.writtenBy) === 'E2E Owner', JSON.stringify(tRen));
    // Pages
    const rv = await page('/review?view=activity', A.cookie);
    check('Review › Activity: the owner’s page shows the new kinds', rv.status === 200 && ['state_now', 'note_created', 'message_sent', 'need_asked', 'project_renamed'].every(t => rv.text.includes(`data-activity-type="${t}"`)), String(rv.status));
    const rs = await page('/review?view=activity&what=state', A.cookie);
    check('Review › Activity, What = State: State rows only', rs.status === 200 && rs.text.includes('data-activity-type="state_now"') && !rs.text.includes('data-activity-type="message_sent"') && rs.text.includes('data-activity-what'), String(rs.status));
    const pp = await page(`/projects/${SP}?tab=info`, A.cookie);
    check('project page: shows its State, message and Need rows', pp.status === 200 && ['next_added', 'message_sent', 'need_asked'].every(t => pp.text.includes(`data-activity-type="${t}"`)), String(pp.status));
  }
  await placedLikeSubjects('after the writes');

  // ── a private project: its rows reach nobody else ──
  const P = { now: mark('pvnow'), note: mark('pvnote'), msg: mark('pvmsg'), need: mark('pvneed') };
  await must(A.chat, 'save_state', { project: PP, base_version: 0, ops: [{ op: 'set_now', text: P.now }, { op: 'add_decision', text: P.now + 'd' }] });
  await must(A.chat, 'write_note', { project: PP, title: P.note, body: 'x' });
  const ppSid = (await must(A.code, 'start_work', { project: PP, label: 'actq private' })).session;
  await must(A.chat, 'send_message', { to: ppSid, kind: 'request', body: P.msg });
  await must(A.code, 'ask', { project: PP, to: 'me', kind: 'approve', ask: P.need });
  const pvAll = [P.now, P.note, P.need, ppName];
  {
    const own = await feed(A.chat);
    check('private: the owner reads its rows (control)', [P.now, P.note, P.need].every(s => own.text.includes(s)) && own.events.some(e => e.type === 'message_sent' && e.project === ppName), own.text.slice(0, 200));
  }
  for (const [who, p] of [['T', T], ['X', X]]) {
    for (const what of [undefined, 'state', 'notes', 'messages', 'needs', 'projects']) {
      const f = await feed(p.chat, what ? { what } : {});
      check(`private: ${who}’s feed carries none of it (what=${what ?? 'all'})`, f.ok && pvAll.every(s => !f.text.includes(s)), f.text.slice(0, 200));
    }
    const byId = await mcpH(p.chat, 'recent_activity', { since: '1d', project: PP });
    check(`private: ${who} asking for the project by id gets nothing of it`, pvAll.every(s => !byId.text.includes(s)), byId.text.slice(0, 200));
    for (const path_ of ['/review?view=activity', '/review?view=activity&what=state', '/review?view=activity&what=notes', '/review?view=activity&what=needs', `/projects/${PP}?tab=info`]) {
      const r = await page(path_, p.cookie);
      // The project's id is made from its name (actqprivate…-1d9224e2), and a page echoes the address it was asked for:
      // that echo is the reader's own input, not something read from the project.
      const text = path_.startsWith('/projects/') ? r.text.split(PP).join('') : r.text;
      const hits = pvAll.filter(s => text.includes(s)).map(s => text.slice(Math.max(0, text.indexOf(s) - 80), text.indexOf(s) + s.length + 40));
      check(`private: ${who}’s page ${path_} carries none of it`, hits.length === 0, `${r.status} ${JSON.stringify(hits).slice(0, 400)}`);
    }
    const ds = await mcpH(p.chat, 'daily_summary', { since: '1d' });
    check(`private: ${who}’s daily_summary carries none of it`, pvAll.every(s => !ds.text.includes(s)), ds.text.slice(0, 200));
  }
  // X never sees the shared project's rows either (another organization)
  {
    const f = await feed(X.chat);
    check('other org: X’s feed carries nothing of the shared project', f.ok && [S.now, N.title, Q.answered, spName2].every(s => !f.text.includes(s)), f.text.slice(0, 200));
  }
  await placedLikeSubjects('private project');

  // ── visibility changes hide and show the rows ──
  const spSeen = async p => {
    const f = await feed(p.chat);
    const n = await feed(p.chat, { what: 'notes' });
    const rv = await page('/review?view=activity', p.cookie);
    return { mcp: [S.now, Q.answered, N.title].filter(s => f.text.includes(s)).length + (f.events.some(e => e.type === 'message_sent' && e.project === spName2) ? 1 : 0), notes: n.text.includes(N.title), page: rv.text.includes(S.now) };
  };
  const sees = (label, p, want) => async () => {
    const s = await spSeen(p);
    const ok = want ? s.mcp === 4 && s.notes && s.page : s.mcp === 0 && !s.notes && !s.page;
    check(`visibility: ${label}`, ok, JSON.stringify(s));
  };
  await sees('T reads the shared project’s rows', T, true)();
  await must(A.chat, 'update_project', { project: SP, visibility: 'private' });
  await sees('made private: T reads none of its rows', T, false)();
  await placedLikeSubjects('made private');
  {
    const vc = await rawDb.collection('activity').findOne({ projectId: SP, type: 'visibility_changed' });
    check('visibility: the change is a row, placed like the project now (private)', vc?.visibility === 'private' && vc.ownerId === A.userId && vc.changes?.visibility?.to === 'Private', JSON.stringify(vc && [vc.visibility, vc.changes]));
  }
  await must(A.chat, 'update_project', { project: SP, visibility: 'org' });
  await sees('shared again: T reads them again', T, true)();
  check('visibility: T reads the change rows too once shared', (await feed(T.chat, { what: 'projects' })).events.some(e => e.type === 'visibility_changed'));
  await placedLikeSubjects('shared again');
  await must(A.chat, 'update_project', { project: SP, visibility: 'members', shared_with: [U.email] });
  await sees('chosen people without T: T reads none', T, false)();
  await sees('…and U, who was chosen, reads them', U, true)();
  await placedLikeSubjects('chosen people without T');
  await must(A.chat, 'update_project', { project: SP, visibility: 'members', shared_with: [U.email, T.email] });
  await sees('T added to the chosen people: T reads them', T, true)();
  await placedLikeSubjects('chosen people with T');
  await must(A.chat, 'update_project', { project: SP, visibility: 'org' });
  {
    const f = await feed(X.chat);
    check('visibility: X (other org) read none of it at any point', [S.now, N.title, Q.answered, spName2].every(s => !f.text.includes(s)), f.text.slice(0, 200));
  }

  // ── a task moves from the shared project to the private one, with its note's and its Need's rows ──
  {
    const before = await feed(T.chat);
    check('move: before, T reads the task’s note row and its Need row', before.text.includes(N.taskNoteTitle) && before.text.includes(Q.onTask), before.text.slice(0, 200));
    await must(A.chat, 'update_task', { task: task.ref, project: PP, note: 'actq move' });
    for (const what of [undefined, 'notes', 'needs', 'tasks']) {
      const f = await feed(T.chat, what ? { what } : {});
      check(`move: after the move T reads neither (what=${what ?? 'all'})`, f.ok && !f.text.includes(N.taskNoteTitle) && !f.text.includes(Q.onTask) && !f.text.includes(task.title), f.text.slice(0, 200));
    }
    const rows = await rawDb.collection('activity').find({ $or: [{ taskId: task.id }, { 'subject.id': { $in: [taskNote, nTask.id] } }] }).toArray();
    check('move: the task’s, its note’s and its Need’s rows are all private now', rows.length >= 3 && rows.every(r => r.visibility === 'private' && r.ownerId === A.userId), JSON.stringify(rows.map(r => [r.type, r.visibility])));
    const rv = await page('/review?view=activity&what=notes', T.cookie);
    check('move: …nor on T’s Review › Activity page', !rv.text.includes(N.taskNoteTitle), String(rv.status));
    await placedLikeSubjects('task moved');
  }

  // ── trash and restore ──
  {
    // a project note
    await must(A.chat, 'delete_note', { note_id: note, title: N.title });
    for (const [who, p] of [['A', A], ['T', T]]) {
      const f = await feed(p.chat, { what: 'notes' });
      check(`trash: a deleted note’s rows leave ${who}’s feed`, f.ok && !f.text.includes(N.title), f.text.slice(0, 200));
    }
    const tp = await page('/review?view=activity', T.cookie);
    check('trash: …and T’s Review › Activity page', !tp.text.includes(N.title));
    const rs = await action('app/(app)/notes/actions.ts#restoreNoteAction', [note], A.cookie);
    check('trash: the owner restores the note in the app', rs.value?.ok === true, JSON.stringify(rs.value ?? rs).slice(0, 200));
    for (const [who, p] of [['A', A], ['T', T]]) {
      const f = await feed(p.chat, { what: 'notes' });
      check(`trash: restored, its rows are back in ${who}’s feed`, f.text.includes(N.title), f.text.slice(0, 200));
    }
    // a task with a note: its rows go to the trash with it and come back
    const t2 = (await must(A.chat, 'add_task', { title: mark('trashtask'), project: SP })).created;
    t2.id = await tidOf(t2.ref);
    const t2NoteTitle = mark('trashnote');
    await must(A.chat, 'write_note', { task: t2.ref, title: t2NoteTitle, body: 'x' });
    check('trash: T reads the task note row first', (await feed(T.chat, { what: 'notes' })).text.includes(t2NoteTitle));
    await must(A.chat, 'delete_task', { task: t2.ref, title: t2.title });
    // One row stays on purpose: "trashed", so who deleted what shows in History and recent_activity (tasks.ts trashOne).
    const left = (await rawDb.collection('activity').find({ taskId: t2.id }).toArray()).map(r => r.type);
    check('trash: a deleted task takes its rows (its note’s too) out of the feed, all but the "trashed" row', JSON.stringify(left) === '["trashed"]', JSON.stringify(left));
    for (const [who, p] of [['A', A], ['T', T]]) check(`trash: …so ${who}’s feed no longer has the note row`, !(await feed(p.chat, { what: 'notes' })).text.includes(t2NoteTitle));
    await must(A.chat, 'restore_task', { task: t2.ref });
    const back = await rawDb.collection('activity').find({ taskId: t2.id }).toArray();
    check('trash: restored, the rows are back (the note’s included)', back.some(r => r.type === 'note_created'), JSON.stringify(back.map(r => r.type)));
    check('trash: …and T reads the note row again', (await feed(T.chat, { what: 'notes' })).text.includes(t2NoteTitle));
    await placedLikeSubjects('trash and restore');
  }

  // ── get_project reads a task's note rows through the note (review fix 2) ──
  {
    const t3 = (await must(A.chat, 'add_task', { title: mark('treetask'), project: SP })).created;
    const t3NoteTitle = mark('treenote');
    const t3Note = (await must(A.chat, 'write_note', { task: t3.ref, title: t3NoteTitle, body: 'x' })).created.id;
    const before = await mcpH(T.chat, 'get_project', { project: SP, depth: 'full', activity_per_task: 30 });
    check('get_project: T reads the task note’s row (control)', !before.isError && before.text.includes(t3NoteTitle), before.text.slice(0, 200));
    await must(A.chat, 'delete_note', { note_id: t3Note, title: t3NoteTitle });
    for (const depth of ['project', 'full']) {
      for (const [who, p] of [['A', A], ['T', T]]) {
        const r = await mcpH(p.chat, 'get_project', { project: SP, depth, activity_per_task: 30 });
        check(`get_project: a note in the trash leaves ${who}’s recentActivity and task history (depth ${depth})`, !r.isError && !r.text.includes(t3NoteTitle), r.text.slice(0, 200));
      }
    }
  }

  // ── a full page even when rows drop out after the query (review fix 4) ──
  {
    // Six fresh notes, then all in the trash: their rows are the newest, readable by placement, dropped by readableRows.
    for (let i = 0; i < 6; i++) {
      const title = mark(`gone${i}`);
      const id = (await must(A.chat, 'write_note', { project: SP, title, body: 'x' })).created.id;
      await must(A.chat, 'delete_note', { note_id: id, title });
    }
    for (const limit of [2, 5]) {
      const f = await feed(A.chat, { what: 'notes', limit });
      check(`limit: what=notes limit ${limit} still returns ${limit} rows past the dropped ones`, f.ok && f.events.length === limit && !/actqgone/.test(f.text), `${f.events.length} rows`);
    }
  }

  // ── a task taken out of its project leaves the project behind, with its Need and the Need's rows (review fix 1) ──
  {
    const p2Name = mark('leaving');
    await must(A.chat, 'add_project', { name: p2Name, visibility: 'private' });
    const P2 = await pidOf(p2Name);
    const t4 = (await must(A.chat, 'add_task', { title: mark('leavetask'), project: P2 })).created;
    t4.id = await tidOf(t4.ref);
    const ask = mark('leaveneed');
    const nd = (await must(A.code, 'ask', { project: P2, to: 'me', kind: 'approve', ask, task: t4.ref })).need;
    await must(A.chat, 'update_task', { task: t4.ref, project: null, note: 'actq out of the project' });
    const nDoc = await rawDb.collection('needs').findOne({ _id: nd.id });
    const nRows = await rawDb.collection('activity').find({ 'subject.id': nd.id }).toArray();
    check('no project: the Need no longer names the old project', nDoc && !nDoc.projectId, JSON.stringify(nDoc?.projectId));
    check('no project: its rows name no project and are placed like the task (private)', nRows.length > 0 && nRows.every(r => !r.projectId && r.visibility === 'private' && r.ownerId === A.userId), JSON.stringify(nRows.map(r => [r.type, r.projectId, r.visibility])));
    await must(A.chat, 'update_project', { project: P2, visibility: 'org' });
    const nAfter = await rawDb.collection('needs').findOne({ _id: nd.id });
    check('no project: the old project shared with everyone does not take the Need along', nAfter?.visibility === 'private', JSON.stringify(nAfter && [nAfter.visibility, nAfter.projectId]));
    for (const what of [undefined, 'needs']) {
      const f = await feed(T.chat, what ? { what } : {});
      check(`no project: T reads neither the Need nor its row (what=${what ?? 'all'})`, f.ok && !f.text.includes(ask), f.text.slice(0, 200));
    }
    const tn = await mcpH(T.chat, 'needs', { status: 'all' });
    check('no project: …nor in T’s needs list', !tn.text.includes(ask), tn.text.slice(0, 200));
    const tp = await page('/review?view=activity&what=needs', T.cookie);
    check('no project: …nor on T’s Review › Activity page', !tp.text.includes(ask), String(tp.status));
    await placedLikeSubjects('task taken out of its project');
  }
} catch (e) {
  check('activity-all suite ran to the end', false, e.stack ?? String(e));
}
await finish();
