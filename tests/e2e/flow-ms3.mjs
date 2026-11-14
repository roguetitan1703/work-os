// Flow MS3 (docs/flows/step-1.md "Tests"): message_status applied, with a commit, shows to the sender; applying a decision adds
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

  // The person's own word (a chat key) as a decision, applied by the person's agent with a commit
  const d = await must(MCP, 'send_message', { project: NAME, kind: 'decision', body: 'Use Postgres for the queue' });
  const ap = await must(cc, 'message_status', { id: d.id, status: 'applied', commit: 'abc1234', note: 'queue moved' });
  check('MS3: applied with a commit and a note', ap.message.status === 'applied' && ap.message.commit === 'abc1234' && ap.message.note === 'queue moved' && ap.addedToDecisions === true, JSON.stringify(ap).slice(0, 300));
  const seenBySender = (await must(MCP, 'inbox', { project: NAME, status: 'applied' })).messages.find(m => m.id === d.id);
  check('MS3: the sender sees it applied, with the commit', seenBySender?.status === 'applied' && seenBySender.commit === 'abc1234', JSON.stringify(seenBySender));
  const st = (await must(cc, 'get_state', { project: NAME })).state;
  const dec = st.decisions.find(x => x.text === 'Use Postgres for the queue');
  check('MS3: applying a decision adds it to the State Decisions with via and the message id', !!dec && dec.message === d.id && dec.via === 'chat', JSON.stringify(st.decisions));
  const again = await mcpH(cc, 'message_status', { id: d.id, status: 'rejected' });
  check('MS3: an applied message cannot be changed again', again.isError && /already applied/.test(again.text), again.text.slice(0, 200));
  check('MS3: and the decision was recorded once', (await must(cc, 'get_state', { project: NAME })).state.decisions.filter(x => x.message === d.id).length === 1);

  // A decision an agent sent is not applied by an agent
  const ad = await must(cc, 'send_message', { project: NAME, kind: 'decision', body: 'Ship to production on Friday' });
  const ap2 = await mcpH(cc, 'message_status', { id: ad.id, status: 'applied' });
  check('MS3: a decision that came from an agent is not applied through MCP', ap2.isError && /in the app|person/.test(ap2.text), ap2.text.slice(0, 200));
  const ap3 = await mcpH(MCP, 'message_status', { id: ad.id, status: 'applied' });
  check('MS3: not even by the same person Claude chat', ap3.isError, ap3.text.slice(0, 200));
  check('MS3: nothing was added to Decisions', !(await must(cc, 'get_state', { project: NAME })).state.decisions.some(x => x.text.startsWith('Ship to production')));
  const rj = await must(cc, 'message_status', { id: ad.id, status: 'rejected', note: 'not without Om' });
  check('MS3: it can be rejected with a note', rj.message.status === 'rejected' && rj.message.note === 'not without Om');

  // A teammate's decision is information to Om's agent
  const td = await must(kT, 'send_message', { project: NAME, kind: 'decision', body: 'Drop the old API' });
  const ap4 = await mcpH(cc, 'message_status', { id: td.id, status: 'applied' });
  check('MS3: a teammate decision is not applied by someone else agent', ap4.isError, ap4.text.slice(0, 200));

  // A request becomes a task with one call
  const rq = await must(MCP, 'send_message', { project: NAME, kind: 'request', body: 'Write the migration notes\nInclude the rollback step' });
  const mk = await must(cc, 'message_status', { id: rq.id, status: 'applied', make_task: true });
  const taskRef = Number(mk.task.match(/#(\d+)/)[1]);
  const task = await rawDb.collection('tasks').findOne({ ref: taskRef });
  check('MS3: make_task turns a request into a task of the project, and the message is applied with its number', task?.projectId === project._id && task.title === 'Write the migration notes' && mk.message.status === 'applied' && mk.message.taskRef === taskRef, JSON.stringify(mk).slice(0, 300));
  const fyi = await must(MCP, 'send_message', { project: NAME, kind: 'fyi', body: 'only fyi' });
  const notRq = await mcpH(cc, 'message_status', { id: fyi.id, status: 'applied', make_task: true });
  check('MS3: only a request becomes a task', notRq.isError && /request/.test(notRq.text), notRq.text.slice(0, 200));
  const tq = await must(kT, 'send_message', { project: NAME, kind: 'request', body: 'Tess asks: please add the export button' });
  const mk2 = await must(cc, 'message_status', { id: tq.id, status: 'applied', make_task: true });
  const got = await must(cc, 'get_task', { task: Number(mk2.task.match(/#(\d+)/)[1]) });
  check('MS3: a teammate request becomes a task whose title is labelled with their name', /writtenBy/.test(JSON.stringify(got)) && /Tess/.test(JSON.stringify(got)), JSON.stringify(got).slice(0, 300));
  const nf = await mcpH(cc, 'message_status', { id: 'm_nonexistent', status: 'seen' });
  check('MS3: an unknown message id is refused', nf.isError && /not found/.test(nf.text));
} catch (e) {
  check('flow-ms3 (error)', false, e?.stack || String(e));
}
await finish();
