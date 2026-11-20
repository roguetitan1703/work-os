// Flow MS2 (docs/flows/step-1.md "Tests", rewritten for Identity step 6: messages are sent to the session by id; and on 20 Nov: a session
// without the Work OS hook gets a short unread line on every answer until it reads them): ids and counts only, never body text, not for
// its own messages; message_status with no id reads them; a reply goes back in the same thread and its sender hears of it. Seed profile: none.
import { MCP, check, finish, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Ping';
const CANARY = 'zq9messagebodytext';
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-ping' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Ping Code' });
  const sid = (await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'ping' })).session;
  const quiet = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  check('MS2: nothing new, no forYou', quiet.json && !('forYou' in quiet.json));

  const m1 = await must(MCP, 'send_message', { to: sid, kind: 'request', body: `First ${CANARY}` });
  const m2 = await must(MCP, 'send_message', { to: sid, kind: 'fyi', body: `Second ${CANARY}` });
  const got = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  const line = (got.json?.forYou ?? []).find(l => /unread messages? for this session/.test(l));
  check('MS2: the next answer names both messages by id, with the count and how to read them', !!line && /^2 unread messages for this session from me/.test(line) && line.includes(m1.id) && line.includes(m2.id) && /message_status with no id reads them/.test(line), JSON.stringify(got.json?.forYou));
  const fy = JSON.stringify(got.json?.forYou ?? []);
  check('MS2: forYou carries ids and counts only: no body text, no canary, no project name', !fy.includes(CANARY) && !fy.includes(NAME), fy);
  const again = await mcpH(cc, 'list_tasks', { project: NAME });
  check('MS2: and again on the next answer until read (any tool, found by the key)', JSON.stringify(again.json?.forYou ?? []).includes(m1.id), again.text.slice(0, 200));

  const m3 = await must(MCP, 'send_message', { to: sid, kind: 'question', body: 'A third' });
  const g3 = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  check('MS2: a later message joins the line (3 unread)', /^3 unread messages/.test((g3.json?.forYou ?? []).join(' ')) && (g3.json?.forYou ?? []).join(' ').includes(m3.id), JSON.stringify(g3.json?.forYou));

  const own = await mcpH(cc, 'send_message', { to: sid, kind: 'fyi', body: 'From the session itself', session: sid });
  const afterOwn = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  check('MS2: a session is not told about the message it sent itself', !JSON.stringify(own.json?.forYou ?? []).includes(own.json?.id) && !JSON.stringify(afterOwn.json?.forYou ?? []).includes(own.json?.id) && /^3 unread/.test((afterOwn.json?.forYou ?? []).join(' ')), `${own.text.slice(0, 160)} | ${afterOwn.text.slice(0, 160)}`);
  const read = await must(cc, 'message_status', { session: sid });
  check('MS2: message_status with no id reads the three, oldest first, full text', read.messages?.map(m => m.id).join() === [m1.id, m2.id, m3.id].join() && read.messages[0].body === `First ${CANARY}`, JSON.stringify(read).slice(0, 200));
  const after = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  check('MS2: …then the line is gone', after.json && !('forYou' in after.json), after.text.slice(0, 200));

  const rep = await must(cc, 'reply', { id: m1.id, body: 'On it', session: sid });
  const root = await rawDb.collection('messages').findOne({ _id: m1.id });
  const r = await rawDb.collection('messages').findOne({ _id: rep.id });
  check('MS2: a reply is in the same thread, kind fyi, and its target says who gets it', r.thread === root.thread && r.kind === 'fyi' && r.from.word === 'agent' && !!rep.target, JSON.stringify([r.thread, root.thread, rep.target]));
  const back = await mcpH(MCP, 'get_state', { project: NAME });
  check('MS2: the sender, with no session of its own, hears of the reply on its next answer', (back.json?.forYou ?? []).some(l => l.includes(rep.id)), JSON.stringify(back.json?.forYou));
  check('MS2: the thread holds the message and its reply', (await rawDb.collection('messages').countDocuments({ thread: root.thread })) === 2);
} catch (e) {
  check('flow-ms2 (error)', false, e?.stack || String(e));
}
await finish();
