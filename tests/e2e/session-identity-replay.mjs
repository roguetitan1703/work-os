// Replay of the real case (plan note db5bf91389, piece E2): one Claude Code session got three Work OS ids after a compaction started from a
// subfolder or the parent folder, then a prompt, then a restart. Here the same order runs against the routes, and after every step the
// session must have the SAME id, ONE open row, no second row showing Working, its messages and Needs still addressed to it, and its doing.
//   1 start unfiled in the unlinked parent folder   2 cd into the project: the next prompt files it   3 resume in the parent, with and
//   without the token   4 compaction from an unlinked sibling   5 /clear (same claude process, new Claude Code session id)
//   6 a folder of another project   7 the token runs out, then a prompt: renew.
// The server of the suites is a production build, so AGENT_TOKEN_TTL_MS is ignored there; the token's expiry is set in the database.
// Seed profile: none.
import crypto from 'node:crypto';
import { B, MCP, ME, check, finish, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

const call = async (path, cred, body = {}) => {
  const r = await fetch(B + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), 'x-work-os-hook': '5' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};
const col = n => rawDb.collection(n);
const U = ME.userId;
const K = s => `${U}:${s}`;
const uid = () => crypto.randomUUID();
const hdr = s => ({ 'X-Work-OS-Session': s });
const folder = (dev, id, remote, projectId) => ({ _id: `${dev.id}:${id}`, deviceId: dev.id, folderId: id, name: `C:/code/${id}`, git: true, remote, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: U });

try {
  const P = 'Replay P';
  const Q = 'Replay Q';
  const pidP = (await must(MCP, 'add_project', { name: P, code: [{ remote: 'acme/replay-p' }] })).project.id;
  const pidQ = (await must(MCP, 'add_project', { name: Q, code: [{ remote: 'acme/replay-q' }] })).project.id;
  const dev = await mkDevice('replay-pc');
  await col('devices').updateOne({ _id: dev.id }, { $set: { ownerId: U, orgId: ME.orgId } });
  await col('workerFolders').insertMany([folder(dev, 'rpFoldP', 'acme/replay-p', pidP), folder(dev, 'rpFoldQ', 'acme/replay-q', pidQ), folder(dev, 'rpPar', 'acme/replay-parent', null)]);
  const task = (await must(MCP, 'add_task', { title: 'Replay task', project: P })).created;
  const taskId = task?.id ?? (await col('tasks').findOne({ title: 'Replay task' }))._id;

  const C1 = uid();
  const C2 = uid(); // /clear gives the same claude process a new Claude Code session id
  const PROC = { pid: 6161, procStart: '133000000000000009' };
  const parent = { folders: ['rpPar'], path: 'C:/code/parent', machine: 'rpc' };
  const inP = { folders: ['rpFoldP'], path: 'C:/code/parent/replay-p', machine: 'rpc' };
  const sibling = { folders: ['rpSib'], path: 'C:/code/sibling', machine: 'rpc' }; // no folder row at all: a folder no project owns
  const cc = await mkKey({ agent: 'claude-code', name: 'replay session key' });
  let S = null;
  const sent = [];

  // After every step: same id, one open row, at most one row showing Working, the messages and Needs on S, and the doing.
  const inv = async (label, { project, doing }) => {
    const rows = await col('presence').find({ ccSession: { $in: [C1, C2] }, userId: U }).toArray();
    const open = rows.filter(r => !r.endedAt);
    const working = open.filter(r => r.activity?.state === 'working');
    check(`${label}: one open row, under the one id${project === null ? ', no project' : ''}`, open.length === 1 && open[0].session === S && (project === null ? !open[0].projectId : open[0].projectId === project), JSON.stringify(open.map(r => [r.session, r.projectId])));
    check(`${label}: no ghost row shows Working`, working.length <= 1 && working.every(r => r.session === S), JSON.stringify(working.map(r => r.session)));
    check(`${label}: one session record, still the same`, (await col('agentIdentities').countDocuments({ ownerId: U, deviceId: dev.id, ccSessions: { $in: [C1, C2] } })) === 1 && !!(await col('agentIdentities').findOne({ _id: S })));
    for (const id of sent) {
      const mm = await col('messages').findOne({ _id: id });
      check(`${label}: message ${id.slice(0, 6)} is still addressed to the session (not lost to another id)`, mm?.toSids?.join() === K(S) && ['unread', 'seen'].includes(mm.status), JSON.stringify(mm?.toSids));
    }
    for (const nd of await col('needs').find({ ask: /^Replay/ }).toArray()) check(`${label}: Need "${nd.ask.slice(0, 20)}" is still the session's and open`, nd.from.session === S && nd.status === 'open');
    if (doing) check(`${label}: doing survives on the open row`, open[0]?.doing?.taskId === taskId, JSON.stringify(open[0]?.doing));
  };
  const message = async (project, body) => {
    const r = await must(MCP, 'send_message', { project, kind: 'fyi', body, to: S });
    sent.push(r.id);
  };

  // 1. start unfiled in the unlinked parent folder
  const s1 = await call('/api/agent/start', dev.key, { ...parent, ccSession: C1, source: 'startup', proc: PROC });
  let T = s1.json?.token ?? '';
  S = (await col('agentIdentities').findOne({ ownerId: U, deviceId: dev.id, ccSessions: C1 }))?._id;
  check('1 unfiled start in the parent folder: 200, unfiled, a token and a session record', s1.status === 200 && s1.json?.unfiled === true && /^wst_/.test(T) && !!S, `${s1.status} ${s1.text.slice(0, 160)}`);
  await inv('1', { project: null });

  // 2. cd into the project: the next prompt files it (the hook starts again with its token)
  const s2 = await call('/api/agent/start', T, { ...inP, ccSession: C1, source: 'startup', proc: PROC });
  check('2 the project folder files the session: the same id on the project, no 403', s2.status === 200 && s2.json?.brief?.session === S && s2.json?.brief?.project?.id === pidP, `${s2.status} ${s2.text.slice(0, 160)}`);
  await col('presence').updateOne({ session: S, projectId: pidP, endedAt: { $exists: false } }, { $set: { doing: { taskId, at: new Date() } } });
  await message(P, 'Replay message one');
  const fy2 = (await mcpH(cc, 'list_tasks', { project: P }, hdr(S))).json;
  check('2 the session sees the message in its forYou (an MCP call that names its id)', JSON.stringify(fy2.forYou ?? []).length > 2, JSON.stringify(fy2).slice(0, 300));
  const need1 = await must(MCP, 'ask', { project: P, to: 'me', kind: 'decide', ask: 'Replay Need one: still mine?', options: [{ label: 'Yes now', means: 'go' }, { label: 'Later', means: 'wait' }], session: S }, hdr(S));
  check('2 a Need asked as the session names it', !!need1.need && (await col('needs').findOne({ ask: /^Replay Need one/ }))?.from?.session === S);
  const ev = await call('/api/agent/event', T, { event: 'prompt' });
  const ev2 = await call('/api/agent/event', T, { event: 'tool' });
  check('2 events with the token land on the session', ev.status === 200 && ev2.status === 200, ev2.text.slice(0, 200));
  await inv('2', { project: pidP, doing: true });

  // 3. resume in the parent, with the token and without it
  const s3a = await call('/api/agent/start', T, { ...parent, ccSession: C1, source: 'resume', proc: PROC });
  check('3a resume in the parent with the token: the same id, stays on the project, elsewhere', s3a.status === 200 && s3a.json?.brief?.session === S && s3a.json?.brief?.project?.id === pidP && s3a.json?.elsewhere === true && !('token' in (s3a.json ?? {})), `${s3a.status} ${s3a.text.slice(0, 160)}`);
  await inv('3a', { project: pidP, doing: true });
  const s3b = await call('/api/agent/start', dev.key, { ...parent, ccSession: C1, source: 'resume', proc: PROC });
  check('3b resume in the parent with no token file (the device key): the same id, on the project, elsewhere, a new token', s3b.status === 200 && s3b.json?.brief?.session === S && s3b.json?.brief?.project?.id === pidP && s3b.json?.elsewhere === true && /^wst_/.test(s3b.json?.token ?? ''), `${s3b.status} ${s3b.text.slice(0, 160)}`);
  T = s3b.json?.token ?? T;
  await inv('3b', { project: pidP, doing: true });

  // 4. compaction from an unlinked sibling
  const s4 = await call('/api/agent/start', T, { ...sibling, ccSession: C1, source: 'compact', proc: PROC });
  check('4 compaction from an unlinked sibling folder: the same id, elsewhere', s4.status === 200 && s4.json?.brief?.session === S && s4.json?.elsewhere === true, `${s4.status} ${s4.text.slice(0, 160)}`);
  await inv('4', { project: pidP, doing: true });

  // 5. /clear: the same claude process, a new Claude Code session id
  const s5 = await call('/api/agent/start', dev.key, { ...parent, ccSession: C2, source: 'clear', proc: PROC });
  check('5 /clear with the same proc: the same id', s5.status === 200 && s5.json?.brief?.session === S, `${s5.status} ${s5.text.slice(0, 160)}`);
  T = s5.json?.token ?? T;
  await inv('5', { project: pidP, doing: true });

  // 6. a folder of another project: the session moves, the first project's row ends
  const s6 = await call('/api/agent/start', T, { folders: ['rpFoldQ'], path: 'C:/code/replay-q', machine: 'rpc', ccSession: C2, source: 'startup', proc: PROC });
  check('6 a folder of project Q: the same id on Q', s6.status === 200 && s6.json?.brief?.session === S && s6.json?.brief?.project?.id === pidQ, `${s6.status} ${s6.text.slice(0, 160)}`);
  const pRow = await col('presence').findOne({ session: S, projectId: pidP });
  check('6 the row on P ended', !!pRow?.endedAt, JSON.stringify(pRow?.endedAt));
  // A doing names a task of project P: it does not follow the session to Q (it stays on P's ended row, not lost).
  check("6 the doing stays on P's ended row", pRow?.doing?.taskId === taskId, JSON.stringify(pRow?.doing));
  await message(Q, 'Replay message two');
  await inv('6', { project: pidQ });

  // 7. the token runs out, then a prompt: renew
  await col('agentSessions').updateMany({ $or: [{ sessionId: S }, { _id: S }] }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const dead = await call('/api/agent/event', T, { event: 'prompt' });
  check('7 the token has run out: 401', dead.status === 401, `${dead.status}`);
  const r7 = await call('/api/agent/start', dev.key, { renew: true, ccSession: C2, proc: PROC });
  check('7 renew: the same session id, a new token, no brief', r7.status === 200 && r7.json?.session === S && /^wst_/.test(r7.json?.token ?? '') && !('brief' in (r7.json ?? {})), `${r7.status} ${r7.text.slice(0, 160)}`);
  const ev7 = await call('/api/agent/event', r7.json?.token ?? '', { event: 'prompt' });
  check('7 an event with the renewed token lands on the row on Q', ev7.status === 200 && (await col('presence').findOne({ session: S, projectId: pidQ }))?.activity?.state === 'working', `${ev7.status} ${ev7.text.slice(0, 120)}`);
  await inv('7', { project: pidQ });
  const fy7 = (await mcpH(cc, 'list_tasks', { project: Q }, hdr(S))).json;
  check('7 after the renew the session still sees the mail of Q in its forYou', JSON.stringify(fy7.forYou ?? []).length > 2, JSON.stringify(fy7.forYou));
  const need2 = await must(MCP, 'ask', { project: Q, to: 'me', kind: 'decide', ask: 'Replay Need two: after the renew', options: [{ label: 'Yes now', means: 'go' }, { label: 'Later', means: 'wait' }], session: S }, hdr(S));
  check('7 a Need asked after the renew names the same session', !!need2.need && (await col('needs').findOne({ ask: /^Replay Need two/ }))?.from?.session === S);
} catch (e) {
  check('session-identity-replay suite (error)', false, e?.stack || String(e));
}
await finish();
