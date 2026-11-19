// Flow MS2 (docs/flows/step-1.md "Tests"): a present session gets `forYou` once per message (ids and counts only, never body
// text), not for its own messages; a reply goes back in the same thread. Seed profile: none.
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

  const m1 = await must(MCP, 'send_message', { project: NAME, kind: 'request', body: `First ${CANARY}` });
  const m2 = await must(MCP, 'send_message', { project: NAME, kind: 'fyi', body: `Second ${CANARY}` });
  const got = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  const line = (got.json?.forYou ?? []).find(l => /inbox: m_/.test(l));
  check('MS2: the next answer names both messages once, by id', !!line && /1 request from me and 1 fyi from me on project/.test(line) && line.includes(m1.id) && line.includes(m2.id), JSON.stringify(got.json?.forYou));
  const fy = JSON.stringify(got.json?.forYou ?? []);
  check('MS2: forYou carries ids and counts only: no body text, no canary, no project name', !fy.includes(CANARY) && !fy.includes(NAME) && fy.includes(project._id), fy);
  const again = await mcpH(cc, 'list_tasks', { project: NAME });
  check('MS2: and only once (any tool, found by the key)', again.json && !('forYou' in again.json), again.text.slice(0, 200));

  const m3 = await must(MCP, 'send_message', { project: NAME, kind: 'question', body: 'A third' });
  const g3 = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  check('MS2: a later message is named once more (1 question from me)', /1 question from me /.test((g3.json?.forYou ?? []).join(' ')) && (g3.json?.forYou ?? []).join(' ').includes(m3.id), JSON.stringify(g3.json?.forYou));

  const own = await mcpH(cc, 'send_message', { project: NAME, kind: 'fyi', body: 'From the session itself', session: sid });
  const afterOwn = await mcpH(cc, 'get_state', { project: NAME, session: sid });
  check('MS2: a session is not told about the message it sent itself', !own.json?.forYou && !afterOwn.json?.forYou, `${own.text.slice(0, 120)} | ${afterOwn.text.slice(0, 120)}`);

  const rep = await must(cc, 'reply', { id: m1.id, body: 'On it', session: sid });
  const root = await rawDb.collection('messages').findOne({ _id: m1.id });
  const r = await rawDb.collection('messages').findOne({ _id: rep.id });
  check('MS2: a reply is in the same thread, kind fyi, and its target says who gets it', r.thread === root.thread && r.kind === 'fyi' && r.from.word === 'agent' && !!rep.target, JSON.stringify([r.thread, root.thread, rep.target]));
  const back = await mcpH(MCP, 'get_state', { project: NAME });
  check('MS2: someone who did not start work gets no forYou', back.json && !('forYou' in back.json));
  const ib = await must(MCP, 'inbox', { project: NAME });
  check('MS2: the thread shows in the inbox with the reply', ib.messages.filter(m => m.thread === root.thread).length === 2, JSON.stringify(ib.messages.map(m => [m.id, m.thread])));
} catch (e) {
  check('flow-ms2 (error)', false, e?.stack || String(e));
}
await finish();
