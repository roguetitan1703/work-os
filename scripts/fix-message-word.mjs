#!/usr/bin/env node
// Messages stamped word "chat" that an agent sent. Until Identity step 1 every OAuth key counted as a chat, so a message
// sent through Claude Code's own OAuth, or by any session (it carries a session id), was stamped "chat" and its reader was
// told it is "an instruction from your person". The rule now: chat only for the claude.ai connector with no session.
// This script sets word "agent" on the messages that do not fit it.
//
//   node scripts/fix-message-word.mjs --db <database>           dry run: counts what it would change
//   node scripts/fix-message-word.mjs --db <database> --apply   does it
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: it only touches messages whose word is still "chat". Prints counts only.
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
  const ids = [];
  let bySession = 0;
  let byClient = 0;
  for await (const m of messages.find({ 'from.word': 'chat' }, { projection: { 'from.session': 1, 'from.keyId': 1, 'from.label': 1 } })) {
    if (m.from?.session) {
      bySession++;
      ids.push(m._id);
      continue;
    }
    const key = String(m.from?.keyId ?? '');
    const clientId = key.startsWith('oauth_') ? key.slice('oauth_'.length, key.lastIndexOf('_')) : '';
    const chat = clientId ? await isChatClient(clientId) : false;
    if (chat === false || (chat === null && m.from?.label)) {
      byClient++;
      ids.push(m._id);
    }
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);
  if (APPLY && ids.length) await messages.updateMany({ _id: { $in: ids }, 'from.word': 'chat' }, { $set: { 'from.word': 'agent' } });
  console.log(ids.length ? `  ${APPLY ? '✓' : '-'} ${ids.length} messages: word ${APPLY ? 'set' : 'would be set'} to agent (${bySession} with a session, ${byClient} from a client that is not the claude.ai connector)` : '  Nothing to do: no message is stamped chat wrongly.');
} finally {
  await client.close();
}
