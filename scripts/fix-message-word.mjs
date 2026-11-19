#!/usr/bin/env node
// Messages, Needs, Orders proposals and State decisions stamped "chat" that an agent made. Until Identity step 1 every OAuth key counted as a chat, so a message
// sent through Claude Code's own OAuth, or by any session (it carries a session id), was stamped "chat" and its reader was
// told it is "an instruction from your person". The rule now: chat only for the claude.ai connector with no session.
// This script sets word "agent" on the messages and Needs that do not fit it (and via "code" on State decisions, whose word is a via).
//
//   node scripts/fix-message-word.mjs --db <database>           dry run: counts what it would change
//   node scripts/fix-message-word.mjs --db <database> --apply   does it
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: it only touches records whose word is still "chat". Prints counts per collection only, never a body.
// A message is an agent's when it names a session, or when its key (oauth_<client>_<person>) belongs to an OAuth client
// that is not the claude.ai connector (a client with a redirect address other than claude.ai/claude.com), or whose client
// no longer exists and whose message has a label.
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const source = args.indexOf('--db') >= 0 && args[args.indexOf('--db') + 1] && !args[args.indexOf('--db') + 1].startsWith('--') ? args[args.indexOf('--db') + 1] : null;
const APPLY = args.includes('--apply');
const die = msg => {
  console.error(msg);
  process.exit(2);
};
if (!source) die('Name the database: node scripts/fix-message-word.mjs --db <database> [--apply]');
const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');
const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
const CLAUDE_CALLBACK = /^https:\/\/(claude\.ai|claude\.com)\/api\/mcp\/auth_callback$/;

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  const messages = db.collection('messages');
  const clients = new Map();
  const isChatClient = async clientId => {
    if (!clients.has(clientId)) {
      const c = await db.collection('oauthClient').findOne({ clientId }, { projection: { redirectUris: 1 } });
      const uris = Array.isArray(c?.redirectUris) ? c.redirectUris.map(String) : [];
      clients.set(clientId, c ? uris.length > 0 && uris.every(u => CLAUDE_CALLBACK.test(u)) : null);
    }
    return clients.get(clientId);
  };
  // One rule for what counts as an agent-made record: it names a session, or its key (oauth_<client>_<person>) belongs to an OAuth
  // client that is not the claude.ai connector, or whose client no longer exists and which has a label.
  const agentMade = async ({ session, keyId, label }) => {
    if (session) return 'session';
    const key = String(keyId ?? '');
    const clientId = key.startsWith('oauth_') ? key.slice('oauth_'.length, key.lastIndexOf('_')) : '';
    const chat = clientId ? await isChatClient(clientId) : false;
    return chat === false || (chat === null && label) ? 'client' : null;
  };
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);
  let total = 0;
  const report = (name, ids, bySession, byClient) => {
    total += ids.length;
    console.log(ids.length ? `  ${APPLY ? '✓' : '-'} ${ids.length} ${name}: word ${APPLY ? 'set' : 'would be set'} to agent (${bySession} with a session, ${byClient} from a client that is not the claude.ai connector)` : `  ${name}: nothing stamped chat wrongly.`);
  };

  // Messages
  {
    const ids = [];
    let bySession = 0;
    let byClient = 0;
    for await (const m of messages.find({ 'from.word': 'chat' }, { projection: { 'from.session': 1, 'from.keyId': 1, 'from.label': 1 } })) {
      const why = await agentMade(m.from ?? {});
      if (why === 'session') bySession++;
      else if (why === 'client') byClient++;
      else continue;
      ids.push(m._id);
    }
    if (APPLY && ids.length) await messages.updateMany({ _id: { $in: ids }, 'from.word': 'chat' }, { $set: { 'from.word': 'agent' } });
    report('messages', ids, bySession, byClient);
  }

  // Needs and Orders proposals (a proposal is a Need with an `order`): the same from.word
  {
    const needs = db.collection('needs');
    const plain = [];
    const props = [];
    const counts = { plain: [0, 0], props: [0, 0] };
    for await (const n of needs.find({ 'from.word': 'chat' }, { projection: { 'from.session': 1, 'from.keyId': 1, 'from.label': 1, order: 1 } })) {
      const why = await agentMade(n.from ?? {});
      if (!why) continue;
      const k = n.order ? 'props' : 'plain';
      (k === 'props' ? props : plain).push(n._id);
      counts[k][why === 'session' ? 0 : 1]++;
    }
    if (APPLY) for (const ids of [plain, props]) if (ids.length) await needs.updateMany({ _id: { $in: ids }, 'from.word': 'chat' }, { $set: { 'from.word': 'agent' } });
    report('Needs', plain, ...counts.plain);
    report('Orders proposals', props, ...counts.props);
  }

  // State decisions: via "chat" with the key that recorded them (a decision keeps no session id, so the client rule is the one that applies)
  {
    const states = db.collection('states');
    let found = 0;
    let byClient = 0;
    for await (const st of states.find({ 'decisions.via': 'chat' }, { projection: { decisions: 1 } })) {
      const ids = [];
      for (const d of st.decisions ?? []) {
        if (d.via !== 'chat' || !d.key) continue;
        if ((await agentMade({ keyId: d.key })) === 'client') ids.push(d.id);
      }
      if (!ids.length) continue;
      found += ids.length;
      byClient += ids.length;
      if (APPLY) await states.updateOne({ _id: st._id }, { $set: { 'decisions.$[d].via': 'code' } }, { arrayFilters: [{ 'd.via': 'chat', 'd.id': { $in: ids } }] });
    }
    total += found;
    console.log(found ? `  ${APPLY ? '✓' : '-'} ${found} State decisions: via ${APPLY ? 'set' : 'would be set'} to code (${byClient} from a client that is not the claude.ai connector)` : '  State decisions: nothing stamped chat wrongly.');
  }
  if (!total) console.log('\n  Nothing to do.');
} finally {
  await client.close();
}
