// Flow MS1 (docs/archive/step-1.md "Tests", rewritten for Identity step 6: messages are to sessions and people, not project inboxes):
// send_message needs `to` (a session of yours by id or name, or a person); the answer says who is on the receiving end; a session that was
// here earlier says "off, last active 3 h ago; it gets this when it starts" (never "present now" for an off row); the session's next
// start_work lists what is unread for it and no other session has it; `word` is set by the server from how the call came in (an argument
// for it is ignored); message_status with no status reads the full text for the session it is for or its sender; the hourly limit, the
// body limit and an unknown project are refused. Seed profile: none.
import { randomBytes } from 'node:crypto';
import { ME, MCP, check, finish, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Mail';
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-mail' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Cutroom Code' });
  const prime = await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'cutroom prime' });
  const other = await must(cc, 'start_work', { project: NAME, machine: 'desktop', label: 'cutroom other' });
  const idA = prime.session;

  const none = await mcpH(MCP, 'send_message', { project: NAME, kind: 'request', body: 'Rebuild the client after the API change' });
  check('MS1: a message with only a project, when no session holds Now, is refused (never sent to every session) and nothing is stored', none.isError && /No session holds Now/.test(none.text) && !(await rawDb.collection('messages').findOne({ projectId: project._id })), none.text.slice(0, 160));
  const first = await must(MCP, 'send_message', { to: 'Cutroom Prime', kind: 'request', body: 'Rebuild the client after the API change', word: 'person' });
  check('MS1: `to` as a session name (any case) reaches that session, and the answer says who is on the receiving end', first.sent === true && /^cutroom prime: /.test(first.target) && !/cutroom other/.test(first.target) && /^m_/.test(first.id), JSON.stringify(first));
  const d1 = await rawDb.collection('messages').findOne({ _id: first.id });
  check('MS1: word is set from the call (a static Claude chat key is an agent), whatever the argument says', d1.from.word === 'agent' && first.word === 'agent', JSON.stringify(d1.from));
  check('MS1: the message carries the project placement, the session key it is for, and starts unread', d1.projectId === project._id && d1.visibility === 'org' && d1.status === 'unread' && d1.thread === d1._id && JSON.stringify(d1.toSids) === JSON.stringify([`${ME.userId}:${idA}`]), JSON.stringify([d1.toSids, d1.projectId]));
  check('MS1: a message to a session is not to a person (no toUser)', d1.toUser === undefined);

  await rawDb.collection('presence').updateMany({ projectId: project._id }, { $set: { lastSeen: new Date(Date.now() - 3 * 3600_000) } });
  const second = await must(MCP, 'send_message', { to: idA, kind: 'fyi', body: 'The API now returns ids as strings' });
  check('MS1: `to` as a session id; a session that was here 3 h ago: off, last active 3 h ago, it gets this when it starts', /cutroom prime: off, last active 3 h ago; it gets this when it starts/.test(second.target) && !/present now/.test(second.target), second.target);
  const nobody = await mcpH(MCP, 'send_message', { to: 'antigravity', kind: 'fyi', body: 'For a session that never was' });
  check('MS1: a name that is neither one of your sessions nor a person is refused', nobody.isError && /not a session of yours/.test(nobody.text), nobody.text.slice(0, 160));
  const noId = await mcpH(MCP, 'send_message', { to: randomBytes(16).toString('hex'), kind: 'fyi', body: 'For an id nobody has' });
  check('MS1: a session id of no session of yours is refused (another person\'s id never works either)', noId.isError && /No session of yours has that id/.test(noId.text), noId.text.slice(0, 160));
  const noProject = await mcpH(MCP, 'send_message', { to: idA, project: 'No Such Project', kind: 'fyi', body: 'x' });
  check('MS1: a project that is not there is refused', noProject.isError && /not found/.test(noProject.text), noProject.text.slice(0, 120));

  // What the session is told when it starts again: the unread messages for it (and the other session has none)
  const s2 = await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'cutroom prime', session: idA });
  check('MS1: the session\'s next start_work lists what is unread for it, with sender, word, body and what to do with it', s2.inbox?.unread === 2 && s2.inbox.messages.length === 2 && s2.inbox.messages.some(m => m.body.startsWith('Rebuild the client') && m.word === 'agent' && m.kind === 'request' && /proposal/.test(m.treat)), JSON.stringify(s2.inbox).slice(0, 300));
  const keys = Object.keys(s2);
  check('MS1: the messages come after the State and before the open tasks', keys.indexOf('state') < keys.indexOf('inbox') && keys.indexOf('inbox') < keys.indexOf('openTasks'), keys.join());
  const s3 = await must(cc, 'start_work', { project: NAME, label: 'cutroom other', session: other.session });
  check('MS1: another session of the same person has none of them (nothing was for it)', s3.inbox === 'no messages', JSON.stringify(s3.inbox).slice(0, 200));
  const s4 = await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'cutroom prime', session: idA });
  check('MS1: once read they are listed as seen, not unread', s4.inbox.unread === 0 && s4.inbox.messages.length === 2 && s4.inbox.messages.every(m => !m.unread), JSON.stringify(s4.inbox).slice(0, 200));

  // message_status with no status reads the text: the session it is for, or its sender
  const asTo = await must(cc, 'message_status', { id: first.id, session: idA });
  check('MS1: message_status with no status gives the session it is for the full text and the frame', asTo.message?.body === 'Rebuild the client after the API change' && /proposal/.test(asTo.message.treat) && asTo.textRule === undefined, JSON.stringify(asTo).slice(0, 240));
  const asFrom = await must(MCP, 'message_status', { id: first.id });
  check('MS1: …and its sender', asFrom.message?.body === 'Rebuild the client after the API change', JSON.stringify(asFrom).slice(0, 200));
  const asOther = await mcpH(cc, 'message_status', { id: first.id, session: other.session });
  check('MS1: …but not another session it was not addressed to (not found, whatever the project)', asOther.isError && /not found/.test(asOther.text), asOther.text.slice(0, 160));
  const inboxGone = await mcpH(MCP, 'inbox', { project: NAME });
  check('MS1: the inbox tool is gone', inboxGone.isError, inboxGone.text.slice(0, 120));

  const asAgent = await must(cc, 'send_message', { to: 'Cutroom Other', kind: 'question', body: 'Which branch?', session: idA });
  check('MS1: a Claude Code key message has word agent', asAgent.word === 'agent' && (await rawDb.collection('messages').findOne({ _id: asAgent.id })).from.word === 'agent');
  const tooLong = await mcpH(MCP, 'send_message', { to: idA, kind: 'fyi', body: 'x'.repeat(4001) });
  check('MS1: a body over 4,000 characters is refused', tooLong.isError, tooLong.text.slice(0, 120));
  // 60 messages an hour per person across all their keys, the 61st is refused
  const sent = await rawDb.collection('messages').countDocuments({ 'from.userId': ME.userId, at: { $gt: new Date(Date.now() - 3_600_000) } });
  for (let i = sent; i < 60; i++) await must(i % 2 ? MCP : cc, 'send_message', { to: idA, kind: 'fyi', body: `flood ${i}`, ...(i % 2 ? {} : { session: other.session }) });
  const sixtyOne = await mcpH(cc, 'send_message', { to: idA, kind: 'fyi', body: 'one more', session: other.session });
  check('MS1: the 61st message in an hour is refused, whichever key sends it', sixtyOne.isError && /60 messages/.test(sixtyOne.text), sixtyOne.text.slice(0, 200));
} catch (e) {
  check('flow-ms1 (error)', false, e?.stack || String(e));
}
await finish();
