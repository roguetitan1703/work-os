// R8 batch A: how agents call the MCP tools. Session on every tool, Orders rows say how to change them, list_tasks dates
// parse like due, first-call mistakes, answer size, words that lie. Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { markOrders, mcpH, must } from './flow-lib.mjs';

const NAME = 'R8A Project';
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/r8a' }] });
  const cc = await mkKey({ agent: 'claude-code', name: 'Claude Code' });

  // F1: session on every tool
  const rules = (await must(MCP, 'write_note', { project: NAME, title: 'R8 rules', body: 'Original orders text.' })).created.id;
  await markOrders(rules, 'org');
  await must(cc, 'start_work', { project: NAME, label: 'r8 interactive', session: 'r8int' });
  await must(cc, 'start_work', { project: NAME, label: 'r8 disp · worker · #5', session: 'r8disp' });
  const noSess = await mcpH(cc, 'write_note', { note_id: rules, append: 'NOSESS', why: 'r8' });
  check('F1: write_note on the Orders with no session is refused', noSess.isError && /Orders/.test(noSess.text), noSess.text.slice(0, 200));
  const disp = await mcpH(cc, 'write_note', { note_id: rules, append: 'DISP', why: 'r8', session: 'r8disp' });
  check('F1: write_note on the Orders with a dispatched session is refused', disp.isError && /Orders/.test(disp.text), disp.text.slice(0, 200));
  const holder = await mcpH(cc, 'write_note', { note_id: rules, append: 'HOLDER LINE', why: 'r8', session: 'r8int' });
  check('F1: write_note on the Orders with the holder\'s own session (argument only) succeeds', !holder.isError && /HOLDER LINE/.test((await rawDb.collection('notes').findOne({ _id: rules })).body), holder.text.slice(0, 200));
  const body = (await rawDb.collection('notes').findOne({ _id: rules })).body;
  check('F1: the refused tries wrote nothing', !/NOSESS|DISP\b/.test(body));
  const askNo = await must(cc, 'ask', { project: NAME, to: 'me', kind: 'decide', ask: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] });
  check('F1: ask with no session answers with a note to pass session', /No session given: the answer will not wake you; pass session\./.test(askNo.sessionNote ?? ''), JSON.stringify(askNo).slice(0, 300));
  const askYes = await must(cc, 'ask', { project: NAME, to: 'me', kind: 'decide', ask: 'Which other?', options: [{ label: 'A' }, { label: 'B' }], session: 'r8int' });
  check('F1: ask with a session has no such note', !askYes.sessionNote, JSON.stringify(askYes).slice(0, 300));
  const start = await must(cc, 'start_work', { project: NAME, session: 'r8int' });
  check('F1: the brief says to pass the session on every call', /session on every Work OS call/.test(start.sessionNote ?? ''), start.sessionNote);
  const dc = await mcpH(cc, 'declutter', { project: NAME, session: 'r8int' });
  check('F1: declutter takes session', !dc.isError, dc.text.slice(0, 200));

  // F4: Orders rows say how to change them
  check('F4: the holder is brief rows say write_note, with the layer word org', start.orders.length > 0 && start.orders.every(o => o.change === 'write_note') && start.orders.some(o => o.layer === 'org'), JSON.stringify(start.orders.map(o => [o.layer, o.change])));
  const T = await makeUser({ email: 'r8tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const tk = await mkKey({ agent: 'claude-code', userId: T.userId, orgId: ME.orgId, name: 'Tess Code' });
  const ts = await must(tk, 'start_work', { project: NAME, session: 'r8tess' });
  check('F4: a teammate is brief rows say propose_order for the org layer', ts.orders.some(o => o.layer === 'org' && o.change === 'propose_order'), JSON.stringify(ts.orders));

  // F5: list_tasks dates
  await must(cc, 'add_task', { title: 'R8 due today', project: NAME, due: 'today' });
  await must(cc, 'add_task', { title: 'R8 due much later', project: NAME, due: '+30d' });
  const lt = await must(cc, 'list_tasks', { project: NAME, due_from: 'today', due_to: 'today' });
  check('F5: list_tasks due_from today and due_to today return that day only', lt.total === 1 && lt.tasks.some(t => /due today/.test(t.title)), JSON.stringify(lt).slice(0, 300));
  const badDate = await mcpH(cc, 'list_tasks', { project: NAME, due_to: 'soonish' });
  check('F5: a due_to that does not parse is refused, naming the field', badDate.isError && /due_to/.test(badDate.text), badDate.text);
  const badDone = await mcpH(cc, 'list_tasks', { project: NAME, done_since: '31/12' });
  check('F5: a done_since that does not parse is refused', badDone.isError && /done_since/.test(badDone.text), badDone.text);
  const okDone = await mcpH(cc, 'list_tasks', { project: NAME, done_since: 'today' });
  check('F5: done_since today is read', !okDone.isError, okDone.text);

  // F8: first-call mistakes
  const pNo = await mcpH(cc, 'add_task', { title: 'R8 typo project', project: 'R8A Projet' });
  check('F8: add_task with an unknown project is refused, names the closest and create_project', pNo.isError && /not found/.test(pNo.text) && /"R8A Project"/.test(pNo.text) && /create_project/.test(pNo.text), pNo.text);
  check('F8: â€¦and no project was made', !(await rawDb.collection('projects').findOne({ name: 'R8A Projet' })));
  const pYes = await mcpH(cc, 'add_task', { title: 'R8 new project', project: 'R8A Fresh', create_project: true });
  check('F8: add_task with create_project true makes the project', !pYes.isError && !!(await rawDb.collection('projects').findOne({ name: 'R8A Fresh' })), pYes.text);
  const uNo = await mcpH(cc, 'update_task', { task: pYes.json?.created?.ref, project: 'R8A Nowhere' });
  check('F8: update_task with an unknown project is refused', uNo.isError && /not found/.test(uNo.text) && !(await rawDb.collection('projects').findOne({ name: 'R8A Nowhere' })), uNo.text);
  const sdNo = await mcpH(cc, 'set_doing', { project: NAME, task: 9999, session: 'r8int' });
  check('F8: set_doing says which task was not found', sdNo.isError && /9999/.test(sdNo.text), sdNo.text);

  // F7: answer size
  const gt = await mcpH(cc, 'get_task', { task: (await must(cc, 'list_tasks', { project: NAME })).tasks[0].ref });
  check('F7: answers are compact JSON (no pretty-print newlines)', !gt.text.includes('\n') && gt.json !== null, gt.text.slice(0, 120));
  check('F7: get_task no longer carries the text rule', gt.json?.textRule === undefined);
  const gs = await must(cc, 'get_state', { project: NAME, session: 'r8int' });
  check('F7: get_state no longer carries the text rule', gs.textRule === undefined);
  for (const i of [1, 2, 3, 4, 5, 6, 7]) await must(cc, 'save_state', { project: NAME, session: 'r8int', ops: [{ op: 'add_later', text: `R8 later ${i}`, waits_on: 'nothing' }] });
  const sw = await must(cc, 'start_work', { project: NAME, session: 'r8int' });
  check('F7: start_work keeps the text rule', typeof sw.textRule === 'string');
  check('F7: start_work gives Later as the first 5 lines plus a count and a pointer to get_state', sw.state.later.length === 5 && sw.state.laterCount === 7 && /get_state/.test(sw.state.laterMore ?? ''), JSON.stringify(sw.state.later?.length));
  const full = await must(cc, 'get_state', { project: NAME, session: 'r8int' });
  check('F7: get_state still has every Later line', full.state.later.length === 7);

  // F9: a reply to a question or a request wakes the asker
  await must(cc, 'start_work', { project: NAME, label: 'r8 helper', session: 'r8help' });
  const q = await must(cc, 'send_message', { to: 'r8help', project: NAME, kind: 'question', body: 'R8 which way?', session: 'r8int' });
  const rq = await must(cc, 'reply', { id: q.message?.id ?? q.id, body: 'R8 this way', session: 'r8help' });
  const rdoc = await rawDb.collection('messages').findOne({ body: 'R8 this way' });
  check('F9: a reply to a question is marked as waking the asker', rdoc?.kind === 'fyi' && rdoc.wakes === true, JSON.stringify(rdoc));
  const f = await must(cc, 'send_message', { to: 'r8help', project: NAME, kind: 'fyi', body: 'R8 just so you know', session: 'r8int' });
  await must(cc, 'reply', { id: f.message?.id ?? f.id, body: 'R8 noted', session: 'r8help' });
  const rf = await rawDb.collection('messages').findOne({ body: 'R8 noted' });
  check('F9: a reply to an fyi does not wake', rf && !rf.wakes, JSON.stringify(rf));
  const ad = await mcpH(cc, 'save_state', { project: NAME, session: 'r8int', ops: [{ op: 'archive_decision', id: 'x' }] });
  check('F3: archive_decision is not in the agent schema', ad.isError && /archive_decision|op/.test(ad.text), ad.text.slice(0, 200));
} catch (e) {
  check('flow-r8a (error)', false, e?.stack || String(e));
}
await finish();
