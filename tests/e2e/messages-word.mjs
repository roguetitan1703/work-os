// The word a message carries (lib/data/messages.ts wordOf; Identity step 1): "chat" only for the claude.ai connector (an
// OAuth client on the claude.ai redirect) with no session id; every other call is an agent: a static key of any kind, Claude
// Code's own OAuth client, and a claude.ai key that carries a session id. A message that says word in its arguments is
// ignored. Also scripts/fix-message-word.mjs: its dry run changes nothing, --apply fixes the wrongly stamped messages and
// leaves the right ones, a second run finds nothing. Seed profile: none.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBNAME, ME, MCP, check, finish, mkKey, rawDb } from './lib.mjs';
import { must, mkOAuth } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NAME = 'Word Project';
const word = async id => (await rawDb.collection('messages').findOne({ _id: id })).from.word;
try {
  await must(MCP, 'add_project', { name: NAME, code: [{ remote: 'acme/word-project' }] });
  const project = await rawDb.collection('projects').findOne({ name: NAME });
  const cc = await mkKey({ agent: 'claude-code', name: 'Word Code' });
  const chatTok = await mkOAuth({ userId: ME.userId, orgId: ME.orgId, name: 'Word chat' });
  const codeTok = await mkOAuth({ userId: ME.userId, orgId: ME.orgId, name: 'Word code oauth' });
  await rawDb.collection('oauthClient').updateOne({ name: 'Word code oauth' }, { $set: { redirectUris: ['http://localhost:51234/callback'] } });
  const send = (key, body, headers = {}) => must(key, 'send_message', { project: NAME, kind: 'fyi', body, word: 'person' }, headers);

  const a = await send(chatTok, 'from the claude.ai chat, no session');
  check('word: claude.ai over OAuth with no session is chat', (await word(a.id)) === 'chat' && a.word === 'chat', JSON.stringify(a));
  const b = await send(chatTok, 'from the claude.ai chat, with a session id', { 'X-Work-OS-Session': 'word-session-1' });
  check('word: the same key with a session id is an agent', (await word(b.id)) === 'agent' && b.word === 'agent');
  const c = await send(codeTok, 'from Claude Code over OAuth, no session');
  check('word: Claude Code over OAuth is an agent even with no session', (await word(c.id)) === 'agent');
  const d = await send(MCP, 'from a static Claude chat key');
  check('word: a static Claude chat key is an agent', (await word(d.id)) === 'agent');
  const e = await send(cc, 'from a Claude Code key');
  check('word: a Claude Code key is an agent', (await word(e.id)) === 'agent');

  // The fix script
  const mk = async (id, from) => rawDb.collection('messages').insertOne({ _id: id, orgId: ME.orgId, projectId: project._id, visibility: 'org', seenBy: [], from: { userId: ME.userId, ...from }, kind: 'fyi', body: id, refs: {}, thread: id, status: 'unread', at: new Date() });
  const chatClient = (await rawDb.collection('oauthClient').findOne({ name: 'Word chat' })).clientId;
  const codeClient = (await rawDb.collection('oauthClient').findOne({ name: 'Word code oauth' })).clientId;
  await mk('m_fix_session', { word: 'chat', keyId: `oauth_${chatClient}_${ME.userId}`, session: 's-1' });
  await mk('m_fix_client', { word: 'chat', keyId: `oauth_${codeClient}_${ME.userId}` });
  await mk('m_fix_right', { word: 'chat', keyId: `oauth_${chatClient}_${ME.userId}` });
  await mk('m_fix_agent', { word: 'agent', keyId: 'wkr_x' });
  const run = extra => execFileSync(process.execPath, [path.join(ROOT, 'scripts/fix-message-word.mjs'), '--db', DBNAME, ...extra], { encoding: 'utf8', env: process.env });
  const dry = run([]);
  check('fix script: the dry run says what it would change and changes nothing', /DRY RUN/.test(dry) && /would be set/.test(dry) && (await word('m_fix_session')) === 'chat' && (await word('m_fix_client')) === 'chat', dry);
  const applied = run(['--apply']);
  check('fix script: --apply fixes the session message and the other client’s message', /APPLY/.test(applied) && (await word('m_fix_session')) === 'agent' && (await word('m_fix_client')) === 'agent', applied);
  check('fix script: the claude.ai chat message and the agent message are left alone', (await word('m_fix_right')) === 'chat' && (await word('m_fix_agent')) === 'agent' && (await word(a.id)) === 'chat');
  check('fix script: a second run finds nothing', /Nothing to do/.test(run(['--apply'])));
  check('fix script: refuses to run without --db', (() => { try { execFileSync(process.execPath, [path.join(ROOT, 'scripts/fix-message-word.mjs')], { encoding: 'utf8', stdio: 'pipe', env: process.env }); return false; } catch (x) { return x.status === 2; } })());
} catch (e) {
  check('messages-word (error)', false, e?.stack || String(e));
}
await finish();
