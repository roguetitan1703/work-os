// Flow MS4 (docs/flows/step-1.md "Tests", rewritten for Identity step 6: the project Inbox tab is gone, messages for a person show on
// Claude › Now under Messages for you): a message reaches the one it is for labelled with who wrote it, its word and what to do with it;
// a teammate's message to Om shows under Messages for you (1280 and 390, light and dark): the project and who it is from, Reply (word
// person, back to the sender's session, same thread), Apply a decision (it lands in Decisions), Reject, Make a task from a request.
// Messages between Om's own sessions never show there. Seed profile: none.
import { ME, MCP, B, SP, check, finish, launch, login, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Messages UI';
const OM = 'E2E Owner';
// 20 Nov: send_message to a person goes to their lead session, never to Messages for you. The app list stays for messages stored before
// that (toUser): these are sent the new way and then turned into that old form, so the list and its buttons are still tested.
const asOld = async r => {
  await rawDb.collection('messages').updateOne({ _id: r.id }, { $set: { toUser: ME.userId }, $unset: { toSids: '', toSession: '' } });
  return r;
};
try {
  const T = await makeUser({ email: 'tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached for a minute
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-messages-ui' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Messages Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  const omS = (await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'om session' })).session;
  const tS = (await must(kT, 'start_work', { project: NAME, machine: 'tess-pc', label: 'tess session' })).session;

  // What a session is told: the sender's word and what to do with it
  const own = await must(MCP, 'send_message', { to: omS, kind: 'request', body: 'My own chat request' });
  check('MS4: a static Claude chat key message is stored as agent, not chat', (await rawDb.collection('messages').findOne({ _id: own.id })).from.word === 'agent');
  await rawDb.collection('messages').updateOne({ _id: own.id }, { $set: { 'from.word': 'chat' } }); // as if it came through the claude.ai connector (OAuth)
  const prop = await must(cc, 'send_message', { to: omS, kind: 'question', body: 'An agent question' });
  const sw = await must(cc, 'start_work', { project: NAME, label: 'om session', session: omS });
  const byId = Object.fromEntries(sw.inbox.messages.map(m => [m.id, m]));
  check('MS4: Om own chat message is an instruction for ordinary work, never an approval', /instruction from your person/.test(byId[own.id].treat) && /never approves/.test(byId[own.id].treat) && !byId[own.id].writtenBy, JSON.stringify(byId[own.id]));
  check('MS4: Om own agent message is a proposal', /^A proposal/.test(byId[prop.id].treat), byId[prop.id].treat);

  // A teammate's message to Om (a person): Om's chat reads it labelled as theirs; it is not for any of Om's sessions
  const tm = await must(kT, 'send_message', { to: OM, project: NAME, kind: 'fyi', body: 'Tess here: the staging key rotated', session: tS });
  check('MS4: a teammate message to Om goes to his lead session on the project (one key), not to the app', JSON.stringify((await rawDb.collection('messages').findOne({ _id: tm.id })).toSids) === JSON.stringify([`${ME.userId}:${omS}`]));
  await asOld(tm);
  const tmRead = await must(MCP, 'message_status', { id: tm.id });
  check('MS4: a teammate message reaches Om with word agent, labelled with their name, as information', tmRead.message.writtenBy === 'Tess' && tmRead.message.word === 'agent' && /^Information from Tess/.test(tmRead.message.treat) && tmRead.message.from.name === 'Tess', JSON.stringify(tmRead.message));
  const swAfter = await must(cc, 'start_work', { project: NAME, label: 'om session', session: omS });
  check('MS4: …and none of Om’s sessions is handed it (it is for Om, in the app)', !JSON.stringify(swAfter.inbox).includes(tm.id), JSON.stringify(swAfter.inbox).slice(0, 200));
  const long = 'L'.repeat(1200);
  const forOm = await asOld(await must(kT, 'send_message', { to: OM, project: NAME, kind: 'fyi', body: long, session: tS }));
  const tessReads = await must(kT, 'message_status', { id: forOm.id, session: tS });
  check('MS4: the sender reading her own message does not mark it read, and sees her own session id', (await rawDb.collection('messages').findOne({ _id: forOm.id })).status === 'unread' && !!tessReads.message.from.session, JSON.stringify(tessReads.message.from));
  const omReads = await must(MCP, 'message_status', { id: forOm.id });
  check('MS4: Om reads all of it, and another person’s session id is not shown to him', omReads.message.body.length === 1200 && !omReads.message.from.session, JSON.stringify(omReads.message.from));
  const longToSession = await must(MCP, 'send_message', { to: omS, kind: 'fyi', body: long });
  const swCut = await must(cc, 'start_work', { project: NAME, label: 'om session', session: omS });
  const cutBody = swCut.inbox.messages.find(m => m.id === longToSession.id).body;
  check('MS4: start_work cuts long bodies and says how to read the rest with message_status', cutBody.length < 600 && /read the rest with message_status/.test(cutBody), String(cutBody.length));
  check('MS4: the old inbox tool is gone', (await mcpH(cc, 'inbox', { project: NAME })).isError);

  const br = await launch();
  for (const phone of [false, true]) {
    for (const scheme of ['light', 'dark']) {
      const tag = `${phone ? '390' : '1280'}-${scheme}`;
      const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: scheme } : { viewport: { width: 1280, height: 800 }, colorScheme: scheme });
      const p = await ctx.newPage();
      await login(p, { phone, next: '/claude?tab=now' });
      // The set for this pass: a teammate's decision, request and fyi, each from her session; plus one between Om's own sessions that must not show
      const dm = await asOld(await must(kT, 'send_message', { to: OM, project: NAME, kind: 'decision', body: `Use the new queue (${tag})`, session: tS }));
      const rq = await asOld(await must(kT, 'send_message', { to: OM, project: NAME, kind: 'request', body: `Please add the export button (${tag})`, session: tS }));
      const fy = await asOld(await must(kT, 'send_message', { to: OM, project: NAME, kind: 'fyi', body: `Tess again (${tag})`, session: tS }));
      const ownMsg = await must(cc, 'send_message', { to: omS, kind: 'fyi', body: `Between my own sessions (${tag})` });
      await p.goto(`${B}/claude?tab=now`);
      const sec = p.locator('[data-section=messages-for-you]');
      await sec.waitFor({ timeout: 20000 });
      check(`MS4 app (${tag}): Messages for you lists the teammate messages, one row each, with who and the project`, (await sec.locator('[data-message-for-you]').count()) >= 3 && (await sec.locator(`[data-message-for-you="${dm.id}"]`).innerText()).includes('Tess') && (await sec.locator(`[data-message-for-you="${dm.id}"]`).innerText()).includes(NAME), (await sec.innerText()).slice(0, 300));
      check(`MS4 app (${tag}): a message between Om’s own sessions is not there`, (await p.locator(`[data-message-for-you="${ownMsg.id}"]`).count()) === 0 && !(await p.content()).includes('Between my own sessions'));
      check(`MS4 app (${tag}): no sideways scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await p.screenshot({ path: `${SP}/ms4-${tag}-messages.png` });

      // Reply: word person, back to Tess's session, same thread
      const drow = sec.locator(`[data-message-for-you="${dm.id}"]`);
      await drow.locator('button').first().click();
      await drow.locator('[data-msg-body]').waitFor({ timeout: 10000 });
      check(`MS4 app (${tag}): opening a row shows the text, how it came and Apply, Reject, Reply (a decision has no Make a task)`, (await drow.locator('[data-msg-apply]').count()) === 1 && (await drow.locator('[data-msg-reject]').count()) === 1 && (await drow.locator('[data-msg-reply-input]').count()) === 1 && (await drow.locator('[data-msg-task]').count()) === 0 && /through a Claude session/.test(await drow.locator('[data-msg-via]').innerText()));
      await p.screenshot({ path: `${SP}/ms4-${tag}-messages-open.png` });
      const text = `Reply from the app at ${tag}`;
      await drow.locator('[data-msg-reply-input]').fill(text);
      await drow.locator('[data-msg-reply]').click();
      let sent = null;
      for (let i = 0; i < 40 && !sent; i++) { sent = await rawDb.collection('messages').findOne({ body: text }); if (!sent) await new Promise(r => setTimeout(r, 250)); }
      check(`MS4 app (${tag}): Reply stores a message with word person, from the signed-in person, to Tess’s session, in the same thread`, sent?.from.word === 'person' && sent.from.userId === ME.userId && sent.thread === dm.id && JSON.stringify(sent.toSids) === JSON.stringify([`${T.userId}:${tS}`]), JSON.stringify([sent?.from, sent?.thread, sent?.toSids]));

      // Apply the decision: lands in Decisions with the message id, by the signed-in person
      await sec.locator(`[data-message-for-you="${dm.id}"] [data-msg-apply]`).click();
      await p.locator(`[data-message-for-you="${dm.id}"]`).waitFor({ state: 'detached', timeout: 15000 });
      const st = { decisions: await rawDb.collection('stateDecisions').find({ projectId: project._id }).sort({ at: 1 }).toArray() }; // decisions are rows of their own
      const dec = st.decisions.find(d => d.msg === dm.id);
      check(`MS4 app (${tag}): Apply adds the decision to the State with the message id, by the signed-in person, and the row goes away`, dec?.text === `Use the new queue (${tag})` && dec.by === ME.userId, JSON.stringify(st.decisions.slice(-1)));

      // Reject the fyi
      const frow = p.locator(`[data-message-for-you="${fy.id}"]`);
      await frow.locator('button').first().click();
      await frow.locator('[data-msg-reject]').click();
      await frow.waitFor({ state: 'detached', timeout: 15000 });
      const rj = await rawDb.collection('messages').findOne({ _id: fy.id });
      check(`MS4 app (${tag}): Reject closes it`, rj.status === 'rejected' && rj.statusBy === ME.userId, JSON.stringify([rj.status, rj.statusBy]));

      // Make a task from the request
      const rrow = p.locator(`[data-message-for-you="${rq.id}"]`);
      await rrow.locator('button').first().click();
      check(`MS4 app (${tag}): a request shows Make a task`, (await rrow.locator('[data-msg-task]').count()) === 1);
      await rrow.locator('[data-msg-task]').click();
      await rrow.waitFor({ state: 'detached', timeout: 15000 });
      const rd = await rawDb.collection('messages').findOne({ _id: rq.id });
      const task = rd.taskRef ? await rawDb.collection('tasks').findOne({ ref: rd.taskRef }) : null;
      check(`MS4 app (${tag}): Make a task creates the task in the project, labelled as Tess's words`, task?.projectId === project._id && task.title.startsWith('Please add the export button') && task.titleBy?.userId === T.userId, JSON.stringify([rd.taskRef, task?.title, task?.titleBy]));
      await ctx.close();
    }
  }
  await br.close();
} catch (e) {
  check('flow-ms4 (error)', false, e?.stack || String(e));
}
await finish();
