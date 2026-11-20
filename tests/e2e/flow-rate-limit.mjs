// The hourly call budget of a Claude Code key (lib/mcp/policy.ts CALLS; Grant Leads, 20 Nov: one busy session spent the key's
// 300 and another session's save_state was refused). A key's sessions share 1,000 calls an hour for reads and most writes, each
// session has a share of 300, a write that saves State still goes through past 1,000 while its session is under 400, and 1,500
// stops everything. A refusal names the 3 sessions with the most calls by label, the caller's own only. The calls are seeded as
// policyEvents rows (what one MCP call records), so the suite needs no thousands of calls. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { ME, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'RL Alpha';
const hdr = sess => ({ 'X-Work-OS-Session': sess });

try {
  const T = await makeUser({ email: 'rl-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const cc = await mkKey({ agent: 'claude-code', name: 'RL cc' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'RL Tess cc' });
  await must(cc, 'add_project', { name: P, visibility: 'org' });
  const start = (key, sess, label) => must(key, 'start_work', { project: P, session: sess, label }, hdr(sess));
  await start(cc, 'rlBusy', 'RL busy builder');
  await start(cc, 'rlLead', 'RL lead');
  await start(cc, 'rlOther', 'RL other');
  // Tess's own session with the same session id and a label of hers: never named in Om's refusal
  await start(kT, 'rlBusy', 'Tess private label');
  const keyId = (await rawDb.collection('policyEvents').findOne({ kind: 'call', sid: 'rlLead' }))?.keyId;
  check('setup: a call records its session on the policy event', typeof keyId === 'string' && !!(await rawDb.collection('policyEvents').findOne({ kind: 'call', sid: 'rlBusy', keyId })), String(keyId));
  const tessKey = (await rawDb.collection('policyEvents').findOne({ kind: 'call', sid: 'rlBusy', keyId: { $ne: keyId } }))?.keyId;
  const seed = async (sid, n, key = keyId) => {
    const at = new Date(Date.now() - 10 * 60_000);
    await rawDb.collection('policyEvents').insertMany(Array.from({ length: n }, () => ({ _id: randomUUID(), keyId: key, kind: 'call', at, sid })));
  };
  const count = async () => rawDb.collection('policyEvents').countDocuments({ keyId, kind: 'call' });
  const reset = async () => rawDb.collection('policyEvents').deleteMany({ kind: 'call', keyId: { $in: [keyId, tessKey] } });
  const call = (sess, name = 'get_state', args = { project: P }) => mcpH(cc, name, { ...args, session: sess }, hdr(sess));

  // 1. One busy session spends its own share; its sibling's reads and saves go on
  await reset();
  await seed('rlBusy', 300);
  await seed('rlBusy', 400, tessKey); // Tess's key is another budget: none of it counts for Om's
  const busy = await call('rlBusy');
  check('session share: the 301st call of a session is refused, saying it is this session\'s share', busy.isError && /this session made 300 Work OS calls in the last hour \(its share is 300/.test(busy.text), busy.text.slice(0, 300));
  check('session share: the refusal names the sessions with the most calls, by label', /Most calls this hour: "RL busy builder" 300/.test(busy.text) && !/Tess private label/.test(busy.text), busy.text.slice(0, 400));
  const lead = await call('rlLead');
  check('session share: another session of the same key still reads', !lead.isError, lead.text.slice(0, 200));
  const busySave = await call('rlBusy', 'log_progress', { task: 1, note: 'x' });
  check('session share: a saving write of the busy session passes its 300 share (it gets 400), refused only for another reason', !/Rate limit/.test(busySave.text), busySave.text.slice(0, 200));

  // 2. The key's shared 1,000 is spent by others: reads are refused first, a session under its share still saves State
  await reset();
  await seed('rlBusy', 240);
  await seed('rlOther', 240);
  await seed(randomUUID(), 240);
  await seed(randomUUID(), 240);
  await seed('rlLead', 40);
  const before = await count();
  const read = await call('rlLead');
  check('key budget: past 1,000 a read is refused, naming the shared budget and this session\'s own count', read.isError && /this key made 1000 Work OS calls in the last hour \(max 1000 for reads and most writes, shared by every session of the key; this session made 40\)/.test(read.text), read.text.slice(0, 300));
  check('key budget: the refusal says saving State still works and lists the top 3 (labels, or "a session with no name")', /Saving State \(save_state, end_work, set_doing, log_progress, complete_task, hand_in\) still works/.test(read.text) && /Most calls this hour: ("RL busy builder"|"RL other"|a session with no name) 240/.test(read.text) && (read.text.match(/ 240/g) ?? []).length === 3 && !/RL lead/.test(read.text), read.text.slice(0, 500));
  check('key budget: a refused call is not counted', (await count()) === before, String(await count()));
  const save = await call('rlLead', 'save_state', { project: P, ops: [{ op: 'add_later', text: 'RL a saved line while the key is busy' }] });
  check('key budget: save_state of a session under its share is not refused by the shared budget', !save.isError && save.json?.saved === true, save.text.slice(0, 300));
  const doing = await call('rlLead', 'end_work', { friction: 'none' });
  check('key budget: end_work also passes', !/Rate limit/.test(doing.text), doing.text.slice(0, 200));
  const write = await call('rlLead', 'add_task', { title: 'RL not a saving write', project: P });
  check('key budget: a write that does not save State (add_task) is refused like a read', write.isError && /max 1000 for reads and most writes/.test(write.text), write.text.slice(0, 200));

  // 3. A saving write over the session's 200, and the hard cap of 900 that no session id lifts
  await reset();
  await seed('rlLead', 400);
  const over = await call('rlLead', 'save_state', { project: P, ops: [{ op: 'add_later', text: 'RL over the session share' }] });
  check('session save share: the 401st call is refused even for save_state', over.isError && /this session made 400 Work OS calls/.test(over.text), over.text.slice(0, 200));
  await reset();
  for (let i = 0; i < 15; i++) await seed(randomUUID(), 100);
  const hard = await call('rlLead', 'save_state', { project: P, ops: [{ op: 'add_later', text: 'RL over the hard cap' }] });
  check('hard cap: at 1,500 even a saving write of a quiet session is refused', hard.isError && /this key made 1500 Work OS calls in the last hour \(max 1500/.test(hard.text), hard.text.slice(0, 200));
  const fresh = await call(randomUUID(), 'save_state', { project: P, ops: [{ op: 'add_later', text: 'RL a new session id' }] });
  check('hard cap: a new session id does not get round it', fresh.isError && /max 1500/.test(fresh.text), fresh.text.slice(0, 200));

  // 5. Calls with no session id (the key's fallback) get the key's budget, not a 300 share (independent review, 21 Nov)
  await reset();
  await seed(keyId, 400);
  const noSess = await mcpH(cc, 'get_state', { project: P });
  check('no session id: past 300 (here 400) a call is not refused: no share applies, only the key budget', !noSess.isError, noSess.text.slice(0, 200));
  await seed('rlOther', 599);
  const noSessOver = await mcpH(cc, 'get_state', { project: P });
  check('no session id: past the key budget it is refused, saying to pass session', noSessOver.isError && /passed no session, so it has no share of its own: pass session/.test(noSessOver.text), noSessOver.text.slice(0, 300));

  // 4. Tess's key: her own budget, and nothing of Om's sessions in her refusal
  await reset();
  await seed('rlBusy', 300, tessKey);
  const tess = await mcpH(kT, 'get_state', { project: P, session: 'rlBusy' }, hdr('rlBusy'));
  check('other person: her refusal names her own session only', tess.isError && /"Tess private label" 300/.test(tess.text) && !/RL busy builder/.test(tess.text), tess.text.slice(0, 300));
  await reset();
} catch (e) {
  check('suite ran without throwing', false, e?.stack ?? String(e));
}
await finish();
