// Lanes step 1 (plan note 666b20a6e9): the Now holder and held lines. Now has one holder session: the first set_now takes it, the
// holder keeps it, another session is refused while the holder is busy (working, or at a permission prompt) and takes it otherwise
// (the old holder gets an fyi). A dispatched run never sets Now; a person in the app is never refused and keeps the hold. A held
// Next or Later line (edit_line holds it; set_doing on its task holds it) is finished or edited only by its holder, the Now holder or
// a person. save_state, end_work and get_state answer holdsNow. The copy has no holder. Refusals name labels and people, never a
// session id. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { B, EMAIL, ME, PW, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = 'LN Alpha';
const hdr = sess => ({ 'X-Work-OS-Session': sess });
const ago = min => new Date(Date.now() - min * 60_000);
let PID = '';
const stateDoc = () => rawDb.collection('states').findOne({ _id: PID });
const ver = async () => (await stateDoc())?.version ?? 0;
const K = s => `${ME.userId}:${s}`;
const setRow = (sess, set, unset) => rawDb.collection('presence').updateOne({ session: sess }, { ...(set ? { $set: set } : {}), ...(unset ? { $unset: unset } : {}) });
const line = async text => (await stateDoc()).next.concat((await stateDoc()).later).find(l => l.text === text);

// ── server actions as a signed-in person (the State card's save) ──
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
  for (const l of text.split('\n')) { const m = l.match(/^([0-9a-f]+):(.*)$/); if (m) rows.set(m[1], m[2]); }
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
const SAVE = 'app/(app)/projects/[id]/state-actions.ts#saveStateAction';
const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '3', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};

try {
  const T = await makeUser({ email: 'ln-tess@example.test', name: 'Tess Lane', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const ccA = await mkKey({ agent: 'claude-code', name: 'LN ccA' });
  const ccB = await mkKey({ agent: 'claude-code', name: 'LN ccB' });
  const ccD = await mkKey({ agent: 'claude-code', name: 'LN ccD' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'LN Tess cc' });
  PID = (await must(ccA, 'add_project', { name: P, visibility: 'org', code: [{ remote: 'acme/ln-alpha' }] })).project.id;
  const start = (key, sess, label) => must(key, 'start_work', { project: P, session: sess, label }, hdr(sess));
  // A refusal's text without the MCP error prefix ("Error: "), so the checks compare the text Work OS wrote.
  const save = async (key, sess, ops, base) => {
    const r = await mcpH(key, 'save_state', { project: P, ops, ...(base !== undefined ? { base_version: base } : {}), session: sess }, hdr(sess));
    return r.isError ? { ...r, text: r.text.replace(/^Error: /, '') } : r;
  };
  await start(ccA, 'lnA', 'LN A');
  await start(ccB, 'lnB', 'LN B');
  await start(kT, 'lnT', 'LN T');
  const noIds = t => !['lnA', 'lnB', 'lnT', 'lnD', ME.userId, T.userId].some(x => t.includes(x));
  const NOW_HELD = (label, person, state) => new RegExp(`^Now is held by "${label}" \\(${person}, ${state}, \\d+ min ago\\)\\. Nothing was written\\. Keep your lane instead: set_doing your task, log_progress, add_next or add_decision\\. Now passes to you once that session is not working, or your person changes it in the app\\.$`);

  // ── 0. Now is held by sessions Work OS knows: a call naming no session, or a session with no row here, is refused
  const NO_SESSION = 'Now is held by sessions Work OS knows: pass the session id start_work gave you (session) and call again. Nothing was written.';
  const r0 = await mcpH(ccA, 'save_state', { project: P, base_version: 0, ops: [{ op: 'set_now', text: 'LN no session' }] });
  const r0b = await save(ccA, 'lnNope', [{ op: 'set_now', text: 'LN unknown session' }], 0);
  check('known: set_now naming no session, or a session that never started work here, is refused; nothing written', r0.isError && r0.text.replace(/^Error: /, '') === NO_SESSION && r0b.isError && r0b.text === NO_SESSION && !(await stateDoc())?.now, `${r0.text} | ${r0b.text}`);

  // ── 1. no holder: the first set_now takes Now; add_next holds nothing; the copy has no holder
  const r1 = await save(ccA, 'lnA', [{ op: 'set_now', text: 'LN goal one' }, { op: 'add_next', text: 'LN line one' }, { op: 'add_next', text: 'LN line two' }], 0);
  let st = await stateDoc();
  check('take: the first set_now makes the caller the Now holder (key userId:session, its label), holdsNow true for that session', !r1.isError && r1.json?.holdsNow === true && r1.json.holdsNowFor === 'lnA' && st.now.hold?.key === K('lnA') && st.now.hold.label === 'LN A', r1.text.slice(0, 200));
  const gNo = await must(ccA, 'get_state', { project: P });
  check('get_state naming no session: holdsNow false and no holdsNowFor (the hook keeps nothing from it)', gNo.holdsNow === false && !('holdsNowFor' in gNo), JSON.stringify([gNo.holdsNow, gNo.holdsNowFor]));
  check('take: add_next holds no line', st.next.every(l => !l.hold), JSON.stringify(st.next));
  const g1 = await must(ccA, 'get_state', { project: P, copy: true, session: 'lnA' }, hdr('lnA'));
  check('get_state: holdsNow true for the holder, now.holder is its label, the copy has the Now line without a holder', g1.holdsNow === true && g1.state.now.holder === 'LN A' && g1.markdown.includes('\n## Now\n- LN goal one\n'), JSON.stringify([g1.holdsNow, g1.state.now]));

  // ── 2. the holder keeps it; set_now's holder argument is ignored and the answer says so
  const r2 = await save(ccA, 'lnA', [{ op: 'set_now', text: 'LN goal two', holder: 'someone else' }], await ver());
  st = await stateDoc();
  check('holder: the holder sets Now again; holder is ignored (the answer says so)', !r2.isError && r2.json.holdsNow === true && /set_now's holder is ignored/.test(r2.json.note ?? '') && st.now.hold.key === K('lnA') && !st.now.holder && st.now.text === 'LN goal two', r2.text.slice(0, 300));

  // ── 3. another session is refused while the holder works (set_now and edit_line on Now)
  let v = await ver();
  const r3 = await save(ccB, 'lnB', [{ op: 'set_now', text: 'LN B goal' }], v);
  const r3b = await save(ccB, 'lnB', [{ op: 'edit_line', find: 'goal two', new: 'goal three' }], v);
  check('busy: set_now by another session while the holder works is refused with the holder label, person and state', r3.isError && NOW_HELD('LN A', 'E2E Owner', 'working').test(r3.text) && noIds(r3.text), r3.text);
  check('busy: edit_line on Now is refused the same way', r3b.isError && NOW_HELD('LN A', 'E2E Owner', 'working').test(r3b.text), r3b.text);
  check('busy: nothing was written', (await ver()) === v && (await stateDoc()).now.text === 'LN goal two');

  // ── 4. a holder at a permission prompt is busy too
  await setRow('lnA', { activity: { state: 'waiting', why: 'prompt', at: new Date() } });
  const r4 = await save(ccB, 'lnB', [{ op: 'set_now', text: 'LN B goal' }], v);
  check('prompt: a holder waiting at a permission prompt blocks a take-over', r4.isError && NOW_HELD('LN A', 'E2E Owner', 'waiting at a prompt').test(r4.text), r4.text);

  // ── 5. the holder is idle: the hold moves and the old holder gets an fyi on its own session (labels only)
  await setRow('lnA', { activity: { state: 'idle', at: ago(12) }, lastSeen: ago(12) });
  const r5 = await save(ccB, 'lnB', [{ op: 'set_now', text: 'LN B goal' }], v);
  st = await stateDoc();
  check('idle: set_now by another session moves the hold to it (holdsNow true)', !r5.isError && r5.json.holdsNow === true && st.now.hold.key === K('lnB') && st.now.hold.label === 'LN B' && st.now.text === 'LN B goal', r5.text.slice(0, 300));
  const fyi = await rawDb.collection('messages').findOne({ projectId: PID, toSids: K('lnA'), kind: 'fyi' });
  check('idle: the old holder gets an fyi on its own session, naming the new holder by label only', !!fyi && /^"LN B" took over Now on LN Alpha: LN B goal\. You no longer hold Now\./.test(fyi.body) && noIds(fyi.body) && fyi.src === K('lnB'), JSON.stringify(fyi && { body: fyi.body, src: fyi.src, toSids: fyi.toSids }));
  const r6 = await save(ccA, 'lnA', [{ op: 'add_next', text: 'LN line three' }]);
  check('idle: the old holder\'s next save answers holdsNow false', !r6.isError && r6.json.holdsNow === false, r6.text.slice(0, 200));

  // ── 6. another person's session: refused while the holder works, and nothing names a session id
  v = await ver();
  const r7 = await save(kT, 'lnT', [{ op: 'set_now', text: 'LN Tess goal' }], v);
  check('person: a teammate\'s session is refused while the holder works; the text names the label and its person, no ids', r7.isError && NOW_HELD('LN B', 'E2E Owner', 'working').test(r7.text) && noIds(r7.text), r7.text);
  const gT = await must(kT, 'get_state', { project: P, session: 'lnT' }, hdr('lnT'));
  check('person: the teammate\'s get_state says holdsNow false, holder by label, no session id', gT.holdsNow === false && gT.state.now.holder === 'LN B' && gT.holdsNowFor === 'lnT' && noIds(JSON.stringify({ ...gT, holdsNowFor: undefined })), JSON.stringify(gT.state.now));

  // ── 7. a dispatched run never sets Now
  await start(ccD, 'lnD', 'LN D');
  const tD = (await must(ccA, 'add_task', { title: 'LN dispatched task', project: P })).created;
  await setRow('lnD', { dispatched: { taskId: tD.id, ref: tD.ref } });
  const r8 = await save(ccD, 'lnD', [{ op: 'set_now', text: 'LN D goal' }], v);
  check('dispatched: refused, naming the holder and the ops that work', r8.isError && r8.text === `A dispatched run never sets Now (held by "LN B", working). log_progress on #${tD.ref}, hand_in when done, or add_next.`, r8.text);
  await setRow('lnB', { lastSeen: ago(15) });
  const r8b = await save(ccD, 'lnD', [{ op: 'edit_line', find: 'LN B goal', new: 'LN D goal' }], v);
  check('dispatched: refused even when the holder is not busy (edit_line on Now too)', r8b.isError && r8b.text.startsWith('A dispatched run never sets Now (held by "LN B", idle).'), r8b.text);
  check('dispatched: nothing was written', (await ver()) === v && (await stateDoc()).now.hold.key === K('lnB'));
  await setRow('lnB', { lastSeen: new Date() });

  // ── 8. a person in the app is never refused, and keeps the hold
  const cookie = await signIn(EMAIL);
  const a1 = await action(SAVE, [PID, [{ op: 'set_now', text: 'LN person goal' }], v], cookie);
  st = await stateDoc();
  check('app: a person sets Now while the holder works; the hold stays with the holder', a1.value?.ok === true && st.now.text === 'LN person goal' && st.now.hold?.key === K('lnB'), JSON.stringify(a1.value).slice(0, 200));
  const a2 = await action(SAVE, [PID, [{ op: 'edit_line', find: 'person goal', new: 'person goal, edited' }]], cookie);
  st = await stateDoc();
  check('app: a person edits Now; the hold stays', a2.value?.ok === true && st.now.text === 'LN person goal, edited' && st.now.hold?.key === K('lnB'), JSON.stringify(a2.value).slice(0, 200));

  // ── 9. held lines: edit_line holds a line; only its holder, the Now holder or a person changes it
  const l1 = await line('LN line one');
  const e1 = await save(ccA, 'lnA', [{ op: 'edit_line', id: l1.id, find: 'line one', new: 'line one, edited' }]);
  let l1b = await line('LN line one, edited');
  check('line: a session that edits a free line holds it (key userId:session), and is stamped with that key', !e1.isError && l1b?.hold?.key === K('lnA') && l1b.src === K('lnA'), JSON.stringify(l1b));
  const LINE_HELD = `Next line ${l1.id} "LN line one, edited" is held by "LN A" (idle). Nothing was written. That session, the Now holder "LN B" or a person in the app can finish or edit it; add_next a new line, or send_message "LN A".`;
  v = await ver();
  const tOps = [
    ['done_next', { op: 'done_next', id: l1.id }],
    ['edit_line', { op: 'edit_line', find: 'line one, edited', new: 'Tess was here' }],
    ['archive_line', { op: 'archive_line', id: l1.id }],
  ];
  for (const [name, op] of tOps) {
    const r = await save(kT, 'lnT', [op]);
    check(`line: another person's session is refused ${name} on a held line, with the exact text`, r.isError && r.text === LINE_HELD, r.text);
  }
  const rC = await save(ccD, 'lnD', [{ op: 'done_next', id: l1.id }]);
  check('line: another session of the same person is refused too', rC.isError && rC.text === LINE_HELD, rC.text);
  check('line: nothing was written', (await ver()) === v);
  const eB = await save(ccB, 'lnB', [{ op: 'edit_line', id: l1.id, find: 'edited', new: 'edited by the lead' }]);
  l1b = await line('LN line one, edited by the lead');
  check('line: the Now holder edits a held line; the hold stays with its holder', !eB.isError && l1b?.hold?.key === K('lnA'), eB.text.slice(0, 200) + JSON.stringify(l1b));
  const dA = await save(ccA, 'lnA', [{ op: 'done_next', id: l1.id }]);
  check('line: its holder finishes it', !dA.isError && !(await line('LN line one, edited by the lead')), dA.text.slice(0, 200));

  // ── 10. set_doing on a task holds its Next line (derived, no State write)
  const t2 = (await must(ccB, 'add_task', { title: 'LN doing task', project: P })).created;
  await save(ccB, 'lnB', [{ op: 'add_next', text: 'LN task line', ref: t2.ref }]);
  const vDo = await ver();
  const sd = await must(kT, 'set_doing', { task: t2.ref, session: 'lnT' }, hdr('lnT'));
  const lt = await line('LN task line');
  check('doing: set_doing says the session holds the task\'s Next line, and writes nothing to the State', /You hold its Next line l_[0-9a-f]+ while you are on it/.test(sd.note) && (await ver()) === vDo && !lt.hold, JSON.stringify(sd));
  const rD = await save(ccA, 'lnA', [{ op: 'done_next', id: lt.id }]);
  check('doing: another session is refused, the text says which task the holder is on', rD.isError && rD.text === `Next line ${lt.id} "LN task line" is held by "LN T" (working, on #${t2.ref}). Nothing was written. That session, the Now holder "LN B" or a person in the app can finish or edit it; add_next a new line, or send_message "LN T".` && noIds(rD.text), rD.text);
  const vB = await ver();
  const rDB = await save(ccB, 'lnB', [{ op: 'done_next', id: lt.id }]);
  check('doing: the Now holder is refused finishing a busy session\'s line too (it is that session\'s or a person\'s)', rDB.isError && rDB.text.startsWith(`Next line ${lt.id} "LN task line" is held by "LN T" (working, on #${t2.ref}).`) && (await ver()) === vB, rDB.text);
  const mA = await save(ccA, 'lnA', [{ op: 'move_next', id: lt.id, to: 'top' }]);
  check('doing: another session is refused move_next on a busy session\'s line', mA.isError && mA.text.startsWith(`Next line ${lt.id} "LN task line" is held by "LN T"`) && (await ver()) === vB, mA.text);
  const mB = await save(ccB, 'lnB', [{ op: 'move_next', id: lt.id, to: 'top' }]);
  check('doing: the Now holder may reorder it', !mB.isError && (await stateDoc()).next[0]?.id === lt.id, mB.text.slice(0, 200));
  // Taking Now from an idle holder and finishing a busy session's line in the same call does not get around the line's hold.
  await start(ccA, 'lnO', 'LN O');
  await setRow('lnB', { lastSeen: ago(15) });
  const vO = await ver();
  const msgO = await rawDb.collection('messages').countDocuments({});
  const rTk = await save(ccA, 'lnO', [{ op: 'set_now', text: 'LN O goal' }, { op: 'done_next', id: lt.id }], vO);
  const stO = await stateDoc();
  check('doing: take Now + done_next on a busy session\'s line in one call is refused; nothing written, no message', rTk.isError && rTk.text.startsWith(`Next line ${lt.id} "LN task line" is held by "LN T"`) && (await ver()) === vO && stO.now.hold.key === K('lnB') && (await rawDb.collection('messages').countDocuments({})) === msgO, rTk.text);
  await setRow('lnB', { lastSeen: new Date() });
  await setRow('lnO', { endedAt: new Date() });
  const rD2 = await save(kT, 'lnT', [{ op: 'edit_line', id: lt.id, find: 'task line', new: 'task line, by Tess' }]);
  check('doing: the session on the task edits its line', !rD2.isError && (await line('LN task line, by Tess'))?.hold?.key === `${T.userId}:lnT`, rD2.text.slice(0, 200));

  // ── 11. Later lines: a held Later line is refused the same way (promote_later), and a person may archive it
  await save(ccB, 'lnB', [{ op: 'add_later', text: 'LN later one' }]);
  const ll = await line('LN later one');
  await save(ccA, 'lnA', [{ op: 'edit_line', id: ll.id, find: 'later one', new: 'later one, held' }]);
  const rL = await save(kT, 'lnT', [{ op: 'promote_later', id: ll.id }]);
  check('later: promote_later on a held Later line is refused (Later line …)', rL.isError && rL.text.startsWith(`Later line ${ll.id} "LN later one, held" is held by "LN A" (idle). Nothing was written.`), rL.text);
  const aL = await action(SAVE, [PID, [{ op: 'archive_line', id: ll.id }]], cookie);
  check('later: a person archives the held line in the app', aL.value?.ok === true && !(await line('LN later one, held')), JSON.stringify(aL.value).slice(0, 200));

  // ── 12. a hold whose session is gone (no row, or off 30 minutes) stops nobody
  await save(ccB, 'lnB', [{ op: 'add_next', text: 'LN orphan line' }]);
  const lo = await line('LN orphan line');
  await rawDb.collection('states').updateOne({ _id: PID, 'next.id': lo.id }, { $set: { 'next.$.hold': { key: K('lnGone'), at: ago(90) } } });
  const rO = await save(kT, 'lnT', [{ op: 'archive_line', id: lo.id }]);
  check('gone: a line held by a session with no row is archived by anyone', !rO.isError && !(await line('LN orphan line')), rO.text.slice(0, 200));

  // ── 13. the hook's State route: a bare session id is normalised to userId:sid (holds and stamps), the copy has no holder
  const pc = await mkDevice('ln-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'LN-PC' } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold1`, deviceId: pc.id, folderId: 'fold1', name: 'C:/code/ln', git: true, remote: 'acme/ln-alpha', projectId: PID, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const hs = await call('/api/agent/start', pc.key, { folders: ['fold1'], remote: 'https://github.com/acme/ln-alpha.git', branch: 'main', path: 'C:/code/ln', ccSession: randomUUID(), source: 'startup' });
  const TOK = hs.json?.token;
  const SID = hs.json?.brief?.session;
  check('route setup: a hook session of Om on the project', hs.status === 200 && /^wst_/.test(TOK ?? '') && !!SID, hs.text.slice(0, 160));
  await save(ccB, 'lnB', [{ op: 'add_next', text: 'LN hook line' }]);
  const hr = await call('/api/agent/state', TOK, { edit: { old: 'LN hook line', new: 'LN hook line, edited in the copy' } });
  const hl = await line('LN hook line, edited in the copy');
  check('route: an edit of the copy holds the line under userId:sid and stamps that key', hr.status === 200 && hl?.hold?.key === `${ME.userId}:${SID}` && hl.src === `${ME.userId}:${SID}`, hr.text.slice(0, 200) + JSON.stringify(hl));
  check('route: the answer carries holdsNow (false: the hook session does not hold Now) and the copy has no holder', hr.json?.holdsNow === false && /\n## Now\n- LN person goal, edited\n/.test(hr.json.markdown ?? ''), (hr.json?.markdown ?? '').slice(0, 300));
  const hn = await call('/api/agent/state', TOK, { edit: { old: 'LN person goal, edited', new: 'LN hook goal' } });
  check('route: an edit of Now through the copy is refused while the holder works', hn.status === 400 && NOW_HELD('LN B', 'E2E Owner', 'working').test(hn.json?.error ?? '') && noIds(hn.json?.error ?? ''), hn.text.slice(0, 300));

  // ── 14. a holder with no row on the project: the hold moves without a message; end_work answers holdsNow
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: K('lnGhost'), label: 'LN Ghost', at: ago(5) } } });
  const msgs = await rawDb.collection('messages').countDocuments({});
  const r14 = await save(ccA, 'lnA', [{ op: 'set_now', text: 'LN A again' }], await ver());
  check('ghost: a hold whose session has no row moves at once, and no message is sent', !r14.isError && r14.json.holdsNow === true && (await stateDoc()).now.hold.key === K('lnA') && (await rawDb.collection('messages').countDocuments({})) === msgs, r14.text.slice(0, 200));
  const ew = await must(ccA, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'lnbox', branch: 'main' }], friction: 'none', session: 'lnA' }, hdr('lnA'));
  const ewB = await must(ccB, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'lnbox', branch: 'main' }], friction: 'none', session: 'lnB' }, hdr('lnB'));
  check('end_work: the answer carries holdsNow (true for the holder, false for another)', ew.ended === true && ew.holdsNow === true && ewB.holdsNow === false, JSON.stringify([ew.holdsNow, ewB.holdsNow]));
  // A holder whose session has ended is not told when Now moves (nobody would read it).
  await start(ccB, 'lnB', 'LN B');
  const msgE = await rawDb.collection('messages').countDocuments({});
  const rE = await save(ccB, 'lnB', [{ op: 'set_now', text: 'LN B back' }], await ver());
  check('ended: Now moves from an ended holder with no message to it', !rE.isError && rE.json.holdsNow === true && (await stateDoc()).now.hold.key === K('lnB') && (await rawDb.collection('messages').countDocuments({})) === msgE, rE.text.slice(0, 200));

  // ── 15. a legacy free-text holder is shown by get_state but not in the copy
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.holder': 'old lead' }, $unset: { 'now.hold': '' } });
  const g15 = await must(kT, 'get_state', { project: P, copy: true, session: 'lnT' }, hdr('lnT'));
  check('legacy: get_state shows the old holder text; the copy never has a holder suffix', g15.state.now.holder === 'old lead' && g15.markdown.includes('\n- LN B back\n') && !g15.markdown.includes('old lead'), JSON.stringify(g15.state.now));

  // ── 16. an unheld Now (set before Lanes): a save by a main session takes it; a builder (a row with a parent) does not; a hold is never moved
  await rawDb.collection('states').updateOne({ _id: PID }, { $unset: { 'now.holder': '', 'now.hold': '' } });
  await setRow('lnB', { parent: 'lnA' });
  const r16a = await save(ccB, 'lnB', [{ op: 'set_where', machine: 'lnbox', branch: 'b1' }], await ver());
  check('unheld: a builder row (with parent) saving does not take Now', !r16a.isError && r16a.json.holdsNow === false && !(await stateDoc()).now.hold, r16a.text.slice(0, 200));
  await setRow('lnB', {}, { parent: '' });
  const r16b = await save(ccB, 'lnB', [{ op: 'set_where', machine: 'lnbox', branch: 'b2' }], await ver());
  st = await stateDoc();
  check('unheld: a save by a main session (no set_now) takes Now: holdsNow true and now.hold set', !r16b.isError && r16b.json.holdsNow === true && st.now.hold?.key === K('lnB') && st.now.hold.label === 'LN B', r16b.text.slice(0, 200));
  const r16c = await save(ccA, 'lnA', [{ op: 'set_where', machine: 'lnbox', branch: 'b3' }], await ver());
  check('unheld: an existing hold is never moved by a plain save', !r16c.isError && r16c.json.holdsNow === false && (await stateDoc()).now.hold.key === K('lnB'), r16c.text.slice(0, 200));
} catch (e) {
  check('flow-lanes (error)', false, e?.stack || String(e));
}
await finish();
