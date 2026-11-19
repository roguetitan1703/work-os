// Identity step 3, server side of the worker's process view: a claudeSessions item may say `unknown: true` (the computer has no evidence
// about the process: stored as running, and the roster takes no word from it); a known `running: false` makes the session off at once;
// a known `running: true` keeps a quiet session alive. One machine name per PC: a row made by the hook keeps its device when the agent's
// start_work names the PC differently. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, MCP, ME, check, finish, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ago = min => new Date(Date.now() - min * 60_000);

try {
  const P = 'Process One';
  const ONE = (await must(MCP, 'add_project', { name: P, code: [{ remote: 'acme/process-one' }] })).project.id;
  const pc = await mkDevice('process-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'Process-PC' } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:f1`, deviceId: pc.id, folderId: 'f1', name: 'C:/code/f1', git: true, remote: 'acme/process-one', projectId: ONE, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const cc = randomUUID();
  const st = await call('/api/agent/start', pc.key, { remote: 'https://github.com/acme/process-one.git', branch: 'main', path: 'C:/code/f1', label: 'proc', ccSession: cc, source: 'startup' });
  const sid = st.json.brief.session;
  const rowId = `${ME.userId}:s:${sid}:${ONE}`;
  const stateOf = async () => (await must(MCP, 'list_sessions', { project: P, include_off: true })).sessions.find(x => x.session === sid)?.state;
  const item = extra => ({ sessionId: cc, folder: 'f1', title: 't', lastActiveAt: Date.now(), subagentsActive: 0, startedByWorkOs: false, running: false, ...extra });
  const report = items => call('/api/worker/status', pc.key, { worker: { version: '1', os: 'win32' }, jobs: [], sessions: [], claudeSessions: items });

  await rawDb.collection('presence').updateOne({ _id: rowId }, { $set: { activity: { state: 'idle', at: ago(40) }, lastSeen: ago(40) } });
  check('setup: idle and quiet for 40 min, no word from the computer: off', (await stateOf()) === 'off');
  const r1 = await report([item({ running: true })]);
  check('a status naming the session as running is accepted', r1.status === 200, r1.text.slice(0, 200));
  check('running: true keeps the quiet session alive (idle)', (await stateOf()) === 'idle');
  await rawDb.collection('presence').updateOne({ _id: rowId }, { $set: { activity: { state: 'idle', at: ago(1) }, lastSeen: ago(1) } });
  await report([item({ running: false })]);
  check('a known running: false makes it off at once', (await stateOf()) === 'off');
  const r3 = await report([item({ running: false, unknown: true })]);
  const dev = await rawDb.collection('devices').findOne({ _id: pc.id });
  const stored = dev.claudeSessions.items[0];
  check('unknown: true is accepted and stored as running with the unknown flag (readers of running keep working)', r3.status === 200 && stored.running === true && stored.unknown === true, JSON.stringify(stored));
  check('…and the roster takes no word from it: the quiet-but-recent session is idle, not off', (await stateOf()) === 'idle');
  const bad = await report([item({ unknown: 'yes' })]);
  check('unknown must be a boolean', bad.status === 400 || bad.status === 422, `${bad.status} ${bad.text.slice(0, 100)}`);

  // one machine name
  const agent = await mkKey({ agent: 'claude-code', name: 'process agent' });
  const sw = await mcpH(agent, 'start_work', { project: P, machine: 'process-pc-nickname', label: 'proc' }, { 'X-Work-OS-Session': sid });
  const row = await rawDb.collection('presence').findOne({ _id: rowId });
  check('start_work naming the PC another way keeps the hook row on its device (one machine)', !sw.isError && row.machine === pc.id && row.machineName === 'Process-PC', `${sw.text.slice(0, 100)} ${JSON.stringify([row.machine, row.machineName])}`);
  const sw2 = await mcpH(agent, 'start_work', { project: P, machine: 'process-pc', label: 'proc' }, { 'X-Work-OS-Session': sid });
  const row2 = await rawDb.collection('presence').findOne({ _id: rowId });
  check('start_work naming the device (any case) keeps the device too', !sw2.isError && row2.machine === pc.id && row2.machineName === 'Process-PC', JSON.stringify([row2.machine, row2.machineName]));
  const other = await mcpH(agent, 'start_work', { project: P, machine: 'laptop-x', label: 'plain one' });
  const plain = await rawDb.collection('presence').findOne({ projectId: ONE, label: 'plain one' });
  check('a session with no device keeps the plain name it gave', !other.isError && plain?.machine === 'laptop-x' && !plain.machineName, JSON.stringify(plain && [plain.machine, plain.machineName]));
} catch (e) {
  check('worker-process (error)', false, e?.stack || String(e));
}
await finish();
