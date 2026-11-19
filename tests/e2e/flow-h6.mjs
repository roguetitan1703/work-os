// Flow H6 (plan note 94de045351, steps 1-3): a Claude Code session's state from its hook. POST /api/agent/event
// (app/api/agent/event/route.ts, lib/data/presence.ts recordEvent, lib/data/presence-state.ts) takes a wst_ session token
// only and sets the state of that session's own presence row. Covers: the auth sweep (no credential, a device key, wos_ keys,
// a chat key, X-API-Key, a cookie, a made-up token, the session id: 401), bad bodies (400, 413), the sequence through the real
// start route (on, working, waiting at a prompt, working, idle, off, on again), out-of-order and future events, the state
// rules on read for seeded rows (working 40 min old, idle 9 h old, the daemon list for the Claude Code session id, an
// open Need, a row with no hook), the daemon join by ccSession and machine id, who sees what (a teammate sees "Waiting on a
// person" and never the prompt or ccSession, another organization sees nothing, a teammate's token touches only their own
// row), no State, feed or cursor writes, and the hourly limit (300). Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, EMAIL, MCP, ME, PW, check, finish, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const call = async (url, cred, body = {}, { headers = {}, raw, method = 'POST' } = {}) => {
  const r = await fetch(B + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), ...headers }, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
};
const start = (cred, body) => call('/api/agent/start', cred, body);
const ev = (cred, body, o) => call('/api/agent/event', cred, body, o);
const folder = (dev, who, fid, remote, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
async function deviceOf(who, name) {
  const dev = await mkDevice(name);
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { ownerId: who.userId, orgId: who.orgId, name } });
  return dev;
}
const body0 = { remote: 'https://github.com/acme/h6-one.git', branch: 'main', path: 'C:/code/h6-one', label: 'Claude Code' };
const ago = min => new Date(Date.now() - min * 60_000);
async function cookieOf(email) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
const unesc = s => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const page = async ck => (await fetch(B + '/claude?tab=workers', { headers: { cookie: ck } })).text();
/** The worker rows of a Workers page: { id, state, text }. */
function workers(h) {
  const starts = [...h.matchAll(/<li[^>]*data-worker="([^"]*)"[^>]*>/g)];
  return starts.map((m, i) => {
    const seg = h.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : h.indexOf('</ul>', m.index));
    return { id: m[1], state: /data-state="(\w+)"/.exec(m[0])?.[1], text: unesc(seg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) };
  });
}

try {
  const ONE = (await must(MCP, 'add_project', { name: 'H6 One', code: [{ remote: 'acme/h6-one' }] })).project.id;
  const pc = await deviceOf(ME, 'h6-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pc, ME, 'f1', 'acme/h6-one', ONE));
  const ck = await cookieOf(EMAIL);
  const rowId = sid => `${ME.userId}:s:${sid}:${ONE}`;
  const prow = sid => rawDb.collection('presence').findOne({ _id: rowId(sid) });
  const stateOf = async sid => workers(await page(ck)).find(w => w.id === rowId(sid));
  const newSession = async (extra = {}) => {
    const r = await start(pc.key, { ...body0, ...extra });
    return { token: r.json?.token ?? '', sid: r.json?.brief?.session ?? '' };
  };

  const CC = randomUUID();
  const S = await newSession({ ccSession: CC, source: 'startup' });
  check('setup: a session token and a presence row that is on', /^wst_/.test(S.token) && (await prow(S.sid))?.activity?.state === 'on', JSON.stringify(await prow(S.sid)));

  // ---- bad credentials ----
  const wos = await mkKey({ agent: 'claude-code', name: 'cc' });
  const refusedAll = [
    ['no credential', await ev('', { event: 'prompt' })],
    ['a device key', await ev(pc.key, { event: 'prompt' })],
    ['a Claude Code key', await ev(wos, { event: 'prompt' })],
    ['a Claude chat key', await ev(MCP, { event: 'prompt' })],
    ['a made-up token', await ev('wst_' + 'a'.repeat(43), { event: 'prompt' })],
    ['the session id as a token', await ev(S.sid, { event: 'prompt' })],
    ['the token in X-API-Key', await ev('', { event: 'prompt' }, { headers: { 'x-api-key': S.token } })],
    ['the token in a cookie', await ev('', { event: 'prompt' }, { headers: { cookie: `token=${S.token}` } })],
    ['Basic auth', await ev('', { event: 'prompt' }, { headers: { authorization: `Basic ${Buffer.from('x:' + S.token).toString('base64')}` } })],
  ];
  for (const [label, r] of refusedAll) check(`${label}: 401, no cookie`, r.status === 401 && !r.headers.get('set-cookie') && !/"state"/.test(r.text), `${r.status} ${r.text.slice(0, 120)}`);
  check('GET: 405', (await call('/api/agent/event', S.token, {}, { method: 'GET' })).status === 405);
  check('the refused calls changed nothing', (await prow(S.sid)).activity.state === 'on');

  // ---- bad bodies ----
  const bad = async (label, b, o) => { const r = await ev(S.token, b, o); check(`${label}: 400`, r.status === 400, `${r.status} ${r.text.slice(0, 120)}`); };
  await bad('an empty body', {}, { raw: '' });
  await bad('not JSON', null, { raw: '{nope' });
  await bad('no event', {});
  await bad('an unknown event', { event: 'delete' });
  await bad('an unknown kind', { event: 'notify', kind: 'whatever' });
  await bad('an extra field (a state)', { event: 'prompt', state: 'off' });
  await bad('an extra field (the message text)', { event: 'notify', kind: 'permission_prompt', message: 'Claude needs your permission to run git push' });
  await bad('at that is not a number', { event: 'prompt', at: 'now' });
  check('a body over 1 KB: 413', (await ev(S.token, { event: 'prompt', kind: 'x'.repeat(1100) })).status === 413);
  check('the refused bodies changed nothing', (await prow(S.sid)).activity.state === 'on');

  // ---- the sequence through the real start route ----
  const seq = async (label, body, want, test) => {
    const r = await ev(S.token, body);
    const got = await stateOf(S.sid);
    check(`${label}: answer ${want}, the Workers tab shows it`, r.status === 200 && r.json?.state === want && got?.state === want && (!test || test(got)), `${r.status} ${r.text.slice(0, 100)} / ${JSON.stringify(got)?.slice(0, 200)}`);
  };
  check('a started session shows on', (await stateOf(S.sid))?.state === 'on');
  await seq('prompt', { event: 'prompt' }, 'working');
  await seq('notify permission_prompt', { event: 'notify', kind: 'permission_prompt' }, 'waiting', g => /Waiting on you/.test(g.text));
  check('the row keeps why: prompt', (await prow(S.sid)).activity.why === 'prompt');
  await seq('tool', { event: 'tool' }, 'working', g => !/Waiting/.test(g.text));
  check('working again drops why', (await prow(S.sid)).activity.why === undefined);
  await seq('stop', { event: 'stop' }, 'idle');
  await seq('notify idle_prompt', { event: 'notify', kind: 'idle_prompt' }, 'idle');
  const ig = await ev(S.token, { event: 'notify', kind: 'auth_success' });
  check('a notification of another kind changes nothing (ignored)', ig.status === 200 && ig.json?.ignored === true && (await prow(S.sid)).activity.state === 'idle', ig.text);
  await seq('elicitation_dialog', { event: 'notify', kind: 'elicitation_dialog' }, 'waiting');
  await seq('end', { event: 'end' }, 'off');
  const rs = await start(S.token, { ...body0, ccSession: CC, source: 'resume' });
  check('a resume start with the kept token is on again', rs.status === 200 && !rs.json?.token && (await stateOf(S.sid))?.state === 'on', rs.text.slice(0, 120));
  const cs = await start(S.token, { ...body0, ccSession: CC, source: 'compact' });
  check('a compaction start is working', cs.status === 200 && (await stateOf(S.sid))?.state === 'working');

  // ---- order: an older event is ignored, a far-future one is clamped ----
  const O = await newSession();
  await ev(O.token, { event: 'prompt', at: Date.now() });
  const old = await ev(O.token, { event: 'stop', at: Date.now() - 120_000 });
  check('an event older than the stored one does not change the state (the answer is the stored state)', old.status === 200 && old.json?.state === 'working' && (await prow(O.sid)).activity.state === 'working', old.text);
  const fut = await ev(O.token, { event: 'stop', at: Date.now() + 10 * 86_400_000 });
  const fa = (await prow(O.sid)).activity.at.getTime();
  check('an event dated days ahead is accepted but clamped to about 5 minutes ahead', fut.json?.state === 'idle' && fa <= Date.now() + 5 * 60_000 + 2000 && fa > Date.now(), `${fut.text} ${fa - Date.now()}`);
  const stale = await ev(O.token, { event: 'prompt', at: Date.now() - 400_000 });
  check('an event from long ago is older than the stored one: ignored', stale.json?.state === 'idle', stale.text);

  // ---- the state rules on read (seeded rows) ----
  const R = await newSession({ ccSession: randomUUID(), source: 'startup' });
  const setRow = (s, set) => rawDb.collection('presence').updateOne({ _id: rowId(s.sid) }, { $set: set });
  const ccOfRow = async s => (await prow(s.sid)).ccSession;
  const daemonList = items => rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { claudeSessions: { at: new Date(), items } } });
  const item = (sessionId, running) => ({ sessionId, folder: 'f', title: 't', lastActiveAt: new Date(), subagentsActive: 0, startedByWorkOs: false, running });
  const want = async (label, s, state) => { const g = await stateOf(s.sid); check(label, g?.state === state, `${g?.state} wanted ${state}`); };
  await daemonList([]);
  await setRow(R, { activity: { state: 'working', at: ago(40) }, lastSeen: ago(40) });
  await want('working for 40 minutes with no word since, no daemon word: idle', R, 'idle');
  await setRow(R, { activity: { state: 'working', at: ago(5) }, lastSeen: ago(5) });
  await want('working 5 minutes ago: working', R, 'working');
  await setRow(R, { activity: { state: 'idle', at: ago(9 * 60) }, lastSeen: ago(9 * 60) });
  await want('idle for 9 hours, no daemon word: off', R, 'off');
  await daemonList([item(await ccOfRow(R), true)]);
  await want('idle for 9 hours but the daemon says its process (Claude Code session id) runs: idle', R, 'idle');
  await daemonList([item(await ccOfRow(R), false)]);
  await setRow(R, { activity: { state: 'idle', at: ago(2) }, lastSeen: ago(2) });
  await want('idle 2 minutes ago but the fresh daemon list says it is not running: off', R, 'off');
  await daemonList([item(randomUUID(), true)]);
  await want('the daemon lists other sessions only: no word on this one, idle', R, 'idle');
  await setRow(R, { activity: { state: 'waiting', at: ago(9 * 60), why: 'prompt' }, lastSeen: ago(9 * 60) });
  await want('waiting at a prompt for 9 hours, no word from the daemon: off', R, 'off');
  await setRow(R, { activity: { state: 'waiting', at: ago(20), why: 'prompt' }, lastSeen: ago(20) });
  await want('waiting at a prompt for 20 minutes: waiting', R, 'waiting');
  // An open Need (matched on the session id)
  await setRow(R, { activity: { state: 'idle', at: ago(2) }, lastSeen: ago(2) });
  const need = await must(wos, 'ask', { project: 'H6 One', to: 'me', kind: 'approve', ask: 'H6 ship?', session: R.sid });
  const g1 = await stateOf(R.sid);
  check('idle with an open Need it asked: waiting (on a Need)', g1?.state === 'waiting' && /Waiting on a person/.test(g1.text), JSON.stringify(g1)?.slice(0, 200));
  await setRow(R, { activity: { state: 'working', at: ago(1) }, lastSeen: ago(1) });
  await want('working with an open Need: working (the hook knows better than a quiet session)', R, 'working');
  await must(wos, 'withdraw_need', { id: need.need.ref, session: R.sid });
  // A row with no hook (a call-based session) keeps the 10/30-minute rules
  const key = await mkKey({ agent: 'claude-code', name: 'Plain Code' });
  await must(key, 'start_work', { project: 'H6 One', label: 'plain', session: 'h6-plain' });
  const plain = { sid: 'h6-plain' };
  check('a session with no hook has no activity', (await prow('h6-plain')).activity === undefined);
  await want('a call-based session seen just now: working', plain, 'working');
  await setRow(plain, { lastSeen: ago(20) });
  await want('a call-based session seen 20 minutes ago: idle', plain, 'idle');
  await setRow(plain, { lastSeen: ago(45) });
  await want('a call-based session seen 45 minutes ago: off', plain, 'off');

  // ---- the daemon join and the machine ----
  const pr = await prow(S.sid);
  check('the row’s machine is the computer’s id and its name the computer’s name; ccSession is the Claude Code id', pr.machine === pc.id && pr.machineName === 'h6-pc' && pr.ccSession === CC, JSON.stringify([pr.machine, pr.machineName]));

  // ---- who sees what ----
  const tess = await makeUser({ email: 'h6-tess@example.test', name: 'Tess H6', orgId: ME.orgId, role: 'member' });
  await makeUser({ email: 'h6-other@example.test', name: 'Olly H6', orgName: 'H6 Other Org' });
  const W = await newSession({ ccSession: randomUUID(), source: 'startup' });
  await ev(W.token, { event: 'notify', kind: 'permission_prompt' });
  const tessHtml = await page(await cookieOf('h6-tess@example.test'));
  const tw = workers(tessHtml).find(w => w.id === rowId(W.sid));
  check('a teammate who reads the project sees the state as waiting on a person, never as a prompt', tw?.state === 'waiting' && /Waiting on a person/.test(tw.text) && !/Waiting on you/.test(tw.text), JSON.stringify(tw)?.slice(0, 300));
  const wrow = await prow(W.sid);
  check('the teammate’s page never carries Claude Code’s session id', !tessHtml.includes(wrow.ccSession));
  const otherHtml = await page(await cookieOf('h6-other@example.test'));
  check('another organization sees no worker of this one', !workers(otherHtml).some(w => w.id.startsWith(ME.userId)) && !otherHtml.includes(wrow.ccSession));
  const pcT = await deviceOf(tess, 'tess-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pcT, tess, 'tf', 'acme/h6-one', ONE));
  const tt = (await start(pcT.key, body0)).json;
  const before = JSON.stringify((await prow(W.sid)).activity);
  const te = await ev(tt.token, { event: 'end' });
  const tRow = await rawDb.collection('presence').findOne({ _id: `${tess.userId}:s:${tt.brief.session}:${ONE}` });
  check('a teammate’s token changes only the teammate’s own row (Om’s row is as it was)', te.json?.state === 'off' && tRow.activity.state === 'off' && JSON.stringify((await prow(W.sid)).activity) === before, te.text);

  // ---- no side effects ----
  const states0 = await rawDb.collection('states').findOne({ projectId: ONE });
  const feed0 = await rawDb.collection('activity').countDocuments({});
  const pres0 = await prow(W.sid);
  for (let i = 0; i < 20; i++) await ev(W.token, { event: i % 2 ? 'tool' : 'stop' });
  const states1 = await rawDb.collection('states').findOne({ projectId: ONE });
  const pres1 = await prow(W.sid);
  check('20 events: the State version, the activity feed and the for-you cursor are unchanged', states1.version === states0.version && (await rawDb.collection('activity').countDocuments({})) === feed0 && +pres1.forYouCursor === +pres0.forYouCursor && pres1.writesSinceSave === pres0.writesSinceSave);

  // ---- the hourly limit: 300 events per token ----
  const L = await newSession();
  let ok = 0;
  for (let i = 0; i < 303; i++) if ((await ev(L.token, { event: 'tool' })).status === 200) ok++;
  const over = await ev(L.token, { event: 'tool' });
  check('one token: 300 events an hour, then 429 with Retry-After', ok === 300 && over.status === 429 && !!over.headers.get('retry-after'), `${ok} then ${over.status}`);

  // ---- the token is nowhere in the database ----
  const found = [];
  for (const { name } of await rawDb.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const all = JSON.stringify(await rawDb.collection(name).find({}).toArray());
    for (const t of [S.token, O.token, R.token, W.token, L.token, tt.token].filter(Boolean)) if (all.includes(t) || all.includes(t.slice(4))) found.push(name);
  }
  check('no session token is stored anywhere (only its hash)', found.length === 0, found.join(', '));
} catch (e) {
  check('flow-h6 suite (error)', false, e?.stack || String(e));
}
await finish();
