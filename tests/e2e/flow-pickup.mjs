// Lanes step 2 (plan note 666b20a6e9): pickup and sweep. A session that picks up a handover is given the old session's Needs (open and
// answered-unbriefed, with the asking key), its unread messages and its Now hold and held lines, when the old one ended or is not busy,
// and only a person's own sessions pass Needs and messages. movedTo on the old row makes a reply follow the work (at most 3 hops).
// A session off for 30 minutes hands its Needs and messages to the Now holder (else the person's newest live session) when the person's
// next session takes a turn, and its held lines are released with a `left` record. withdraw_need on an answered Need says which answer.
// The State version is never bumped by any of it. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, MCP, ME, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'PK Alpha';
const hdr = sess => ({ 'X-Work-OS-Session': sess });
const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '3', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ago = min => new Date(Date.now() - min * 60_000);
const row = sess => rawDb.collection('presence').findOne({ session: sess });
const needDoc = id => rawDb.collection('needs').findOne({ _id: id });
const msgDoc = id => rawDb.collection('messages').findOne({ _id: id });
const stateDoc = async () => rawDb.collection('states').findOne({ _id: PID });
let PID = '';
const K = s => `${ME.userId}:${s}`;

try {
  const T = await makeUser({ email: 'pk-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const cc = await mkKey({ agent: 'claude-code', name: 'PK cc' });
  const ccB = await mkKey({ agent: 'claude-code', name: 'PK ccB' });
  const ccC = await mkKey({ agent: 'claude-code', name: 'PK ccC' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'PK Tess cc' });
  PID = (await must(MCP, 'add_project', { name: P, visibility: 'org', code: [{ remote: 'acme/pk-alpha' }] })).project.id;
  const start = (key, sess, extra = {}) => must(key, 'start_work', { project: P, session: sess, ...extra }, hdr(sess));
  const ask = async (key, sess, text, extra = {}) => (await must(key, 'ask', { project: P, to: 'me', kind: 'decide', ask: text, options: [{ label: 'Yes now', means: 'go' }, { label: 'Later', means: 'wait' }], session: sess, ...extra }, hdr(sess))).need;
  const answer = async (n, by = ME.userId) => {
    const d = await needDoc(n.id);
    await rawDb.collection('needs').updateOne({ _id: n.id }, { $set: { status: 'answered', answer: { option: d.options[0].id, by, via: 'app', at: new Date() }, answeredAt: new Date() } });
  };
  const say = (key, sess, to, body, kind = 'request') => must(key, 'send_message', { to, kind, body, session: sess }, hdr(sess));
  const handover = (key, sess, title, extra = {}) => must(key, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'pkbox', branch: `br-${sess}` }], friction: 'none', handover: { step: `PK ${title}`, title, ...extra }, session: sess }, hdr(sess));

  // set_now needs a session Work OS knows (Lanes): a fixture session, whose row is removed again so no pickup or sweep sees it.
  await start(cc, 'pk-fixture');
  await must(cc, 'save_state', { project: P, base_version: 0, session: 'pk-fixture', ops: [{ op: 'set_now', text: 'PK goal: hand work over' }, { op: 'add_next', text: 'PK line one, long enough to matter' }, { op: 'add_next', text: 'PK line two, long enough to matter' }] });
  await rawDb.collection('presence').deleteMany({ session: 'pk-fixture' });
  let st = await stateDoc();
  check('setup: a State with two Next lines', st?.next?.length === 2, JSON.stringify(st?.next));
  const L1 = st.next[0].id;
  const L2 = st.next[1].id;

  // ── 1. moves when A is off: A holds Needs (open and answered), an unread message, Now and a line; B picks up A's handover
  await start(cc, 'pkA', { label: 'PK A', machine: 'pkbox', branch: 'br-pkA' });
  const sStart = await start(cc, 'pkS', { label: 'PK S' });
  check('name: a plain start (no handover) is not told to name itself', !sStart.handover && !sStart.sessionNote.includes('Name this session now'), sStart.sessionNote);
  const n1 = await ask(cc, 'pkA', 'PK A answered question?');
  const n2 = await ask(cc, 'pkA', 'PK A open question?');
  await answer(n1);
  const m1 = await say(cc, 'pkS', 'pkA', 'PK to A: please look at line one');
  const m2 = await say(cc, 'pkA', 'pkS', 'PK from A: a question for S', 'question');
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: K('pkA'), label: 'PK A', at: new Date() }, 'next.0.hold': { key: K('pkA'), at: new Date() } } });
  const hA = await handover(cc, 'pkA', 'Handover: PK A');
  check('A: ended, with a handover', !!hA.handover?.id && !!(await row('pkA')).endedAt, JSON.stringify(hA).slice(0, 200));
  const vBefore = (await stateDoc()).version;
  const bStart = await start(ccB, 'pkB', { label: 'PK B', machine: 'pkbox', branch: 'br-pkB' });
  check('B: its brief shows the handover', bStart.handover?.some(h => h.id === hA.handover.id), JSON.stringify(bStart.handover)?.slice(0, 200));
  check('name: taking a handover at a fresh start tells the session its name, project filled in, role open (the writer has no role in its label)', bStart.sessionNote.includes(`Name this session now: ${P} · <role> · <what you take on>. Pass it as start_work's label`) && bStart.sessionNote.includes('set_session_title') && bStart.sessionNote.includes('/rename'), bStart.sessionNote);
  const bAgain = await start(ccB, 'pkB', { label: 'PK B' });
  check('name: the same session starting again (after compaction) sees the handover but no name line', !!bAgain.handover?.some(h => h.id === hA.handover.id) && !bAgain.sessionNote.includes('Name this session now'), bAgain.sessionNote);
  const rowB = await row('pkB');
  const n1b = await needDoc(n1.id);
  const n2b = await needDoc(n2.id);
  check('pickup: A\'s answered and open Needs now say B asked them, with B\'s own key', n1b.from.session === 'pkB' && n2b.from.session === 'pkB' && n1b.from.keyId === rowB.keyId && n2b.from.keyId === rowB.keyId && rowB.keyId !== (await row('pkA')).keyId, JSON.stringify([n1b.from, n2b.from, rowB.keyId]));
  const m1b = await msgDoc(m1.id);
  const m2b = await msgDoc(m2.id);
  check('pickup: the unread message to A is addressed to B; a message A sent stays as it was', JSON.stringify(m1b.toSids) === JSON.stringify([`${ME.userId}:pkB`]) && m2b.src === `${ME.userId}:pkA` && JSON.stringify(m2b.toSids) === JSON.stringify([`${ME.userId}:pkS`]), JSON.stringify([m1b.toSids, m2b.src, m2b.toSids]));
  st = await stateDoc();
  check('pickup: the Now hold and the held line move to B, a line nobody held stays free', st.now.hold?.key === K('pkB') && st.next.find(l => l.id === L1).hold?.key === K('pkB') && !st.next.find(l => l.id === L2).hold, JSON.stringify([st.now.hold, st.next.map(l => l.hold)]));
  check('pickup: the State version is unchanged and A\'s row says where its work went', st.version === vBefore && (await row('pkA')).movedTo === 'pkB', JSON.stringify([st.version, vBefore, (await row('pkA')).movedTo]));
  const w1 = await mcpH(ccB, 'withdraw_need', { id: n2.ref, session: 'pkB' }, hdr('pkB'));
  check('pickup: B may withdraw the Need A asked (its session and key match now)', !w1.isError && /withdrawn/.test(w1.text), w1.text.slice(0, 200));

  // ── 2. nothing moves while A is busy
  await start(cc, 'pkA2', { label: 'PK A2' });
  const nA2 = await ask(cc, 'pkA2', 'PK A2 question?');
  const mA2 = await say(cc, 'pkS', 'pkA2', 'PK to A2: still here');
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'next.1.hold': { key: K('pkA2'), at: new Date() } } });
  const hA2 = await handover(cc, 'pkA2', 'Handover: PK A2');
  await rawDb.collection('presence').updateOne({ session: 'pkA2' }, { $unset: { endedAt: '' }, $set: { activity: { state: 'working', at: new Date() }, lastSeen: new Date() } }); // A2 is working again
  const b2 = await start(ccB, 'pkB2', { label: 'PK B2' });
  check('busy: B2 is still shown the handover (the note is for it)', b2.handover?.some(h => h.id === hA2.handover.id), JSON.stringify(b2.handover)?.slice(0, 200));
  const nA2b = await needDoc(nA2.id);
  st = await stateDoc();
  check('busy: nothing moved: the Need, the message, the held line and A2\'s row are as they were', nA2b.from.session === 'pkA2' && JSON.stringify((await msgDoc(mA2.id)).toSids) === JSON.stringify([`${ME.userId}:pkA2`]) && st.next[1].hold?.key === K('pkA2') && st.now.hold?.key === K('pkB') && !(await row('pkA2')).movedTo, JSON.stringify([nA2b.from.session, st.now.hold, st.next[1].hold]));
  await rawDb.collection('presence').updateOne({ session: 'pkA2' }, { $set: { activity: { state: 'waiting', why: 'prompt', at: new Date() } } });
  await rawDb.collection('notes').updateOne({ _id: hA2.handover.id }, { $unset: { 'handover.pickedUp': '' } }); // offered again to a fresh session
  const b2b = await start(ccC, 'pkB2b', { label: 'PK B2b' });
  check('busy: a session at a permission prompt is busy too (the handover is shown, nothing moves)', !!b2b.handover?.some(h => h.id === hA2.handover.id) && (await needDoc(nA2.id)).from.session === 'pkA2' && !(await row('pkA2')).movedTo, JSON.stringify(b2b.handover)?.slice(0, 200));
  await rawDb.collection('states').updateOne({ _id: PID }, { $unset: { 'next.1.hold': '' } });

  // ── 3. nothing crosses persons: Om's A3 hands a note to Tess; her session picks it up, but Needs and messages stay with Om's session
  await start(cc, 'pkA3', { label: 'PK A3' });
  const nA3 = await ask(cc, 'pkA3', 'PK A3 question?');
  const mA3 = await say(cc, 'pkS', 'pkA3', 'PK to A3: for Om only');
  const hA3 = await handover(cc, 'pkA3', 'Handover: PK A3', { for: 'Tess' });
  const t3 = await start(kT, 'pkT3', { label: 'PK T3' });
  check('person: Tess is shown the handover Om\'s session left for her', t3.handover?.some(h => h.id === hA3.handover.id), JSON.stringify(t3.handover)?.slice(0, 200));
  const nA3b = await needDoc(nA3.id);
  const A3 = await row('pkA3');
  check('person: Om\'s Need still says Om\'s session asked it, the message is still for Om\'s session, and A3 names no one to follow', nA3b.from.session === 'pkA3' && nA3b.from.keyId === A3.keyId && JSON.stringify((await msgDoc(mA3.id)).toSids) === JSON.stringify([`${ME.userId}:pkA3`]) && !A3.movedTo && !A3.doing, JSON.stringify([nA3b.from, A3.movedTo]));

  // ── 4. chain A -> B -> C
  const nB = await ask(ccB, 'pkB', 'PK B open question?');
  const mB = await say(cc, 'pkS', 'pkB', 'PK to B: unread when B stops');
  const hB = await handover(ccB, 'pkB', 'Handover: PK B');
  const cStart = await start(ccC, 'pkC', { label: 'PK C' });
  check('chain: C is shown B\'s handover', cStart.handover?.some(h => h.id === hB.handover.id), JSON.stringify(cStart.handover)?.slice(0, 200));
  const rowC = await row('pkC');
  const nBc = await needDoc(nB.id);
  st = await stateDoc();
  check('chain: the open Need and unread message of B, and the Now hold and line B got from A, are now C\'s', nBc.from.session === 'pkC' && nBc.from.keyId === rowC.keyId && JSON.stringify((await msgDoc(mB.id)).toSids) === JSON.stringify([`${ME.userId}:pkC`]) && st.now.hold?.key === K('pkC') && st.next.find(l => l.id === L1).hold?.key === K('pkC'), JSON.stringify([nBc.from, st.now.hold, st.next[0].hold]));
  check('chain: A points at B and B points at C', (await row('pkA')).movedTo === 'pkB' && (await row('pkB')).movedTo === 'pkC');

  // ── 5. a reply to A reaches C; the chain is followed 3 hops at most
  const rp = await must(cc, 'reply', { id: m2.id, body: 'PK reply to A', session: 'pkS' }, hdr('pkS'));
  const rd = await msgDoc(rp.id);
  check('reply: an answer to A\'s message goes to C, in the same thread', JSON.stringify(rd.toSids) === JSON.stringify([`${ME.userId}:pkC`]) && rd.thread === m2.id, JSON.stringify([rd.toSids, rd.thread]));
  const base = await row('pkS');
  for (let i = 1; i <= 5; i++) await rawDb.collection('presence').insertOne({ ...base, _id: `${ME.userId}:s:x${i}:${PID}`, key: `x${i}`, session: `x${i}`, label: `X${i}`, ...(i < 5 ? { movedTo: `x${i + 1}` } : {}), ...(i < 4 ? { activity: { state: 'off', at: new Date() } } : {}) });
  const parent = await msgDoc(m2.id);
  await rawDb.collection('messages').insertOne({ ...parent, _id: 'm_pkhops000001', src: `${ME.userId}:x1`, from: { ...parent.from, session: 'x1' }, toSids: [`${ME.userId}:pkS`], seenBy: [], thread: 'm_pkhops000001', status: 'unread' });
  const hop = await must(cc, 'reply', { id: 'm_pkhops000001', body: 'PK reply along a long chain', session: 'pkS' }, hdr('pkS'));
  check('reply: a chain of moves is followed 3 hops and no further (x1 -> x4; a session alive again ends the chain)', JSON.stringify((await msgDoc(hop.id)).toSids) === JSON.stringify([`${ME.userId}:x4`]), JSON.stringify((await msgDoc(hop.id)).toSids));
  const bare = await must(cc, 'reply', { id: 'm_pkhops000001', body: 'again', session: 'pkS' }, hdr('pkS'));
  check('reply: the same answer twice still goes to the same place', JSON.stringify((await msgDoc(bare.id)).toSids) === JSON.stringify([`${ME.userId}:x4`]));

  // ── 6. the sweep: a session off for 30 minutes hands its Needs and messages on when the person's next session takes a turn
  const pc = await mkDevice('pk-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'PK-PC' } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold1`, deviceId: pc.id, folderId: 'fold1', name: 'C:/code/f1', git: true, remote: 'acme/pk-alpha', projectId: PID, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const hs = await call('/api/agent/start', pc.key, { folders: ['fold1'], remote: 'https://github.com/acme/pk-alpha.git', branch: 'main', path: 'C:/code/f1', ccSession: randomUUID(), source: 'startup' });
  const LTOK = hs.json?.token;
  const LSID = hs.json?.brief?.session;
  check('sweep setup: a hook session of Om on the project', hs.status === 200 && /^wst_/.test(LTOK ?? '') && !!LSID, hs.text.slice(0, 160));
  await start(cc, 'pkH', { label: 'PK H' });
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: K('pkH'), label: 'PK H', at: new Date() } } });
  await start(cc, 'pkA6', { label: 'PK A6', machine: 'pkbox', branch: 'br-pkA6' });
  const t6 = (await must(cc, 'add_task', { title: 'PK sweep task', project: P })).created;
  await must(cc, 'log_progress', { task: t6.ref, progress: 30, note: 'PK sweep log note', session: 'pkA6' }, hdr('pkA6'));
  const n6o = await ask(cc, 'pkA6', 'PK A6 open question?');
  const n6a = await ask(cc, 'pkA6', 'PK A6 answered question?');
  await answer(n6a);
  const m6 = await say(cc, 'pkS', 'pkA6', 'PK to A6: unread');
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'next.1.hold': { key: K('pkA6'), at: ago(50) }, 'next.1.ref': t6.ref, 'where.raw6': { branch: 'br-pkA6', head: 'bbb2222', at: new Date(), by: ME.userId } } });
  await start(cc, 'pkA7', { label: 'PK A7' });
  const n7 = await ask(cc, 'pkA7', 'PK A7 open question?');
  await start(kT, 'pkTs', { label: 'PK Tess off' });
  const nT = (await must(kT, 'ask', { project: P, to: 'me', kind: 'decide', ask: 'PK Tess question?', options: [{ label: 'Yes', means: 'go' }, { label: 'No', means: 'stop' }], session: 'pkTs' }, hdr('pkTs'))).need;
  const off = (sess, min) => rawDb.collection('presence').updateOne({ session: sess }, { $set: { lastSeen: ago(min), activity: { state: 'off', at: ago(min) } } });
  await off('pkA6', 45);
  await off('pkA7', 10);
  await off('pkTs', 45);
  // A message sent to nobody in particular, addressed to every session present then; the gone session had read it, the Now holder had not.
  const bcId = randomUUID();
  await rawDb.collection('messages').insertOne({ _id: bcId, orgId: ME.orgId, ownerId: ME.userId, visibility: 'org', sharedWith: [], projectId: PID, from: { userId: ME.userId, word: 'agent', session: 'pkS' }, kind: 'fyi', body: 'PK broadcast', refs: {}, thread: bcId, status: 'seen', src: K('pkS'), toSids: [K('pkA6'), K('pkH')], seenBy: [K('pkA6')], at: ago(60), createdAt: ago(60) });
  const keyH = (await row('pkH')).keyId;
  const vSweep = (await stateDoc()).version;
  const d1 = await call('/api/agent/event', LTOK, { event: 'prompt', deliver: true });
  check('sweep: the event with deliver answered', d1.status === 200, d1.text.slice(0, 160));
  const n6ob = await needDoc(n6o.id);
  const n6ab = await needDoc(n6a.id);
  check('sweep: the Needs of the session that was off 45 minutes (open and answered) go to the Now holder, with its key', n6ob.from.session === 'pkH' && n6ab.from.session === 'pkH' && n6ob.from.keyId === keyH, JSON.stringify([n6ob.from, n6ab.from]));
  check("sweep: the gone session's read mark does not make the live target treat a broadcast as read (it stays unread for it)", !((await msgDoc(bcId)).seenBy ?? []).includes(K('pkH')), JSON.stringify((await msgDoc(bcId)).seenBy));
  check('sweep: its unread message is addressed to the Now holder', JSON.stringify((await msgDoc(m6.id)).toSids) === JSON.stringify([`${ME.userId}:pkH`]));
  st = await stateDoc();
  const l2 = st.next.find(l => l.id === L2);
  check('sweep: its held line is released and keeps where it stood (label, branch, head, last log)', !l2.hold && l2.left?.label === 'PK A6' && l2.left.branch === 'br-pkA6' && l2.left.head === 'bbb2222' && l2.left.log === 'PK sweep log note', JSON.stringify(l2));
  check('sweep: the State version is unchanged and the row is marked swept', st.version === vSweep && !!(await row('pkA6')).swept, JSON.stringify([st.version, vSweep]));
  check('sweep: a session off only 10 minutes is left alone', (await needDoc(n7.id)).from.session === 'pkA7' && !(await row('pkA7')).swept);
  check('sweep: another person\'s session, off 45 minutes, is left alone (nothing crosses persons)', (await needDoc(nT.id)).from.session === 'pkTs' && !(await row('pkTs')).swept);
  // Now holder is no live session of Om's: the newest live session of his (the caller's) gets it, and the answer is handed over in that very turn
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: `${T.userId}:pkTs`, label: 'PK Tess off', at: new Date() } } });
  await start(cc, 'pkA8', { label: 'PK A8' });
  const n8 = await ask(cc, 'pkA8', 'PK A8 answered question?');
  await answer(n8);
  await off('pkA8', 40);
  const d2 = await call('/api/agent/event', LTOK, { event: 'prompt', deliver: true });
  check('sweep: with no live Now holder of his own, the Needs go to the newest live session (the caller here)', (await needDoc(n8.id)).from.session === LSID, JSON.stringify((await needDoc(n8.id)).from));
  check('sweep: …and the answer reaches the caller in that same turn', new RegExp(`Need #${n8.ref} was answered`).test(d2.json?.deliver?.text ?? '') && (d2.json.deliver.needs ?? []).includes(n8.id), (d2.text ?? '').slice(0, 240));
  check('sweep: the row of the first one is not swept again (still marked, Needs stay with the holder)', (await needDoc(n6a.id)).from.session === 'pkH');


  // ── 8. review fixes
  // movedTo after a sweep: the swept row points at the receiver; a reply to a message it sent goes there; alive again, it gets it back
  const a6 = await row('pkA6');
  check('sweep: the swept row points at the session that received its work', a6.movedTo === 'pkH', String(a6.movedTo));
  const m6s = await say(cc, 'pkA6', 'pkS', 'PK from A6 before it died', 'question'); // sent now, so src is A6
  const rp6 = await must(cc, 'reply', { id: m6s.id, body: 'PK reply to a swept session', session: 'pkS' }, hdr('pkS'));
  check('reply: an answer to a swept session goes to the one that got its work', JSON.stringify((await msgDoc(rp6.id)).toSids) === JSON.stringify([K('pkH')]), JSON.stringify((await msgDoc(rp6.id)).toSids));
  await rawDb.collection('presence').updateOne({ session: 'pkA6' }, { $set: { lastSeen: new Date(), activity: { state: 'on', at: new Date() } } });
  const rp6b = await must(cc, 'reply', { id: m6s.id, body: 'PK reply after it came back', session: 'pkS' }, hdr('pkS'));
  check('reply: a session that came alive again gets its replies again', JSON.stringify((await msgDoc(rp6b.id)).toSids) === JSON.stringify([K('pkA6')]), JSON.stringify((await msgDoc(rp6b.id)).toSids));

  // an old handover does not move holds (24 hours), Needs and messages still move
  await start(cc, 'pkOld', { label: 'PK Old' });
  const nOld = await ask(cc, 'pkOld', 'PK Old question?');
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: K('pkOld'), label: 'PK Old', at: new Date() } } });
  const hOld = await handover(cc, 'pkOld', 'Handover: PK Old');
  await rawDb.collection('notes').updateOne({ _id: hOld.handover.id }, { $set: { 'handover.at': ago(26 * 60) } });
  await start(ccB, 'pkNew', { label: 'PK New' });
  st = await stateDoc();
  check('old handover: the Need moves but the Now hold stays where it was (the handover is over 24 hours old)', (await needDoc(nOld.id)).from.session === 'pkNew' && st.now.hold?.key === K('pkOld'), JSON.stringify([(await needDoc(nOld.id)).from.session, st.now.hold]));

  // a private task of another project is never read into this State by the sweep
  const Q = (await must(cc, 'add_project', { name: 'PK Private', visibility: 'private' })).project.id;
  const tq = (await must(cc, 'add_task', { title: 'PK private task', project: 'PK Private' })).created;
  await must(cc, 'log_progress', { task: tq.ref, progress: 10, note: 'PK SECRET private note' });
  await start(cc, 'pkA9', { label: 'PK A9', branch: 'br-pkA9' });
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'next.0.hold': { key: K('pkA9'), at: ago(60) }, 'next.0.ref': tq.ref } });
  await off('pkA9', 45);
  await call('/api/agent/event', LTOK, { event: 'prompt', deliver: true });
  st = await stateDoc();
  const l1 = st.next.find(l => l.id === L1);
  check('sweep: a line naming a task of another project gets no log from it', !l1.hold && l1.left?.label === 'PK A9' && !('log' in l1.left) && !JSON.stringify(st).includes('SECRET') && !!Q, JSON.stringify(l1));

  // ── 7. withdraw_need on an answered Need says which answer
  await start(cc, 'pkW', { label: 'PK W' });
  const nW = await ask(cc, 'pkW', 'PK W question?');
  await answer(nW);
  const wd = await mcpH(cc, 'withdraw_need', { id: nW.ref, session: 'pkW' }, hdr('pkW'));
  check('withdraw: an answered Need says its answer, when and by whom, and that nothing was withdrawn', wd.isError && new RegExp(`Need #${nW.ref} is already answered: "Yes now", \\d\\d:\\d\\d \\d{1,2} [A-Z][a-z]{2} by [^.]+\\. Read it with needs; nothing to withdraw\\.`).test(wd.text) && !/a former member/.test(wd.text), wd.text.slice(0, 240));
  check('withdraw: the Need is still answered', (await needDoc(nW.id)).status === 'answered');

  // ── 9. start_work { pick_up }: the pick-up named by its note id (what /transfer pick up calls), not read_note
  await start(cc, 'pkU1', { label: 'PK U1' });
  const nU = await ask(cc, 'pkU1', 'PK U1 question?');
  const mU = await say(cc, 'pkS', 'pkU1', 'PK to U1: unread');
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: K('pkU1'), label: 'PK U1', at: new Date() } } });
  const hU = await handover(cc, 'pkU1', 'Handover: PK U1');
  const noteBefore = await rawDb.collection('notes').findOne({ _id: hU.handover.id });
  // wrong project: the handover is on PK Alpha, the caller starts on another project
  await must(cc, 'add_project', { name: 'PK Other', visibility: 'org' });
  const wp = await mcpH(ccB, 'start_work', { project: 'PK Other', session: 'pkU2x', pick_up: hU.handover.id }, hdr('pkU2x'));
  check('pick_up: a handover of another project is refused, and nothing moved', !wp.isError && /another project/.test(wp.json?.pickUp?.refused ?? '') && (await needDoc(nU.id)).from.session === 'pkU1' && !(await rawDb.collection('notes').findOne({ _id: hU.handover.id })).handover.pickedUp, wp.text.slice(0, 200));
  // not addressed to me: Tess left a handover for herself; Om's session may not pick it up. Om's own note for Tess is Tess's, not his.
  await start(kT, 'pkTh', { label: 'PK Tess writer' });
  const hT = await handover(kT, 'pkTh', 'Handover: PK Tess own');
  const nt = await mcpH(cc, 'start_work', { project: P, session: 'pkU3', pick_up: hT.handover.id }, hdr('pkU3'));
  check('pick_up: another person\'s handover not addressed to me is refused', !nt.isError && /for another person/.test(nt.json?.pickUp?.refused ?? '') && !(await rawDb.collection('notes').findOne({ _id: hT.handover.id })).handover.pickedUp, nt.text.slice(0, 200));
  const nn = await mcpH(cc, 'start_work', { project: P, session: 'pkU3', pick_up: nU.id }, hdr('pkU3'));
  check('pick_up: a note that is not a handover is refused', !nn.isError && /not an open handover/.test(nn.json?.pickUp?.refused ?? ''), nn.text.slice(0, 200));
  // the real pick-up: counts in plain words, the handover shown, lanes and holdsNow in the answer
  const up = await mcpH(ccB, 'start_work', { project: P, session: 'pkU2', label: 'PK U2', pick_up: hU.handover.id }, hdr('pkU2'));
  const upj = up.json;
  check('pick_up: the answer says what moved, in counts', !up.isError && upj?.pickedUp === 'Moved to you: 1 Need, 1 unread message, 0 held lines, the Now hold.', up.isError ? up.text.slice(0, 200) : String(upj?.pickedUp));
  check('pick_up: the handover is in the answer and marked picked up by this session', upj?.handover?.[0]?.id === hU.handover.id && (await rawDb.collection('notes').findOne({ _id: hU.handover.id })).handover.pickedUp?.session === 'pkU2' && (await needDoc(nU.id)).from.session === 'pkU2' && JSON.stringify((await msgDoc(mU.id)).toSids) === JSON.stringify([K('pkU2')]), JSON.stringify(upj?.handover?.[0]?.id));
  check('pick_up: the answer carries lanes (labels, no session id) and holdsNow true for the new Now holder', Array.isArray(upj?.lanes) && upj.lanes.some(l => l.label === 'PK U2' && l.writtenBy === false) && upj.holdsNow === true && !JSON.stringify(upj.lanes).includes('pkU1'), JSON.stringify(upj?.lanes)?.slice(0, 300));
  const again = await mcpH(ccB, 'start_work', { project: P, session: 'pkU2', pick_up: hU.handover.id }, hdr('pkU2'));
  check('pick_up: the same session asking again says so and moves nothing more', !again.isError && /already picked this handover up/.test(again.json?.pickedUp ?? ''), again.text.slice(0, 200));
  const other = await mcpH(ccC, 'start_work', { project: P, session: 'pkU4', pick_up: hU.handover.id }, hdr('pkU4'));
  check('pick_up: a handover another session already picked up is refused', !other.isError && /already picked up/.test(other.json?.pickUp?.refused ?? ''), other.text.slice(0, 200));
  check('name: pick_up tells the session its name', upj?.sessionNote?.includes(`Name this session now: ${P} · <role> · <what you take on>`), upj?.sessionNote);
  check('name: a repeated pick_up and a refused one carry no name line', !again.json?.sessionNote?.includes('Name this session now') && !other.json?.sessionNote?.includes('Name this session now') && !wp.json?.sessionNote?.includes('Name this session now'), [again.json?.sessionNote, other.json?.sessionNote].join(' | '));
  check('name: the note itself does not get the name line', !(await rawDb.collection('notes').findOne({ _id: hU.handover.id })).body.includes('Name this session now'));
  // a writer labelled "<Project> · <role> · <what>": the role is carried over, the rest left to the new session
  await start(cc, 'pkR1', { label: `${P} · lead · old work` });
  const hR = await handover(cc, 'pkR1', 'Handover: PK R1');
  const upR = await mcpH(ccB, 'start_work', { project: P, session: 'pkR2', pick_up: hR.handover.id }, hdr('pkR2'));
  check('name: the role from the handover label is filled in', !upR.isError && upR.json?.sessionNote?.includes(`Name this session now: ${P} · lead · <what you take on>.`), upR.isError ? upR.text.slice(0, 200) : upR.json?.sessionNote);
  void noteBefore;
  // an old handover (over 24 hours) moves the Need but no holds; the count line says 0 held lines and no Now hold
  await start(cc, 'pkU5', { label: 'PK U5' });
  const nU5 = await ask(cc, 'pkU5', 'PK U5 question?');
  await rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key: K('pkU5'), label: 'PK U5', at: new Date() } } });
  const hU5 = await handover(cc, 'pkU5', 'Handover: PK U5');
  await rawDb.collection('notes').updateOne({ _id: hU5.handover.id }, { $set: { 'handover.at': ago(26 * 60) } });
  const up5 = await mcpH(ccC, 'start_work', { project: P, session: 'pkU6', label: 'PK U6', pick_up: hU5.handover.id }, hdr('pkU6'));
  st = await stateDoc();
  check('pick_up: an old handover moves the Need but no hold (the answer says so)', !up5.isError && up5.json?.pickedUp === 'Moved to you: 1 Need, 0 unread messages, 0 held lines.' && (await needDoc(nU5.id)).from.session === 'pkU6' && st.now.hold?.key === K('pkU5') && up5.json?.holdsNow === false, up5.isError ? up5.text.slice(0, 200) : `${up5.json?.pickedUp} ${JSON.stringify(st.now.hold)}`);
  // a session still working holds its work back, and the answer says why
  await start(cc, 'pkU7', { label: 'PK U7' });
  const hU7 = await handover(cc, 'pkU7', 'Handover: PK U7');
  await rawDb.collection('presence').updateOne({ session: 'pkU7' }, { $unset: { endedAt: '' }, $set: { activity: { state: 'working', at: new Date() }, lastSeen: new Date() } });
  const up7 = await mcpH(ccC, 'start_work', { project: P, session: 'pkU8', label: 'PK U8', pick_up: hU7.handover.id }, hdr('pkU8'));
  check('pick_up: while the old session is working nothing moves and the answer says why', !up7.isError && /Nothing moved: the session that wrote it is still working/.test(up7.json?.pickedUp ?? ''), up7.text.slice(0, 200));
  check('pick_up (review fix): the busy writer left the handover unclaimed, no pick-up line was written', !(await rawDb.collection('notes').findOne({ _id: hU7.handover.id })).handover.pickedUp && !(await rawDb.collection('notes').findOne({ _id: hU7.handover.id })).body.includes('Picked up by'));
  // a refused pick_up still gives the brief (Orders, State, session id) with the reason in pickUp.refused
  check('pick_up (review fix): a refusal is a normal brief with pickUp.refused, Orders and State', !!wp.json?.orders && !!wp.json?.state && typeof wp.json?.pickUp?.refused === 'string', JSON.stringify(Object.keys(wp.json ?? {})));
  // the writer stops; a later pick-up now works and claims the handover
  await rawDb.collection('presence').updateOne({ session: 'pkU7' }, { $set: { endedAt: new Date(), activity: { state: 'on', at: ago(60) } } });
  const up7b = await mcpH(ccC, 'start_work', { project: P, session: 'pkU9', label: 'PK U9', pick_up: hU7.handover.id }, hdr('pkU9'));
  check('pick_up (review fix): once the writer has stopped, a later pick-up works and claims the handover', !up7b.isError && /^Moved to you/.test(up7b.json?.pickedUp ?? '') && (await rawDb.collection('notes').findOne({ _id: hU7.handover.id })).handover.pickedUp?.session === 'pkU9', up7b.text.slice(0, 200));
  // the 24 hour hold limit counts from when the writer wrote the handover: the pick-up line and a repeat call do not restart it
  const again5 = await mcpH(ccC, 'start_work', { project: P, session: 'pkU6', pick_up: hU5.handover.id }, hdr('pkU6'));
  st = await stateDoc();
  check('pick_up (review fix): a repeat pick-up of a handover over 24 hours old moves no hold', !again5.isError && st.now.hold?.key === K('pkU5') && again5.json?.holdsNow === false, JSON.stringify(st.now.hold));
  // an archived handover cannot be picked up
  await start(cc, 'pkAr', { label: 'PK Ar' });
  const hAr = await handover(cc, 'pkAr', 'Handover: PK Ar');
  await rawDb.collection('notes').updateOne({ _id: hAr.handover.id }, { $set: { archived: true } });
  const arch = await mcpH(ccC, 'start_work', { project: P, session: 'pkAr2', label: 'PK Ar2', pick_up: hAr.handover.id }, hdr('pkAr2'));
  check('pick_up (review fix): an archived handover is refused and not claimed', !arch.isError && /not an open handover/.test(arch.json?.pickUp?.refused ?? '') && !(await rawDb.collection('notes').findOne({ _id: hAr.handover.id })).handover.pickedUp, arch.text.slice(0, 200));
} catch (e) {
  check('flow-pickup (error)', false, e?.stack || String(e));
}
await finish();
