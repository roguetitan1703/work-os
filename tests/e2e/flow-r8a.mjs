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
} catch (e) {
  check('flow-r8a (error)', false, e?.stack || String(e));
}
await finish();
