// Flow MS4 (docs/flows/step-1.md "Tests", rewritten for Identity step 6 and again on 21 Nov, when the personal inbox went): a message reaches the
// one it is for labelled with who wrote it, its word and what to do with it. There is no Messages for you: an old row stored for a person (toUser)
// shows on no page (Claude, Today, Menu; 1280 and 390, light and dark) and in no brief or message list. Seed profile: none.
import { ME, MCP, B, SP, check, finish, launch, login, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const NAME = 'Flow Messages UI';
const OM = 'E2E Owner';
// Messages stored before 20 Nov for a person carry toUser (no send makes one now): the same send, turned into that old form.
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
  const tmRead = await must(cc, 'message_status', { id: tm.id, session: omS });
  check('MS4: a teammate message reaches Om with word agent, labelled with their name, as information', tmRead.message.writtenBy === 'Tess' && tmRead.message.word === 'agent' && /^Information from Tess/.test(tmRead.message.treat) && tmRead.message.from.name === 'Tess', JSON.stringify(tmRead.message));
  const long = 'L'.repeat(1200);
  const forOm = (await must(kT, 'send_message', { to: OM, project: NAME, kind: 'fyi', body: long, session: tS }));
  const tessReads = await must(kT, 'message_status', { id: forOm.id, session: tS });
  check('MS4: the sender reading her own message does not mark it read, and sees her own session id', (await rawDb.collection('messages').findOne({ _id: forOm.id })).status === 'unread' && !!tessReads.message.from.session, JSON.stringify(tessReads.message.from));
  const omReads = await must(cc, 'message_status', { id: forOm.id, session: omS });
  check('MS4: Om reads all of it, and another person’s session id is not shown to him', omReads.message.body.length === 1200 && !omReads.message.from.session, JSON.stringify(omReads.message.from));
  const longToSession = await must(MCP, 'send_message', { to: omS, kind: 'fyi', body: long });
  const swCut = await must(cc, 'start_work', { project: NAME, label: 'om session', session: omS });
  const cutBody = swCut.inbox.messages.find(m => m.id === longToSession.id).body;
  check('MS4: start_work cuts long bodies and says how to read the rest with message_status', cutBody.length < 600 && /read the rest with message_status/.test(cutBody), String(cutBody.length));
  check('MS4: the old inbox tool is gone', (await mcpH(cc, 'inbox', { project: NAME })).isError);

  // An old inbox row (toUser) for Om, open: it shows on no page and in no brief or list
  const old = await asOld(await must(kT, 'send_message', { to: OM, project: NAME, kind: 'request', body: 'Old inbox row MARKER-OLD-INBOX', session: tS }));
  const oldDoc = await rawDb.collection('messages').findOne({ _id: old.id });
  check('MS4: the old row is in the database as an open message for a person', oldDoc.toUser === ME.userId && oldDoc.status === 'unread', JSON.stringify([oldDoc.toUser, oldDoc.status]));
  const swOld = await must(cc, 'start_work', { project: NAME, label: 'om session', session: omS });
  check('MS4: a toUser message is in no start_work brief', !JSON.stringify(swOld).includes('MARKER-OLD-INBOX') && !JSON.stringify(swOld).includes(old.id), JSON.stringify(swOld.inbox).slice(0, 200));
  const swChat = await must(MCP, 'start_work', { project: NAME });
  check('MS4: …nor in a chat brief (a session with no row of its own)', !JSON.stringify(swChat).includes('MARKER-OLD-INBOX') && !JSON.stringify(swChat).includes(old.id), JSON.stringify(swChat.inbox).slice(0, 200));
  const stOld = await must(MCP, 'message_status', {});
  check('MS4: …nor in message_status with no id', !JSON.stringify(stOld).includes(old.id), JSON.stringify(stOld).slice(0, 200));

  const br = await launch();
  for (const phone of [false, true]) {
    for (const scheme of ['light', 'dark']) {
      const tag = `${phone ? '390' : '1280'}-${scheme}`;
      const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: scheme } : { viewport: { width: 1280, height: 800 }, colorScheme: scheme });
      const p = await ctx.newPage();
      await login(p, { phone, next: '/claude' });
      for (const path of ['/claude', '/today', '/menu', '/projects', '/needs']) {
        await p.goto(`${B}${path}`, { waitUntil: 'networkidle' });
        const html = await p.content();
        check(`MS4 app (${tag}) ${path}: the old inbox row and the Messages for you card are nowhere`, !html.includes('MARKER-OLD-INBOX') && !html.includes('Messages for you') && (await p.locator('[data-section=messages-for-you]').count()) === 0);
      }
      await p.goto(`${B}/claude`, { waitUntil: 'networkidle' });
      check(`MS4 app (${tag}): Claude still lists sessions, no sideways scroll`, (await p.locator('[data-section=sessions]').count()) === 1 && (await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
      await p.screenshot({ path: `${SP}/ms4-${tag}-claude.png` });
      await ctx.close();
    }
  }
  await br.close();
} catch (e) {
  check('flow-ms4 (error)', false, e?.stack || String(e));
}
await finish();
