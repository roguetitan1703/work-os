// Flow MS4 (docs/flows/step-1.md "Tests"): a teammate's message reaches Om's session labelled as theirs, with word and what to do
// with it; the Inbox tab in the app (1280 and 390): the thread, Send (word person), Apply a decision (it lands in Decisions),
// Reject with a note, Make a task from a request. Seed profile: none.
import { ME, MCP, B, check, finish, launch, login, makeUser, mkKey, pick, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const NAME = 'Flow Inbox UI';
try {
  const T = await makeUser({ email: 'tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached for a minute
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/flow-inbox-ui' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Inbox Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  await must(cc, 'start_work', { project: NAME, machine: 'laptop', label: 'om session' });

  const tm = await must(kT, 'send_message', { project: NAME, kind: 'fyi', body: 'Tess here: the staging key rotated' });
  const own = await must(MCP, 'send_message', { project: NAME, kind: 'request', body: 'My own chat request' });
  check('MS4: a static Claude chat key message is stored as agent, not chat', (await rawDb.collection('messages').findOne({ _id: own.id })).from.word === 'agent');
  await rawDb.collection('messages').updateOne({ _id: own.id }, { $set: { 'from.word': 'chat' } }); // as if it came through the claude.ai connector (OAuth)
  const prop = await must(cc, 'send_message', { project: NAME, kind: 'question', body: 'An agent question' });
  const inb = await must(cc, 'inbox', { project: NAME });
  const byId = Object.fromEntries(inb.messages.map(m => [m.id, m]));
  check('MS4: a teammate message reaches Om with word agent, labelled with their name, as information', byId[tm.id].writtenBy === 'Tess' && byId[tm.id].word === 'agent' && /^Information from Tess/.test(byId[tm.id].treat) && byId[tm.id].from.name === 'Tess', JSON.stringify(byId[tm.id]));
  check('MS4: Om own chat message is an instruction for ordinary work, never an approval', /instruction from your person/.test(byId[own.id].treat) && /never approves/.test(byId[own.id].treat) && !byId[own.id].writtenBy, JSON.stringify(byId[own.id]));
  check('MS4: Om own agent message is a proposal', /^A proposal/.test(byId[prop.id].treat), byId[prop.id].treat);
  // Seen is for the one it is addressed to: another reader's inbox and start_work leave it alone; a session id is not shown to others
  const long = 'L'.repeat(1200);
  const forOm = await must(kT, 'send_message', { project: NAME, kind: 'fyi', body: long, session: 'tess-session-1' });
  const tessSeesOwn = await must(kT, 'inbox', { project: NAME });
  const omMsgNote = await must(MCP, 'send_message', { project: NAME, kind: 'fyi', body: 'For Om from Om, not for Tess' });
  await must(kT, 'start_work', { project: NAME, label: 'tess' });
  await must(kT, 'inbox', { project: NAME });
  check('MS4: a message to the project owner stays unread when another member reads the inbox or starts work', (await rawDb.collection('messages').findOne({ _id: omMsgNote.id })).status === 'unread');
  const omSeesTess = (await must(cc, 'inbox', { project: NAME })).messages.find(m => m.id === forOm.id);
  check('MS4: the owner reading it marks it seen, and another person’s session id is not shown to them', (await rawDb.collection('messages').findOne({ _id: forOm.id })).status === 'seen' && !omSeesTess.from.session && !!tessSeesOwn.messages.find(m => m.id === forOm.id).from.session, JSON.stringify(omSeesTess.from));
  const swCut = await must(cc, 'start_work', { project: NAME, label: 'om cut check' });
  const cutBody = swCut.inbox.messages.find(m => m.id === forOm.id).body;
  check('MS4: start_work cuts long bodies and says how to read the rest; inbox has all of it', cutBody.length < 600 && /read the rest with inbox/.test(cutBody) && omSeesTess.body.length === 1200, String(cutBody.length));
  const sw = await must(cc, 'start_work', { project: NAME, label: 'om second session' });
  check('MS4: start_work lists the teammate message labelled', sw.inbox.messages.some(m => m.id === tm.id && m.writtenBy === 'Tess'), JSON.stringify(sw.inbox).slice(0, 300));

  const br = await launch();
  for (const phone of [false, true]) {
    const tag = phone ? '390' : '1280';
    const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await login(p, { phone, next: '/today' });
    await p.goto(`${B}/projects/${project._id}`);
    check(`MS4 app (${tag}): the project page has an Inbox tab`, (await p.locator('[data-tab=inbox]').count()) === 1);
    await p.locator('[data-tab=inbox]').click();
    const view = p.locator('[data-view=inbox]');
    await view.waitFor({ timeout: 20000 });
    check(`MS4 app (${tag}): the Inbox lists the messages, the teammate one says who`, (await view.locator('[data-msg-id]').count()) >= 3 && (await view.locator(`[data-msg-id="${tm.id}"]`).innerText()).includes('Tess'), (await view.innerText()).slice(0, 200));
    const noX = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`MS4 app (${tag}): no sideways scroll`, noX);

    // Send a decision from the app: word person
    const text = `Decision from the app at ${tag}`;
    await pick(view, '[data-inbox-kind]', 'decision');
    await view.locator('[data-inbox-body]').fill(text);
    await view.locator('[data-inbox-send]').click();
    await view.locator('[data-msg-id]', { hasText: text }).waitFor({ timeout: 15000 });
    const sent = await rawDb.collection('messages').findOne({ body: text });
    check(`MS4 app (${tag}): Send stores it with word person, kind decision, from the signed-in person`, sent?.from.word === 'person' && sent.from.userId === ME.userId && sent.kind === 'decision', JSON.stringify(sent?.from));
    // Apply it: lands in Decisions with via app and the message id
    await view.locator(`[data-msg-id="${sent._id}"] [data-msg-apply]`).click();
    await view.locator(`[data-msg-id="${sent._id}"][data-msg-status=applied]`).waitFor({ timeout: 15000 });
    const st = await rawDb.collection('states').findOne({ _id: project._id });
    const dec = st.decisions.find(d => d.msg === sent._id);
    check(`MS4 app (${tag}): Apply adds the decision to the State with via app and the message id`, dec?.text === text && dec.via === 'app' && dec.by === ME.userId, JSON.stringify(st.decisions.slice(-1)));
    // Reject the teammate's with a note
    const tmsg = await must(kT, 'send_message', { project: NAME, kind: 'fyi', body: `Tess again at ${tag}` });
    await p.reload();
    const row = p.locator(`[data-msg-id="${tmsg.id}"]`);
    await row.waitFor({ timeout: 15000 });
    await row.locator('input[aria-label=Note]').fill('not relevant');
    await row.locator('[data-msg-reject]').click();
    await p.locator(`[data-msg-id="${tmsg.id}"][data-msg-status=rejected]`).waitFor({ timeout: 15000 });
    const rj = await rawDb.collection('messages').findOne({ _id: tmsg.id });
    check(`MS4 app (${tag}): Reject saves the note`, rj.status === 'rejected' && rj.note === 'not relevant' && rj.statusBy === ME.userId, JSON.stringify([rj.status, rj.note]));
    // Make a task from a request
    const rq = await must(kT, 'send_message', { project: NAME, kind: 'request', body: `Please add the export button (${tag})` });
    await p.reload();
    const rrow = p.locator(`[data-msg-id="${rq.id}"]`);
    await rrow.waitFor({ timeout: 15000 });
    await rrow.locator('[data-msg-task]').click();
    await p.locator(`[data-msg-id="${rq.id}"][data-msg-status=applied]`).waitFor({ timeout: 15000 });
    const rd = await rawDb.collection('messages').findOne({ _id: rq.id });
    const task = rd.taskRef ? await rawDb.collection('tasks').findOne({ ref: rd.taskRef }) : null;
    check(`MS4 app (${tag}): Make a task creates the task in the project, labelled as Tess's words`, task?.projectId === project._id && task.title.startsWith('Please add the export button') && task.titleBy?.userId === T.userId, JSON.stringify([rd.taskRef, task?.title, task?.titleBy]));
    check(`MS4 app (${tag}): a request shows Make a task, a fyi does not`, (await p.locator(`[data-msg-id="${rq.id}"]`).count()) === 1 && (await p.locator(`[data-msg-id="${tm.id}"] [data-msg-task]`).count()) === 0);
    await ctx.close();
  }
  await br.close();
} catch (e) {
  check('flow-ms4 (error)', false, e?.stack || String(e));
}
await finish();
