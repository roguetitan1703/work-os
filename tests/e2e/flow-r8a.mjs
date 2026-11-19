// R8 batch A: how agents call the MCP tools. Session on every tool, Orders rows say how to change them, list_tasks dates
// parse like due, first-call mistakes, answer size, words that lie. Seed profile: none.
import { ME, MCP, check, finish, mkKey, rawDb } from './lib.mjs';
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
} catch (e) {
  check('flow-r8a (error)', false, e?.stack || String(e));
}
await finish();
