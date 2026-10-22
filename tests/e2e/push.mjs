// Push (docs/multi-user.md "As built: phase 5 push"): the page stream (/api/stream) and the worker stream
// (/api/worker/stream). Checks who may connect, that a write reaches exactly the people who can read it (a teammate and
// the writer for shared work; nobody else for a private task; nobody in another organization), that hints carry no
// titles, that an open Claude page shows a teammate's change without a reload, that a worker gets a job pushed (the
// real worker/push.mjs client), and that removing a member closes their streams. Ends with the request counts of an
// idle Claude page for an hour, push off (the old poll) and on (docs/cpu.md). Seed profile: none.
import { randomBytes, randomUUID } from 'node:crypto';
import { B, EMAIL, ME, MCP, PW, check, finish, launch, login, makeUser, mkKey, rawDb, sha } from './lib.mjs';
import { connectPush } from '../../worker/push.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return v;
}
let rid = 0;
async function as(key, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  if (b.result?.isError || b.error) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
/** Session cookies for email (Better Auth sign-in over HTTP). */
async function cookieFor(email) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
/** An SSE reader: events as { ev, data, raw }; ended once the server closes it. */
function sse(path, headers) {
  const s = { events: [], ended: false, status: 0 };
  const ac = new AbortController();
  s.ready = fetch(B + path, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal }).then(
    r => {
      s.status = r.status;
      if (!r.ok || !r.body) return void (s.ended = true);
      (async () => {
        const dec = new TextDecoder();
        let buf = '';
        try {
          for await (const c of r.body) {
            buf += dec.decode(c, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: ?(.*)$/m.exec(raw)?.[1];
              const data = /^data: ?(.*)$/m.exec(raw)?.[1];
              if (ev) s.events.push({ ev, data: data ? JSON.parse(data) : null, raw });
            }
          }
        } catch {
          // aborted
        }
        s.ended = true;
      })();
    },
    () => void (s.ended = true),
  );
  s.close = () => ac.abort();
  s.hello = () => until(() => s.events.some(e => e.ev === 'hello'));
  s.hints = (t = null) => s.events.filter(e => e.ev === 'hint' && (!t || e.data?.t === t));
  return s;
}

const browser = await launch();
const all = [];
const track = s => (all.push(s), s);
try {
  // ── people ──
  const bea = 'bea-push@example.test';
  const Bea = await makeUser({ email: bea, name: 'Bea', orgId: ME.orgId, role: 'member' });
  const Olly = await makeUser({ email: 'olly-push@example.test', name: 'Olly' });
  const kA = MCP;
  const kB = await mkKey({ agent: 'claude', userId: Bea.userId, orgId: ME.orgId, name: 'bea chat' });
  const kO = await mkKey({ agent: 'claude', userId: Olly.userId, orgId: Olly.orgId, name: 'olly chat' });
  const [cA, cB, cO] = [await cookieFor(EMAIL), await cookieFor(bea), await cookieFor('olly-push@example.test')];
  check('setup: three signed-in people', !!cA && !!cB && !!cO);

  // ── who may connect ──
  const devKey = (name, owner) => {
    const key = 'wkr_' + randomBytes(32).toString('base64url');
    const id = randomUUID();
    return rawDb.collection('devices').insertOne({ _id: id, name, ownerId: owner.userId, orgId: owner.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null }).then(() => ({ id, key }));
  };
  const dA = await devKey('Push-PC', ME);
  const dB = await devKey('Bea-PC', Bea);
  const status = async (path, headers) => (await fetch(B + path, { headers, redirect: 'manual' }).then(r => (r.body?.cancel(), r.status)));
  // The page stream goes through the proxy's session check like any API route (it is counted there too), and the
  // route checks the session itself: a Claude chat key passes the proxy and is still refused by the route.
  const seen = async () => { let n = 0; for (const d of await rawDb.collection('requestStats').find().toArray()) for (const [k, v] of Object.entries(d.counts ?? {})) if (k.endsWith('|/api/stream')) n += v; return n; };
  const seen0 = await seen();
  check('page stream: no session is refused', (await status('/api/stream')) === 401);
  check('page stream: the proxy sees it (counted, not skipped like /api/live)', !!(await until(async () => (await seen()) > seen0, 8000)));
  check('page stream: a Claude chat key passes the proxy but the route refuses it', (await status('/api/stream', { authorization: `Bearer ${kA}` })) === 401);
  check('liveness /api/live is still the plain "ok"', (await fetch(B + '/api/live').then(r => r.text())) === 'ok');
  check('page stream: a device key is refused', (await status('/api/stream', { authorization: `Bearer ${dA.key}` })) === 401);
  check('worker stream: no key is refused', (await status('/api/worker/stream')) === 401);
  check('worker stream: a Claude chat key is refused', (await status('/api/worker/stream', { authorization: `Bearer ${kA}` })) === 401);
  check('worker stream: a made-up device key is refused', (await status('/api/worker/stream', { authorization: `Bearer wkr_${'x'.repeat(43)}` })) === 401);

  const sA = track(sse('/api/stream', { cookie: cA }));
  const sB = track(sse('/api/stream', { cookie: cB }));
  const sO = track(sse('/api/stream', { cookie: cO }));
  await Promise.all([sA.ready, sB.ready, sO.ready]);
  check('page stream: each signed-in person connects (hello)', !!(await sA.hello()) && !!(await sB.hello()) && !!(await sO.hello()), `${sA.status} ${sB.status} ${sO.status}`);
  check('page stream: served as text/event-stream', await fetch(B + '/api/stream', { headers: { cookie: cA } }).then(r => (r.body?.cancel(), /text\/event-stream/.test(r.headers.get('content-type') ?? ''))));

  // ── a write reaches the people who can read it ──
  await as(kA, 'add_project', { name: 'Push Shared' });
  check('shared project: the writer and the teammate get "projects"', !!(await until(() => sA.hints('projects').length && sB.hints('projects').length)));
  const SECRET = 'Zebra-Quartz invoice for Push';
  const t1 = (await as(kA, 'add_task', { title: SECRET, project: 'Push Shared' })).created;
  check('shared task: the teammate gets "tasks"', !!(await until(() => sB.hints('tasks').length)));
  check('shared task: the writer gets "tasks" marked as their own (s: 1)', !!(await until(() => sA.hints('tasks').some(e => e.data.s === 1))));
  check('shared task: the teammate\'s hint is not marked as theirs', sB.hints('tasks').every(e => !e.data.s));
  const aBefore = sA.hints().length;
  const priv = (await as(kB, 'add_task', { title: 'Bea private Zebra-Quartz plan' })).created;
  check('private task: its owner gets "tasks"', !!(await until(() => sB.hints('tasks').length >= 2)));
  await as(kB, 'update_task', { task: priv.ref, priority: 'P1' });
  await as(kB, 'log_progress', { task: priv.ref, progress: 30, note: 'Zebra-Quartz progress' });
  await until(() => sB.hints('tasks').length >= 4, 4000);
  await sleep(1500);
  check('private task: someone else in the organization gets nothing', sA.hints().length === aBefore, JSON.stringify(sA.hints().slice(aBefore)));
  check('another organization gets nothing at all', sO.hints().length === 0, JSON.stringify(sO.hints()));
  await as(kO, 'add_task', { title: 'Olly own task' });
  check('another organization\'s writes reach its own people', !!(await until(() => sO.hints('tasks').length)));
  await sleep(800);
  check('...and nobody in ours', sA.hints().length === aBefore && sB.hints().every(e => e.raw.indexOf('Olly') < 0));
  const raws = [...sA.events, ...sB.events, ...sO.events].map(e => e.raw).join('\n');
  check('hints carry no titles, names or ids', !/Zebra|Quartz|Push Shared|Olly|"ref"|"id"/.test(raws) && !raws.includes(String(t1.id ?? 'none-x')), raws.slice(0, 300));
  check('hints carry only a topic (and s)', [...sA.hints(), ...sB.hints(), ...sO.hints()].every(e => Object.keys(e.data).every(k => k === 't' || k === 's')));
  // a shared project made private: the teammate who could see it hears so (from where it was before the write)
  const bProj = sB.hints('projects').length;
  await as(kA, 'add_project', { name: 'Push Later Private' });
  await until(() => sB.hints('projects').length > bProj);
  const bProj2 = sB.hints('projects').length;
  await as(kA, 'update_project', { project: 'Push Later Private', visibility: 'private' });
  check('shared made private: the teammate who lost it gets "projects"', !!(await until(() => sB.hints('projects').length > bProj2)));

  // ── an open Claude page follows a teammate's change without a reload ──
  await as(kA, 'add_project', { name: 'Push Team' });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pA = await ctxA.newPage();
  let liveReqs = 0;
  let rscAfter = 0;
  let liveOk = 0;
  pA.on('response', r => { if (new URL(r.url()).pathname === '/api/stream' && r.status() === 200) liveOk++; });
  pA.on('request', r => { if (new URL(r.url()).pathname === '/api/stream') liveReqs++; else if (r.headers()['rsc']) rscAfter++; });
  await login(pA, { next: '/claude?tab=queue' });
  await pA.goto(B + '/claude?tab=queue');
  await pA.waitForLoadState('networkidle').catch(() => {});
  check('Claude page opens a push stream', !!(await until(() => liveReqs >= 1 && liveOk >= 1)));
  await sleep(500);
  const itemTitle = 'Teammate pushed item ' + randomBytes(3).toString('hex');
  rscAfter = 0;
  await as(kB, 'update_claude_items', { project: 'Push Team', ops: [{ op: 'add', project: 'Push Team', kind: 'bug', title: itemTitle, why: 'Push check: an open Claude page (Queue tab) must follow a change a teammate makes elsewhere.', done_when: 'The open page lists this item without a reload.' }] });
  check('Claude page shows a teammate\'s new item without a reload', !!(await until(async () => (await pA.getByText(itemTitle).count()) > 0, 10000)));

  // ── the worker gets a job pushed ──
  const proj = (await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: 'Push Team' }))._id;
  await rawDb.collection('workerFolders').insertOne({ _id: `${dA.id}:f_push1`, orgId: ME.orgId, ownerId: ME.userId, deviceId: dA.id, folderId: 'f_push1', name: 'push-repo', git: false, projectId: proj, linkedAt: new Date(), seenAt: new Date(), missing: false });
  const sid = randomUUID();
  await rawDb.collection('workerSessions').insertOne({ _id: sid, orgId: ME.orgId, ownerId: ME.userId, deviceId: dA.id, folderId: 'f_push1', projectId: proj, state: 'running', startedAt: new Date(), updatedAt: new Date() });
  const got = [];
  let wakes = 0;
  const w = connectPush({
    getCfg: () => ({ baseUrl: B }),
    getToken: () => dA.key,
    onWake: async () => {
      wakes++;
      const r = await fetch(B + '/api/worker/jobs', { headers: { authorization: `Bearer ${dA.key}` } }).then(x => x.json());
      got.push(...(r.jobs ?? []));
    },
  });
  try {
    check('worker: connects with its device key', !!(await until(() => w.up)));
    await pA.goto(B + '/claude?tab=now');
    const stopBtn = pA.locator('[data-session-row] button:has-text("Stop")').first();
    await stopBtn.waitFor({ timeout: 15000 });
    const t0 = Date.now();
    await stopBtn.click();
    await pA.locator('button[data-confirm]').click();
    check('worker: Stop on the page pushes a wake', !!(await until(() => wakes > 0, 10000)));
    check('worker: the wake fetches the stop job (no poll timer involved)', !!(await until(() => got.some(j => j.kind === 'stop' && j.sessionId === sid), 5000)), JSON.stringify(got));
    console.log(`COUNT worker job pushed after ${Date.now() - t0} ms (click to job in hand)`);
  } finally {
    w.stop();
  }

  // ── removing a member closes their streams ──
  const sBw = track(sse('/api/worker/stream', { authorization: `Bearer ${dB.key}` }));
  await sBw.ready;
  check('before removal: Bea\'s page and worker streams are open', !sB.ended && !!(await sBw.hello()) && !sBw.ended);
  await pA.goto(B + '/settings?section=members');
  await pA.waitForSelector(`button[aria-label="Remove ${bea}"]`, { timeout: 15000 });
  await pA.click(`button[aria-label="Remove ${bea}"]`);
  await pA.click(`[data-remove-confirm="${bea}"] button:has-text("Remove")`);
  check('removal: Bea\'s page stream is closed', !!(await until(() => sB.ended, 10000)));
  check('removal: Bea\'s worker stream is closed', !!(await until(() => sBw.ended, 10000)));
  check('removal: the server said why (bye)', sB.events.some(e => e.ev === 'bye' && e.data?.r === 'closed'));
  check('removal: Bea cannot connect again', (await status('/api/stream', { cookie: cB })) === 401 && (await status('/api/worker/stream', { authorization: `Bearer ${dB.key}` })) === 401);
  check('removal: other people\'s streams stay open', !sA.ended && !sO.ended);
  await ctxA.close();

  // ── requests of an idle Claude page in an hour (docs/cpu.md) ──
  // A simulated hour (Playwright clock) on /claude Now: "untouched" (no input) and "in use" (mouse moves every 30 s),
  // with the push stream blocked (the page falls back to the old poll, i.e. before phase 5) and with push on.
  const measure = async (push, inUse) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (!push) await ctx.route('**/api/stream', r => r.abort());
    const p = await ctx.newPage();
    await login(p, { next: '/claude' });
    await p.clock.install();
    await p.goto(B + '/claude');
    await p.waitForLoadState('networkidle').catch(() => {});
    await sleep(1500);
    const n = { page: 0, live: 0, other: 0 };
    p.on('request', r => {
      const u = new URL(r.url());
      if (u.origin !== B || u.pathname.startsWith('/_next/static') || u.pathname.startsWith('/icons')) return;
      if (u.pathname === '/api/stream') n.live++;
      else if (r.headers()['rsc'] || u.searchParams.has('_rsc')) n.page++;
      else n.other++;
    });
    for (let i = 0; i < 120; i++) {
      if (inUse) await p.mouse.move(100 + (i % 7) * 10, 200);
      await p.clock.runFor(30_000);
      await sleep(40);
    }
    await sleep(1500);
    await ctx.close();
    return n;
  };
  for (const inUse of [false, true]) {
    const off = await measure(false, inUse);
    const on = await measure(true, inUse);
    const label = inUse ? 'in use' : 'untouched';
    console.log(`COUNT idle Claude page per hour (${label}), push off (old poll): page fetches ${off.page}, other ${off.other}`);
    console.log(`COUNT idle Claude page per hour (${label}), push on: page fetches ${on.page}, stream connects ${on.live} during the hour (plus 2 real ones: open, and the 30-minute reconnect), other ${on.other}`);
    check(`idle Claude page (${label}): push makes fewer requests than the poll`, on.page + on.live + on.other < off.page + off.other, JSON.stringify({ off, on }));
  }
} catch (e) {
  check('suite ran to the end', false, e.stack ?? String(e));
} finally {
  for (const s of all) s.close();
  await browser.close();
}
await finish();
