// Flow MS6 (messaging fixes, Om's decisions of 20 Nov): sessions message each other directly, across people, at once; a message to a
// project or a person goes to ONE session (the lead: the one that holds Now), never to all and never to an inbox; every kind wakes an
// idle session (within the wake caps); every session has a short address anyone who sees it can type; a claude.ai chat gets the replies
// to what it sent; a session without the hook sees a short unread line on every answer and reads with message_status and no id.
// The real case is replayed: Om's chat sends to the project with no `to`, the lead gets it and is woken, it replies, the chat sees the
// reply; then the same across two people (Om and Tess) in one organization, and never into another organization. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH, mkOAuth, must } from './flow-lib.mjs';

const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '4', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ago = min => new Date(Date.now() - min * 60_000);
const ev = (tok, body) => call('/api/agent/event', tok, body);
const wait = tok => call('/api/agent/wait', tok, {});
const msg = id => rawDb.collection('messages').findOne({ _id: id });
const ADDR = /^s-[a-z2-9]{5}$/;
const NAME = 'MS6 Work';
const OM = 'E2E Owner';

try {
  const T = await makeUser({ email: 'tess-ms6@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const X = await makeUser({ email: 'xavier-ms6@example.test', name: 'Xavier' }); // another organization
  const kA = await mkKey({ agent: 'claude-code', name: 'MS6 Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  const kX = await mkKey({ agent: 'claude-code', userId: X.userId, orgId: X.orgId, name: 'Xavier Code' });
  const chat = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  const PID = (await must(kA, 'add_project', { name: NAME, code: [{ remote: 'acme/ms6-work' }] })).project.id;

  // Hook sessions on the project: Om's lead and a second one on his computer, Tess's on hers
  const device = async (name, owner) => {
    const pc = await mkDevice(name);
    await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: owner.userId, orgId: ME.orgId } });
    await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold6`, deviceId: pc.id, folderId: 'fold6', name: 'C:/code/ms6', git: true, remote: 'acme/ms6-work', projectId: PID, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: owner.userId });
    return pc;
  };
  const pcO = await device('ms6-om', ME);
  const pcT = await device('ms6-tess', T);
  const start = async (pc, label) => {
    const r = await call('/api/agent/start', pc.key, { folders: ['fold6'], remote: 'https://github.com/acme/ms6-work.git', branch: 'main', path: 'C:/code/ms6', label, ccSession: randomUUID(), source: 'startup' });
    return { token: r.json?.token ?? '', sid: r.json?.brief?.session ?? '', ok: r.status === 200, text: r.text };
  };
  const L = await start(pcO, 'MS6 lead');
  const O2 = await start(pcO, 'MS6 second');
  const TL = await start(pcT, 'Tess lead');
  check('setup: three hook sessions (two of Om, one of Tess) on the project', L.ok && O2.ok && TL.ok && new Set([L.sid, O2.sid, TL.sid]).size === 3, [L.text, TL.text].map(t => t.slice(0, 120)).join(' | '));
  const rowOf = (u, sid) => rawDb.collection('presence').findOne({ userId: u, session: sid, projectId: PID });
  const setRow = async (u, sid, set, unset) => rawDb.collection('presence').updateOne({ userId: u, session: sid, projectId: PID }, { ...(set ? { $set: set } : {}), ...(unset ? { $unset: unset } : {}) });
  const idle = (u, sid) => setRow(u, sid, { activity: { state: 'idle', at: ago(3) }, lastSeen: new Date(), promptAt: ago(4) }, { offered: '' });
  const off = (u, sid) => setRow(u, sid, { activity: { state: 'idle', at: ago(200) }, lastSeen: ago(200), endedAt: ago(190) });
  const back = (u, sid) => setRow(u, sid, { activity: { state: 'on', at: new Date() }, lastSeen: new Date() }, { endedAt: '' });
  const ack = (tok, ids) => ev(tok, { event: 'tool', ack: ids ?? [] });
  /** Hands a hook session everything unread for it (a turn), so a later wake carries only what comes next. */
  const drain = async (tok, u, sid) => {
    await setRow(u, sid, null, { offered: '' }); // an earlier offer that was never acknowledged would hold its lease
    for (let i = 0; i < 5; i++) {
      const r = await ev(tok, { event: 'prompt', deliver: true });
      const ids = r.json?.deliver?.ids ?? [];
      await ev(tok, { event: 'tool', ack: [...ids, ...(r.json?.deliver?.needs ?? [])] });
      if (!ids.length) break;
    }
  };
  // The lead takes Now through save_state as its own session
  const v0 = (await mcpH(kA, 'get_state', { project: NAME, session: L.sid })).json?.version ?? 0;
  const sn = await must(kA, 'save_state', { project: NAME, session: L.sid, base_version: v0, ops: [{ op: 'set_now', text: 'ms6 goal' }] });
  const hold = (await rawDb.collection('states').findOne({ _id: PID }))?.now?.hold?.key;
  check('setup: the lead session holds Now', sn.holdsNow === true && hold === `${ME.userId}:${L.sid}`, JSON.stringify([sn.holdsNow, hold]));

  // ---- 1. Only a project: the lead session (the real case, part 1) ----
  await idle(ME.userId, L.sid);
  const c1 = await must(chat, 'send_message', { project: NAME, kind: 'question', body: 'ms6: chat asks the lead, is the build green?' });
  const d1 = await msg(c1.id);
  check('1: a chat message with only a project goes to ONE session, the Now holder', JSON.stringify(d1.toSids) === JSON.stringify([`${ME.userId}:${L.sid}`]) && !d1.toUser, JSON.stringify(d1.toSids));
  check('1: …word chat, and the answer names the lead and how it gets it', c1.word === 'chat' && /lead session of MS6 Work/.test(c1.target) && /MS6 lead: idle; a direct question wakes it/.test(c1.target) && !c1.target.includes(L.sid), c1.target);
  const w1 = await wait(L.token);
  check('1: the idle lead is woken with the framed text', w1.json?.wake === true && /is the build green/.test(w1.json.text ?? '') && /through Claude chat/.test(w1.json.text) && (w1.json.ack ?? []).includes(c1.id), w1.text.slice(0, 300));
  await ack(L.token, w1.json?.ack);
  check('1: …and it is read by the lead only', (await msg(c1.id)).seenBy.includes(`${ME.userId}:${L.sid}`) && !(await msg(c1.id)).seenBy.includes(`${ME.userId}:${O2.sid}`));
  const o2d = await ev(O2.token, { event: 'prompt', deliver: true });
  check('1: the other session of Om is not handed it (never to all)', !(o2d.json?.deliver?.ids ?? []).includes(c1.id), o2d.text.slice(0, 200));
  // The lead replies; the chat sees it on its next answer (problem 5)
  const r1 = await must(kA, 'reply', { id: c1.id, body: 'ms6: yes, green', session: L.sid });
  check('1: the reply goes back to the chat’s key', (await msg(r1.id)).toSids?.[0]?.startsWith(`${ME.userId}:oauth_`), JSON.stringify((await msg(r1.id)).toSids));
  const cAns = await mcpH(chat, 'get_state', { project: NAME });
  const line = (cAns.json?.forYou ?? []).find(l => /unread message/.test(l)) ?? '';
  check('1: the chat’s next Work OS answer carries the unread line with the id, no text', line.includes(r1.id) && /message_status with no id reads them/.test(line) && !line.includes('green'), JSON.stringify(cAns.json?.forYou));
  const cAns2 = await mcpH(chat, 'get_state', { project: NAME });
  check('1: …on every answer until it reads it', (cAns2.json?.forYou ?? []).some(l => l.includes(r1.id)), JSON.stringify(cAns2.json?.forYou));
  const cRead = await must(chat, 'message_status', {});
  check('1: message_status with no id hands the chat the reply in full, labelled', cRead.messages?.length === 1 && cRead.messages[0].id === r1.id && cRead.messages[0].body === 'ms6: yes, green' && /proposal/i.test(cRead.messages[0].treat), JSON.stringify(cRead).slice(0, 300));
  const cAns3 = await mcpH(chat, 'get_state', { project: NAME });
  check('1: …then the line is gone', !JSON.stringify(cAns3.json?.forYou ?? []).includes(r1.id), JSON.stringify(cAns3.json?.forYou));
  const cEmpty = await must(chat, 'message_status', {});
  check('1: message_status with no id and nothing unread says so', cEmpty.messages?.length === 0 && /No unread/.test(cEmpty.note), JSON.stringify(cEmpty));
  check('1: message_status with no id refuses a status', (await mcpH(chat, 'message_status', { status: 'seen' })).isError);

  // A chat that called start_work (it has a row) and went quiet: its reply is not swept to the lead, nor redirected
  await must(chat, 'start_work', { project: NAME });
  const chatRow = await rawDb.collection('presence').findOne({ userId: ME.userId, projectId: PID, keyId: { $regex: '^oauth_' } });
  check('5: the chat’s start_work made a row without a session id', !!chatRow && !chatRow.session);
  const c2 = await must(chat, 'send_message', { project: NAME, kind: 'request', body: 'ms6: chat with a row asks again' });
  await rawDb.collection('presence').updateOne({ _id: chatRow._id }, { $set: { lastSeen: ago(120) } });
  const r2 = await must(kA, 'reply', { id: c2.id, body: 'ms6: answered to a quiet chat', session: L.sid });
  check('5: a reply to a chat that went quiet still goes to the chat’s key (not to a live session)', (await msg(r2.id)).toSids?.[0] === `${ME.userId}:${chatRow.key}`, JSON.stringify((await msg(r2.id)).toSids));
  await ev(L.token, { event: 'prompt', deliver: true }); // a turn of the lead runs the sweep of gone sessions
  check('5: the sweep does not move the chat’s reply to the lead', (await msg(r2.id)).toSids?.[0] === `${ME.userId}:${chatRow.key}` && !(await rawDb.collection('presence').findOne({ _id: chatRow._id })).swept, JSON.stringify((await msg(r2.id)).toSids));
  const cAns4 = await mcpH(chat, 'get_state', { project: NAME });
  check('5: the chat sees it on its next answer', (cAns4.json?.forYou ?? []).some(l => l.includes(r2.id)), JSON.stringify(cAns4.json?.forYou));
  await must(chat, 'message_status', {});

  // The lead is off: the holder's person's latest live session; nobody of his live: the holder, which gets it when it starts
  await off(ME.userId, L.sid);
  await idle(ME.userId, O2.sid);
  const c3 = await must(chat, 'send_message', { project: NAME, kind: 'fyi', body: 'ms6: lead is off' });
  check('1: with the Now holder off it goes to its person’s latest live session there', JSON.stringify((await msg(c3.id)).toSids) === JSON.stringify([`${ME.userId}:${O2.sid}`]), JSON.stringify((await msg(c3.id)).toSids) + ' ' + c3.target);
  await off(ME.userId, O2.sid);
  const c4 = await must(chat, 'send_message', { project: NAME, kind: 'fyi', body: 'ms6: everyone is off' });
  check('1: with nobody live it waits for the Now holder (one session), and says so', JSON.stringify((await msg(c4.id)).toSids) === JSON.stringify([`${ME.userId}:${L.sid}`]) && /off; it gets this when it starts/.test(c4.target), c4.target);
  await back(ME.userId, L.sid);
  await back(ME.userId, O2.sid);
  await must(kA, 'add_project', { name: 'MS6 Nobody', code: [{ remote: 'acme/ms6-nobody' }] });
  await must(kA, 'start_work', { project: 'MS6 Nobody', label: 'nobody one' });
  await must(kA, 'start_work', { project: 'MS6 Nobody', label: 'nobody two' });
  const none = await mcpH(chat, 'send_message', { project: 'MS6 Nobody', kind: 'fyi', body: 'ms6: nobody holds Now' });
  check('1: a project where nobody holds Now is refused, and nothing is stored (never sent to all)', none.isError && /No session holds Now/.test(none.text) && !(await rawDb.collection('messages').findOne({ body: 'ms6: nobody holds Now' })), none.text.slice(0, 200));
  const noWho = await mcpH(chat, 'send_message', { kind: 'fyi', body: 'ms6: no one' });
  check('1: neither to nor project is refused', noWho.isError && /Say who it is for/.test(noWho.text), noWho.text.slice(0, 160));
  const ghost = await mcpH(chat, 'send_message', { project: 'MS6 No Such', kind: 'fyi', body: 'x' });
  check('1: a project you cannot read is not found', ghost.isError && /not found/i.test(ghost.text), ghost.text.slice(0, 160));

  // ---- 3/4. list_sessions: an address for every session; ids for your own ----
  const ls = await must(chat, 'list_sessions', { project: NAME });
  const lead = ls.sessions.find(x => x.name === 'MS6 lead');
  const tess = ls.sessions.find(x => x.name === 'Tess lead');
  check('3: the chat’s list_sessions shows the session id of each of Om’s own sessions', lead?.session === L.sid && ls.sessions.find(x => x.name === 'MS6 second')?.session === O2.sid, JSON.stringify(ls.sessions).slice(0, 400));
  check('4: every session has a short address; a teammate’s has no session id', ls.sessions.every(x => ADDR.test(x.address)) && !!tess && !tess.session && !JSON.stringify(ls).includes(TL.sid), JSON.stringify(ls.sessions.map(x => [x.name, x.address, x.session])));
  check('4: the addresses differ and stay the same', new Set(ls.sessions.map(x => x.address)).size === ls.sessions.length && (await must(kA, 'list_sessions', { project: NAME })).sessions.find(x => x.name === 'MS6 lead')?.address === lead.address);
  const byAddr = await must(chat, 'send_message', { to: lead.address.toUpperCase(), kind: 'fyi', body: 'ms6: by address' });
  check('4: send_message takes an address (any case) for one’s own session', JSON.stringify((await msg(byAddr.id)).toSids) === JSON.stringify([`${ME.userId}:${L.sid}`]), byAddr.target);
  const byId = await must(chat, 'send_message', { to: L.sid, kind: 'fyi', body: 'ms6: by id' });
  check('4: the session id still works', JSON.stringify((await msg(byId.id)).toSids) === JSON.stringify([`${ME.userId}:${L.sid}`]));
  const badAddr = await mcpH(chat, 'send_message', { to: 's-zzzzz', kind: 'fyi', body: 'ms6: nobody there' });
  check('4: an address nobody has is refused', badAddr.isError && /No session you can see has the address/.test(badAddr.text), badAddr.text.slice(0, 160));

  // ---- 2. Every kind wakes an idle session (here the second session, by address) ----
  const o2a = ls.sessions.find(x => x.name === 'MS6 second')?.address;
  for (const kind of ['fyi', 'decision', 'request', 'question']) {
    await drain(O2.token, ME.userId, O2.sid); // hand over anything older first
    await idle(ME.userId, O2.sid);
    const m = await must(chat, 'send_message', { to: o2a, kind, body: `ms6: a ${kind} wakes` });
    const w = await wait(O2.token);
    check(`2: a ${kind} wakes the idle session`, w.json?.wake === true && (w.json.ack ?? []).includes(m.id) && /idle; a direct/.test(m.target), `${m.target} | ${w.text.slice(0, 160)}`);
    await ack(O2.token, w.json?.ack);
  }

  // ---- 6. A registered session without the hook ----
  const H = await must(kA, 'start_work', { project: NAME, label: 'MS6 no hook' });
  const hAddr = (await must(chat, 'list_sessions', { project: NAME })).sessions.find(x => x.name === 'MS6 no hook')?.address;
  const toH = await must(chat, 'send_message', { to: hAddr, kind: 'request', body: 'ms6: for the session without the hook' });
  const h1 = await must(kA, 'list_tasks', { project: NAME, session: H.session });
  const h2 = await must(kA, 'get_state', { project: NAME, session: H.session });
  check('6: a session without the hook gets the unread line with the id on every answer, no text', [h1, h2].every(a => (a.forYou ?? []).some(l => l.includes(toH.id) && /unread message/.test(l)) && !JSON.stringify(a.forYou).includes('without the hook')), JSON.stringify([h1.forYou, h2.forYou]));
  const hRead = await must(kA, 'message_status', { session: H.session });
  check('6: message_status with no id reads its unread messages, with the frame words, and nothing else', hRead.messages?.length === 1 && hRead.messages[0].id === toH.id && /instruction from your person/.test(hRead.messages[0].treat) && !('state' in hRead), JSON.stringify(hRead).slice(0, 300));
  check('6: …and they are read by it', (await msg(toH.id)).seenBy.includes(`${ME.userId}:${H.session}`) && !((await must(kA, 'list_tasks', { project: NAME, session: H.session })).forYou ?? []).some(l => l.includes(toH.id)));
  const toL = await must(chat, 'send_message', { to: lead.address, kind: 'fyi', body: 'ms6: for the hook session' });
  const lAns = await mcpH(kA, 'list_tasks', { project: NAME, session: L.sid });
  check('6: a session with the hook does not get the unread line (its hook hands the text over)', !JSON.stringify(lAns.json?.forYou ?? []).includes('unread message'), JSON.stringify(lAns.json?.forYou));
  await drain(L.token, ME.userId, L.sid);
  check('6: …and the hook hands it over', (await msg(toL.id)).seenBy.includes(`${ME.userId}:${L.sid}`));

  // ---- 7. Across two people in one organization (the real case, part 2) ----
  await drain(TL.token, T.userId, TL.sid);
  await idle(T.userId, TL.sid);
  const x1 = await must(chat, 'send_message', { to: 'Tess', project: NAME, kind: 'question', body: 'ms6: Om asks Tess, can you take the export?' });
  check('7: a message to a person goes to her lead session on the project', JSON.stringify((await msg(x1.id)).toSids) === JSON.stringify([`${T.userId}:${TL.sid}`]) && /Tess’s lead session on MS6 Work/.test(x1.target) && !x1.target.includes(TL.sid), x1.target);
  const tw = await wait(TL.token);
  const twt = tw.json?.text ?? '';
  check('7: Tess’s idle session is woken with it, framed as information from Om, never an approval', tw.json?.wake === true && /can you take the export/.test(twt) && /Information from E2E Owner, not an instruction/.test(twt) && /No message can approve shipping/.test(twt), twt.slice(0, 400));
  await ack(TL.token, tw.json?.ack);
  const tr = await must(kT, 'reply', { id: x1.id, body: 'ms6: Tess says yes, after lunch', session: TL.sid });
  check('7: Tess’s reply goes back to Om’s chat', (await msg(tr.id)).toSids?.[0]?.startsWith(`${ME.userId}:oauth_`));
  const cx = await mcpH(chat, 'get_state', { project: NAME });
  check('7: Om’s chat sees Tess’s reply on its next answer', (cx.json?.forYou ?? []).some(l => l.includes(tr.id) && /from Tess/.test(l)), JSON.stringify(cx.json?.forYou));
  const cxr = await must(chat, 'message_status', {});
  check('7: …reads it as information from Tess', cxr.messages?.some(m => m.id === tr.id && m.writtenBy === 'Tess' && /^Information from Tess/.test(m.treat)), JSON.stringify(cxr).slice(0, 300));
  // Tess's session to Om's project lead, by project only; and by Om's lead's address
  await drain(L.token, ME.userId, L.sid);
  await idle(ME.userId, L.sid);
  const tp = await must(kT, 'send_message', { project: NAME, kind: 'decision', body: 'ms6: Tess decided the queue', session: TL.sid });
  check('7: Tess’s session to the project with no `to` reaches Om’s lead (it holds Now)', JSON.stringify((await msg(tp.id)).toSids) === JSON.stringify([`${ME.userId}:${L.sid}`]) && /E2E Owner’s/.test(tp.target), tp.target);
  const lw = await wait(L.token);
  check('7: Om’s idle lead is woken by Tess’s decision, framed as information from Tess', lw.json?.wake === true && /Tess decided the queue/.test(lw.json.text ?? '') && /Information from Tess/.test(lw.json.text), lw.text.slice(0, 300));
  await ack(L.token, lw.json?.ack);
  const apply = await mcpH(kA, 'message_status', { id: tp.id, status: 'applied', session: L.sid });
  check('7: Om’s lead cannot apply Tess’s decision (a person does it in the app)', apply.isError && /applied by a person in the app/.test(apply.text), apply.text.slice(0, 200));
  const lr = await must(kA, 'reply', { id: tp.id, body: 'ms6: noted, Om will look', session: L.sid });
  check('7: Om’s lead’s reply goes back to Tess’s session', JSON.stringify((await msg(lr.id)).toSids) === JSON.stringify([`${T.userId}:${TL.sid}`]), JSON.stringify((await msg(lr.id)).toSids));
  const tls = await must(kT, 'list_sessions', { project: NAME });
  const omLeadForT = tls.sessions.find(x => x.name === 'MS6 lead');
  check('7: Tess sees Om’s sessions with addresses and no ids', ADDR.test(omLeadForT?.address ?? '') && !omLeadForT.session && !JSON.stringify(tls).includes(L.sid), JSON.stringify(omLeadForT));
  const ta = await must(kT, 'send_message', { to: omLeadForT.address, kind: 'fyi', body: 'ms6: Tess by address', session: TL.sid });
  check('7: Tess reaches Om’s session by its address', JSON.stringify((await msg(ta.id)).toSids) === JSON.stringify([`${ME.userId}:${L.sid}`]));
  const tid = await mcpH(kT, 'send_message', { to: L.sid, kind: 'fyi', body: 'ms6: Tess by id', session: TL.sid });
  check('7: …never by its session id', tid.isError && /No session of yours has that id/.test(tid.text) && !tid.text.includes(L.sid), tid.text.slice(0, 160));
  const tRead = await mcpH(kT, 'message_status', { id: c1.id });
  check('7: Tess cannot read a message between Om’s chat and his lead', tRead.isError && /not found/.test(tRead.text));
  // A teammate's private project: its sessions are not reachable
  await must(kT, 'add_project', { name: 'MS6 Tess Private', visibility: 'private' });
  await must(kT, 'start_work', { project: 'MS6 Tess Private', label: 'tess private' });
  const tPrivAddr = (await must(kT, 'list_sessions', { project: 'MS6 Tess Private' })).sessions.find(x => x.name === 'tess private')?.address;
  const toPriv = await mcpH(chat, 'send_message', { to: tPrivAddr, kind: 'fyi', body: 'ms6: into a private project' });
  check('7: a session on a teammate’s private project is not reachable by its address', ADDR.test(tPrivAddr ?? '') && toPriv.isError && /No session you can see/.test(toPriv.text) && !(await rawDb.collection('messages').findOne({ body: 'ms6: into a private project' })), toPriv.text.slice(0, 160));
  const toPrivP = await mcpH(chat, 'send_message', { to: 'Tess', project: 'MS6 Tess Private', kind: 'fyi', body: 'x' });
  check('7: …nor through the person on it', toPrivP.isError && /not found/i.test(toPrivP.text));

  // Never into another organization
  await must(kX, 'add_project', { name: 'MS6 Other Org', code: [{ remote: 'acme/ms6-other' }] });
  const xs = await must(kX, 'start_work', { project: 'MS6 Other Org', label: 'xavier session' });
  const xAddr = (await must(kX, 'list_sessions', {})).sessions.find(x => x.name === 'xavier session')?.address;
  const toX = await mcpH(chat, 'send_message', { to: xAddr, kind: 'fyi', body: 'ms6: across organizations' });
  const toXId = await mcpH(chat, 'send_message', { to: xs.session, kind: 'fyi', body: 'ms6: across organizations by id' });
  const toXP = await mcpH(chat, 'send_message', { to: 'Xavier', project: NAME, kind: 'fyi', body: 'ms6: across organizations by name' });
  const toXProj = await mcpH(chat, 'send_message', { project: 'MS6 Other Org', kind: 'fyi', body: 'ms6: into their project' });
  check('7: another organization’s session, person or project is never reachable, and nothing is stored', ADDR.test(xAddr ?? '') && [toX, toXId, toXP, toXProj].every(r => r.isError) && !(await rawDb.collection('messages').findOne({ body: /across organizations|into their project/ })), [toX, toXId, toXP, toXProj].map(r => r.text.slice(0, 80)).join(' | '));
  const xls = await must(kX, 'list_sessions', { include_off: true });
  check('7: their list_sessions shows nothing of this organization', !JSON.stringify(xls).includes('MS6 lead') && !JSON.stringify(xls).includes(lead.address), JSON.stringify(xls).slice(0, 200));
} catch (e) {
  check('flow-ms6 (error)', false, e?.stack || String(e));
}
await finish();
