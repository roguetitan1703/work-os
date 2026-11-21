// One Claude session, one id: the move and the merge (plan note db5bf91389, piece B). lib/session-move.ts moves what a left-behind
// row of the same Claude Code session holds (Needs open or answered-unbriefed, handedTo, unread messages, read marks, the Now hold and
// held lines, the writer mark on lines and tasks, slot holds, builders' parent, claimed items, handovers) to the session's row; the
// close at sign-in (closeLeftBehind, before the brief) does it when a start finds older rows of its Claude Code session under another id,
// and never closes a busy row; scripts/merge-dup-sessions.mjs does it for the rows already there (dry run, apply, a second apply
// finds nothing). Seed profile: none.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { B, MCP, ME, DBNAME, check, finish, mkClaudeItem, mkDevice, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const P = 'SM Alpha';
const call = async (path, cred, body = {}) => {
  const r = await fetch(B + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), 'x-work-os-hook': '5' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ago = min => new Date(Date.now() - min * 60_000);
const U = ME.userId;
const K = s => `${U}:${s}`;
const uid = () => crypto.randomUUID();
const col = n => rawDb.collection(n);
const hdr = s => ({ 'X-Work-OS-Session': s });

try {
  const pid = (await must(MCP, 'add_project', { name: P, code: [{ remote: 'acme/sm-alpha' }] })).project.id;
  const dev = await mkDevice('sm-pc');
  await col('devices').updateOne({ _id: dev.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId } });
  await col('workerFolders').insertOne({ _id: `${dev.id}:smfld`, deviceId: dev.id, folderId: 'smfld', name: 'C:/code/sm-alpha', git: true, remote: 'acme/sm-alpha', projectId: pid, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  // A State with a Now and two Next lines (a fixture session writes it; its row is removed again).
  await must(MCP, 'start_work', { project: P, session: 'sm-fixture' }, hdr('sm-fixture'));
  await must(MCP, 'save_state', { project: P, base_version: 0, session: 'sm-fixture', ops: [{ op: 'set_now', text: 'SM goal: one session one id' }, { op: 'add_next', text: 'SM line one, long enough to matter' }, { op: 'add_next', text: 'SM line two, long enough to matter' }] }, hdr('sm-fixture'));
  await col('presence').deleteMany({ session: 'sm-fixture' });
  const task = (await must(MCP, 'add_task', { title: 'SM task', project: P })).created;
  const taskId = task?.id ?? (await col('tasks').findOne({ title: 'SM task' }))._id;

  const legacyRow = (sess, cc, o = {}) => ({ _id: `${U}:s:${sess}:${pid}`, projectId: pid, userId: U, key: sess, session: sess, ...(cc ? { ccSession: cc } : {}), machine: dev.id, ai: 'Claude Code', agent: 'claude-code', hook: 4, label: `Legacy ${sess}`, lastSeen: ago(120), createdAt: ago(130), forYouCursor: ago(120), writesSinceSave: 0, orgId: ME.orgId, ownerId: U, visibility: 'org', sharedWith: [], ...o });
  const need = (id, from, o = {}) => ({ _id: id, orgId: ME.orgId, ownerId: U, visibility: 'org', sharedWith: [], ref: Math.floor(Math.random() * 1e6) + 1000, projectId: pid, taskId: null, taskRef: null, to: U, from: { actor: { kind: 'agent', agent: 'claude-code', userId: U }, word: 'agent', session: from }, kind: 'decide', ask: `SM ask ${id}`, options: [], status: 'open', appOnly: false, createdAt: ago(100), answeredAt: null, ...o });
  const msg = (id, o = {}) => ({ _id: id, orgId: ME.orgId, ownerId: U, visibility: 'org', sharedWith: [], projectId: pid, from: { userId: U, word: 'agent', session: 'someone' }, kind: 'fyi', body: `SM ${id}`, refs: {}, thread: id, status: 'unread', src: K('someone'), at: ago(90), createdAt: ago(90), ...o });
  const n = id => col('needs').findOne({ _id: id });
  const m = id => col('messages').findOne({ _id: id });

  // ── 1. the close at sign-in moves a left-behind row's work to the session's own id
  const CC = uid();
  const OLD = `old-${uid().slice(0, 8)}`;
  await col('presence').insertOne(legacyRow(OLD, CC, { doing: { taskId, at: ago(100) } }));
  const ids = { open: uid(), answered: uid(), closed: uid(), briefed: uid(), handed: uid(), mUnread: uid(), mRead: uid(), mOpen: uid(), note: uid(), bld: uid() };
  await col('needs').insertMany([
    need(ids.open, OLD),
    need(ids.answered, OLD, { status: 'answered', answeredAt: ago(50), answer: { option: 'x', by: U, via: 'app', at: ago(50) } }),
    need(ids.closed, OLD, { status: 'closed', closedAt: ago(40) }),
    need(ids.briefed, OLD, { status: 'answered', answeredAt: ago(50), briefedAt: ago(45) }),
    need(ids.handed, 'other-sess', { status: 'answered', answeredAt: ago(50), handedTo: OLD }),
  ]);
  await col('messages').insertMany([
    msg(ids.mUnread, { toSids: [K(OLD)], seenBy: [] }),
    msg(ids.mRead, { toSids: [K(OLD)], seenBy: [K(OLD)], status: 'seen' }),
    msg(ids.mOpen, { seenBy: [K(OLD)], status: 'seen' }), // not addressed: read by the old key
  ]);
  await col('states').updateOne({ _id: pid }, { $set: { 'now.hold': { key: K(OLD), label: 'Legacy', at: ago(100) }, 'next.0.hold': { key: K(OLD), at: ago(100) }, 'next.0.src': K(OLD), 'next.1.src': OLD } });
  await col('tasks').updateOne({ _id: taskId }, { $set: { src: K(OLD) } });
  await col('slots').insertOne({ _id: 'sm-slot', orgId: ME.orgId, machine: 'sm-pc', kind: 'heavy', ownerId: U, touchedAt: new Date(), holds: [{ h: K(OLD), session: OLD, userId: U, until: new Date(Date.now() + 3600e3) }, { h: K('keep'), session: 'keep', userId: U, until: new Date(Date.now() + 3600e3) }] });
  await col('presence').insertOne(legacyRow(ids.bld, uid(), { parent: OLD }));
  const item = await mkClaudeItem({ project: P, title: 'SM claimed' });
  await col('claudeItems').updateOne({ _id: item.id }, { $set: { claimedBy: { session: OLD, at: ago(100) } } });
  await col('notes').insertOne({ _id: ids.note, orgId: ME.orgId, ownerId: U, visibility: 'org', sharedWith: [], projectId: pid, title: 'SM handover', body: '', shelf: 'handovers', createdAt: ago(100), updatedAt: ago(100), handover: { by: U, for: 'anyone', session: OLD, at: ago(100), fields: { step: 'SM' }, pickedUp: { session: OLD, by: U, at: ago(90) } } });

  const s1 = await call('/api/agent/start', dev.key, { folders: ['smfld'], path: 'C:/code/sm-alpha', ccSession: CC, source: 'startup', proc: { pid: 7001, procStart: '1' } });
  const S = s1.json?.brief?.session;
  check('setup: a start of the same Claude Code session gets its own id', s1.status === 200 && !!S && S !== OLD, `${s1.status} ${s1.text.slice(0, 120)}`);
  const oldRow = await col('presence').findOne({ session: OLD });
  check('the old row is ended and points at the session (movedTo = its bare key)', !!oldRow?.endedAt && oldRow.movedTo === S && !!oldRow.swept, JSON.stringify(oldRow));
  check('the close leaves one open row of the Claude Code session on the project', (await col('presence').countDocuments({ ccSession: CC, projectId: pid, endedAt: { $exists: false } })) === 1);
  check('an open Need and an answered unbriefed Need move to the session', (await n(ids.open)).from.session === S && (await n(ids.answered)).from.session === S);
  check('handedTo moves too', (await n(ids.handed)).handedTo === S);
  check('a closed Need and a briefed Need stay put', (await n(ids.closed)).from.session === OLD && (await n(ids.briefed)).from.session === OLD);
  check('an unread message is readdressed to the session', (await m(ids.mUnread)).toSids.join() === K(S), JSON.stringify((await m(ids.mUnread)).toSids));
  check('read mail stays read (still addressed to the old key) and is read by the new key too', (await m(ids.mRead)).toSids.join() === K(OLD) && (await m(ids.mRead)).seenBy.includes(K(S)) && (await m(ids.mOpen)).seenBy.includes(K(S)));
  const st1 = await col('states').findOne({ _id: pid });
  check('the Now hold and the Next hold move; src on lines moves in its own form', st1.now.hold.key === K(S) && st1.next[0].hold.key === K(S) && st1.next[0].src === K(S) && st1.next[1].src === S, JSON.stringify([st1.now.hold, st1.next[0].src, st1.next[1].src]));
  check('src on a task moves', (await col('tasks').findOne({ _id: taskId })).src === K(S));
  const slot = await col('slots').findOne({ _id: 'sm-slot' });
  check("a slot hold moves (h and session) and another session's hold stays", slot.holds[0].session === S && slot.holds[0].h === K(S) && slot.holds[1].session === 'keep', JSON.stringify(slot.holds));
  check("a builder row's parent moves", (await col('presence').findOne({ session: ids.bld })).parent === S);
  check('claimedBy moves', (await col('claudeItems').findOne({ _id: item.id })).claimedBy.session === S);
  const note = await col('notes').findOne({ _id: ids.note });
  check('handover.session and handover.pickedUp.session move', note.handover.session === S && note.handover.pickedUp.session === S);
  // What the old row was doing goes on the new row (it did not exist when the work moved).
  const newRow = await col('presence').findOne({ session: S, projectId: pid, endedAt: { $exists: false } });
  check('doing ends up on the new row, and not on the old one', newRow?.doing?.taskId === taskId && !(await col('presence').findOne({ session: OLD })).doing, JSON.stringify([newRow?.doing]));
  // A second start finds nothing to close.
  const snap = async () => JSON.stringify(await col('presence').find({ ccSession: CC }).sort({ _id: 1 }).project({ endedAt: 1, movedTo: 1, swept: 1, doing: 1 }).toArray());
  const before = await snap();
  const s1b = await call('/api/agent/start', dev.key, { folders: ['smfld'], path: 'C:/code/sm-alpha', ccSession: CC, source: 'resume', proc: { pid: 7001, procStart: '1' } });
  const after = await snap();
  check('a second start gets the same id and finds nothing to close (no row changes, one open row)', s1b.status === 200 && s1b.json?.brief?.session === S && before === after && (await col('presence').countDocuments({ ccSession: CC, projectId: pid, endedAt: { $exists: false } })) === 1, `${s1b.status} ${before} ${after}`);
  // A reply to a message the old key sent reaches the session: the reply follows movedTo.
  await must(MCP, 'start_work', { project: P, session: 'sm-sender' }, hdr('sm-sender'));
  const parentId = uid();
  await col('messages').insertOne(msg(parentId, { toSids: [K('sm-sender')], seenBy: [], src: K(OLD), from: { userId: U, word: 'agent', session: OLD, label: 'Legacy' } }));
  const sent = await must(MCP, 'reply', { id: parentId, body: 'SM reply to the old key', session: 'sm-sender' }, hdr('sm-sender')).catch(e => ({ error: String(e) }));
  const reply = await col('messages').findOne({ body: 'SM reply to the old key' });
  check('a reply to a message of the old key reaches the kept session (it follows movedTo)', !!reply && (reply.toSids ?? []).join() === K(S), `${JSON.stringify(sent).slice(0, 160)} ${JSON.stringify(reply?.toSids)}`);

  // ── 2. a busy row is not closed and its work stays
  const CC2 = uid();
  const BUSY = `busy-${uid().slice(0, 8)}`;
  const nb = uid();
  await col('presence').insertOne(legacyRow(BUSY, CC2, { lastSeen: new Date(), activity: { state: 'working', at: new Date() }, activeAt: new Date() }));
  await col('needs').insertOne(need(nb, BUSY));
  const s2 = await call('/api/agent/start', dev.key, { folders: ['smfld'], path: 'C:/code/sm-alpha', ccSession: CC2, source: 'startup', proc: { pid: 7002, procStart: '2' } });
  const busyRow = await col('presence').findOne({ session: BUSY });
  check('a busy row (working) under another id is not closed and its Need stays', s2.status === 200 && !busyRow.endedAt && !busyRow.movedTo && (await n(nb)).from.session === BUSY, `${s2.status} ${JSON.stringify(busyRow?.endedAt)}`);

  // ── 2b. two windows: a busy row of the session on its project survives another window's start on another project
  const pid2 = (await must(MCP, 'add_project', { name: 'SM Beta', code: [{ remote: 'acme/sm-beta' }] })).project.id;
  await col('workerFolders').insertOne({ _id: `${dev.id}:smfld2`, deviceId: dev.id, folderId: 'smfld2', name: 'C:/code/sm-beta', git: true, remote: 'acme/sm-beta', projectId: pid2, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const CCW = uid();
  const w1 = await call('/api/agent/start', dev.key, { folders: ['smfld'], path: 'C:/code/sm-alpha', ccSession: CCW, source: 'startup', proc: { pid: 7010, procStart: '10' } });
  const SW1 = w1.json?.brief?.session;
  await col('presence').updateOne({ session: SW1, projectId: pid }, { $set: { lastSeen: new Date(), activity: { state: 'working', at: new Date() }, activeAt: new Date() } });
  const w2 = await call('/api/agent/start', dev.key, { folders: ['smfld2'], path: 'C:/code/sm-beta', ccSession: CCW, source: 'startup', proc: { pid: 7011, procStart: '11' } });
  check('two windows: the start on another project keeps the id, and the busy row on the first project is not ended', w2.status === 200 && w2.json?.brief?.session === SW1 && !(await col('presence').findOne({ session: SW1, projectId: pid })).endedAt && !!(await col('presence').findOne({ session: SW1, projectId: pid2 })), `${w2.status} ${w2.text.slice(0, 120)}`);
  await col('presence').updateOne({ session: SW1, projectId: pid }, { $set: { activity: { state: 'off', at: ago(60) }, lastSeen: ago(60) } });
  const w3 = await call('/api/agent/start', dev.key, { folders: ['smfld2'], path: 'C:/code/sm-beta', ccSession: CCW, source: 'resume', proc: { pid: 7010, procStart: '10' } });
  check('two windows: once idle, the next start closes the first project row', w3.status === 200 && !!(await col('presence').findOne({ session: SW1, projectId: pid })).endedAt);

  // ── 3. a start_work row (no Claude Code session id) is never touched; another computer's row ends only
  const CC3 = uid();
  const SW = `sw-${uid().slice(0, 8)}`;
  const nsw = uid();
  await col('presence').insertOne(legacyRow(SW, null));
  await col('needs').insertOne(need(nsw, SW));
  const OTHER = `oth-${uid().slice(0, 8)}`;
  await col('presence').insertOne(legacyRow(OTHER, CC3, { machine: 'another-device-id' }));
  const s3 = await call('/api/agent/start', dev.key, { folders: ['smfld'], path: 'C:/code/sm-alpha', ccSession: CC3, source: 'startup', proc: { pid: 7003, procStart: '3' } });
  check('a start_work row (no ccSession) is never closed or moved', s3.status === 200 && !(await col('presence').findOne({ session: SW })).endedAt && (await n(nsw)).from.session === SW);
  const otherRow = await col('presence').findOne({ session: OTHER });
  check("a row of the same Claude Code session on another computer ends, its work is not moved", !!otherRow.endedAt && !otherRow.movedTo);

  // ── 4. the merge script: dry run changes nothing, apply merges, a second apply finds nothing
  const CC4 = uid();
  const rows = [`mg-new-${uid().slice(0, 6)}`, `mg-mid-${uid().slice(0, 6)}`, `mg-old-${uid().slice(0, 6)}`];
  await col('presence').insertMany([
    legacyRow(rows[0], CC4, { lastSeen: ago(40) }), // the newest of those older than 30 minutes: kept
    legacyRow(rows[1], CC4, { lastSeen: ago(90) }),
    legacyRow(rows[2], CC4, { lastSeen: ago(200) }),
  ]);
  const nm1 = uid();
  const nm2 = uid();
  await col('needs').insertMany([need(nm1, rows[1]), need(nm2, rows[2])]);
  await col('messages').insertOne(msg(uid(), { toSids: [K(rows[2])], seenBy: [] }));
  const tokId = uid();
  await col('agentSessions').insertOne({ _id: tokId, hash: crypto.randomBytes(32).toString('hex'), sessionId: rows[2], keyHash: 'x', deviceId: dev.id, ownerId: U, orgId: ME.orgId, projectId: pid, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  // The session record's own id is kept (its tokens stay), though an older row; the other row's tokens go. A message addressed to both keys keeps the new key once.
  const CC6 = uid();
  const ig = [`id-new-${uid().slice(0, 6)}`, `id-own-${uid().slice(0, 6)}`];
  await col('presence').insertMany([legacyRow(ig[0], CC6, { lastSeen: ago(40) }), legacyRow(ig[1], CC6, { lastSeen: ago(90) })]);
  await col('agentIdentities').insertOne({ _id: ig[1], orgId: ME.orgId, ownerId: U, deviceId: dev.id, ccSessions: [CC6], projectId: pid, createdAt: ago(100), lastSeen: ago(90) });
  const igTok = [uid(), uid()];
  await col('agentSessions').insertMany(ig.map((sid, i) => ({ _id: igTok[i], hash: crypto.randomBytes(32).toString('hex'), sessionId: sid, keyHash: 'x', deviceId: dev.id, ownerId: U, orgId: ME.orgId, projectId: pid, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) })));
  const igMsg = uid();
  await col('messages').insertOne(msg(igMsg, { toSids: [K(ig[0]), K(ig[1])], seenBy: [] }));
  // A row with no lastSeen is the oldest and does not throw.
  const CC7 = uid();
  const nl = [`nl-new-${uid().slice(0, 6)}`, `nl-none-${uid().slice(0, 6)}`];
  await col('presence').insertMany([legacyRow(nl[0], CC7, { lastSeen: ago(50) }), legacyRow(nl[1], CC7)]);
  await col('presence').updateOne({ session: nl[1] }, { $unset: { lastSeen: '' } });
  // A group on no project: its unread message (no project) follows.
  const CC8 = uid();
  const uf = [`uf-new-${uid().slice(0, 6)}`, `uf-old-${uid().slice(0, 6)}`];
  const unfiledRow = (sess, o) => legacyRow(sess, CC8, { _id: `${U}:s:${sess}:none`, projectId: null, ...o });
  await col('presence').insertMany([unfiledRow(uf[0], { lastSeen: ago(40) }), unfiledRow(uf[1], { lastSeen: ago(90) })]);
  const ufMsg = uid();
  await col('messages').insertOne(msg(ufMsg, { projectId: null, toSids: [K(uf[1])], seenBy: [] }));
  // A row whose own id is the session record id of ANOTHER Claude Code session is never ended or merged (it is skipped and logged).
  const CC9 = uid();
  const CCX = uid();
  const fx = [`fx-new-${uid().slice(0, 6)}`, `fx-other-${uid().slice(0, 6)}`, `fx-plain-${uid().slice(0, 6)}`];
  await col('presence').insertMany([legacyRow(fx[0], CC9, { lastSeen: ago(40) }), legacyRow(fx[1], CC9, { lastSeen: ago(90) }), legacyRow(fx[2], CC9, { lastSeen: ago(95) })]);
  await col('agentIdentities').insertOne({ _id: fx[1], orgId: ME.orgId, ownerId: U, deviceId: dev.id, ccSessions: [CCX], projectId: pid, createdAt: ago(100), lastSeen: ago(90) });
  const fxTok = uid();
  await col('agentSessions').insertOne({ _id: fxTok, hash: crypto.randomBytes(32).toString('hex'), sessionId: fx[1], keyHash: 'x', deviceId: dev.id, ownerId: U, orgId: ME.orgId, projectId: pid, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  const fxNeed = uid();
  await col('needs').insertOne(need(fxNeed, fx[1]));
  const run = (...a) => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('../../scripts/merge-dup-sessions.mjs', import.meta.url)), '--db', DBNAME, ...a], { env: process.env, encoding: 'utf8' });
  const dry = run();
  check('dry run: names the groups and changes nothing', /DRY RUN/.test(dry) && /to merge/.test(dry) && !(await col('presence').findOne({ session: rows[1] })).endedAt && (await n(nm1)).from.session === rows[1], dry.slice(-300));
  check('dry run: prints how many token rows --apply would delete, and deletes none', /Token rows --apply would delete: [1-9]/.test(dry) && (await col('agentSessions').countDocuments({ _id: { $in: [tokId, igTok[0]] } })) === 2, dry.slice(-200));
  const app = run('--apply');
  const kept = await col('presence').findOne({ session: rows[0] });
  check('apply: the older rows end and point at the newest; their Needs and messages move', !kept.endedAt && (await col('presence').findOne({ session: rows[1] })).movedTo === rows[0] && (await col('presence').findOne({ session: rows[2] })).movedTo === rows[0] && (await n(nm1)).from.session === rows[0] && (await n(nm2)).from.session === rows[0] && (await col('messages').countDocuments({ toSids: K(rows[0]) })) === 1, app.slice(-300));
  check('apply: the token rows of merged ids are deleted', (await col('agentSessions').countDocuments({ _id: tokId })) === 0);
  const own = await col('presence').findOne({ session: ig[1] });
  check("the session record's own row is kept though older; the newer row ends and points at it", !own.endedAt && (await col('presence').findOne({ session: ig[0] })).movedTo === ig[1], JSON.stringify(own));
  check("the record's tokens are kept and the merged row's tokens are deleted", (await col('agentSessions').countDocuments({ _id: igTok[1] })) === 1 && (await col('agentSessions').countDocuments({ _id: igTok[0] })) === 0);
  check('a message addressed to both keys keeps the new key once', JSON.stringify((await m(igMsg)).toSids) === JSON.stringify([K(ig[1])]), JSON.stringify((await m(igMsg)).toSids));
  check('a row with no lastSeen does not throw and merges into the newest', !(await col('presence').findOne({ session: nl[0] })).endedAt && (await col('presence').findOne({ session: nl[1] })).movedTo === nl[0]);
  check('an unfiled group: the unread message with no project follows to the newest row', JSON.stringify((await m(ufMsg)).toSids) === JSON.stringify([K(uf[0])]) && (await col('presence').findOne({ session: uf[1] })).movedTo === uf[0], JSON.stringify((await m(ufMsg)).toSids));
  const fo = await col('presence').findOne({ session: fx[1] });
  check("a row that is another Claude Code session's record id is not ended, merged or stripped (its Need and token stay)", !fo.endedAt && !fo.movedTo && (await n(fxNeed)).from.session === fx[1] && (await col('agentSessions').countDocuments({ _id: fxTok })) === 1, JSON.stringify(fo));
  check('the other rows of that group still merge, and the skip is logged', (await col('presence').findOne({ session: fx[2] })).movedTo === fx[0] && /another Claude Code session/.test(app), app.slice(-400));
  const again = run('--apply');
  check('a second apply finds nothing', /0 row\(s\) merged/.test(again), again.slice(-200));

  // A row seen in the last 30 minutes is skipped on its own; the rest of its group still merges into the newest row.
  const CC5 = uid();
  const g = [`rc-new-${uid().slice(0, 6)}`, `rc-recent-${uid().slice(0, 6)}`, `rc-old-${uid().slice(0, 6)}`];
  await col('presence').insertMany([legacyRow(g[0], CC5, { lastSeen: new Date() }), legacyRow(g[1], CC5, { lastSeen: ago(10) }), legacyRow(g[2], CC5, { lastSeen: ago(100) })]);
  run('--apply');
  check('a recently seen row is skipped on its own; the old one still merges into the newest', !(await col('presence').findOne({ session: g[1] })).endedAt && (await col('presence').findOne({ session: g[2] })).movedTo === g[0]);

  // ── 4. a brief that fails after the close loses no doing: the closed row opens again, and the next start moves it
  const pidB = (await must(MCP, 'add_project', { name: 'SM Beta', code: [{ remote: 'acme/sm-beta' }] })).project.id;
  await col('workerFolders').insertOne({ _id: `${dev.id}:smfldb`, deviceId: dev.id, folderId: 'smfldb', name: 'C:/code/sm-beta', git: true, remote: 'acme/sm-beta', projectId: pidB, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: U });
  const CC10 = uid();
  const FO = `fail-${uid().slice(0, 8)}`;
  await col('presence').insertOne({ ...legacyRow(FO, CC10, { doing: { taskId, at: ago(100) } }), _id: `${U}:s:${FO}:${pidB}`, projectId: pidB });
  const projDoc = await col('projects').findOne({ _id: pidB });
  await col('projects').deleteOne({ _id: pidB }); // the brief cannot find its project
  const bad = await call('/api/agent/start', dev.key, { folders: ['smfldb'], path: 'C:/code/sm-beta', ccSession: CC10, source: 'startup', proc: { pid: 7010, procStart: '1' } });
  const keptRow = await col('presence').findOne({ session: FO });
  check('a failed brief: the start does not answer 200, the old row is open again and still holds its doing', bad.status !== 200 && !keptRow.endedAt && !keptRow.movedTo && keptRow.doing?.taskId === taskId, `${bad.status} ${JSON.stringify(keptRow)}`);
  await col('projects').insertOne(projDoc);
  const good = await call('/api/agent/start', dev.key, { folders: ['smfldb'], path: 'C:/code/sm-beta', ccSession: CC10, source: 'startup', proc: { pid: 7010, procStart: '1' } });
  const SB = good.json?.brief?.session;
  const nr = await col('presence').findOne({ session: SB, projectId: pidB, endedAt: { $exists: false } });
  check('the retry works: the doing is on the session row and gone from the old one', good.status === 200 && nr?.doing?.taskId === taskId && !(await col('presence').findOne({ session: FO })).doing, `${good.status} ${JSON.stringify(nr?.doing)}`);
} catch (e) {
  check('session-merge suite (error)', false, e?.stack || String(e));
}
await finish();
