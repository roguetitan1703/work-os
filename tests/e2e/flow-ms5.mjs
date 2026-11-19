// Flow MS5 (Harness H3, docs/flows/agent-system.md sections 11 and 16.8; rewritten for Identity step 6): per-session ids and read state for messages.
// One key with several sessions: a message to a session id or name reaches that session only, unread and seen are per session,
// names match exactly (several sessions sharing one all get it), a claude.ai chat (no session, no presence row) is answered,
// another person passing Om's session id gets her own key and can never send to or read Om's sessions, and old messages (no seenBy)
// keep their meaning. Seed profile: none.
// What went on purpose: a message to a name nobody has (a "pending label") or to an id that is not there yet is refused now, and a
// message with no `to` is not a thing, so the pending-label, ghost-id and "untargeted for the project owner" checks became refusals.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, mkOAuth, must } from './flow-lib.mjs';

const OM = 'E2E Owner';
const H = sid => ({ 'X-Work-OS-Session': sid });
// What a session is told it has unread: start_work with its id lists them and marks them read for it (as the old inbox call did).
const unreadOf = async (key, project, sid, extra = {}) => {
  const r = await must(key, 'start_work', { project, ...(sid ? { session: sid } : {}), ...extra });
  return r.inbox === 'no messages' ? 0 : r.inbox.unread;
};
const peek = async (key, project, sid) => (await mcpH(key, 'list_tasks', { project }, H(sid))).json;
const proj = async name => {
  await must(MCP, 'add_project', { name, code: [{ remote: `acme/${name.toLowerCase().replace(/\W+/g, '-')}` }] });
  return rawDb.collection('projects').findOne({ name });
};

try {
  const T = await makeUser({ email: 'tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const kA = await mkKey({ agent: 'claude-code', name: 'MS5 Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });

  // a) one key, two sessions: addressed by id
  const PA = 'Flow Sessions A';
  await proj(PA);
  const a = await must(kA, 'start_work', { project: PA, label: 'Work OS · builder A' });
  const b = await must(kA, 'start_work', { project: PA, label: 'Work OS · builder B' });
  check('MS5 a: start_work hands each session its own id', !!a.session && !!b.session && a.session !== b.session, `${a.session} ${b.session}`);
  const ownIds = (await must(kA, 'start_work', { project: PA, label: 'Work OS · observer' })).alsoHere;
  check('MS5 a: alsoHere names the caller’s own other sessions by id', Array.isArray(ownIds) && ownIds.some(x => x.session === a.session) && ownIds.some(x => x.session === b.session), JSON.stringify(ownIds));
  const sent = await must(kA, 'send_message', { kind: 'request', body: 'B please rebuild the client', to: b.session, session: a.session });
  check('MS5 a: the answer names the target by label, never by id', /builder B/.test(sent.target) && !sent.target.includes(b.session), sent.target);
  const mDoc = await rawDb.collection('messages').findOne({ _id: sent.id });
  check('MS5 a: the message stores the addressed key and a label for display, not the raw id', mDoc.toSids?.length === 1 && mDoc.toSids[0] === `${ME.userId}:${b.session}` && mDoc.toSession === 'Work OS · builder B' && Array.isArray(mDoc.seenBy) && mDoc.seenBy.length === 0, JSON.stringify([mDoc.toSids, mDoc.toSession, mDoc.seenBy]));
  const fyB = await peek(kA, PA, b.session);
  const fyA = await peek(kA, PA, a.session);
  check('MS5 a: forYou names the message on B once and not on A', fyB?.forYou?.some(l => /1 request from me on project/.test(l)) && !(fyA && 'forYou' in fyA), JSON.stringify([fyB?.forYou, fyA?.forYou]));
  check('MS5 a: …and B’s forYou carries no body text', !JSON.stringify(fyB.forYou).includes('rebuild'));
  check('MS5 a: A has nothing unread (it sent it)', (await unreadOf(kA, PA, a.session)) === 0);
  const inbB = (await must(kA, 'start_work', { project: PA, session: b.session })).inbox;
  check('MS5 a: B has it unread (1) and the message is flagged unread', inbB.unread === 1 && inbB.messages.find(m => m.id === sent.id)?.unread === true, JSON.stringify(inbB.messages));
  check('MS5 a: no seenBy or toSids in the output', !/seenBy|toSids/.test(JSON.stringify(inbB)));
  check('MS5 a: B read it: unread 0 now', (await unreadOf(kA, PA, b.session)) === 0);
  check('MS5 a: A sees the status seen (message_status)', (await must(kA, 'message_status', { id: sent.id, status: 'seen', session: a.session })).message.status === 'seen');
  const rep = await must(kA, 'reply', { id: sent.id, body: 'done, rebuilt', session: b.session });
  check('MS5 a: B’s reply is addressed back to A', /builder A/.test(rep.target), rep.target);
  check('MS5 a: A has the reply unread (1), B has none', (await unreadOf(kA, PA, b.session)) === 0 && (await unreadOf(kA, PA, a.session)) === 1);
  check('MS5 a: A read it: 0', (await unreadOf(kA, PA, a.session)) === 0);

  // b) names match exactly (the same name on two projects needs `project`, or the id)
  const PB = 'Flow Sessions B';
  await proj(PB);
  const s1 = await must(kA, 'start_work', { project: PB, label: 'Work OS · builder A' });
  const s2 = await must(kA, 'start_work', { project: PB, label: 'Work OS · builder B' });
  const s3 = await must(kA, 'start_work', { project: PB, label: 'twin' });
  const s4 = await must(kA, 'start_work', { project: PB, label: 'twin' });
  const m1 = await must(kA, 'send_message', { kind: 'fyi', body: 'for builder b', to: 'work os · builder b', project: PB, session: s1.session });
  const m2 = await must(kA, 'send_message', { kind: 'fyi', body: 'for the twins', to: 'twin', project: PB, session: s1.session });
  const m3 = await mcpH(kA, 'send_message', { kind: 'fyi', body: 'for nobody', to: 'builder', project: PB, session: s1.session });
  const d1 = await rawDb.collection('messages').findOne({ _id: m1.id });
  const d2 = await rawDb.collection('messages').findOne({ _id: m2.id });
  check('MS5 b: a case-insensitive exact name reaches B only', d1.toSids?.length === 1 && d1.toSids[0] === `${ME.userId}:${s2.session}`, JSON.stringify(d1.toSids));
  check('MS5 b: a name shared by 2 sessions reaches both and the answer says 2', d2.toSids?.length === 2 && /2 sessions/.test(m2.target), `${JSON.stringify(d2.toSids)} ${m2.target}`);
  check('MS5 b: the substring "builder" matches nobody and is refused (there are no pending names)', m3.isError && /not a session of yours/.test(m3.text), m3.text.slice(0, 200));
  check('MS5 b: builder B has exactly its message unread', (await unreadOf(kA, PB, s2.session)) === 1);
  check('MS5 b: builder A (the sender) has nothing unread', (await unreadOf(kA, PB, s1.session)) === 0);
  check('MS5 b: twin 1 has 1 unread, reads it, then 0', (await unreadOf(kA, PB, s3.session)) === 1 && (await unreadOf(kA, PB, s3.session)) === 0);
  check('MS5 b: …and twin 2 still has its own unread (each marks only itself)', (await unreadOf(kA, PB, s4.session)) === 1);
  const s5 = await must(kA, 'start_work', { project: PB, label: 'builder' });
  check('MS5 b: a session that later takes the name "builder" finds nothing (a refused message waits for nobody)', s5.inbox === 'no messages', JSON.stringify(s5.inbox).slice(0, 200));

  // c) a claude.ai chat (OAuth, no session, no presence row) is answered
  const PC = 'Flow Sessions C';
  await proj(PC);
  const kO = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  const code = await must(kA, 'start_work', { project: PC, label: 'code' });
  const q = await must(kO, 'send_message', { kind: 'question', body: 'Chat here: is the build green?', to: code.session });
  check('MS5 c: the chat message is unread for the Code session', (await unreadOf(kA, PC, code.session)) === 1);
  const ans = await must(kA, 'reply', { id: q.id, body: 'Yes, green', session: code.session });
  check('MS5 c: the reply goes back to the chat’s key', (await rawDb.collection('messages').findOne({ _id: ans.id })).toSids?.[0]?.startsWith(`${ME.userId}:oauth_`), JSON.stringify((await rawDb.collection('messages').findOne({ _id: ans.id })).toSids));
  check('MS5 c: chat has the reply unread (1)', (await unreadOf(kO, PC)) === 1);
  check('MS5 c: chat read it: 0 (the 18 Nov repro)', (await unreadOf(kO, PC)) === 0);

  // d) another person passing Om's session id gets her own key
  const PD = 'Flow Sessions D';
  await proj(PD);
  const om1 = await must(kA, 'start_work', { project: PD, label: 'om one' });
  const om2 = await must(kA, 'start_work', { project: PD, label: 'om two' });
  const mm2 = await must(kA, 'send_message', { kind: 'fyi', body: 'to om one', to: om1.session, session: om2.session });
  const tOne = await must(kT, 'start_work', { project: PD, label: 'tess', session: om1.session });
  const tIn = tOne.inbox === 'no messages' ? { unread: 0 } : tOne.inbox;
  check('MS5 d: Tess passing Om’s session id has nothing unread', tIn.unread === 0, String(tIn.unread));
  const tBrief = await must(kT, 'start_work', { project: PD, label: 'tess' });
  const tAll = JSON.stringify([tIn, tBrief]);
  check('MS5 d: her outputs carry none of Om’s other session ids, and Om’s sessions in alsoHere have no id (the id she passed is a row of her own)', !tAll.includes(om2.session) && (Array.isArray(tBrief.alsoHere) ? tBrief.alsoHere : []).filter(x => /om (one|two)/.test(JSON.stringify(x))).every(x => !x.session), JSON.stringify(tBrief.alsoHere));
  const close = await mcpH(kT, 'message_status', { id: mm2.id, status: 'seen', session: om1.session });
  check('MS5 d: she cannot mark seen or close a message meant for Om’s session', close.isError, close.text.slice(0, 200));
  const readIt = await mcpH(kT, 'message_status', { id: mm2.id, session: om1.session });
  check('MS5 d: nor read it (not found)', readIt.isError && /not found/.test(readIt.text), readIt.text.slice(0, 200));
  const mDoc2 = await rawDb.collection('messages').findOne({ _id: mm2.id });
  check('MS5 d: Om’s unread and the status are untouched by her reading', mDoc2.status === 'unread' && !mDoc2.seenBy.length, JSON.stringify([mDoc2.status, mDoc2.seenBy]));
  const tToOm2 = await mcpH(kT, 'send_message', { kind: 'fyi', body: 'tess to om two', to: om2.session });
  check('MS5 d: she cannot send to Om’s other session by its id (it is no session of hers)', tToOm2.isError && /No session of yours has that id/.test(tToOm2.text), tToOm2.text.slice(0, 200));
  const tToName = await mcpH(kT, 'send_message', { kind: 'fyi', body: 'tess to om one', to: 'om one' });
  check('MS5 d: nor by its name', tToName.isError && /not a session of yours/.test(tToName.text), tToName.text.slice(0, 200));
  const tSend = await must(kT, 'send_message', { kind: 'fyi', body: 'from tess to her own', to: om1.session, session: om1.session });
  const tDoc = await rawDb.collection('messages').findOne({ _id: tSend.id });
  check('MS5 d: her message is stamped with her own key and goes to her own row, not Om’s', tDoc.src === `${T.userId}:${om1.session}` && tDoc.from.userId === T.userId && tDoc.toSids?.[0] === `${T.userId}:${om1.session}` && tDoc.toSids.length === 1, JSON.stringify([tDoc.src, tDoc.toSids]));
  check('MS5 d: Om’s session one still has exactly its one (to him by id)', (await unreadOf(kA, PD, om1.session)) === 1);
  check('MS5 d: no seenBy or toSids in Tess’s or Om’s outputs', !/seenBy|toSids/.test(tAll));

  // e) legacy messages (no seenBy, no addressee): for the project owner, as they always were
  const PE = 'Flow Sessions E';
  await proj(PE);
  const ls = await must(kA, 'start_work', { project: PE, label: 'legacy reader' });
  const te = await must(kT, 'start_work', { project: PE, label: 'tess e' });
  const l1 = await must(kT, 'send_message', { kind: 'fyi', body: 'legacy seen', to: OM, project: PE, session: te.session });
  const l2 = await must(kT, 'send_message', { kind: 'fyi', body: 'legacy unread', to: OM, project: PE, session: te.session });
  // as if they were stored before per-session read state and addressing: no seenBy, toSids, toUser or src
  await rawDb.collection('messages').updateOne({ _id: l1.id }, { $set: { status: 'seen' }, $unset: { seenBy: '', toSids: '', toUser: '', src: '' } });
  await rawDb.collection('messages').updateOne({ _id: l2.id }, { $unset: { seenBy: '', toSids: '', toUser: '', src: '' } });
  const li = (await must(kA, 'start_work', { project: PE, session: ls.session })).inbox;
  check('MS5 e: a legacy seen message is unread for nobody; a legacy unread one is unread once', li.unread === 1 && li.messages.find(m => m.id === l2.id)?.unread === true && !li.messages.find(m => m.id === l1.id)?.unread, JSON.stringify(li.messages?.map(m => [m.id, m.unread])));
  check('MS5 e: after reading it is 0', (await unreadOf(kA, PE, ls.session)) === 0);
  check('MS5 e: reading a legacy message does not give it a seenBy list', !('seenBy' in (await rawDb.collection('messages').findOne({ _id: l2.id }))));

  // f) start_work again without a label keeps the label
  const PF = 'Flow Sessions F';
  await proj(PF);
  const f1 = await must(kA, 'start_work', { project: PF, label: 'keep me', session: 'ms5-keep-label' });
  await must(kA, 'start_work', { project: PF, session: f1.session });
  const row = await rawDb.collection('presence').findOne({ userId: ME.userId, session: 'ms5-keep-label' });
  check('MS5 f: start_work again without a label keeps the label', row?.label === 'keep me', JSON.stringify(row?.label));

  // g) review fixes: name spoofing, ids that are not there, a message to a person is not for a session, no borrowed sibling row
  const PG = 'Flow Sessions G';
  await proj(PG);
  const g1 = await must(kA, 'start_work', { project: PG, label: 'Secret Label' });
  const g2 = await must(kA, 'start_work', { project: PG, label: 'Other One' });
  const gt = await must(kT, 'start_work', { project: PG, label: 'Secret Label' });
  const toLabel = await must(kA, 'send_message', { kind: 'request', body: 'for the secret label', to: 'Secret Label', session: g2.session });
  const dl = await rawDb.collection('messages').findOne({ _id: toLabel.id });
  check('MS5 g1: a name copied by another member does not receive it: only the sender’s own rows match', dl.toSids?.length === 1 && dl.toSids[0] === `${ME.userId}:${g1.session}`, JSON.stringify(dl.toSids));
  check('MS5 g1: her session has nothing unread and cannot close it', (await unreadOf(kT, PG, gt.session)) === 0 && (await mcpH(kT, 'message_status', { id: toLabel.id, status: 'rejected', session: gt.session })).isError);
  const fromT = await must(kT, 'send_message', { kind: 'fyi', body: 'tess to her own name', to: 'Secret Label', session: gt.session });
  const dt = await rawDb.collection('messages').findOne({ _id: fromT.id });
  check('MS5 g1: her message to that name reaches her own session only, not Om’s', dt.toSids?.length === 1 && dt.toSids[0] === `${T.userId}:${gt.session}` && (await unreadOf(kA, PG, g1.session)) === 1);

  const ghostId = 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7';
  const toGhost = await mcpH(kA, 'send_message', { kind: 'fyi', body: 'to a session that is not there yet', to: ghostId, session: g2.session });
  check('MS5 g2: an id that is no session of yours is refused, and nothing is stored', toGhost.isError && /No session of yours has that id/.test(toGhost.text) && !(await rawDb.collection('messages').findOne({ body: 'to a session that is not there yet' })), toGhost.text.slice(0, 200));
  const tg = await must(kT, 'start_work', { project: PG, session: ghostId });
  check('MS5 g2: another member starting with that id gets her own key and nothing', tg.inbox === 'no messages' || tg.inbox.unread === 0);

  // g3: a message to a person is for the person (Claude › Now), not for any of their sessions
  const PH = 'Flow Sessions H';
  await proj(PH);
  const h1 = await must(kA, 'start_work', { project: PH, label: 'h one' });
  const h2 = await must(kA, 'start_work', { project: PH, label: 'h two' });
  const toOmP = await must(kT, 'send_message', { kind: 'fyi', body: 'for the project owner', to: OM, project: PH });
  const h3 = await must(kA, 'start_work', { project: PH, label: 'h three (late)' });
  check('MS5 g3: a session that starts after a message to the person has no backlog', h3.inbox === 'no messages' || h3.inbox.unread === 0, JSON.stringify(h3.inbox).slice(0, 160));
  check('MS5 g3: neither earlier session of the person gets it (it is for the person, in the app)', (await unreadOf(kA, PH, h1.session)) === 0 && (await unreadOf(kA, PH, h2.session)) === 0 && (await rawDb.collection('messages').findOne({ _id: toOmP.id })).toUser === ME.userId);

  // g4: a call with no session id does not borrow a sibling's row
  const PI = 'Flow Sessions I';
  await proj(PI);
  const i1 = await must(kA, 'start_work', { project: PI, label: 'i one' });
  const toI = await must(kA, 'send_message', { kind: 'request', body: 'for i one', to: i1.session });
  const noId = await must(kA, 'message_status', { id: toI.id });
  check('MS5 g4: a read with no session id (the sender) does not mark a sibling’s message read', noId.message?.body === 'for i one' && !(await rawDb.collection('messages').findOne({ _id: toI.id })).seenBy.length, JSON.stringify(noId).slice(0, 200));
  await mcpH(kA, 'message_status', { id: toI.id, status: 'seen' }); // the sender may set it; it is not a read by the sibling
  check('MS5 g4: the session it is for still has it unread', (await unreadOf(kA, PI, i1.session)) === 1);

  // j) a chat that runs start_work without a session id: its brief and its later calls agree on one key
  const PJ = 'Flow Sessions J';
  await proj(PJ);
  const kO2 = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  const jc = await must(kA, 'start_work', { project: PJ, label: 'j code' });
  const jq = await must(kO2, 'send_message', { kind: 'question', body: 'Chat asks something', to: jc.session });
  const r1 = await must(kA, 'reply', { id: jq.id, body: 'first answer', session: jc.session });
  const sw1 = await must(kO2, 'start_work', { project: PJ });
  check('MS5 j: start_work without a session id from a chat stores a row without one and hands out no id', !('session' in sw1) && !(await rawDb.collection('presence').findOne({ userId: ME.userId, projectId: (await rawDb.collection('projects').findOne({ name: PJ }))._id, keyId: { $regex: '^oauth_' }, session: { $exists: true } })));
  check('MS5 j: its brief shows the reply unread', sw1.inbox?.unread === 1 && sw1.inbox.messages.find(m => m.id === r1.id)?.unread === true, JSON.stringify(sw1.inbox).slice(0, 200));
  check('MS5 j: its next brief has it read (the brief and the later call agree on the key)', (await unreadOf(kO2, PJ)) === 0);
  const r2 = await must(kA, 'reply', { id: jq.id, body: 'second answer', session: jc.session });
  const sw2 = await must(kO2, 'start_work', { project: PJ });
  check('MS5 j: a new message arrives in its next brief and the earlier one stays read', sw2.inbox?.unread === 1 && sw2.inbox.messages.find(m => m.id === r2.id)?.unread === true && !sw2.inbox.messages.find(m => m.id === r1.id)?.unread, JSON.stringify(sw2.inbox).slice(0, 300));

  // k) another member's name: with no session of her own with that name she cannot send to it
  const PK = 'Flow Sessions K';
  await proj(PK);
  const k1 = await must(kA, 'start_work', { project: PK, label: 'K Label' });
  const kt = await mcpH(kT, 'send_message', { kind: 'request', body: 'tess to a name she has no session for', to: 'k label' });
  check('MS5 k: a name only another member’s session has is not matched: refused, and nothing waits on any key', kt.isError && /not a session of yours/.test(kt.text) && (await unreadOf(kA, PK, k1.session)) === 0, kt.text.slice(0, 200));
} catch (e) {
  console.error(e);
  await finish(1);
}
await finish();
