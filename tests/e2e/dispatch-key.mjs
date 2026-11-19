// Run keys (docs/dispatcher.md "Run keys"): a dispatched run's own Work OS credential. The worker asks for one with its device key
// (POST /api/worker/run-key) for this computer's own dispatched session; every MCP call made with it is dispatched on the server,
// whatever the run sends: Orders are never writable (even naming the person's real session), a session id that is not the run's
// is refused, mail and Discord are refused, and the sessions it starts are marked. The person's own key is unaffected.
// Keys are generated test values and never printed (check() redacts). Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, api, check, finish, mkDevice, rawDb } from './lib.mjs';
import { must, mcpH, markOrders } from './flow-lib.mjs';

const RUN_RE = /^wdr_[A-Za-z0-9_-]{43}$/;
const folderRow = (dev, fid, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote: 'acme/dk-one', projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
const wsRow = (dev, id, taskId, extra = {}) => ({ _id: id, orgId: ME.orgId, ownerId: ME.userId, deviceId: dev.id, folderId: 'fdk1', projectId: extra.projectId, state: 'running', startedAt: new Date(), updatedAt: new Date(), ...(taskId ? { dispatched: true, taskId } : {}), ...extra });
const mint = (devKey, sessionId) => api(devKey, 'POST', '/api/worker/run-key', { sessionId });
const ordersBody = async id => (await rawDb.collection('notes').findOne({ _id: id }))?.body ?? '';

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
  const lead = (await must(MCP, 'start_work', { project: 'DK One', label: 'DK · lead' })).session;
  check('setup: the person has a real session id', typeof lead === 'string' && lead.length > 8, String(lead));

  // ---- 1: minting: only the computer's own dispatched session, only with its device key ----
  const m1 = await mint(pc.key, cc);
  const runKey = m1.body?.key;
  check('1: the device key gets a run key for its own dispatched session', m1.status === 200 && RUN_RE.test(runKey ?? '') && !!m1.body?.expiresAt, `${m1.status} ${JSON.stringify(m1.body)}`);
  const stored = await rawDb.collection('workerSessions').findOne({ _id: cc });
  check('1: only its hash is stored, on the run\'s own session row', !!stored?.runKey?.hash && !JSON.stringify(stored).includes(runKey) && stored.runKey.ref === task.ref);
  const m2 = await mint(pc.key, plain);
  check('1: an ordinary (not dispatched) session gets none', m2.status === 400 && !m2.body?.key, `${m2.status}`);
  const m3 = await mint(other.key, cc);
  check('1: another computer gets none for this run', m3.status === 400 && !m3.body?.key, `${m3.status}`);
  const m4 = await mint(MCP, cc);
  check('1: a Claude Code key cannot mint one (device key only)', m4.status === 401, `${m4.status}`);
  const m5 = await mint(runKey, cc);
  check('1: a run key cannot mint one', m5.status === 401, `${m5.status}`);

  // ---- 2: the run key on MCP: a dispatched caller whatever it sends ----
  const sw = await mcpH(runKey, 'start_work', { project: 'DK One' });
  const own = sw.json?.session;
  const row = own ? await rawDb.collection('presence').findOne({ session: own }) : null;
  check('2: start_work with the run key works and its session row is marked dispatched with the forced label', !sw.isError && row?.dispatched?.ref === task.ref && row?.label === `DK One · worker · #${task.ref}`, sw.text.slice(0, 300));
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
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { hash: 'f'.repeat(64) } });
  const e3 = await mcpH(runKey3, 'get_task', { task: task.ref });
  check('5: a device key replace ends the run key made with the old one', RUN_RE.test(runKey3 ?? '') && e3.isError && /Unauthorized/.test(e3.text), e3.text.slice(0, 100));
  void B;
} catch (e) {
  check('suite ran without throwing', false, e?.stack || String(e));
}
await finish();
