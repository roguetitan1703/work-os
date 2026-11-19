// Flow S1 (docs/flows/step-1.md "Tests"): two clients start work on the same project and get the same State version and
// Orders, and both show as present with their client names; an unknown remote returns candidates; the answer comes in the
// documented order; the session id and the header both identify a session; access to a project's State and presence.
// Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { markOrders, mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Alpha';
const REMOTE = 'acme/flow-alpha';
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: REMOTE }, { path: 'C:/code/flow-alpha' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  await must(MCP, 'add_task', { title: 'Wire the webhook', project: NAME, priority: 'P1' });

  // Orders in three layers (the flag is set in the app; there is no MCP tool for it, so the suite sets it directly)
  const org = (await must(MCP, 'write_note', { project: NAME, title: 'Organisation rules', body: 'Always run the tests before you say done.' })).created.id;
  const proj = (await must(MCP, 'write_note', { project: NAME, title: 'Project rules', body: 'Use the staging database only.' })).created.id;
  const mine = (await must(MCP, 'write_note', { project: NAME, title: 'My rules', body: 'Short answers please.' })).created.id;
  await markOrders(org, 'org');
  await markOrders(proj, 'project');
  await markOrders(mine, 'person');

  // State to share
  const saved = await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'add_next', text: 'Ship the brief' }, { op: 'add_decision', text: 'Use Mongo' }] });
  check('save_state: the first call makes the State at version 1 (one bump per call, however many ops)', saved.saved === true && saved.version === 1, JSON.stringify(saved).slice(0, 200));

  const cc = await mkKey({ agent: 'claude-code', name: 'Claude Code' });
  const ag = await mkKey({ agent: 'claude-code', name: 'Antigravity' });
  const a1 = await mustStart(cc, { path: 'C:/code/flow-alpha/web', remote: `https://github.com/${REMOTE}.git`, machine: 'laptop', label: 'cutroom prime, Opus, main' });
  const a2 = await mustStart(ag, { path: 'c:\\code\\Flow-Alpha', remote: `git@github.com:${REMOTE}.git`, machine: 'desktop', label: 'antigravity, gemini' });

  check('S1: both clients get the same State version', a1.stateVersion === a2.stateVersion && a1.stateVersion === 1, `${a1.stateVersion} ${a2.stateVersion}`);
  check('S1: both get the same Orders (organisation, project, person, in that order)', JSON.stringify(a1.orders) === JSON.stringify(a2.orders) && a1.orders.map(o => o.layer).join() === 'org,project,person', JSON.stringify(a1.orders).slice(0, 300));
  check('S1: the Orders text is there, written by the owner (no writtenBy on their own)', a1.orders[0].text.includes('Always run the tests') && !a1.orders.some(o => o.writtenBy), JSON.stringify(a1.orders));
  check('S1: the project matched by its folder (path, either slash form; the remote does not decide since H13)', a1.project.id === project._id && a2.project.id === project._id && a1.project.matchedBy, JSON.stringify(a1.project));
  check('S1: each gets its own session id', typeof a1.session === 'string' && a1.session.length >= 8 && a1.session !== a2.session, `${a1.session} ${a2.session}`);
  check('S1: the State comes with Next, Decisions and ids', a1.state.next.length === 1 && a1.state.next[0].id && a1.state.decisions.length === 1 && a1.state.decisions[0].text === 'Use Mongo', JSON.stringify(a1.state).slice(0, 300));
  check('S1: open tasks in brief', a1.openTasks.total === 1 && a1.openTasks.tasks[0].title === 'Wire the webhook', JSON.stringify(a1.openTasks));
  const keys = Object.keys(a1);
  const at = k => keys.indexOf(k);
  check('S1: the answer is in order: orders, state, open tasks, who else is here, version', at('orders') < at('state') && at('state') < at('openTasks') && at('openTasks') < at('alsoHere') && at('alsoHere') < at('stateVersion'), keys.join());
  check('S1: the second client sees the first as present, by client name', Array.isArray(a2.alsoHere) && a2.alsoHere.some(p => p.ai === 'Claude Code' && p.machine === 'laptop' && p.label.includes('cutroom prime')), JSON.stringify(a2.alsoHere));
  check('S1: the first client was alone when it started', typeof a1.alsoHere === 'string', JSON.stringify(a1.alsoHere));

  const again = await mustStart(cc, { project: NAME, session: a1.session, machine: 'laptop', label: 'cutroom prime, Opus, main' });
  check('S1: the first client now sees Antigravity present, and its own session id is kept', again.session === a1.session && again.alsoHere.some(p => p.ai === 'Antigravity'), JSON.stringify(again.alsoHere));

  const rows = await rawDb.collection('presence').find({ projectId: project._id }).toArray();
  check('S1: presence rows exist per session, with the client names', rows.length === 2 && rows.map(r => r.ai).sort().join() === 'Antigravity,Claude Code', JSON.stringify(rows.map(r => [r._id, r.ai])));
  check('S1: a presence row is stamped with the project placement', rows.every(r => r.orgId === ME.orgId && r.visibility === 'org' && r.projectId === project._id), JSON.stringify(rows[0]));

  // The session header names a session too (any kind of client), and a start made with one keeps that id
  const hdr = await mcpH(MCP, 'start_work', { project: NAME, machine: 'phone', label: 'claude chat' }, { 'x-work-os-session': 'chat-session-77' });
  check('S1: X-Work-OS-Session is the session id when no argument is given (a chat key too)', hdr.json?.session === 'chat-session-77' && !!(await rawDb.collection('presence').findOne({ userId: ME.userId, session: "chat-session-77" })), hdr.text.slice(0, 200));

  // An unknown remote returns candidates
  const un = await must(cc, 'start_work', { remote: 'github.com/nobody/never-heard-of-it', branch: 'main' });
  check('S1: an unknown remote returns unmatched with candidates and a hint', un.unmatched === true && Array.isArray(un.candidates) && un.candidates.length >= 1 && /start_work/.test(un.hint) && /not_work_os/.test(un.hint), JSON.stringify(un).slice(0, 300));
  check('S1: unmatched registers nobody as present', (await rawDb.collection('presence').countDocuments({})) === 3);

  // No project, no repo: an error that says what to give
  const none = await mcpH(cc, 'start_work', {});
  check('S1: start_work with nothing to go on says what to pass', none.isError && /project/.test(none.text), none.text.slice(0, 200));

  // A project nobody sees: refused like a made-up one, and nothing is registered
  const T = await makeUser({ email: 'tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Claude Code' });
  await must(MCP, 'add_project', { name: 'Flow Private', visibility: 'private' });
  const before = await rawDb.collection('presence').countDocuments({});
  const real = await mcpH(kT, 'start_work', { project: 'Flow Private' });
  const fake = await mcpH(kT, 'start_work', { project: 'Flow Nonexistent' });
  const strip = t => t.replace(/Flow (Private|Nonexistent)/g, 'X');
  check('S1: a teammate who cannot see a private project is refused like for a made-up one', real.isError && fake.isError && strip(real.text) === strip(fake.text), `${real.text} | ${fake.text}`);
  check('S1: the refused start made no presence row', (await rawDb.collection('presence').countDocuments({})) === before);
  const pub = await mustStart(kT, { project: NAME, machine: 'tess pc', label: 'tess' });
  check('S1: the teammate sees the shared project, and the owner sessions listed as the owner’s (labelled writtenBy)', pub.alsoHere.length >= 2 && pub.alsoHere.every(p => p.writtenBy && p.for !== 'me'), JSON.stringify(pub.alsoHere));
  check('S1: the teammate gets the organisation Orders as rules, the owner’s project Orders labelled as information, and not the owner’s person Orders', pub.orders.some(o => o.layer === 'org' && !o.writtenBy) && pub.orders.some(o => o.layer === 'project' && o.writtenBy) && !pub.orders.some(o => o.layer === 'person'), JSON.stringify(pub.orders).slice(0, 400));
} catch (e) {
  check('flow-s1 (error)', false, e?.stack || String(e));
}
await finish();

async function mustStart(key, args) {
  const r = await mcpH(key, 'start_work', args);
  if (r.isError) throw new Error(`start_work: ${r.text.slice(0, 400)}`);
  return r.json;
}
