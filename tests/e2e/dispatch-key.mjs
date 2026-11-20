// Run keys (docs/dispatcher.md "Run keys"): a dispatched run's own Work OS credential. The worker asks for one with its device key
// (POST /api/worker/run-key) for this computer's own dispatched session; every MCP call made with it is dispatched on the server,
// whatever the run sends: Orders are never writable (even naming the person's real session), a session id that is not the run's
// is refused, mail and Discord are refused, and the sessions it starts are marked. The person's own key is unaffected.
// Keys are generated test values and never printed (check() redacts). Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { B, EMAIL, ME, MCP, PW, api, check, finish, mkDevice, rawDb } from './lib.mjs';
import { must, mcpH, markOrders } from './flow-lib.mjs';

const RUN_RE = /^wdr_[A-Za-z0-9_-]{43}$/;
const folderRow = (dev, fid, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote: 'acme/dk-one', projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
const wsRow = (dev, id, taskId, extra = {}) => ({ _id: id, orgId: ME.orgId, ownerId: ME.userId, deviceId: dev.id, folderId: 'fdk1', projectId: extra.projectId, state: 'running', startedAt: new Date(), updatedAt: new Date(), ...(taskId ? { dispatched: true, taskId } : {}), ...extra });
const mint = (devKey, sessionId) => api(devKey, 'POST', '/api/worker/run-key', { sessionId });
const ordersBody = async id => (await rawDb.collection('notes').findOne({ _id: id }))?.body ?? '';
// Server actions by name from the build (as flow-h15 does).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
function actionOf(name, file) {
  for (const [id, e] of Object.entries(MANIFEST)) {
    const ws = e.exportedName ? [e] : Object.values(e.workers);
    if (!ws.some(w => w.exportedName === name && file.test(w.filename))) continue;
    const page = Object.keys(e.workers).find(x => !x.includes('[')) ?? Object.keys(e.workers)[0];
    return { id, url: '/' + page.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(x => !/^\(.*\)$/.test(x)).join('/') };
  }
  return null;
}
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
async function act(cookie, name, file, ...args) {
  const a = actionOf(name, file);
  if (!a) return { ok: false, text: `${name} not in the build` };
  const r = await fetch(B + a.url, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  const text = await r.text();
  return { ok: /"ok":true/.test(text), text };
}

try {
  const proj = (await must(MCP, 'add_project', { name: 'DK One', code: [{ remote: 'acme/dk-one' }] })).project.id;
  const created = (await must(MCP, 'add_task', { title: 'DK task', project: 'DK One' })).created;
  const task = { ref: created.ref, id: (await rawDb.collection('tasks').findOne({ ref: created.ref }))._id };
  const pc = await mkDevice('dk-pc');
  const other = await mkDevice('dk-other');
  await rawDb.collection('workerFolders').insertOne(folderRow(pc, 'fdk1', proj));
  const cc = randomUUID();
  const plain = randomUUID();
  await rawDb.collection('workerSessions').insertMany([wsRow(pc, cc, task.id, { projectId: proj }), wsRow(pc, plain, null, { projectId: proj })]);
  const orders = (await must(MCP, 'write_note', { project: 'DK One', title: 'DK Orders', body: 'Rule one.' })).created.id;
  await markOrders(orders, 'project');
  // Om's own interactive session on the project (his own key): the session a hijacked run would like to act as.
  const leadBrief = await must(MCP, 'start_work', { project: 'DK One', label: 'DK · lead' });
  const lead = leadBrief.session;
  check('setup: the person\'s own brief still says write_note for the layer they hold', (leadBrief.orders ?? []).some(o => o.change === 'write_note'), JSON.stringify((leadBrief.orders ?? []).map(o => o.change)));
  check('setup: the person has a real session id', typeof lead === 'string' && lead.length > 8, String(lead));

  // ---- 1: minting: only the computer's own dispatched session, only with its device key ----
  const m1 = await mint(pc.key, cc);
  const runKey = m1.body?.key;
  check('1: the device key gets a run key (and the task ref) for its own dispatched session', m1.status === 200 && RUN_RE.test(runKey ?? '') && !!m1.body?.expiresAt && m1.body?.ref === task.ref, `${m1.status} ${JSON.stringify(m1.body)}`);
  const stored = await rawDb.collection('workerSessions').findOne({ _id: cc });
  check('1: only its hash is stored, on the run\'s own session row', !!stored?.runKey?.hash && !JSON.stringify(stored).includes(runKey) && stored.runKey.ref === task.ref);
  const m2 = await mint(pc.key, plain);
  const m2b = await mint(pc.key, randomUUID());
  check('1: an ordinary session, or one the server never saw, is "not dispatched" (no key): the worker opens it as the person\'s own', m2.status === 200 && m2.body?.dispatched === false && !m2.body?.key && m2b.status === 200 && m2b.body?.dispatched === false, JSON.stringify([m2, m2b]));
  const m3 = await mint(other.key, cc);
  check('1: another computer gets no key for this run and is told so (400, never "not dispatched")', m3.status === 400 && !m3.body?.key, `${m3.status} ${JSON.stringify(m3.body)}`);
  // A dispatched run the worker had reported dead (a reopen after a restart): the key moves the row back to starting, so the key works.
  const dead = randomUUID();
  await rawDb.collection('workerSessions').insertOne(wsRow(pc, dead, task.id, { projectId: proj, state: 'dead' }));
  const md = await mint(pc.key, dead);
  const deadRow = await rawDb.collection('workerSessions').findOne({ _id: dead });
  const dk = md.body?.key ? await mcpH(md.body.key, 'get_task', { task: task.ref }) : { isError: true, text: 'no key' };
  check('1: a key for a dead dispatched run moves its row to starting and works', md.status === 200 && deadRow?.state === 'starting' && !dk.isError, JSON.stringify([md.status, deadRow?.state, dk.text.slice(0, 80)]));
  // A failed one gets none.
  const failed = randomUUID();
  await rawDb.collection('workerSessions').insertOne(wsRow(pc, failed, task.id, { projectId: proj, state: 'failed' }));
  const mf = await mint(pc.key, failed);
  check('1: a failed dispatched run gets no key (400)', mf.status === 400 && !mf.body?.key, `${mf.status}`);
  const m4 = await mint(MCP, cc);
  check('1: a Claude Code key cannot mint one (device key only)', m4.status === 401, `${m4.status}`);
  const m5 = await mint(runKey, cc);
  check('1: a run key cannot mint one', m5.status === 401, `${m5.status}`);

  // ---- 2: the run key on MCP: a dispatched caller whatever it sends ----
  const sw = await mcpH(runKey, 'start_work', { project: 'DK One' });
  const own = sw.json?.session;
  const row = own ? await rawDb.collection('presence').findOne({ session: own }) : null;
  check('2: start_work with the run key works and its session row is marked dispatched with the forced label', !sw.isError && row?.dispatched?.ref === task.ref && row?.label === `DK One · worker · #${task.ref}`, sw.text.slice(0, 300));
  const ordersIn = sw.json?.orders ?? [];
  check('2: its brief names no way to change the Orders (change: none)', ordersIn.length > 0 && ordersIn.every(o => o.change === 'none'), JSON.stringify(ordersIn.map(o => o.change)));
  const po = await mcpH(runKey, 'propose_order', { project: 'DK One', layer: 'project', new: 'Injected rule.', why: 'x' }, { 'x-work-os-session': own });
  check('2: propose_order is refused for a dispatched run (it tells the person in its report)', po.isError && /proposes none/.test(po.text), po.text.slice(0, 200));
  const leadRow = await rawDb.collection('presence').findOne({ session: lead });
  check('2: the person\'s own session row is not marked', !!leadRow && !leadRow.dispatched);

  const w1 = await mcpH(runKey, 'write_note', { note_id: orders, append: 'Injected with the lead session.', why: 'x' }, { 'x-work-os-session': lead });
  check('2: write_note on Orders with the person\'s real session id (header) is refused', w1.isError && /own session/.test(w1.text), w1.text.slice(0, 300));
  const w2 = await mcpH(runKey, 'write_note', { note_id: orders, append: 'Injected as itself.', why: 'x' }, { 'x-work-os-session': own });
  check('2: write_note on Orders as its own session is refused', w2.isError && /Orders/.test(w2.text), w2.text.slice(0, 300));
  const w3 = await mcpH(runKey, 'write_note', { note_id: orders, append: 'Injected, no session.', why: 'x' });
  check('2: write_note on Orders naming no session is refused', w3.isError && /Orders/.test(w3.text), w3.text.slice(0, 300));
  const w4 = await mcpH(runKey, 'apply_changes', { ops: [{ op: 'write_note', note_id: orders, append: 'Injected via batch.', why: 'x' }] }, { 'x-work-os-session': own });
  check('2: apply_changes write_note on Orders is refused', w4.isError || /Orders/.test(w4.text), w4.text.slice(0, 300));
  check('2: the Orders text is unchanged', !/Injected/.test(await ordersBody(orders)));

  const g1 = await mcpH(runKey, 'set_doing', { task: task.ref, session: lead });
  check('2: a session argument naming the person\'s session is refused', g1.isError && /own session/.test(g1.text), g1.text.slice(0, 300));
  const g1h = await mcpH(runKey, 'get_task', { task: task.ref }, { 'x-work-os-session': lead });
  check('2: the session header naming the person\'s session is refused on any tool', g1h.isError && /own session/.test(g1h.text), g1h.text.slice(0, 300));
  const g2 = await mcpH(runKey, 'end_work', { project: 'DK One', state: [{ op: 'add_later', text: 'DK later line' }], friction: 'none', session: lead });
  check('2: end_work of the person\'s session is refused', g2.isError && /own session/.test(g2.text), g2.text.slice(0, 300));
  check('2: the person\'s session is still open', !(await rawDb.collection('presence').findOne({ session: lead }))?.endedAt);
  const g3 = await mcpH(runKey, 'get_task', { task: task.ref }, { 'x-work-os-session': own });
  check('2: get_task as its own session works', !g3.isError && (g3.json?.ref ?? g3.json?.task?.ref) === task.ref, g3.text.slice(0, 300));
  const ver = (await must(MCP, 'save_state', { project: 'DK One', ops: [{ op: 'set_now', text: 'Lead Now' }], base_version: 0, session: lead })).version;
  const s1 = await mcpH(runKey, 'save_state', { project: 'DK One', ops: [{ op: 'set_now', text: 'Hijacked Now' }], base_version: ver, session: own });
  check('2: set_now as its own (dispatched) session is refused', s1.isError && /dispatched run never sets Now/.test(s1.text), s1.text.slice(0, 300));
  const ml = await mcpH(runKey, 'mail_search', { query: 'invoice' });
  check('2: mail tools are refused', ml.isError && /not available to a dispatched run/.test(ml.text), ml.text.slice(0, 200));
  const dc = await mcpH(runKey, 'discord_list_channels', {});
  check('2: Discord tools are refused', dc.isError && /not available to a dispatched run/.test(dc.text), dc.text.slice(0, 200));
  const lp = await mcpH(runKey, 'log_progress', { task: task.ref, progress: 10, note: 'Working on it', session: own });
  check('2: ordinary work (log_progress on its task) passes', !lp.isError, lp.text.slice(0, 300));
  const n2 = await mcpH(runKey, 'start_work', { project: 'DK One', session: randomUUID() });
  const nrow = n2.json?.session ? await rawDb.collection('presence').findOne({ session: n2.json.session }) : null;
  check('2: a fresh session id it names is marked dispatched too', !n2.isError && nrow?.dispatched?.ref === task.ref, n2.text.slice(0, 200));

  // ---- 3: the run key opens nothing else ----
  const r1 = await api(runKey, 'POST', '/api/agent/start', { ccSession: cc, folders: ['fdk1'] });
  const r2 = await api(runKey, 'GET', '/api/worker/jobs');
  const r3 = await api(runKey, 'GET', '/api/notes');
  check('3: the run key is refused by the hook, worker and app routes', r1.status === 401 && r2.status === 401 && r3.status >= 400, JSON.stringify([r1.status, r2.status, r3.status]));

  // ---- 4: the person's own key is unaffected ----
  const o1 = await mcpH(MCP, 'write_note', { note_id: orders, append: 'Rule two, by the holder.', why: 'DK test: holder edit' }, { 'x-work-os-session': lead });
  check('4: the person\'s own key edits Orders from their own session', !o1.isError && /Rule two, by the holder/.test(await ordersBody(orders)), o1.text.slice(0, 300));
  const o2 = await mcpH(MCP, 'get_task', { task: task.ref, session: lead });
  const o3 = await mcpH(MCP, 'mail_search', { query: 'x' });
  check('4: the person\'s own key takes its session argument and is not refused mail as a dispatched run', !o2.isError && !/dispatched run/.test(o3.text), o3.text.slice(0, 200));

  // ---- 5: lifetime: one live key per run, ends with the run, the expiry or a device key replace ----
  const m6 = await mint(pc.key, cc); // a resume asks again
  const runKey2 = m6.body?.key;
  const old = await mcpH(runKey, 'get_task', { task: task.ref });
  const neu = await mcpH(runKey2, 'get_task', { task: task.ref });
  check('5: a resume gets a new key and the old one stops working', m6.status === 200 && runKey2 !== runKey && old.isError && /Unauthorized/.test(old.text) && !neu.isError, JSON.stringify([m6.status, old.text.slice(0, 80), neu.text.slice(0, 80)]));
  await rawDb.collection('workerSessions').updateOne({ _id: cc }, { $set: { state: 'stopped' } });
  const e1 = await mcpH(runKey2, 'get_task', { task: task.ref });
  check('5: a run the worker reports stopped loses its key', e1.isError && /Unauthorized/.test(e1.text), e1.text.slice(0, 100));
  await rawDb.collection('workerSessions').updateOne({ _id: cc }, { $set: { state: 'running', 'runKey.expiresAt': new Date(Date.now() - 1000) } });
  const e2 = await mcpH(runKey2, 'get_task', { task: task.ref });
  check('5: an expired key is refused', e2.isError && /Unauthorized/.test(e2.text), e2.text.slice(0, 100));
  const runKey3 = (await mint(pc.key, cc)).body?.key;
  const pcHash = (await rawDb.collection('devices').findOne({ _id: pc.id })).hash;
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { hash: 'f'.repeat(64) } });
  const e3 = await mcpH(runKey3, 'get_task', { task: task.ref });
  check('5: a device key replace ends the run key made with the old one', RUN_RE.test(runKey3 ?? '') && e3.isError && /Unauthorized/.test(e3.text), e3.text.slice(0, 100));
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { hash: pcHash } });

  // ---- 6: Resume from the app: the row is starting before the job; a dispatched session whose task is gone is not resumed ----
  const cookie = await signIn(EMAIL);
  const rs1 = randomUUID();
  await rawDb.collection('workerSessions').insertOne(wsRow(pc, rs1, task.id, { projectId: proj, state: 'failed' }));
  const a1 = await act(cookie, 'resumeSessionAction', /launcher-actions\.ts$/, proj, rs1);
  const j1 = await rawDb.collection('workerJobs').findOne({ sessionId: rs1, kind: 'resume' });
  const s1row = await rawDb.collection('workerSessions').findOne({ _id: rs1 });
  check('6: resuming a failed dispatched session: starting, and the job carries the task ref', a1.ok && j1?.dispatched === task.ref && s1row?.state === 'starting', JSON.stringify([a1.text.slice(0, 120), j1?.dispatched, s1row?.state]));
  const rs2 = randomUUID();
  await rawDb.collection('workerSessions').insertOne(wsRow(pc, rs2, 'gone-task-id', { projectId: proj, state: 'dead' }));
  const a2 = await act(cookie, 'resumeSessionAction', /launcher-actions\.ts$/, proj, rs2);
  const j2 = await rawDb.collection('workerJobs').findOne({ sessionId: rs2 });
  const s2row = await rawDb.collection('workerSessions').findOne({ _id: rs2 });
  check('6: a dispatched session whose task is gone is not resumed (no job, row unchanged)', !a2.ok && /task that is gone/.test(a2.text) && !j2 && s2row?.state === 'dead', JSON.stringify([a2.text.slice(0, 160), !!j2, s2row?.state]));
  const m7 = await mint(pc.key, rs2);
  check('6: and it gets no run key either', m7.status === 400 && !m7.body?.key, `${m7.status}`);

  // ---- 7: Reopen all asks in one request; a failed launch releases its key; Open in VS Code refuses a dispatched run ----
  const RK = '/api/worker/run-key';
  const [rd, ro, ru] = [randomUUID(), randomUUID(), randomUUID()];
  await rawDb.collection('workerSessions').insertMany([wsRow(pc, rd, task.id, { projectId: proj, state: 'dead' }), wsRow(other, ro, task.id, { projectId: proj, state: 'dead' })]);
  const b1 = await api(pc.key, 'POST', RK, { sessionIds: [rd, plain, ro, ru] });
  const runs = new Map((b1.body?.runs ?? []).map(x => [x.sessionId, x]));
  const rdRow = await rawDb.collection('workerSessions').findOne({ _id: rd });
  check('7: one batched request answers each session: a key for this computer\'s dispatched run, "not dispatched" for others, refused for another computer\'s',
    b1.status === 200 && RUN_RE.test(runs.get(rd)?.key ?? '') && runs.get(rd)?.ref === task.ref && runs.get(plain)?.dispatched === false && runs.get(ru)?.dispatched === false && !!runs.get(ro)?.refused && !runs.get(ro)?.key && rdRow?.state === 'starting' && rdRow?.runKey?.from === 'dead',
    JSON.stringify([b1.status, [...runs.values()].map(x => Object.keys(x).sort().join(',')), rdRow?.state, rdRow?.runKey?.from]));
  const b2 = await api(pc.key, 'POST', RK, { sessionIds: Array.from({ length: 21 }, () => randomUUID()) });
  check('7: more than 20 in one request is refused', b2.status === 400, `${b2.status}`);
  const rdKey = runs.get(rd)?.key;
  const wrong = await api(pc.key, 'POST', RK, { sessionId: rd, release: 'wdr_' + 'A'.repeat(43) });
  const otherRel = await api(other.key, 'POST', RK, { sessionId: rd, release: rdKey });
  check('7: a release needs this computer and the key it was given', wrong.body?.released === false && otherRel.body?.released === false && (await rawDb.collection('workerSessions').findOne({ _id: rd }))?.state === 'starting', JSON.stringify([wrong.body, otherRel.body]));
  const rel = await api(pc.key, 'POST', RK, { sessionId: rd, release: rdKey });
  const rdAfter = await rawDb.collection('workerSessions').findOne({ _id: rd });
  const eRel = await mcpH(rdKey, 'get_task', { task: task.ref });
  check('7: a failed launch releases its key: the key dies and the row goes back to dead', rel.body?.released === true && rdAfter?.state === 'dead' && !rdAfter?.runKey && eRel.isError && /Unauthorized/.test(eRel.text), JSON.stringify([rel.body, rdAfter?.state, !!rdAfter?.runKey, eRel.text.slice(0, 60)]));
  const hashBefore = (await rawDb.collection('workerSessions').findOne({ _id: cc }))?.runKey?.hash;
  const c1 = await api(pc.key, 'POST', RK, { sessionId: cc, check: true });
  const c2 = await api(pc.key, 'POST', RK, { sessionId: plain, check: true });
  const hashAfter = (await rawDb.collection('workerSessions').findOne({ _id: cc }))?.runKey?.hash;
  check('7: the VS Code check says which sessions are dispatched runs and mints nothing', c1.body?.dispatched === true && c2.body?.dispatched === false && !/wdr_/.test(c1.text + c2.text) && hashBefore === hashAfter, JSON.stringify([c1.body, c2.body, hashBefore === hashAfter]));
  const item = (sessionId, title) => ({ sessionId, folder: 'fdk1', title, lastActiveAt: new Date(), subagentsActive: 0, startedByWorkOs: true, running: true, origin: 'vscode' });
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { lastSeenAt: new Date(), claudeSessions: { at: new Date(), items: [item(cc, 'dk dispatched'), item(plain, 'dk plain')] } } });
  const v1 = await act(cookie, 'openInVscodeAction', /launcher-actions\.ts$/, pc.id, cc);
  const vj1 = await rawDb.collection('workerJobs').findOne({ sessionId: cc, kind: 'vscode' });
  check('7: Open in VS Code refuses a dispatched run (use Resume) and queues nothing', !v1.ok && /own key: use Resume/.test(v1.text) && !vj1, v1.text.slice(0, 160));
  const v2 = await act(cookie, 'openInVscodeAction', /launcher-actions\.ts$/, pc.id, plain);
  const vj2 = await rawDb.collection('workerJobs').findOne({ sessionId: plain, kind: 'vscode' });
  check('7: an ordinary session still opens in VS Code', v2.ok && !!vj2, v2.text.slice(0, 160));
  void B;
} catch (e) {
  check('suite ran without throwing', false, e?.stack || String(e));
}
await finish();
