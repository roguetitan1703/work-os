// Flow H1 (docs/flows/step-1.md "Tests"): an idea dropped from a chat (a note, a task, a Next line) reaches the next
// session on the project. The present session's next tool answer carries `forYou` once, with ids and counts only, never
// body text; a new session's start_work lists the items; the session's own writes are not told back to it; the save
// nudge after 10 writes; a session that passes no id is found by its key; the cursor stays inside the person's own sessions.
// Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Inbox';
const CANARY = 'zq7secretbodytext';
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-inbox' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Claude Code' });

  const s1 = (await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'h1 session' })).session;
  const quiet = await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  check('H1: nothing new, no forYou', quiet.json && !('forYou' in quiet.json), quiet.text.slice(0, 200));

  // A chat drops a note, a task and a Next line
  const note = await must(MCP, 'write_note', { project: NAME, title: `Idea ${CANARY} note`, body: `Body ${CANARY}` });
  const task = await must(MCP, 'add_task', { title: `Task ${CANARY}`, project: NAME, description: `Description ${CANARY}` });
  await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'add_next', text: `Next ${CANARY}` }] });
  const nextId = (await must(MCP, 'get_state', { project: NAME })).state.next[0].id;

  const got = await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  const fy = got.json?.forYou;
  check('H1: the present session’s next answer has forYou', Array.isArray(fy) && fy.length >= 2, got.text.slice(0, 300));
  check('H1: it names the new task by number and the new Next line by id', fy.some(l => l.includes(`#${task.created.ref}`) && /new task/.test(l)) && fy.some(l => l.includes(nextId) && /Next/.test(l)), JSON.stringify(fy));
  check('H1: forYou carries ids and counts only: no title, note or description text, no canary', !JSON.stringify(fy).includes(CANARY) && !/Task |Next |Idea |Description/.test(JSON.stringify(fy).replace(/new task|new line in Next|Next on/g, '')), JSON.stringify(fy));
  check('H1: the project is named by id, never by its name', JSON.stringify(fy).includes(project._id) && !JSON.stringify(fy).includes(NAME), JSON.stringify(fy));
  const twice = await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  check('H1: …and only once', twice.json && !('forYou' in twice.json), twice.text.slice(0, 200));
  check('H1: the cursor moved on the session row', (await rawDb.collection('presence').findOne({ userId: ME.userId, session: s1 })).forYouCursor.getTime() > Date.now() - 60_000);

  // Works for any tool, not only the State ones
  await must(MCP, 'add_task', { title: 'Second thing', project: NAME });
  const lt = await mcpH(cc, 'list_tasks', { project: NAME });
  check('H1: any tool’s answer carries it (list_tasks), found by the key when no session id is passed', lt.json?.forYou?.some(l => /1 new task/.test(l)), lt.text.slice(0, 200));

  // A new session's start_work lists the items
  const s2 = await must(cc, 'start_work', { project: NAME, machine: 'desktop', label: 'new session' });
  check('H1: a new session’s start_work lists the Next line (State comes before the tasks) and the tasks', s2.state.next.some(l => l.text === `Next ${CANARY}`) && s2.openTasks.tasks.some(t => t.title === `Task ${CANARY}`) && Object.keys(s2).indexOf('state') < Object.keys(s2).indexOf('openTasks'), JSON.stringify(s2).slice(0, 300));
  check('H1: …and the note is readable by id through the usual tools', !!(await must(cc, 'read_note', { note_id: note.created.id })).markdown);
  check('H1: start_work carries no forYou of its own (the brief is everything)', !('forYou' in s2));

  // The session header works for any client, without the argument
  const s3 = 'hdr-session-3';
  await mcpH(MCP, 'start_work', { project: NAME, label: 'chat' }, { 'x-work-os-session': s3 });
  await must(cc, 'add_task', { title: 'Made by the code key', project: NAME });
  const viaHeader = await mcpH(MCP, 'get_state', { project: NAME }, { 'x-work-os-session': s3 });
  check('H1: a chat key’s session, named only by the header, gets forYou too', viaHeader.json?.forYou?.some(l => /new task/.test(l)), viaHeader.text.slice(0, 200));

  // Own writes are not told back (first drain what the other sessions made meanwhile)
  await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  const own = await mcpH(cc, 'add_task', { title: 'My own task', project: NAME }, { 'x-work-os-session': s1 });
  const afterOwn = await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  check('H1: a session is not told about what it just wrote itself', !own.json?.forYou && !afterOwn.json?.forYou, `${own.text.slice(0, 120)} | ${afterOwn.text.slice(0, 120)}`);

  // The save nudge: 10 writes without a save_state
  await must(cc, 'save_state', { project: NAME, ops: [{ op: 'add_decision', text: 'reset the count' }], session: s1 });
  const nudges = [];
  for (let i = 1; i <= 10; i++) {
    const w = await mcpH(cc, 'add_task', { title: `Write ${i}`, project: NAME }, { 'x-work-os-session': s1 });
    nudges.push(w.json?.forYou?.find(l => /State not saved/.test(l)) ?? null);
  }
  check('H1: the 10th write since the last save is told "State not saved since 10 writes", the ones before are not', nudges.slice(0, 9).every(x => !x) && /State not saved since 10 writes/.test(nudges[9] ?? ''), JSON.stringify(nudges));
  await must(cc, 'save_state', { project: NAME, ops: [{ op: 'add_decision', text: 'saved again' }], session: s1 });
  const w1 = await mcpH(cc, 'add_task', { title: 'After the save', project: NAME }, { 'x-work-os-session': s1 });
  check('H1: save_state resets the count', !w1.json?.forYou, w1.text.slice(0, 200));

  // Another person's key is its own session: the cursor is per session row
  const T = await makeUser({ email: 'tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess CC' });
  const tg = await mcpH(kT, 'get_state', { project: NAME });
  check('H1: someone who did not start work on the project gets no forYou', tg.json && !('forYou' in tg.json), tg.text.slice(0, 200));
  const ts = (await must(kT, 'start_work', { project: NAME, label: 'tess' })).session;
  await must(MCP, 'add_task', { title: 'For both of them', project: NAME });
  const tseen = await mcpH(kT, 'get_state', { project: NAME, session: ts });
  const oseen = await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  check('H1: each present session is told once, separately', tseen.json?.forYou?.some(l => /new task/.test(l)) && oseen.json?.forYou?.some(l => /new task/.test(l)), `${tseen.text.slice(0, 100)} | ${oseen.text.slice(0, 100)}`);

  // A teammate's task made while this session's own write call runs is not skipped by the cursor
  await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  await mcpH(kT, 'get_state', { project: NAME, session: ts });
  let missed = 0;
  for (let i = 0; i < 6; i++) {
    const [mine, theirs] = await Promise.all([mcpH(cc, 'add_task', { title: `Race mine ${i}`, project: NAME }, { 'x-work-os-session': s1 }), mcpH(kT, 'add_task', { title: `Race theirs ${i}`, project: NAME })]);
    const seen = [mine.json?.forYou, (await mcpH(cc, 'get_state', { project: NAME, session: s1 })).json?.forYou].flat().filter(Boolean).join(' ');
    if (!seen.includes('#' + theirs.json.created.ref)) missed++;
    await mcpH(kT, 'get_state', { project: NAME, session: ts });
  }
  check('H1: a teammate’s task made during the session’s own write call is still named (6 races, none skipped)', missed === 0, String(missed));

  // Presence refresh is at most once a minute per row, and presence is not a push topic
  await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  const row = await rawDb.collection('presence').findOne({ userId: ME.userId, session: s1 });
  for (let i = 0; i < 5; i++) await mcpH(cc, 'get_state', { project: NAME, session: s1 });
  const row2 = await rawDb.collection('presence').findOne({ userId: ME.userId, session: s1 });
  check('H1: lastSeen is refreshed at most once a minute (five quick reads change nothing)', Date.now() - row.lastSeen.getTime() > 55_000 || row2.lastSeen.getTime() === row.lastSeen.getTime(), `${row.lastSeen.toISOString()} ${row2.lastSeen.toISOString()}`);
  const src = (await import('node:fs')).readFileSync(new URL('../../lib/scope.ts', import.meta.url), 'utf8');
  const topics = src.slice(src.indexOf('const TOPICS'), src.indexOf('const WRITES'));
  check('H1: presence is not among the push-hint topics (no page refresh from a heartbeat)', !/presence/.test(topics) && /states:/.test(topics));
  void project;
} catch (e) {
  check('flow-h1 (error)', false, e?.stack || String(e));
}
await finish();
