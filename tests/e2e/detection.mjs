// Identity step 2, detection: a hook session with no word for 10 minutes while "working" is idle; with no word at all for 30
// minutes it is off unless the worker's list says its process runs; the worker's "stopped" makes it off at once; the old 8 hour
// rule is gone; a session waiting in /api/agent/wait is alive (the wait refreshes its row once a minute, even when it was
// quiet for over 30 minutes); send_message says "off ... it gets this when it starts" for an off row and never "present now".
// Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, MCP, ME, check, finish, mkDevice, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const call = async (url, cred, body = {}) => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const ago = min => new Date(Date.now() - min * 60_000);
const folder = (dev, who, fid, remote, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });

try {
  const P = 'Detect One';
  const ONE = (await must(MCP, 'add_project', { name: P, code: [{ remote: 'acme/detect-one' }] })).project.id;
  const pc = await mkDevice('detect-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'detect-pc' } });
  await rawDb.collection('workerFolders').insertOne(folder(pc, ME, 'fold1', 'acme/detect-one', ONE));
  const rowId = sid => `${ME.userId}:s:${sid}:${ONE}`;
  const setRow = (sid, set) => rawDb.collection('presence').updateOne({ _id: rowId(sid) }, { $set: set });
  const daemonList = items => rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { claudeSessions: { at: new Date(), items } } });
  const item = (sessionId, running) => ({ sessionId, folder: 'f', title: 't', lastActiveAt: new Date(), subagentsActive: 0, startedByWorkOs: false, running });
  const sess = async () => {
    const cc = randomUUID();
    const r = await call('/api/agent/start', pc.key, { folders: ['fold1'], remote: 'https://github.com/acme/detect-one.git', branch: 'main', path: 'C:/code/detect-one', label: 'detective', ccSession: cc, source: 'startup', machine: 'detect-pc' });
    return { token: r.json.token, sid: r.json.brief.session, cc };
  };
  const rosterState = async sid => {
    const out = await must(MCP, 'list_sessions', { project: P, include_off: true });
    return out.sessions.find(x => x.session === sid)?.state;
  };
  const note = async body => (await must(MCP, 'send_message', { project: P, kind: 'fyi', body, to: 'detective' })).target;

  await daemonList([]);
  const A = await sess();
  await setRow(A.sid, { activity: { state: 'working', at: ago(5) }, lastSeen: ago(5) });
  check('working, last event 5 min ago: working', (await rosterState(A.sid)) === 'working');
  await setRow(A.sid, { activity: { state: 'working', at: ago(12) }, lastSeen: ago(12) });
  check('working, quiet for 12 min: idle (10 min rule)', (await rosterState(A.sid)) === 'idle');
  await setRow(A.sid, { activity: { state: 'working', at: ago(31) }, lastSeen: ago(31) });
  check('working, quiet for 31 min, no daemon word: off (30 min rule)', (await rosterState(A.sid)) === 'off');
  await daemonList([item(A.cc, true)]);
  check('…but the daemon says the process runs: idle', (await rosterState(A.sid)) === 'idle');
  await daemonList([item(A.cc, false)]);
  await setRow(A.sid, { activity: { state: 'idle', at: ago(1) }, lastSeen: ago(1) });
  check('idle a minute ago, the daemon says stopped: off at once', (await rosterState(A.sid)) === 'off');
  await daemonList([]);
  await setRow(A.sid, { activity: { state: 'idle', at: ago(60) }, lastSeen: ago(60) });
  check('idle for an hour: off (no 8 hour rule)', (await rosterState(A.sid)) === 'off');

  // send_message names the state
  const offNote = await note('to an off session');
  check('send_message to an off session: off, it gets this when it starts, never present', /detective: off/.test(offNote) && /it gets this when it starts/.test(offNote) && !/present now/.test(offNote), offNote);
  await setRow(A.sid, { activity: { state: 'idle', at: ago(2) }, lastSeen: ago(2) });
  check('…an idle one is not called off', !/: off/.test(await note('to an idle session')));
  // a row with no hook (call-based): off after 30 quiet minutes, never present
  await rawDb.collection('presence').updateOne({ _id: rowId(A.sid) }, { $unset: { activity: '' }, $set: { lastSeen: ago(45) } });
  const plain = await note('to a call-based row quiet for 45 min');
  check('a call-based row quiet for 45 min: off, never present', /detective: off/.test(plain) && !/present now/.test(plain), plain);
  await rawDb.collection('presence').updateOne({ _id: rowId(A.sid) }, { $set: { lastSeen: ago(3) } });
  check('a call-based row seen 3 min ago: present now', /present now/.test(await note('to a call-based row seen 3 min ago')));

  // the wait refreshes the row (the call-based row above becomes a hook row again)
  const W = await sess();
  await setRow(W.sid, { activity: { state: 'idle', at: ago(50) }, lastSeen: ago(50) });
  check('setup: an idle hook row quiet for 50 min is off', (await rosterState(W.sid)) === 'off');
  const w = await call('/api/agent/wait', W.token, {});
  const row = await rawDb.collection('presence').findOne({ _id: rowId(W.sid) });
  check('a wait on that row refreshes lastSeen (it is alive) and the row is idle again', Date.now() - row.lastSeen.getTime() < 120_000 && (await rosterState(W.sid)) === 'idle', `${w.status} ${w.text.slice(0, 100)} ${row.lastSeen}`);
  check('…the wait did not say busy for a row that is alive', w.status === 200 && !w.json?.busy, w.text.slice(0, 200));
} catch (e) {
  check('detection (error)', false, e?.stack || String(e));
}
await finish();
