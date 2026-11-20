// A Need answered after the session that asked it is off (ended, or no presence row) is not lost:
//   1. answerNeed hands it to the Now holder of the same person when that session is on (never a dispatched run, never another
//      person's session), marks the Need handedTo, and the hook's deliver gives it to that session once;
//   2. start_work lists, for that person on that project, answered Needs whose asking session is off and that nobody was handed
//      (max 5, one line each) and marks them handed to the starting session; a second start lists none of them;
//   3. withdraw_need on an answered / withdrawn Need says which, with the answer and the time, and changes nothing.
//   4. withdraw_need by a new session takes back an open Need whose asking session is off (same person, word and key); refused while
//      the asker is on, from another key, another person, or a dispatched run.
// Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { B, EMAIL, ME, MCP, PW, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
function actionOf(name, file) {
  for (const [id, e] of Object.entries(MANIFEST)) {
    const ws = e.exportedName ? [e] : Object.values(e.workers);
    if (!ws.some(w => w.exportedName === name && file.test(w.filename))) continue;
    const page = Object.keys(e.workers).find(x => !x.includes('[')) ?? Object.keys(e.workers)[0];
    return { id, url: '/' + page.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(x => !/^\(.*\)$/.test(x)).join('/') };
  }
  return null;
}
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
async function act(cookie, name, file, ...args) {
  const a = actionOf(name, file);
  if (!a) return { ok: false, text: `${name} not in the build` };
  const r = await fetch(B + a.url, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  const text = await r.text();
  return { ok: /"ok":true/.test(text), text };
}
const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '3', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ev = (tok, body) => call('/api/agent/event', tok, body);
const P = 'NH Alpha';
const hdr = sess => ({ 'X-Work-OS-Session': sess });
const needDoc = id => rawDb.collection('needs').findOne({ _id: id });
const K = (u, s) => `${u}:${s}`;
let PID = '';

try {
  const T = await makeUser({ email: 'nh-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const cc = await mkKey({ agent: 'claude-code', name: 'NH cc' });
  const ccS = await mkKey({ agent: 'claude-code', name: 'NH ccS' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'NH Tess cc' });
  PID = (await must(MCP, 'add_project', { name: P, visibility: 'org', code: [{ remote: 'acme/nh-alpha' }] })).project.id;
  const start = (key, sess, extra = {}) => must(key, 'start_work', { project: P, session: sess, ...extra }, hdr(sess));
  const ask = async (key, sess, text) => (await must(key, 'ask', { project: P, to: 'me', kind: 'decide', ask: text, options: [{ label: 'Yes now', means: 'go' }, { label: 'Later', means: 'wait' }], session: sess }, hdr(sess))).need;
  const stop = (key, sess) => must(key, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'nhbox', branch: `br-${sess}` }], friction: 'none', session: sess }, hdr(sess));
  const cookie = await signIn(EMAIL);
  const answer = async n => {
    const d = await needDoc(n.id);
    return act(cookie, 'answerNeedAction', /needs\/actions\.ts$/, n.id, d.options[0].id, 'go ahead');
  };
  const setHold = key => rawDb.collection('states').updateOne({ _id: PID }, { $set: { 'now.hold': { key, label: 'NH holder', at: new Date() } } });

  // A State with a Now (set_now needs a session Work OS knows: a fixture session whose row is removed again).
  await start(cc, 'nh-fixture');
  await must(cc, 'save_state', { project: P, base_version: 0, session: 'nh-fixture', ops: [{ op: 'set_now', text: 'NH goal: hand late answers on' }] });
  await rawDb.collection('presence').deleteMany({ session: 'nh-fixture' });

  // A hook session of Om on the project (the one the Now hold goes to, and the one the hook delivers to).
  const pc = await mkDevice('nh-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'NH-PC' } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold1`, deviceId: pc.id, folderId: 'fold1', name: 'C:/code/nh', git: true, remote: 'acme/nh-alpha', projectId: PID, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const hs = await call('/api/agent/start', pc.key, { folders: ['fold1'], remote: 'https://github.com/acme/nh-alpha.git', branch: 'main', path: 'C:/code/nh', ccSession: randomUUID(), source: 'startup' });
  const TOK = hs.json?.token;
  const HSID = hs.json?.brief?.session;
  check('setup: a hook session of Om on the project, on', hs.status === 200 && /^wst_/.test(TOK ?? '') && !!HSID, hs.text.slice(0, 160));

  // ── 1. answered while the asker is off: the Now holder (on) is handed it, once, by the hook
  await start(cc, 'nhA', { label: 'NH A' });
  const n1 = await ask(cc, 'nhA', 'NH one: ship it?');
  await stop(cc, 'nhA');
  await setHold(K(ME.userId, HSID));
  const a1 = await answer(n1);
  const d1 = await needDoc(n1.id);
  check('1: answered in the app', a1.ok && d1.status === 'answered', a1.text.slice(0, 160));
  check('1: the asker is off and the Now holder is on: the Need is marked handedTo the holder', d1.handedTo === HSID, JSON.stringify([d1.handedTo, HSID]));
  const del = await ev(TOK, { event: 'prompt', deliver: true });
  check('1: the hook hands the holder the answer, framed', del.status === 200 && new RegExp(`your Need #${n1.ref} was answered`).test(del.json?.deliver?.text ?? '') && del.json.deliver.needs?.includes(n1.id), del.text.slice(0, 300));
  await ev(TOK, { event: 'tool', ack: [...(del.json?.deliver?.needs ?? [])] });
  const del2 = await ev(TOK, { event: 'prompt', deliver: true });
  check('1: only once: the next delivery does not repeat it', !(del2.json?.deliver?.needs ?? []).includes(n1.id) && !!(await needDoc(n1.id)).briefedAt, del2.text.slice(0, 200));
  const st1 = await must(ccS, 'start_work', { project: P, session: 'nhS1' }, hdr('nhS1'));
  check('1: a later start_work lists nothing of it (it was handed on)', !st1.needs?.answeredWhileAway, JSON.stringify(st1.needs ?? null).slice(0, 200));

  // (every session is started before the answers: any start_work in between would take the unhanded ones itself)
  for (const x of ['nhA2', 'nhA3', 'nhA4']) await start(cc, x, { label: 'NH ' + x.slice(2) });
  // the holder is off: nothing is handed (the Need waits for the next start_work)
  const n2 = await ask(cc, 'nhA2', 'NH two: holder off?');
  await stop(cc, 'nhA2');
  await setHold(K(ME.userId, 'nhGone')); // no row at all
  await answer(n2);
  check('1: a holder with no row is no receiver: the Need is not handed', !(await needDoc(n2.id)).handedTo);

  // a dispatched run is never a receiver
  await rawDb.collection('presence').insertOne({ _id: `${ME.userId}:s:nhD:${PID}`, projectId: PID, userId: ME.userId, key: 'nhD', session: 'nhD', keyId: 'nhD-key', dispatched: { taskId: 'nh-task', ref: 9 }, label: 'NH worker', machine: 'nhbox', ai: 'x', agent: 'claude-code', lastSeen: new Date(), forYouCursor: new Date(), writesSinceSave: 0, activity: { state: 'on', at: new Date() }, createdAt: new Date(), orgId: ME.orgId, ownerId: ME.userId, visibility: 'org' });
  await setHold(K(ME.userId, 'nhD'));
  const n3 = await ask(cc, 'nhA3', 'NH three: dispatched holder?');
  await stop(cc, 'nhA3');
  await answer(n3);
  check('1: a dispatched run holding Now is never handed an answer', !(await needDoc(n3.id)).handedTo);

  // the asker is still on: it keeps its own answer, nobody else is handed it
  await setHold(K(ME.userId, HSID));
  const n4 = await ask(cc, 'nhA4', 'NH four: asker still on?');
  await answer(n4);
  check('1: an asker that is on is the receiver itself: no handedTo', !(await needDoc(n4.id)).handedTo);

  // ── 2. start_work lists answered Needs whose asking session is off (n2, n3), marks them handed
  await setHold(K(ME.userId, 'nhGone'));
  const s2 = await start(ccS, 'nhS2', { label: 'NH S2' });
  const w2 = s2.needs?.answeredWhileAway;
  check('2: start_work lists the two unhanded answers with ref, ask, answer and time', !!w2 && w2.lines.length === 2 && w2.lines.some(l => l.includes(`Need #${n2.ref}`) && /holder off/.test(l) && /Yes now/.test(l) && /\d\d:\d\d \d{1,2} [A-Z][a-z]{2}/.test(l)) && w2.lines.some(l => l.includes(`Need #${n3.ref}`)), JSON.stringify(w2));
  check('2: the asker that is still on (n4) is not listed', !(w2?.lines ?? []).some(l => l.includes(`Need #${n4.ref}`)));
  check('2: they are now handedTo this session', (await needDoc(n2.id)).handedTo === 'nhS2' && (await needDoc(n3.id)).handedTo === 'nhS2');
  const s2b = await start(ccS, 'nhS2b', { label: 'NH S2b' });
  check('2: a second start_work lists none of them again', !s2b.needs?.answeredWhileAway, JSON.stringify(s2b.needs ?? null).slice(0, 200));

  // at most 5, the rest on the next start
  await start(cc, 'nhM', { label: 'NH M' });
  const many = [];
  for (let i = 1; i <= 7; i++) many.push(await ask(cc, 'nhM', `NH many ${i}`));
  await stop(cc, 'nhM');
  for (const n of many) await rawDb.collection('needs').updateOne({ _id: n.id }, { $set: { status: 'answered', answer: { option: 'a', by: ME.userId, via: 'app', at: new Date() }, answeredAt: new Date() } });
  const s3 = await start(ccS, 'nhS3', { label: 'NH S3' });
  check('2: at most 5 lines, the count of the rest', s3.needs?.answeredWhileAway?.lines?.length === 5 && s3.needs.answeredWhileAway.more === 2, JSON.stringify(s3.needs?.answeredWhileAway));
  const s4 = await start(ccS, 'nhS4', { label: 'NH S4' });
  check('2: the next start lists the other 2', s4.needs?.answeredWhileAway?.lines?.length === 2, JSON.stringify(s4.needs?.answeredWhileAway));

  // ── 3. withdraw_need on a closed Need says which, with the answer and the time
  const w3 = await mcpH(cc, 'withdraw_need', { id: n4.ref, session: 'nhA4' }, hdr('nhA4'));
  check('3: an answered Need says its answer and the time, nothing withdrawn', w3.isError && new RegExp(`Need #${n4.ref} is already answered: "Yes now", \\d\\d:\\d\\d \\d{1,2} [A-Z][a-z]{2} by [^.]+\\.`).test(w3.text) && (await needDoc(n4.id)).status === 'answered', w3.text.slice(0, 240));
  const n5 = await ask(cc, 'nhA4', 'NH five: withdrawn');
  await must(cc, 'withdraw_need', { id: n5.ref, session: 'nhA4' }, hdr('nhA4'));
  const w5 = await mcpH(cc, 'withdraw_need', { id: n5.ref, session: 'nhA4' }, hdr('nhA4'));
  check('3: a withdrawn Need says so, with the time', w5.isError && new RegExp(`Need #${n5.ref} is already withdrawn, \\d\\d:\\d\\d \\d{1,2} [A-Z][a-z]{2}\\. Nothing to withdraw\\.`).test(w5.text), w5.text.slice(0, 240));

  // ── 4. never another person: Om's off-asker answer is not handed to Tess's Now holder, and Tess's start_work does not list it
  await start(cc, 'nhA5', { label: 'NH A5' });
  const n6 = await ask(cc, 'nhA5', 'NH six: Om only');
  await stop(cc, 'nhA5');
  await start(kT, 'nhT', { label: 'NH Tess' });
  await setHold(K(T.userId, 'nhT'));
  await answer(n6);
  check('4: Tess\'s live Now holder is not handed Om\'s answer', !(await needDoc(n6.id)).handedTo);
  const t2 = await start(kT, 'nhT2', { label: 'NH Tess 2' });
  check('4: Tess\'s start_work lists none of Om\'s answered Needs', !t2.needs?.answeredWhileAway && !JSON.stringify(t2).includes('Om only'), JSON.stringify(t2.needs ?? null).slice(0, 200));
  check('4: the Need is still unhanded, for Om\'s own next start_work', !(await needDoc(n6.id)).handedTo);
  const s5 = await start(ccS, 'nhS5', { label: 'NH S5' });
  check('4: Om\'s next start_work lists it', !!s5.needs?.answeredWhileAway?.lines?.some(l => l.includes(`Need #${n6.ref}`)), JSON.stringify(s5.needs?.answeredWhileAway));

  // ── 5. a new session withdraws an open Need its ended predecessor asked (same key); every other case reads as no such Need
  await start(cc, 'nhW1', { label: 'NH W1' });
  await start(cc, 'nhW2', { label: 'NH W2' });
  const nw1 = await ask(cc, 'nhW1', 'NH w1: replaced session');
  const nw2 = await ask(cc, 'nhW1', 'NH w2: asker still on');
  const nw3 = await ask(cc, 'nhW1', 'NH w3: other key');
  const nw4 = await ask(cc, 'nhW1', 'NH w4: dispatched run');
  const nw5 = await ask(cc, 'nhW1', 'NH w5: another person');
  // asker still on: refused
  const r2 = await mcpH(cc, 'withdraw_need', { id: nw2.ref, session: 'nhW2' }, hdr('nhW2'));
  check('5: the asking session still on: refused as no such Need', r2.isError && /does not exist, or you did not ask it/.test(r2.text) && (await needDoc(nw2.id)).status === 'open', r2.text.slice(0, 200));
  await stop(cc, 'nhW1'); // the predecessor ends
  const r1 = await mcpH(cc, 'withdraw_need', { id: nw1.ref, session: 'nhW2' }, hdr('nhW2'));
  check('5: a new session withdraws what its ended predecessor asked (same key)', !r1.isError && (await needDoc(nw1.id)).status === 'withdrawn', r1.text.slice(0, 200));
  const r3 = await mcpH(ccS, 'withdraw_need', { id: nw3.ref, session: 'nhW3' }, hdr('nhW3'));
  check('5: another key of the same person: refused', r3.isError && /does not exist, or you did not ask it/.test(r3.text) && (await needDoc(nw3.id)).status === 'open', r3.text.slice(0, 200));
  const r4 = await mcpH(cc, 'withdraw_need', { id: nw4.ref, session: 'nhD' }, hdr('nhD')); // nhD is a dispatched run's session row
  check('5: a dispatched run: refused', r4.isError && /does not exist, or you did not ask it/.test(r4.text) && (await needDoc(nw4.id)).status === 'open', r4.text.slice(0, 200));
  const r5 = await mcpH(kT, 'withdraw_need', { id: nw5.ref, session: 'nhT' }, hdr('nhT'));
  check('5: another person: refused', r5.isError && /does not exist, or you did not ask it/.test(r5.text) && (await needDoc(nw5.id)).status === 'open', r5.text.slice(0, 200));
} catch (e) {
  check('suite ran to the end', false, e?.stack || String(e));
} finally {
  await finish();
}
