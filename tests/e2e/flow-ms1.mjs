// Flow MS1 (docs/flows/step-1.md "Tests"): with nobody present send_message says so, and the next start_work lists the message;
// a message to a session that was here earlier says "offline, last active 3 h ago"; `word` is set by the server from how the
// call came in (an argument for it is ignored). Seed profile: none.
import { ME, MCP, check, finish, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Mail';
const i61Key = (a, b) => b;
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-mail' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Cutroom Code' });

  const first = await must(MCP, 'send_message', { project: NAME, kind: 'request', body: 'Rebuild the client after the API change', word: 'person' });
  check('MS1: with nobody present the answer says so', first.sent === true && /nobody has worked on Flow Mail/.test(first.target) && /^m_/.test(first.id), JSON.stringify(first));
  const d1 = await rawDb.collection('messages').findOne({ _id: first.id });
  check('MS1: word is set from the call (a static Claude chat key is an agent), whatever the argument says', d1.from.word === 'agent' && first.word === 'agent', JSON.stringify(d1.from));
  check('MS1: the message carries the project placement and starts unread', d1.projectId === project._id && d1.visibility === 'org' && d1.status === 'unread' && d1.thread === d1._id);

  await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'cutroom prime' });
  await rawDb.collection('presence').updateMany({ projectId: project._id }, { $set: { lastSeen: new Date(Date.now() - 3 * 3600_000) } });
  const second = await must(MCP, 'send_message', { project: NAME, kind: 'fyi', body: 'The API now returns ids as strings' });
  check('MS1: a session that was here 3 h ago: offline, last active 3 h ago, it will get this on start', /cutroom prime: offline, last active 3 h ago; it will get this on start/.test(second.target), second.target);
  const narrow = await must(MCP, 'send_message', { project: NAME, kind: 'fyi', body: 'Only for cutroom', to_session: 'cutroom' });
  check('MS1: to_session narrows the target note', /^cutroom prime: offline/.test(narrow.target) && (narrow.target.match(/offline/g) || []).length === 1, narrow.target);
  const nobody = await must(MCP, 'send_message', { project: NAME, kind: 'fyi', body: 'For a session that never was', to_session: 'antigravity' });
  check('MS1: a label nobody has used says so', /no session like that/.test(nobody.target), nobody.target);

  const s2 = await must(cc, 'start_work', { project: NAME, machine: 'desktop', label: 'cutroom again' });
  check('MS1: the next start_work lists the messages, unread first (the first one was seen by the earlier start_work)', s2.inbox?.unread === 3 && s2.inbox.messages.length === 4 && s2.inbox.messages.slice(0, 3).every(m => m.status === 'unread') && s2.inbox.messages[3].status === 'seen', JSON.stringify(s2.inbox).slice(0, 300));
  check('MS1: each with sender, word, body and what to do with it', s2.inbox.messages.some(m => m.body.startsWith('Rebuild the client') && m.word === 'agent' && m.kind === 'request' && /proposal/.test(m.treat)), JSON.stringify(s2.inbox.messages[0]));
  const keys = Object.keys(s2);
  check('MS1: the inbox comes after the State and before the open tasks', keys.indexOf('state') < keys.indexOf('inbox') && keys.indexOf('inbox') < keys.indexOf('openTasks'), keys.join());
  check('MS1: the messages addressed to this person or session became seen; the one for a session nobody has used stays unread', (await rawDb.collection('messages').countDocuments({ projectId: project._id, status: 'seen' })) === 3);
  const s3 = await must(cc, 'start_work', { project: NAME, label: 'cutroom third' });
  check('MS1: seen ones are still listed, and the unread count is 1', s3.inbox.unread === 1 && s3.inbox.messages.length === 4);

  const inb = await must(MCP, 'inbox', { project: NAME });
  check('MS1: inbox lists them for the sender with their status', inb.messages.length === 4 && inb.messages.filter(m => m.status === 'seen').length === 3 && inb.messages.filter(m => m.status === 'unread').length === 1, JSON.stringify(inb.messages.map(m => m.status)));
  const asAgent = await must(cc, 'send_message', { project: NAME, kind: 'question', body: 'Which branch?' });
  check('MS1: a Claude Code key message has word agent', asAgent.word === 'agent' && (await rawDb.collection('messages').findOne({ _id: asAgent.id })).from.word === 'agent');
  const tooLong = await mcpH(MCP, 'send_message', { project: NAME, kind: 'fyi', body: 'x'.repeat(4001) });
  check('MS1: a body over 4,000 characters is refused', tooLong.isError, tooLong.text.slice(0, 120));
  // 60 messages an hour per person across all their keys, the 61st is refused
  const sent = await rawDb.collection('messages').countDocuments({ 'from.userId': ME.userId, at: { $gt: new Date(Date.now() - 3_600_000) } });
  for (let i = sent; i < 60; i++) await must(i % 2 ? MCP : cc, 'send_message', { project: NAME, kind: 'fyi', body: `flood ${i}` });
  const sixtyOne = await mcpH(i61Key(MCP, cc), 'send_message', { project: NAME, kind: 'fyi', body: 'one more' });
  check('MS1: the 61st message in an hour is refused, whichever key sends it', sixtyOne.isError && /60 messages/.test(sixtyOne.text), sixtyOne.text.slice(0, 200));
  const none = await mcpH(MCP, 'send_message', { project: 'No Such Project', kind: 'fyi', body: 'x' });
  check('MS1: a project that is not there is refused', none.isError && /not found/.test(none.text));
} catch (e) {
  check('flow-ms1 (error)', false, e?.stack || String(e));
}
await finish();
