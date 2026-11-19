// Flow MS5 (Harness H3, docs/flows/agent-system.md sections 11 and 16.8): per-session ids and read state for messages.
// One key with several sessions: a message to a session id reaches that session only, unread and seen are per session,
// labels match exactly (several sessions sharing one all get it), a claude.ai chat (no session, no presence row) is
// answered, another person passing Om's session id gets their own key, and old messages (no seenBy) keep their meaning.
// Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, mkOAuth, must } from './flow-lib.mjs';

const H = sid => ({ 'X-Work-OS-Session': sid });
const unreadOf = async (key, project, sid) => (await must(key, 'inbox', { project, session: sid })).unread;
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
  const sent = await must(kA, 'send_message', { project: PA, kind: 'request', body: 'B please rebuild the client', to_session: b.session, session: a.session });
  check('MS5 a: the answer names the target by label, never by id', /builder B/.test(sent.target) && !sent.target.includes(b.session), sent.target);
  const mDoc = await rawDb.collection('messages').findOne({ _id: sent.id });
  check('MS5 a: the message stores the addressed key and a label for display, not the raw id', mDoc.toSids?.length === 1 && mDoc.toSids[0] === `${ME.userId}:${b.session}` && mDoc.toSession === 'Work OS · builder B' && Array.isArray(mDoc.seenBy) && mDoc.seenBy.length === 0, JSON.stringify([mDoc.toSids, mDoc.toSession, mDoc.seenBy]));
  const fyB = await peek(kA, PA, b.session);
  const fyA = await peek(kA, PA, a.session);
  check('MS5 a: forYou names the message on B once and not on A', fyB?.forYou?.some(l => /1 request from me on project/.test(l)) && !(fyA && 'forYou' in fyA), JSON.stringify([fyB?.forYou, fyA?.forYou]));
  check('MS5 a: …and B’s forYou carries no body text', !JSON.stringify(fyB.forYou).includes('rebuild'));
  check('MS5 a: A has nothing unread (it sent it)', (await unreadOf(kA, PA, a.session)) === 0);
  const inbB = await must(kA, 'inbox', { project: PA, session: b.session });
  check('MS5 a: B has it unread (1) and the message is flagged unread', inbB.unread === 1 && inbB.messages.find(m => m.id === sent.id)?.unread === true, JSON.stringify(inbB.messages));
  check('MS5 a: no seenBy or toSids in the output', !/seenBy|toSids/.test(JSON.stringify(inbB)));
  check('MS5 a: B read it: unread 0 now', (await unreadOf(kA, PA, b.session)) === 0);
  check('MS5 a: A sees the status seen (message_status)', (await must(kA, 'message_status', { id: sent.id, status: 'seen', session: a.session })).message.status === 'seen');
  const rep = await must(kA, 'reply', { id: sent.id, body: 'done, rebuilt', session: b.session });
  check('MS5 a: B’s reply is addressed back to A', /builder A/.test(rep.target), rep.target);
  check('MS5 a: A has the reply unread (1), B has none', (await unreadOf(kA, PA, b.session)) === 0 && (await unreadOf(kA, PA, a.session)) === 1);
  check('MS5 a: A read it: 0', (await unreadOf(kA, PA, a.session)) === 0);

  // b) labels match exactly
  const PB = 'Flow Sessions B';
  await proj(PB);
  const s1 = await must(kA, 'start_work', { project: PB, label: 'Work OS · builder A' });
  const s2 = await must(kA, 'start_work', { project: PB, label: 'Work OS · builder B' });
  const s3 = await must(kA, 'start_work', { project: PB, label: 'twin' });
  const s4 = await must(kA, 'start_work', { project: PB, label: 'twin' });
  const m1 = await must(kA, 'send_message', { project: PB, kind: 'fyi', body: 'for builder b', to_session: 'work os · builder b', session: s1.session });
  const m2 = await must(kA, 'send_message', { project: PB, kind: 'fyi', body: 'for the twins', to_session: 'twin', session: s1.session });
  const m3 = await must(kA, 'send_message', { project: PB, kind: 'fyi', body: 'for nobody', to_session: 'builder', session: s1.session });
  const d1 = await rawDb.collection('messages').findOne({ _id: m1.id });
  const d2 = await rawDb.collection('messages').findOne({ _id: m2.id });
  const d3 = await rawDb.collection('messages').findOne({ _id: m3.id });
  check('MS5 b: a case-insensitive exact label reaches B only', d1.toSids?.length === 1 && d1.toSids[0] === `${ME.userId}:${s2.session}`, JSON.stringify(d1.toSids));
  check('MS5 b: a label shared by 2 sessions reaches both and the answer says 2', d2.toSids?.length === 2 && /2 sessions/.test(m2.target), `${JSON.stringify(d2.toSids)} ${m2.target}`);
  check('MS5 b: the substring "builder" matches nobody: it is a pending label', !d3.toSids && d3.toSession === 'builder' && /no session like that/.test(m3.target), JSON.stringify([d3.toSids, m3.target]));
  check('MS5 b: builder B has exactly its message unread', (await unreadOf(kA, PB, s2.session)) === 1);
  check('MS5 b: builder A (the sender) has nothing unread', (await unreadOf(kA, PB, s1.session)) === 0);
  check('MS5 b: twin 1 has 1 unread, reads it, then 0', (await unreadOf(kA, PB, s3.session)) === 1 && (await unreadOf(kA, PB, s3.session)) === 0);
  check('MS5 b: …and twin 2 still has its own unread (each marks only itself)', (await unreadOf(kA, PB, s4.session)) === 1);
  // a session that later starts with the pending label gets the message
  const s5 = await must(kA, 'start_work', { project: PB, label: 'builder' });
  check('MS5 b: a session that later takes the pending label finds the message', s5.inbox?.messages?.some(m => m.id === m3.id), JSON.stringify(s5.inbox).slice(0, 200));

  // c) a claude.ai chat (OAuth, no session, no presence row) is answered
  const PC = 'Flow Sessions C';
  await proj(PC);
  const kO = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  const code = await must(kA, 'start_work', { project: PC, label: 'code' });
  const q = await must(kO, 'send_message', { project: PC, kind: 'question', body: 'Chat here: is the build green?' });
  check('MS5 c: the chat message is unread for the Code session', (await unreadOf(kA, PC, code.session)) === 1);
  const ans = await must(kA, 'reply', { id: q.id, body: 'Yes, green', session: code.session });
  check('MS5 c: the reply goes back to the chat’s key', (await rawDb.collection('messages').findOne({ _id: ans.id })).toSids?.[0]?.startsWith(`${ME.userId}:oauth_`), JSON.stringify((await rawDb.collection('messages').findOne({ _id: ans.id })).toSids));
  check('MS5 c: chat has the reply unread (1)', (await must(kO, 'inbox', { project: PC })).unread === 1);
  check('MS5 c: chat read it: 0 (the 18 Nov repro)', (await must(kO, 'inbox', { project: PC })).unread === 0);

  // d) another person passing Om's session id gets her own key
  const PD = 'Flow Sessions D';
  await proj(PD);
  const om1 = await must(kA, 'start_work', { project: PD, label: 'om one' });
  const om2 = await must(kA, 'start_work', { project: PD, label: 'om two' });
  await must(kA, 'send_message', { project: PD, kind: 'fyi', body: 'untargeted from om two', session: om2.session });
  const mm2 = await must(kA, 'send_message', { project: PD, kind: 'fyi', body: 'to om one', to_session: om1.session, session: om2.session });
  const tIn = await must(kT, 'inbox', { project: PD, session: om1.session });
  check('MS5 d: Tess passing Om’s session id has nothing unread', tIn.unread === 0, String(tIn.unread));
  const tBrief = await must(kT, 'start_work', { project: PD, label: 'tess' });
  const tAll = JSON.stringify([tIn, tBrief]);
  check('MS5 d: her outputs carry none of Om’s session ids', !tAll.includes(om1.session) && !tAll.includes(om2.session) && !tBrief.alsoHere.some?.(x => x.session));
  const close = await mcpH(kT, 'message_status', { id: mm2.id, status: 'seen', session: om1.session });
  check('MS5 d: she cannot mark seen or close a message meant for Om’s session', close.isError, close.text.slice(0, 200));
  const mDoc2 = await rawDb.collection('messages').findOne({ _id: mm2.id });
  check('MS5 d: Om’s unread and the status are untouched by her reading', mDoc2.status === 'unread' && !mDoc2.seenBy.length, JSON.stringify([mDoc2.status, mDoc2.seenBy]));
  const tSend = await must(kT, 'send_message', { project: PD, kind: 'fyi', body: 'from tess', session: om1.session });
  const tDoc = await rawDb.collection('messages').findOne({ _id: tSend.id });
  check('MS5 d: her message is stamped with her own key', tDoc.src === `${T.userId}:${om1.session}` && tDoc.from.userId === T.userId, tDoc.src);
  check('MS5 d: Om’s session one still has both unread (to him by id, the untargeted one for the owner)', (await unreadOf(kA, PD, om1.session)) === 3);
  check('MS5 d: no seenBy or toSids in Tess’s or Om’s outputs', !/seenBy|toSids/.test(tAll));

  // e) legacy messages (no seenBy)
  const PE = 'Flow Sessions E';
  await proj(PE);
  const ls = await must(kA, 'start_work', { project: PE, label: 'legacy reader' });
  const l1 = await must(kT, 'send_message', { project: PE, kind: 'fyi', body: 'legacy seen' });
  const l2 = await must(kT, 'send_message', { project: PE, kind: 'fyi', body: 'legacy unread' });
  // as if they were stored before per-session read state: no seenBy, toSids or src
  await rawDb.collection('messages').updateOne({ _id: l1.id }, { $set: { status: 'seen' }, $unset: { seenBy: '', toSids: '', src: '' } });
  await rawDb.collection('messages').updateOne({ _id: l2.id }, { $unset: { seenBy: '', toSids: '', src: '' } });
  const li = await must(kA, 'inbox', { project: PE, session: ls.session });
  check('MS5 e: a legacy seen message is unread for nobody; an untargeted legacy unread one is unread once', li.unread === 1 && li.messages.find(m => m.id === l2.id)?.unread === true && !li.messages.find(m => m.id === l1.id)?.unread, JSON.stringify(li.messages.map(m => [m.id, m.unread])));
  check('MS5 e: after reading it is 0', (await unreadOf(kA, PE, ls.session)) === 0);
  check('MS5 e: reading a legacy message does not give it a seenBy list', !('seenBy' in (await rawDb.collection('messages').findOne({ _id: l2.id }))));

  // f) start_work again without a label keeps the label
  const PF = 'Flow Sessions F';
  await proj(PF);
  const f1 = await must(kA, 'start_work', { project: PF, label: 'keep me', session: 'ms5-keep-label' });
  await must(kA, 'start_work', { project: PF, session: f1.session });
  const row = await rawDb.collection('presence').findOne({ userId: ME.userId, session: 'ms5-keep-label' });
  check('MS5 f: start_work again without a label keeps the label', row?.label === 'keep me', JSON.stringify(row?.label));

  // g) review fixes: label spoofing, id-shaped waits, no backlog, no borrowed sibling row
  const PG = 'Flow Sessions G';
  await proj(PG);
  const g1 = await must(kA, 'start_work', { project: PG, label: 'Secret Label' });
  const g2 = await must(kA, 'start_work', { project: PG, label: 'Other One' });
  const gt = await must(kT, 'start_work', { project: PG, label: 'Secret Label' });
  const toLabel = await must(kA, 'send_message', { project: PG, kind: 'request', body: 'for the secret label', to_session: 'Secret Label', session: g2.session });
  const dl = await rawDb.collection('messages').findOne({ _id: toLabel.id });
  check('MS5 g1: a label copied by another member does not receive it: only the sender’s own rows match', dl.toSids?.length === 1 && dl.toSids[0] === `${ME.userId}:${g1.session}`, JSON.stringify(dl.toSids));
  check('MS5 g1: her session has nothing unread and cannot close it', (await unreadOf(kT, PG, gt.session)) === 0 && (await mcpH(kT, 'message_status', { id: toLabel.id, status: 'rejected', session: gt.session })).isError);
  const fromT = await must(kT, 'send_message', { project: PG, kind: 'fyi', body: 'tess to her own label', to_session: 'Secret Label', session: gt.session });
  const dt = await rawDb.collection('messages').findOne({ _id: fromT.id });
  check('MS5 g1: her message to that label reaches her own session only, not Om’s', dt.toSids?.length === 1 && dt.toSids[0] === `${T.userId}:${gt.session}` && (await unreadOf(kA, PG, g1.session)) === 1);

  const ghostId = 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7';
  const toGhost = await must(kA, 'send_message', { project: PG, kind: 'fyi', body: 'to a session that is not there yet', to_session: ghostId, session: g2.session });
  const dg = await rawDb.collection('messages').findOne({ _id: toGhost.id });
  check('MS5 g2: an unresolved id is never stored or shown as a label', !dg.toSession && !JSON.stringify(toGhost).includes(ghostId) && dg.toSids?.[0] === `${ME.userId}:${ghostId}`, JSON.stringify([dg.toSession, dg.toSids]));
  const ghostIn = JSON.stringify(await must(kA, 'inbox', { project: PG, session: g2.session }));
  check('MS5 g2: …nor in an inbox output', !ghostIn.includes(ghostId));
  const tg = await must(kT, 'start_work', { project: PG, session: ghostId });
  check('MS5 g2: another member starting with that session id gets her own key: unread 0, cannot close it', tg.inbox === 'no messages' || tg.inbox.unread === 0 ? (await mcpH(kT, 'message_status', { id: toGhost.id, status: 'seen', session: ghostId })).isError : false);
  const og = await must(kA, 'start_work', { project: PG, session: ghostId });
  check('MS5 g2: Om starting a session with that id gets it', og.inbox?.messages?.some(m => m.id === toGhost.id && m.unread === true), JSON.stringify(og.inbox).slice(0, 200));
  await must(kA, 'send_message', { project: PG, kind: 'fyi', body: 'to ghost label', to_session: 'ghost', session: g2.session });
  const tl = await must(kT, 'start_work', { project: PG, label: 'ghost' });
  check('MS5 g2: a waiting label is matched only against the sender’s own sessions: Tess taking it gets nothing', tl.inbox === 'no messages' || !tl.inbox.messages?.some(m => m.unread));
  const ol = await must(kA, 'start_work', { project: PG, label: 'ghost' });
  check('MS5 g2: …Om taking it does', ol.inbox?.messages?.some(m => m.body === 'to ghost label' && m.unread === true));

  // g3: no backlog for a new session; two sessions of one person both see a new message
  const PH = 'Flow Sessions H';
  await proj(PH);
  const h1 = await must(kA, 'start_work', { project: PH, label: 'h one' });
  const h2 = await must(kA, 'start_work', { project: PH, label: 'h two' });
  await must(kT, 'send_message', { project: PH, kind: 'fyi', body: 'for the project owner' });
  const h3 = await must(kA, 'start_work', { project: PH, label: 'h three (late)' });
  check('MS5 g3: a session that starts after an untargeted message has no backlog', h3.inbox.unread === 0, JSON.stringify(h3.inbox).slice(0, 160));
  check('MS5 g3: both earlier sessions of the person still see it, each once', (await unreadOf(kA, PH, h1.session)) === 1 && (await unreadOf(kA, PH, h2.session)) === 1 && (await unreadOf(kA, PH, h1.session)) === 0);

  // g4: a call with no session id does not borrow a sibling's row
  const PI = 'Flow Sessions I';
  await proj(PI);
  const i1 = await must(kA, 'start_work', { project: PI, label: 'i one' });
  const toI = await must(kA, 'send_message', { project: PI, kind: 'request', body: 'for i one', to_session: i1.session });
  const noId = await must(kA, 'inbox', { project: PI });
  check('MS5 g4: an inbox call with no session id does not read a sibling’s message', noId.unread === 0 && !(await rawDb.collection('messages').findOne({ _id: toI.id })).seenBy.length, JSON.stringify(noId.unread));
  await mcpH(kA, 'message_status', { id: toI.id, status: 'seen' }); // the sender may set it; it is not a read by the sibling
  check('MS5 g4: the session it is for still has it unread', (await unreadOf(kA, PI, i1.session)) === 1);

  // j) a chat that runs start_work without a session id: its brief and its later calls agree on one key
  const PJ = 'Flow Sessions J';
  await proj(PJ);
  const kO2 = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  const jc = await must(kA, 'start_work', { project: PJ, label: 'j code' });
  const jq = await must(kO2, 'send_message', { project: PJ, kind: 'question', body: 'Chat asks something' });
  const r1 = await must(kA, 'reply', { id: jq.id, body: 'first answer', session: jc.session });
  const sw1 = await must(kO2, 'start_work', { project: PJ });
  check('MS5 j: start_work without a session id from a chat stores a row without one and hands out no id', !('session' in sw1) && !(await rawDb.collection('presence').findOne({ userId: ME.userId, projectId: (await rawDb.collection('projects').findOne({ name: PJ }))._id, keyId: { $regex: '^oauth_' }, session: { $exists: true } })));
  check('MS5 j: its brief shows the reply unread', sw1.inbox?.unread === 1 && sw1.inbox.messages.find(m => m.id === r1.id)?.unread === true, JSON.stringify(sw1.inbox).slice(0, 200));
  check('MS5 j: its next inbox call has it read (the brief and the call agree on the key)', (await must(kO2, 'inbox', { project: PJ })).unread === 0);
  const r2 = await must(kA, 'reply', { id: jq.id, body: 'second answer', session: jc.session });
  const sw2 = await must(kO2, 'start_work', { project: PJ });
  check('MS5 j: a new message arrives in its next brief and the earlier one stays read', sw2.inbox?.unread === 1 && sw2.inbox.messages.find(m => m.id === r2.id)?.unread === true && !sw2.inbox.messages.find(m => m.id === r1.id)?.unread, JSON.stringify(sw2.inbox).slice(0, 300));

  // k) another member's label match: with no live session of her own with that label, it waits on her own key
  const PK = 'Flow Sessions K';
  await proj(PK);
  const k1 = await must(kA, 'start_work', { project: PK, label: 'K Label' });
  const kt = await must(kT, 'send_message', { project: PK, kind: 'request', body: 'tess to a label she has no session for', to_session: 'k label' });
  const dk = await rawDb.collection('messages').findOne({ _id: kt.id });
  check('MS5 k: a label only another member’s session has is not matched: the message waits on the sender’s own key', !dk.toSids && dk.toSession === 'k label' && (await unreadOf(kA, PK, k1.session)) === 0, JSON.stringify([dk.toSids, dk.toSession]));
} catch (e) {
  console.error(e);
  await finish(1);
}
await finish();
