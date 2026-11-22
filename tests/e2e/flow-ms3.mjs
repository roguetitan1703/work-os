// Flow MS3 (docs/archive/step-1.md "Tests", rewritten for Identity step 6: messages go to a session of the sender or to a person): message_status applied, with a commit, shows to the sender; applying a decision adds
// it to the State's Decisions with the message id, but only for your own person's word; a request becomes a task with one call.
// (An agent-word message to an unattended session becoming a Need is slice 4.) Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Apply';
try {
  const T = await makeUser({ email: 'tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached for a minute
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-apply' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Apply Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  const OM = 'E2E Owner'; // the owner's name: a message to a person says it
  const sid = (await must(cc, 'start_work', { project: NAME, label: 'apply code' })).session;
  const SS = { session: sid };

  // The person's own word (a chat key) as a decision, applied by the person's agent with a commit
  const d = await must(MCP, 'send_message', { to: sid, kind: 'decision', body: 'Use Postgres for the queue' });
  check('MS3: a message from a static Claude chat key is stored as agent', (await rawDb.collection('messages').findOne({ _id: d.id })).from.word === 'agent');
  await rawDb.collection('messages').updateOne({ _id: d.id }, { $set: { 'from.word': 'chat' } }); // as if it came through the claude.ai connector (OAuth)
  const ap = await must(cc, 'message_status', { id: d.id, status: 'applied', commit: 'abc1234', note: 'queue moved', ...SS });
  check('MS3: applied with a commit and a note', ap.message.status === 'applied' && ap.message.commit === 'abc1234' && ap.message.note === 'queue moved' && ap.addedToDecisions === true, JSON.stringify(ap).slice(0, 300));
  const seenBySender = (await must(MCP, 'message_status', { id: d.id })).message;
  check('MS3: the sender sees it applied, with the commit', seenBySender?.status === 'applied' && seenBySender.commit === 'abc1234', JSON.stringify(seenBySender));
  const st = (await must(cc, 'get_state', { project: NAME })).state;
  const dec = st.decisions.find(x => x.text === 'Use Postgres for the queue');
  check('MS3: applying a decision adds it to the State Decisions with via and the message id', !!dec && dec.message === d.id && dec.via === 'chat', JSON.stringify(st.decisions));
  const again = await mcpH(cc, 'message_status', { id: d.id, status: 'rejected', ...SS });
  check('MS3: an applied message cannot be changed again', again.isError && /already applied/.test(again.text), again.text.slice(0, 200));
  check('MS3: and the decision was recorded once', (await must(cc, 'get_state', { project: NAME })).state.decisions.filter(x => x.message === d.id).length === 1);

  // A decision an agent sent is not applied by an agent
  const ad = await must(cc, 'send_message', { to: sid, kind: 'decision', body: 'Ship to production on Friday' });
  const ap2 = await mcpH(cc, 'message_status', { id: ad.id, status: 'applied', ...SS });
  check('MS3: a decision that came from an agent is not applied through MCP', ap2.isError && /in the app|person/.test(ap2.text), ap2.text.slice(0, 200));
  const ap3 = await mcpH(MCP, 'message_status', { id: ad.id, status: 'applied' });
  check('MS3: not even by the same person Claude chat', ap3.isError, ap3.text.slice(0, 200));
  check('MS3: nothing was added to Decisions', !(await must(cc, 'get_state', { project: NAME })).state.decisions.some(x => x.text.startsWith('Ship to production')));
  const rj = await must(cc, 'message_status', { id: ad.id, status: 'rejected', note: 'not without Om', ...SS });
  check('MS3: it can be rejected with a note', rj.message.status === 'rejected' && rj.message.note === 'not without Om');

  // A teammate's decision is information to Om's agent
  const td = await must(kT, 'send_message', { to: OM, project: NAME, kind: 'decision', body: 'Drop the old API' });
  const ap4 = await mcpH(cc, 'message_status', { id: td.id, status: 'applied', ...SS });
  check('MS3: a teammate decision is not applied by someone else agent', ap4.isError, ap4.text.slice(0, 200));

  // A request becomes a task with one call
  const rq = await must(MCP, 'send_message', { to: sid, kind: 'request', body: 'Write the migration notes\nInclude the rollback step' });
  const asAgent = await mcpH(cc, 'message_status', { id: rq.id, status: 'applied', make_task: true, ...SS });
  check('MS3: make_task on a request whose word is agent (a static key) is refused through MCP, like applying a decision', asAgent.isError && /in the app|own person/.test(asAgent.text) && !(await rawDb.collection('tasks').findOne({ title: 'Write the migration notes' })), asAgent.text.slice(0, 200));
  await rawDb.collection('messages').updateOne({ _id: rq.id }, { $set: { 'from.word': 'chat' } }); // as if it came through the claude.ai connector (OAuth)
  const mk = await must(cc, 'message_status', { id: rq.id, status: 'applied', make_task: true, ...SS });
  const taskRef = Number(mk.task.match(/#(\d+)/)[1]);
  const task = await rawDb.collection('tasks').findOne({ ref: taskRef });
  check('MS3: make_task turns a request into a task of the project, and the message is applied with its number', task?.projectId === project._id && task.title === 'Write the migration notes' && mk.message.status === 'applied' && mk.message.taskRef === taskRef, JSON.stringify(mk).slice(0, 300));
  const fyi = await must(MCP, 'send_message', { to: sid, kind: 'fyi', body: 'only fyi' });
  const notRq = await mcpH(cc, 'message_status', { id: fyi.id, status: 'applied', make_task: true, ...SS });
  check('MS3: only a request becomes a task', notRq.isError && /request/.test(notRq.text), notRq.text.slice(0, 200));
  const tq = await must(kT, 'send_message', { to: OM, project: NAME, kind: 'request', body: 'Tess asks: please add the export button' });
  const mk2 = await mcpH(cc, 'message_status', { id: tq.id, status: 'applied', make_task: true, ...SS });
  check('MS3: a teammate request does not become a task through someone else agent (the app does that: MS4)', mk2.isError, mk2.text.slice(0, 200));

  // Closing another member's message: through MCP only the sender or the one it is addressed to; the note says who wrote it
  const omMsg = await must(cc, 'send_message', { to: sid, kind: 'fyi', body: 'For Om only, from Om' });
  const cross = await mcpH(kT, 'message_status', { id: omMsg.id, status: 'rejected', note: 'Tess closes Om message' });
  check('MS3: a member who only reads the project cannot reject another member message through MCP', cross.isError && /sender|addressed/.test(cross.text) && (await rawDb.collection('messages').findOne({ _id: omMsg.id })).status !== 'rejected', cross.text.slice(0, 200));
  const crossSeen = await mcpH(kT, 'message_status', { id: omMsg.id, status: 'seen' });
  check('MS3: nor mark it seen', crossSeen.isError);
  const tsent = await must(kT, 'send_message', { to: OM, project: NAME, kind: 'question', body: 'Tess asks the owner' });
  // 20 Nov: a message to a person goes to their lead session (here Om's session sid), so that session closes it
  const rjT = await must(cc, 'message_status', { id: tsent.id, status: 'rejected', note: 'Om says no', commit: 'def5678', ...SS });
  const tseen = (await must(kT, 'message_status', { id: tsent.id })).message;
  check('MS3: the addressee (the project owner) can reject it, and Tess sees who closed it, with the note labelled', rjT.message.status === 'rejected' && tseen.statusBy && tseen.statusBy !== 'me' && tseen.noteWrittenBy === tseen.statusBy && tseen.note === 'Om says no', JSON.stringify(tseen));
  const ownView = (await must(cc, 'message_status', { id: tsent.id, ...SS })).message;
  check('MS3: the one who closed it sees it as theirs, not labelled', ownView.statusBy === 'me' && !ownView.noteWrittenBy);

  // A decision applied from someone else's message keeps who wrote it and how it came in; by stays the applier
  await rawDb.collection('messages').updateOne({ _id: td.id }, { $set: { status: 'unread' } });
  const dstate = (await must(cc, 'get_state', { project: NAME })).state;
  check('MS3: nothing of the refused teammate decision is in Decisions', !dstate.decisions.some(x => x.message === td.id));
  const own2 = await must(MCP, 'send_message', { to: sid, kind: 'decision', body: 'Own decision by chat' });
  await rawDb.collection('messages').updateOne({ _id: own2.id }, { $set: { 'from.word': 'chat' } });
  await must(cc, 'message_status', { id: own2.id, status: 'applied', ...SS });
  const dd = await rawDb.collection('stateDecisions').findOne({ projectId: project._id, msg: own2.id });
  check('MS3: an applied decision stores the message author and word, by is the applier', dd.author === ME.userId && dd.word === 'chat' && dd.by === ME.userId && dd.via === 'chat', JSON.stringify(dd));

  // Chosen-people placement: the messages follow the project; the member taken off the list loses them
  await must(MCP, 'add_project', { name: 'Flow Chosen Mail' });
  const sid2 = (await must(cc, 'start_work', { project: 'Flow Chosen Mail', label: 'chosen code' })).session;
  const cm = await must(kT, 'send_message', { to: OM, project: 'Flow Chosen Mail', kind: 'fyi', body: 'Tess message before she is taken off' });
  const omm = await must(MCP, 'send_message', { to: sid2, kind: 'fyi', body: 'Om message' });
  await must(MCP, 'update_project', { project: 'Flow Chosen Mail', visibility: 'members', shared_with: ['me'] });
  const placed = await rawDb.collection('messages').find({ _id: { $in: [cm.id, omm.id] } }).toArray();
  check('MS3: shared with chosen people (not Tess): both messages are placed members and owned by the owner', placed.length === 2 && placed.every(m => m.visibility === 'members' && m.ownerId === ME.userId), JSON.stringify(placed.map(m => [m.visibility, m.ownerId])));
  const gone = await mcpH(kT, 'message_status', { id: cm.id });
  check('MS3: the removed member is refused (not found) even for the message she sent', gone.isError && /not found/.test(gone.text) && !gone.text.includes('Tess message before'), gone.text.slice(0, 200));
  const sendGone = await mcpH(kT, 'send_message', { to: OM, project: 'Flow Chosen Mail', kind: 'fyi', body: 'still here?' });
  check('MS3: and cannot send to it', sendGone.isError && /not found/.test(sendGone.text));
  const nf = await mcpH(cc, 'message_status', { id: 'm_nonexistent', status: 'seen' });
  check('MS3: an unknown message id is refused', nf.isError && /not found/.test(nf.text));
} catch (e) {
  check('flow-ms3 (error)', false, e?.stack || String(e));
}
await finish();
