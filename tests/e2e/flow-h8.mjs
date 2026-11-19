// Flow H8 (plan note 63bf2014de): the three blocks. The server half of block 1 and 2: a release Need (ask with release: true),
// what production means per project (default from the code remotes, set in the app only), the brief's production field for the
// hook, and the grant route POST /api/agent/release (wst_ token only). The hook half is worker/test/hook-h8.test.mjs.
// Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const call = async (url, cred, body = {}, { headers = {}, raw, method = 'POST' } = {}) => {
  const r = await fetch(B + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), ...headers }, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
};
const folder = (dev, who, fid, remote, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
async function deviceOf(who, name) {
  const dev = await mkDevice(name);
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { ownerId: who.userId, orgId: who.orgId, name } });
  return dev;
}
const HOOK = { 'X-Work-OS-Hook': '1' };

try {
  const T = await makeUser({ email: 'tess-h8@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const kOm = await mkKey({ agent: 'claude-code', name: 'H8 Om Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  const ONE = (await must(MCP, 'add_project', { name: 'H8 One', code: [{ remote: 'acme/h8-one' }, { remote: 'acme/h8-site' }] })).project.id;
  const TESS = (await must(kT, 'add_project', { name: 'H8 Tess', visibility: 'org', code: [{ remote: 'acme/h8-tess' }] })).project.id;
  await must(MCP, 'save_state', { project: 'H8 One', ops: [{ op: 'add_next', text: 'H8 line' }] });
  const one = () => rawDb.collection('projects').findOne({ _id: ONE });
  const needDoc = ref => rawDb.collection('needs').findOne({ orgId: ME.orgId, ref });

  // ---- a) the release Need: fixed, app-only, to the owner ----
  const a1 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Release H8 One to production' });
  const n1 = a1.json?.need;
  const d1 = n1 ? await needDoc(n1.ref) : null;
  check('a: ask {release: true, kind approve} needs no "to": it goes to the project owner', !a1.isError && d1?.to === ME.userId && d1?.release === true, a1.text.slice(0, 300));
  check('a: the options are the three the server fixes (yes, day, no), the first is "Yes, release"', JSON.stringify(d1?.options?.map(o => o.id)) === '["yes","day","no"]' && d1.options[0].label === 'Yes, release' && d1.options[1].label === 'Yes, for 24 hours' && d1.options[2].label === 'No', JSON.stringify(d1?.options));
  check('a: it is app-only whatever the words say', d1?.appOnly === true);
  const a2 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Release again', options: [{ label: 'Sure' }, { label: 'Nope' }] });
  const d2 = a2.json?.need ? await needDoc(a2.json.need.ref) : null;
  check('a: options an agent passes are ignored: the server fixes them', !a2.isError && JSON.stringify(d2?.options?.map(o => o.id)) === '["yes","day","no"]', a2.text.slice(0, 300));
  const a3 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'decide', release: true, ask: 'Release?', options: [{ label: 'A' }, { label: 'B' }] });
  check('a: kind decide with release is refused', a3.isError && /approve/.test(a3.text), a3.text.slice(0, 200));
  const aT = await mcpH(kT, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Tess wants to release H8 One' });
  const dT = aT.json?.need ? await needDoc(aT.json.need.ref) : null;
  check("a: a teammate's agent asks too, and it still goes to the owner (Om), not to the asker", !aT.isError && dT?.to === ME.userId && dT?.from?.actor?.userId === T.userId, aT.text.slice(0, 300));
  const aTme = await mcpH(kT, 'ask', { project: 'H8 One', to: 'me', kind: 'approve', release: true, ask: 'Release, asking myself' });
  check('a: "me" on someone else\'s project is refused (the AKAR shape): a release goes to the owner', aTme.isError && /owner/.test(aTme.text), aTme.text.slice(0, 200));
  const aOwn = await mcpH(kOm, 'ask', { project: 'H8 One', to: 'Tess', kind: 'approve', release: true, ask: 'Release, to Tess' });
  check('a: naming another person than the owner is refused', aOwn.isError && /owner/.test(aOwn.text), aOwn.text.slice(0, 200));
  const aPlain = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', ask: 'No to given' });
  check('a: without release, "to" is still required', aPlain.isError && /to is required/.test(aPlain.text), aPlain.text.slice(0, 200));
  const aNo = await mcpH(kOm, 'ask', { project: 'H8 One', to: 'me', kind: 'approve', ask: 'An ordinary approve' });
  const dNo = aNo.json?.need ? await needDoc(aNo.json.need.ref) : null;
  check('a: an ordinary approve Need has no release mark and keeps Yes / No', !dNo?.release && JSON.stringify(dNo?.options?.map(o => o.id)) === '["yes","no"]', JSON.stringify(dNo));

  // ---- b) production per project: default, the brief for the hook, no MCP way to change it ----
  const pc = await deviceOf(ME, 'h8-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pc, ME, 'f1', 'acme/h8-one', ONE));
  const body0 = { remote: 'https://github.com/acme/h8-one.git', branch: 'main', path: 'C:/code/h8-one', label: 'H8 · builder', ccSession: randomUUID(), source: 'startup' };
  const st = await call('/api/agent/start', pc.key, body0);
  const prod = st.json?.brief?.production;
  check("b: the hook's start brief carries production: the code remotes, main and master, no CLI targets (the default)", st.status === 200 && JSON.stringify(prod) === JSON.stringify({ remotes: ['acme/h8-one', 'acme/h8-site'], branches: ['main', 'master'], targets: [] }), JSON.stringify(prod) + st.text.slice(0, 200));
  const sw = await mcpH(kOm, 'start_work', { project: 'H8 One' });
  check('b: start_work without the hook header has no production field (no tokens spent)', !sw.isError && !('production' in (sw.json ?? {})), sw.text.slice(0, 200));
  const swh = await mcpH(kOm, 'start_work', { project: 'H8 One' }, HOOK);
  check('b: start_work with the hook header carries it', !swh.isError && JSON.stringify(swh.json?.production?.remotes) === '["acme/h8-one","acme/h8-site"]', swh.text.slice(0, 200));
  const up = await mcpH(kOm, 'update_project', { project: 'H8 One', production: { off: true, remotes: [], branches: [], targets: [] }, description: 'h8 touched' });
  const ac = await mcpH(kOm, 'apply_changes', { changes: [{ op: 'update_project', project: 'H8 One', production: { off: true, remotes: [], branches: [], targets: [] } }] });
  check('b: update_project and apply_changes cannot set production (nothing is stored)', !(await one()).production && !(await one()).productionBy, JSON.stringify([up.text.slice(0, 120), ac.text.slice(0, 120)]));
  void TESS;
} catch (e) {
  check('flow-h8 ran to the end', false, String(e?.stack ?? e));
}
await finish();
