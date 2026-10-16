// Backend checks for the session launcher: worker API auth, folder validation, job isolation, rate limit. Seed profile: none.
import { B, check, db, mkDevice, mkWos, api, mcp, MCP, finish } from './lib.mjs';
import { randomUUID } from 'node:crypto';
const A = await mkDevice('dev-A'), Bd = await mkDevice('dev-B');
const wos = await mkWos();
const rev = await mkDevice('dev-revoked'); await db.collection('devices').updateOne({ _id: rev.id }, { $set: { revokedAt: new Date() } });

// auth
for (const [label, key] of [['no key', null], ['wos_ key', wos], ['MCP_TOKEN', MCP], ['revoked wkr_', rev.key], ['garbage wkr_', 'wkr_' + 'a'.repeat(43)], ['wkr_ too short', 'wkr_abc']]) {
  for (const [m, p, b] of [['GET', '/api/worker/jobs'], ['POST', '/api/worker/folders', { folders: [] }], ['POST', '/api/worker/status', {}]]) {
    const r = await api(key, m, p, b);
    check(`refuse ${label} on ${m} ${p}`, r.status === 401, r.status);
  }
}
const r0 = await api(A.key, 'POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'application/json, text/event-stream' });
check('wkr_ key refused on /api/mcp', r0.status === 401, r0.status);
const r1 = await fetch(B + '/today', { headers: { authorization: `Bearer ${A.key}` }, redirect: 'manual' });
check('wkr_ key does not open UI', r1.status === 307 || r1.status === 302 || r1.status === 401, r1.status);
const r2 = await api(A.key, 'GET', '/api/export');
check('wkr_ key refused on other /api route', r2.status === 401 || r2.status === 404, r2.status);
check('valid wkr_ GET jobs', (await api(A.key, 'GET', '/api/worker/jobs')).status === 200);
check('lastSeenAt set', !!(await db.collection('devices').findOne({ _id: A.id })).lastSeenAt);

// folders validation
const good = { id: 'f_good1', name: 'pms', git: true, remote: 'github.com/Om/PMS.git', branch: 'master' };
const post = f => api(A.key, 'POST', '/api/worker/folders', { folders: Array.isArray(f) ? f : [f] });
check('good folder accepted', (await post(good)).status === 200);
for (const bad of ['C:\\Users\\om\\pms', 'c:/work/pms', '/home/om/pms', '~/pms', '\\\\server\\share', '../x', 'a/../b', 'D:foo']) {
  const r = await post({ ...good, id: 'f_bad01', name: bad }); check(`path-like name rejected: ${bad}`, r.status === 400, r.status);
}
const r3 = await post({ ...good, id: 'f_rel001', name: 'AKAR-wt\\debt-3' }); check('backslash inside relative name accepted + normalised to /', r3.status === 200);
check('stored as AKAR-wt/debt-3', !!(await db.collection('workerFolders').findOne({ _id: `${A.id}:f_rel001`, name: 'AKAR-wt/debt-3' })));
check('name >120 rejected', (await post({ ...good, id: 'f_long01', name: 'x'.repeat(121) })).status === 400);
check('bad id rejected', (await post({ ...good, id: 'a b' })).status === 400);
check('short id rejected', (await post({ ...good, id: 'abc' })).status === 400);
check('missing name rejected', (await post({ id: 'f_noname' })).status === 400);
check('non-array folders rejected', (await api(A.key, 'POST', '/api/worker/folders', { folders: 'x' })).status === 400);
check('non-JSON rejected 400', (await api(A.key, 'POST', '/api/worker/folders', 'not json')).status === 400);
check('null body -> 400 not 500', (await api(A.key, 'POST', '/api/worker/folders', 'null')).status === 400);
check('body too large -> 413', (await api(A.key, 'POST', '/api/worker/folders', JSON.stringify({ folders: [], pad: 'x'.repeat(1_100_000) }))).status === 413);
check('>3000 folders rejected', (await post(Array.from({ length: 3001 }, (_, i) => ({ id: `f_${String(i).padStart(6, '0')}`, name: `n${i}` })))).status === 400);
const remotes = [
  ['https://user:s3cretpw@github.com/Om/Repo.git', 'om/repo'],
  ['https://x-access-token:ghp_ABCDEF@github.com/Om/Repo', 'om/repo'],
  ['git@github.com:Om/Repo.git', 'om/repo'],
  ['ssh://git@gitlab.com/grp/sub/proj.git', 'sub/proj'],
  ['not a remote', null],
  ['https://user:pw@host/', null],
];
const sent = remotes.map(([r], i) => ({ id: `f_rem${i}x`, name: `rem${i}`, git: true, remote: r }));
const rr = await post(sent); check('remotes batch accepted (bad remotes dropped, folder kept)', rr.status === 200, JSON.stringify(rr.body));
for (let i = 0; i < remotes.length; i++) {
  const d = await db.collection('workerFolders').findOne({ _id: `${A.id}:f_rem${i}x` });
  const got = d?.remote ?? null; const want = remotes[i][1];
  check(`remote ${remotes[i][0].replace(/:[^:@/]*@/, ':***@')} -> ${want}`, got === want, `got ${got}`);
}
const all = JSON.stringify(await db.collection('workerFolders').find({}).toArray());
check('no credentials stored anywhere', !/s3cretpw|ghp_ABCDEF/.test(all));
const rep = await post([good]); check('rescan: known=1', rep.body?.known === 1, JSON.stringify(rep.body));
check('others marked missing, not deleted', (await db.collection('workerFolders').countDocuments({ deviceId: A.id })) > 1 && (await db.collection('workerFolders').countDocuments({ deviceId: A.id, missing: true })) > 1);
check('rescan with empty list marks all missing', (await post([])).body?.ok === true);
await post([good]);

// jobs / isolation
await mcp('add_project', { name: 'LT Project' });
const pid = (await db.collection('projects').findOne({ name: 'LT Project' }))._id;
await db.collection('workerFolders').updateOne({ _id: `${A.id}:f_good1` }, { $set: { projectId: pid, linkedAt: new Date() } });
const jb = await api(A.key, 'GET', '/api/worker/jobs');
check('links include linked folder', jb.body.links?.length === 1 && jb.body.links[0].folderId === 'f_good1' && jb.body.links[0].projectName === 'LT Project', JSON.stringify(jb.body));
check('device B sees no A links', (await api(Bd.key, 'GET', '/api/worker/jobs')).body.links.length === 0);
const sid = randomUUID();
await db.collection('workerSessions').insertOne({ _id: sid, deviceId: A.id, folderId: 'f_good1', projectId: pid, state: 'starting', startedAt: new Date(), updatedAt: new Date() });
await db.collection('workerJobs').insertOne({ _id: 'j_iso1', deviceId: A.id, kind: 'start', sessionId: sid, folderId: 'f_good1', projectId: pid, createdAt: new Date(), takenAt: null, doneAt: null });
check('B does not see A job', (await api(Bd.key, 'GET', '/api/worker/jobs')).body.jobs.length === 0);
await api(Bd.key, 'POST', '/api/worker/status', { jobs: [{ id: 'j_iso1', ok: true }], sessions: [{ sessionId: sid, folderId: 'f_good1', state: 'dead' }] });
let jd = await db.collection('workerJobs').findOne({ _id: 'j_iso1' }), sd = await db.collection('workerSessions').findOne({ _id: sid });
check('B cannot complete A job', jd.doneAt === null);
check('B cannot change A session', sd.state === 'starting');
check('B cannot invent a session', (await api(Bd.key, 'POST', '/api/worker/status', { sessions: [{ sessionId: randomUUID(), folderId: 'x', state: 'running' }] })).status === 200 && (await db.collection('workerSessions').countDocuments({ deviceId: Bd.id })) === 0);
const jA = await api(A.key, 'GET', '/api/worker/jobs'); check('A gets its job', jA.body.jobs.length === 1 && jA.body.jobs[0].id === 'j_iso1' && jA.body.jobs[0].kind === 'start' && jA.body.jobs[0].sessionId === sid, JSON.stringify(jA.body.jobs));
check('job handed out once', (await api(A.key, 'GET', '/api/worker/jobs')).body.jobs.length === 0);
await db.collection('workerJobs').updateOne({ _id: 'j_iso1' }, { $set: { takenAt: new Date(Date.now() - 11 * 60_000) } });
check('job re-offered after 10 min', (await api(A.key, 'GET', '/api/worker/jobs')).body.jobs.length === 1);
await api(A.key, 'POST', '/api/worker/status', { worker: { version: '0.1.0', os: 'win32' }, jobs: [{ id: 'j_iso1', ok: true }], sessions: [{ sessionId: sid, folderId: 'f_good1', state: 'running' }] });
jd = await db.collection('workerJobs').findOne({ _id: 'j_iso1' }); sd = await db.collection('workerSessions').findOne({ _id: sid });
check('A completes its job + session running', jd.doneAt && jd.ok === true && sd.state === 'running');
check('device worker info stored', (await db.collection('devices').findOne({ _id: A.id })).worker?.os === 'win32');
check('junk entries in status ignored (200)', (await api(A.key, 'POST', '/api/worker/status', { jobs: [null, 1, 'x'], sessions: [null, 3, { sessionId: 'nope', state: 'running' }, { sessionId: sid, state: 'weird' }] })).status === 200);
check('session state unchanged by weird state', (await db.collection('workerSessions').findOne({ _id: sid })).state === 'running');
check('jobs not array -> 400', (await api(A.key, 'POST', '/api/worker/status', { jobs: 'x' })).status === 400);
const sid2 = randomUUID();
await db.collection('workerSessions').insertOne({ _id: sid2, deviceId: A.id, folderId: 'f_good1', projectId: pid, state: 'starting', startedAt: new Date(), updatedAt: new Date() });
await db.collection('workerJobs').insertOne({ _id: 'j_fail1', deviceId: A.id, kind: 'start', sessionId: sid2, createdAt: new Date(), takenAt: new Date(), doneAt: null });
await api(A.key, 'POST', '/api/worker/status', { jobs: [{ id: 'j_fail1', ok: false, error: 'e'.repeat(500) }] });
const fs2 = await db.collection('workerSessions').findOne({ _id: sid2 }); check('failed job -> session failed, error <=300', fs2.state === 'failed' && fs2.error.length === 300);

// rate limit
const L = await mkDevice('dev-rate');
let first429 = -1;
for (let i = 1; i <= 70; i++) { const r = await api(L.key, 'GET', '/api/worker/jobs'); if (r.status === 429 && first429 < 0) first429 = i; }
check('rate limit: 429 starts at call 61', first429 === 61, `first 429 at ${first429}`);
check('rate limit is per device (A still OK)', (await api(A.key, 'GET', '/api/worker/jobs')).status === 200);
await db.collection('devices').updateOne({ _id: Bd.id }, { $set: { revokedAt: new Date() } });
check('revoked B refused', (await api(Bd.key, 'GET', '/api/worker/jobs')).status === 401);
await finish();
