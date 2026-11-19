// Identity step 6: a message goes to a session of yours (by id or name) or to a person. A session with no project is a session like any other
// for messages: the message is private to its person (placed private, owned by them, nobody else reads it or finds it), it is handed to the
// session by the hook (deliver on an event, a wake on wait), the session answers with reply, and a teammate can neither send to it by its id
// nor read what was sent. A message to a person shows on her Claude > Now (flow MS4 does the buttons). Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, MCP, ME, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-work-os-hook': '3', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ev = (tok, body) => call('/api/agent/event', tok, body);

try {
  const TESS = await makeUser({ email: 'tess-m2s@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const kT = await mkKey({ agent: 'claude-code', userId: TESS.userId, name: 'Tess Code' });
  const kA = await mkKey({ agent: 'claude-code', name: 'M2S Code' });
  const pc = await mkDevice('m2s-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'Scratch-PC' } });
  const start = (ccSession, extra = {}) => call('/api/agent/start', pc.key, { path: 'C:/scratch/m2s', branch: 'main', ccSession, source: 'startup', tool: 'desktop', title: 'Made up planner', model: 'model-z', ...extra });

  // A session outside any project, and a session on a project
  const r1 = await start(randomUUID());
  const tok = r1.json?.token;
  const sid = (await rawDb.collection('presence').findOne({ projectId: null }))?.session;
  check('setup: a no-project session with a token and a row', r1.status === 200 && r1.json?.unfiled === true && /^wst_/.test(tok ?? '') && !!sid, r1.text.slice(0, 120));
  await must(MCP, 'add_project', { name: 'M2S Project', code: [{ remote: 'acme/m2s-project' }] });
  const proj = await must(kA, 'start_work', { project: 'M2S Project', machine: 'laptop', label: 'project session' });
  const pSid = proj.session;

  // To the no-project session by id: private to its person
  const BODY = 'Planner: please summarise the open items';
  const m1 = await must(kA, 'send_message', { to: sid, kind: 'request', body: BODY, session: pSid });
  const d1 = await rawDb.collection('messages').findOne({ _id: m1.id });
  check('send_message to a no-project session by id: the answer says No project and who it reaches', /Made up planner/.test(m1.target) && /No project/.test(m1.project), JSON.stringify(m1).slice(0, 240));
  check('…the message has no project, is placed private and owned by its person, and is for that session only', d1.projectId === null && d1.visibility === 'private' && d1.ownerId === ME.userId && JSON.stringify(d1.toSids) === JSON.stringify([`${ME.userId}:${sid}`]), JSON.stringify([d1.projectId, d1.visibility, d1.ownerId, d1.toSids]));
  const m2 = await must(MCP, 'send_message', { to: 'made up planner', kind: 'fyi', body: 'By name, from the chat' });
  check('…and by name (any case)', (await rawDb.collection('messages').findOne({ _id: m2.id })).toSids?.[0] === `${ME.userId}:${sid}`);
  const bad = await mcpH(MCP, 'send_message', { to: sid, project: 'M2S Project', kind: 'fyi', body: 'x' });
  check('a project given for a no-project session it is not on is refused', bad.isError && /not on M2S Project/.test(bad.text), bad.text.slice(0, 160));

  // Nobody else reads it or can send to the session
  const tTo = await mcpH(kT, 'send_message', { to: sid, kind: 'fyi', body: 'tess to the planner' });
  check('a teammate sending to its id is refused: it is no session of hers', tTo.isError && /No session of yours has that id/.test(tTo.text) && !tTo.text.includes(sid), tTo.text.slice(0, 160));
  const tToName = await mcpH(kT, 'send_message', { to: 'Made up planner', kind: 'fyi', body: 'tess to the planner by name' });
  check('…nor by its name', tToName.isError && /not a session of yours/.test(tToName.text), tToName.text.slice(0, 160));
  const tRead = await mcpH(kT, 'message_status', { id: m1.id });
  check('a teammate reading the message gets "not found" (it is private to its person)', tRead.isError && /not found/.test(tRead.text) && !tRead.text.includes('summarise'), tRead.text.slice(0, 160));
  const tAct = await mcpH(kT, 'recent_activity', { since: '1d', limit: 100 });
  check('…and the activity feed of a teammate has nothing of it', !tAct.isError && !tAct.text.includes('summarise') && !tAct.text.includes('Made up planner'), tAct.text.slice(0, 160));
  check('the message text is in no activity row either', !JSON.stringify(await rawDb.collection('activity').find({ 'subject.id': m1.id }).toArray()).includes('summarise'));

  // The hook hands it over: deliver on an event, framed
  const del = await ev(tok, { event: 'prompt', deliver: true });
  const text = del.json?.deliver?.text ?? '';
  check('the hook event with deliver hands the session the messages for it, framed as from its own person’s session', del.status === 200 && /summarise the open items/.test(text) && /By name, from the chat/.test(text) && /\[\[work-os message m_/.test(text) && Array.isArray(del.json.deliver.ids) && del.json.deliver.ids.includes(m1.id), del.text.slice(0, 300));
  const unread = (await rawDb.collection('messages').findOne({ _id: m1.id })).seenBy;
  check('…and nothing is read until the hook acknowledges', Array.isArray(unread) && unread.length === 0);
  await ev(tok, { event: 'tool', ack: del.json.deliver.ids });
  check('…then it is read by that session', (await rawDb.collection('messages').findOne({ _id: m1.id })).seenBy.includes(`${ME.userId}:${sid}`));

  // A request to the idle session wakes it
  await ev(tok, { event: 'stop' });
  const req2 = await must(kA, 'send_message', { to: sid, kind: 'request', body: 'Wake up: one more thing', session: pSid });
  const w = await call('/api/agent/wait', tok, {});
  check('a request to the idle no-project session wakes its wait with the framed text', w.status === 200 && w.json?.wake === true && /one more thing/.test(w.json?.text ?? '') && (w.json.ack ?? []).includes(req2.id), w.text.slice(0, 240));
  await ev(tok, { event: 'tool', ack: w.json.ack ?? [] });

  // It answers: reply goes back to the project session that wrote
  const rep = await must(kA, 'reply', { id: m1.id, body: 'Here are the items', session: sid });
  const dr = await rawDb.collection('messages').findOne({ _id: rep.id });
  check('reply from the no-project session goes to the session that wrote, in the same thread', dr?.thread === m1.id && JSON.stringify(dr.toSids) === JSON.stringify([`${ME.userId}:${pSid}`]) && dr.projectId === null && dr.visibility === 'private', JSON.stringify([dr?.thread, dr?.toSids, dr?.projectId]));
  const back = await must(kA, 'start_work', { project: 'M2S Project', session: pSid });
  check('…and the project session finds it in its brief (a session on a project gets what was sent to its own key with no project)', back.inbox?.messages?.some(m => m.id === rep.id && m.unread === true), JSON.stringify(back.inbox).slice(0, 240));

  // The text and the status, for the session it is for or its sender
  const read = await must(kA, 'message_status', { id: m1.id, session: sid });
  check('message_status with no status gives the no-project session the full text and the frame', read.message?.body === BODY && !!read.textRule, JSON.stringify(read).slice(0, 200));
  const closed = await must(kA, 'message_status', { id: m1.id, status: 'applied', note: 'done', session: sid });
  check('…and it can close it', closed.message?.status === 'applied' && closed.message.note === 'done');
  const noMake = await mcpH(kA, 'message_status', { id: m2.id, status: 'applied', make_task: true, session: sid });
  check('a message with no project cannot become a task', noMake.isError, noMake.text.slice(0, 160));

  // A message to a person: shows on her Claude > Now, not for any session of hers
  const toT = await must(kA, 'send_message', { to: 'Tess', project: 'M2S Project', kind: 'fyi', body: 'Tess: the planner is ready', session: pSid });
  const dt = await rawDb.collection('messages').findOne({ _id: toT.id });
  check('a message to a person carries her id and the project, and no session key', dt.toUser === TESS.userId && !dt.toSids?.length && dt.visibility === 'org', JSON.stringify([dt.toUser, dt.toSids, dt.visibility]));
  const noProj = await mcpH(kA, 'send_message', { to: 'Tess', kind: 'fyi', body: 'no project given' });
  check('a message to a person needs a project you both read', noProj.isError && /needs a project/.test(noProj.text), noProj.text.slice(0, 160));
  const priv = await must(kA, 'add_project', { name: 'M2S Private', visibility: 'private' });
  const noRead = await mcpH(kA, 'send_message', { to: 'Tess', project: 'M2S Private', kind: 'fyi', body: 'she cannot read this project' });
  check('…and she must read it', noRead.isError && /cannot read/.test(noRead.text) && !!priv, noRead.text.slice(0, 160));
  const unknown = await mcpH(kA, 'send_message', { to: 'Nobody Atall', kind: 'fyi', body: 'x' });
  check('a name that is no session of yours and no person is refused', unknown.isError && /not a session of yours/.test(unknown.text), unknown.text.slice(0, 160));
  const noTo = await mcpH(kA, 'send_message', { kind: 'fyi', body: 'x' });
  check('a message with no `to` is refused', noTo.isError && /to is needed/.test(noTo.text), noTo.text.slice(0, 160));
  const self = await mcpH(kA, 'send_message', { to: ME.userId, project: 'M2S Project', kind: 'fyi', body: 'x' });
  check('a message cannot go to yourself as a person', self.isError, self.text.slice(0, 160));
} catch (e) {
  check('messages-to-sessions (error)', false, e?.stack || String(e));
}
await finish();
