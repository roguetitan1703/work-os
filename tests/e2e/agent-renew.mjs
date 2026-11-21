// Token expiry and renew (plan note db5bf91389, piece A6/A7): a token in use keeps itself alive (its expiry moves to a full term once
// under 23 of 24 hours are left, and the event and wait answers carry expiresAt); a start with { renew: true } and the device key gives
// a hook whose token ran out a new token for the SAME session and nothing else (no brief, the folders ignored, the project never changed);
// no record: 404; its own hourly limit (20 per computer and Claude Code session) apart from the sign-ins. Seed profile: none.
import crypto from 'node:crypto';
import { B, MCP, ME, check, finish, mkDevice, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const call = async (path, cred, body = {}, headers = {}) => {
  const r = await fetch(B + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), 'x-work-os-hook': '4', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const hash = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

try {
  const A = ME;
  const p = (await must(MCP, 'add_project', { name: 'Renew One', code: [{ remote: 'acme/renew-one' }] })).project.id;
  const dev = await mkDevice('renew-pc');
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { ownerId: A.userId, orgId: A.orgId } });
  await rawDb.collection('workerFolders').insertOne({ _id: `${dev.id}:rfold`, deviceId: dev.id, folderId: 'rfold', name: 'C:/code/renew-one', git: true, remote: 'acme/renew-one', projectId: p, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: A.orgId, ownerId: A.userId });
  const CC = crypto.randomUUID();
  const PROC = { pid: 5151, procStart: '133000000000000005' };
  const s0 = await call('/api/agent/start', dev.key, { folders: ['rfold'], path: 'C:/code/renew-one', ccSession: CC, source: 'startup', proc: PROC });
  const sid = s0.json?.brief?.session;
  const T = s0.json?.token ?? '';
  check('a start with the device key: a session and a token', s0.status === 200 && !!sid && /^wst_/.test(T), `${s0.status} ${s0.text.slice(0, 150)}`);
  const tokRow = () => rawDb.collection('agentSessions').findOne({ hash: hash(T) });

  // ---- a token in use moves its expiry ----
  const day = 24 * 3600e3;
  const e0 = await call('/api/agent/event', T, { event: 'tool' });
  check('a fresh token (about 24 h left): the event answer carries expiresAt, about now + 24 h, and the row is not rewritten', e0.status === 200 && Math.abs(Date.parse(e0.json?.expiresAt) - (Date.now() + day)) < 60_000 && +(await tokRow()).expiresAt === Date.parse(e0.json?.expiresAt), `${e0.status} ${e0.text.slice(0, 160)}`);
  await rawDb.collection('agentSessions').updateOne({ hash: hash(T) }, { $set: { expiresAt: new Date(Date.now() + 2 * 3600e3) } });
  const e1 = await call('/api/agent/event', T, { event: 'tool' });
  check('near expiry (2 h left): the next call moves expiresAt to a full term, in the row and in the answer', e1.status === 200 && Math.abs(Date.parse(e1.json?.expiresAt) - (Date.now() + day)) < 60_000 && Math.abs(+(await tokRow()).expiresAt - (Date.now() + day)) < 60_000, `${e1.status} ${e1.text.slice(0, 160)}`);
  const stamp = +(await tokRow()).expiresAt;
  await call('/api/agent/event', T, { event: 'tool' });
  check('a second call within the hour writes nothing more', +(await tokRow()).expiresAt === stamp);
  await rawDb.collection('agentSessions').updateOne({ hash: hash(T) }, { $set: { expiresAt: new Date(Date.now() + 3600e3) } });
  const w = await call('/api/agent/wait', T, {});
  check('a wait answer carries expiresAt too (and moves a near expiry)', w.status === 200 && Math.abs(Date.parse(w.json?.expiresAt) - (Date.now() + day)) < 60_000, `${w.status} ${w.text.slice(0, 160)}`);

  // ---- renew ----
  await rawDb.collection('agentSessions').updateOne({ hash: hash(T) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  check('the token has run out: 401', (await call('/api/agent/event', T, { event: 'tool' })).status === 401);
  const r1 = await call('/api/agent/start', dev.key, { renew: true, ccSession: CC, proc: PROC, folders: ['nowhere'] });
  check('renew with the device key: 200 { token, expiresAt, session } with the same session id and no brief', r1.status === 200 && r1.json?.session === sid && /^wst_/.test(r1.json?.token ?? '') && !('brief' in (r1.json ?? {})) && Math.abs(Date.parse(r1.json?.expiresAt) - (Date.now() + day)) < 60_000, `${r1.status} ${r1.text.slice(0, 200)}`);
  const T2 = r1.json?.token ?? '';
  const e2 = await call('/api/agent/event', T2, { event: 'prompt' });
  check('the renewed token posts events to the same session\'s row', e2.status === 200 && !!(await rawDb.collection('presence').findOne({ session: sid, projectId: p }))?.activity && (await rawDb.collection('agentSessions').findOne({ hash: hash(T2) })).sessionId === sid);
  check('renew never changes the project and makes no other session or row', (await rawDb.collection('agentIdentities').findOne({ _id: sid })).projectId === p && (await rawDb.collection('agentIdentities').countDocuments({ ccSessions: CC })) === 1 && (await rawDb.collection('presence').countDocuments({ ccSession: CC })) === 1);
  const r1b = await call('/api/agent/start', dev.key, { renew: true, ccSession: CC, folders: ['rfold'] });
  check('renew ignores the folders (a folder of the project, or none) and answers the same way', r1b.status === 200 && r1b.json?.session === sid && !('brief' in (r1b.json ?? {})));
  const r1t = await call('/api/agent/start', T2, { renew: true, ccSession: CC });
  check('renew with a live token: its session and expiry, no new token', r1t.status === 200 && r1t.json?.session === sid && !('token' in (r1t.json ?? {})));
  const rNone = await call('/api/agent/start', dev.key, { renew: true, ccSession: crypto.randomUUID(), proc: PROC });
  check('renew with no record: 404, and no record is made', rNone.status === 404 && (await rawDb.collection('agentIdentities').countDocuments({})) === 1, `${rNone.status} ${rNone.text.slice(0, 120)}`);
  const rNoCc = await call('/api/agent/start', dev.key, { renew: true });
  check('renew with no Claude Code session id: 404', rNoCc.status === 404);
  check('renew with an unknown field: 400 (the schema stays strict)', (await call('/api/agent/start', dev.key, { renew: true, ccSession: CC, extra: 1 })).status === 400);
  check('renew from another computer finds no record (the session is one computer): 404', await (async () => {
    const other = await mkDevice('renew-pc-2');
    await rawDb.collection('devices').updateOne({ _id: other.id }, { $set: { ownerId: A.userId, orgId: A.orgId } });
    return (await call('/api/agent/start', other.key, { renew: true, ccSession: CC })).status === 404;
  })());

  // ---- its own limit: 20 per computer and Claude Code session, apart from the sign-ins ----
  let ok = 0;
  let last = 0;
  for (let i = 0; i < 30; i++) {
    last = (await call('/api/agent/start', dev.key, { renew: true, ccSession: CC })).status;
    if (last === 200) ok++;
    else break;
  }
  check('renews are limited per computer and Claude Code session (429 with Retry-After once used up)', last === 429 && ok === 17 /* 3 were used above: r1, r1b and the live-token renew */, `${ok} ok then ${last}`);
  const normal = await call('/api/agent/start', dev.key, { folders: ['rfold'], path: 'C:/code/renew-one', ccSession: CC, source: 'resume' });
  check('…a normal sign-in still works while the renews are over their limit', normal.status === 200 && normal.json?.brief?.session === sid, `${normal.status} ${normal.text.slice(0, 120)}`);
  const other = await call('/api/agent/start', dev.key, { renew: true, ccSession: crypto.randomUUID() });
  check('…and another Claude Code session\'s renew is not blocked by this one\'s limit (404 for no record, not 429)', other.status === 404, String(other.status));
} catch (e) {
  check('agent-renew suite (error)', false, e?.stack || String(e));
}
await finish();
