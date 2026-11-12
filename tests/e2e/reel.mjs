// POST /api/cron/reel (lib/instagram.ts): publishes a prepared Instagram reel and alerts the owner, against a mock Graph server
// on the stub port (run.sh mode "reel": IG_GRAPH_BASE, IG_ACCOUNT_ID, IG_PAGE_TOKEN, delays scaled to 1%).
// Checks: success (link in the owner's inbox, token only in the Authorization header), a processing video re-checked,
// an ERROR container (alert, no publish call), a late slot (alert, no Graph call), two 5xx then success, a 4xx not retried,
// a bad token (reason shown, token never), a repeated call not publishing twice, bad bodies, no/wrong secret.
// Seed profile: none.
import http from 'node:http';
import { B, CRON, ME, check, finish, makeUser, rawDb } from './lib.mjs';

const PORT = Number(process.env.E2E_DISCORD_PORT);
const TOKEN = process.env.IG_PAGE_TOKEN;
const ACCT = process.env.IG_ACCOUNT_ID;

const calls = []; // { method, path, auth, urlHasToken }
const state = { inProgress: 0, publish5xx: 0, lost: 0 };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, urlHasToken: req.url.includes(TOKEN) || body.includes(TOKEN) });
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const m = u.pathname.match(/^\/v23\.0\/(\d+)(\/media_publish|\/media)?$/);
    if (!m) return send(404, { error: { message: 'unknown path' } });
    const id = m[1];
    if (req.headers.authorization !== `Bearer ${TOKEN}` && id !== '10000005') return send(401, { error: { message: 'bad auth' } });
    if (m[2] === '/media') return send(200, { data: [{ id: '910000008', permalink: 'https://www.instagram.com/reel/910000008/' }] });
    if (m[2]) {
      if (creation8(body)) return state.lost++ === 0 ? req.socket.destroy() : send(400, { error: { message: 'The media is already published' } });
      const creation = new URLSearchParams(body).get('creation_id');
      if (creation === '10000003' && state.publish5xx++ < 2) return send(503, { error: { message: 'temporarily unavailable' } });
      if (creation === '10000006') return send(400, { error: { message: 'Media ID is not available' } });
      return send(200, { id: '9' + creation });
    }
    if (id === '10000005') return send(400, { error: { message: `Invalid OAuth access token - Cannot parse access token (${TOKEN})`, code: 190 } });
    if (id.startsWith('9')) return send(200, { permalink: `https://www.instagram.com/reel/${id}/`, timestamp: '2030-01-01T00:00:00+0000' });
    if (id === '10000008') return send(200, { status_code: state.lost ? 'PUBLISHED' : 'FINISHED' });
    if (id === '10000002') return send(200, { status_code: 'ERROR', status: 'Error: Video codec not supported' });
    if (id === '10000007' && state.inProgress++ < 2) return send(200, { status_code: 'IN_PROGRESS' });
    send(200, { status_code: 'FINISHED' });
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

function creation8(body) { return new URLSearchParams(body).get('creation_id') === '10000008'; }
const now = () => Math.floor(Date.now() / 1000);
const call = (body, auth = `Bearer ${CRON}`, qs = '') => fetch(`${B}/api/cron/reel${qs}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const inbox = post => rawDb.collection('notifications').find({ userId: ME.userId, title: new RegExp(`^Reel ${post} `) }).toArray();

try {
  const member = await makeUser({ email: 'reel-member@example.test', name: 'Mem', orgId: ME.orgId, role: 'member' });

  // ---- auth and body ----
  check('no secret -> 401', (await call({ post: 'p1', container: '10000001', slot: now() }, '')).status === 401);
  check('wrong secret -> 401', (await call({ post: 'p1', container: '10000001', slot: now() }, 'Bearer ' + 'x'.repeat(CRON.length))).status === 401);
  check('the secret in the URL is not accepted -> 401', (await call({ post: 'p1', container: '10000001', slot: now() }, '', `?key=${CRON}`)).status === 401);
  check('refused calls reached nothing', calls.length === 0 && (await inbox('p1')).length === 0);
  for (const [n, b] of [['not JSON', 'nope'], ['bad post', { post: 'a b', container: '10000001', slot: now() }], ['long post', { post: 'a'.repeat(49), container: '10000001', slot: now() }], ['bad container', { post: 'p', container: '12ab', slot: now() }], ['short container', { post: 'p', container: '1234', slot: now() }], ['slot as text', { post: 'p', container: '10000001', slot: 'soon' }], ['no slot', { post: 'p', container: '10000001' }]])
    check(`bad body (${n}) -> 400`, (await call(b)).status === 400);
  check('bad bodies reached nothing', calls.length === 0);

  // ---- success ----
  const ok = await call({ post: 'ok1', container: '10000001', slot: now() });
  const oj = await ok.json();
  check('success -> 200 { published, permalink }', ok.status === 200 && oj.published === true && oj.permalink === 'https://www.instagram.com/reel/910000001/', JSON.stringify(oj));
  const ib = await inbox('ok1');
  check('the owner has "is live" with the link in the inbox', ib.length === 1 && /is live$/.test(ib[0].title) && ib[0].body.includes('/reel/910000001/') && ib[0].url === 'https://www.instagram.com/reel/910000001/', JSON.stringify(ib));
  check('Graph got the token only in the Authorization header, on every call', calls.length === 3 && calls.every(c => c.auth === `Bearer ${TOKEN}` && !c.urlHasToken), JSON.stringify(calls));
  check('calls were status, publish, permalink in that order', calls[0].method === 'GET' && calls[1].method === 'POST' && calls[1].path.includes(`/${ACCT}/media_publish`) && calls[2].path.endsWith('/910000001'));
  check('a member does not get it', (await rawDb.collection('notifications').countDocuments({ userId: member.userId, title: /^Reel/ })) === 0);
  const before = calls.length;
  const again = await call({ post: 'ok1', container: '10000001', slot: now() });
  check('the same post again does not publish twice', again.status === 200 && calls.length === before && (await inbox('ok1')).length === 1);

  // ---- a processing video is checked again ----
  const ip = await call({ post: 'slow1', container: '10000007', slot: now() });
  check('IN_PROGRESS twice then FINISHED -> published', ip.status === 200 && (await ip.json()).published === true && state.inProgress === 3, String(state.inProgress));

  // ---- an ERROR container ----
  calls.length = 0;
  const er = await call({ post: 'err1', container: '10000002', slot: now() });
  const ej = await er.json();
  check('ERROR container -> 502 with the reason', er.status === 502 && /ERROR/.test(ej.error) && /codec/.test(ej.error), JSON.stringify(ej));
  const ei = await inbox('err1');
  check('alert says NOT posted, with the reason and "from your phone"', ei.length === 1 && /was NOT posted$/.test(ei[0].title) && /ERROR/.test(ei[0].body) && /Post it from your phone\.$/.test(ei[0].body), JSON.stringify(ei));
  check('no publish call was made', !calls.some(c => c.path.endsWith('/media_publish')) && calls.length === 1);

  // ---- late ----
  calls.length = 0;
  const lt = await call({ post: 'late1', container: '10000001', slot: now() - 31 * 60 });
  check('31 minutes late -> 502 and an alert', lt.status === 502 && (await inbox('late1')).length === 1 && /NOT posted/.test((await inbox('late1'))[0].title) && /past its slot/.test((await inbox('late1'))[0].body));
  check('late: no Graph call at all', calls.length === 0);
  const edge = await call({ post: 'late2', container: '10000001', slot: now() - 25 * 60 });
  check('25 minutes late still publishes', edge.status === 200 && (await edge.json()).published === true);

  // ---- two 5xx then success ----
  calls.length = 0;
  const r5 = await call({ post: 'five1', container: '10000003', slot: now() });
  check('two 503s then success -> published', r5.status === 200 && (await r5.json()).published === true);
  check('publish was tried three times', calls.filter(c => c.path.endsWith('/media_publish')).length === 3);

  // ---- a 4xx is not retried ----
  calls.length = 0;
  const f4 = await call({ post: 'four1', container: '10000006', slot: now() });
  const fj = await f4.json();
  check('4xx on publish -> 502 with the reason, one attempt', f4.status === 502 && /Media ID is not available/.test(fj.error) && calls.filter(c => c.path.endsWith('/media_publish')).length === 1, JSON.stringify(fj));

  // ---- a bad token ----
  calls.length = 0;
  const bt = await call({ post: 'tok1', container: '10000005', slot: now() });
  const bj = await bt.text();
  check('bad token -> 502, the reason is shown', bt.status === 502 && /Invalid OAuth access token/.test(bj), bj);
  check('the token is not in the response', !bj.includes(TOKEN));
  const ti = JSON.stringify(await inbox('tok1'));
  check('alert has the reason and not the token', /Invalid OAuth access token/.test(ti) && !ti.includes(TOKEN) && ti.includes('[token]'), ti);
  check('the token is nowhere in the stored notifications', !JSON.stringify(await rawDb.collection('notifications').find({}).toArray()).includes(TOKEN));
  // ---- a publish that timed out but went out: the retry gets a 4xx, the reel is live, not "NOT posted" ----
  calls.length = 0;
  const lost = await call({ post: 'lost1', container: '10000008', slot: now() });
  const lj = await lost.json();
  check('lost answer then 4xx, but PUBLISHED -> reported as live', lost.status === 200 && lj.published === true && lj.permalink === 'https://www.instagram.com/reel/910000008/', JSON.stringify(lj));
  const li = await inbox('lost1');
  check('the owner got "is live", not "NOT posted"', li.length === 1 && /is live$/.test(li[0].title), JSON.stringify(li));
  check('it looked before giving up: publish twice, then the container and the latest media', calls.filter(c => c.path.endsWith('/media_publish')).length === 2 && calls.some(c => c.path.endsWith('/media')));

  // ---- nobody can be told: logged and shown in the response ----
  const owners = await rawDb.collection('member').find({ role: 'owner' }).toArray();
  await rawDb.collection('member').updateMany({ role: 'owner' }, { $set: { role: 'member' } });
  try {
    const na = await call({ post: 'noown1', container: '10000001', slot: now() - 40 * 60 });
    const nj = await na.json();
    check('failure with no owner: error and alertError "no owner"', na.status === 502 && /past its slot/.test(nj.error) && nj.alertError === 'no owner', JSON.stringify(nj));
    const nb = await call({ post: 'noown2', container: '10000001', slot: now() });
    const nk = await nb.json();
    check('success with no owner: still published, alertError "no owner"', nb.status === 200 && nk.published === true && nk.alertError === 'no owner', JSON.stringify(nk));
    check('alertError carries no token', !JSON.stringify([nj, nk]).includes(TOKEN));
  } finally {
    for (const o of owners) await rawDb.collection('member').updateOne({ _id: o._id }, { $set: { role: o.role } });
  }
  const okAgain = await (await call({ post: 'okagain', container: '10000001', slot: now() })).json();
  check('owner restored: no alertError', okAgain.published === true && !('alertError' in okAgain), JSON.stringify(okAgain));
} catch (e) {
  check('reel suite (error)', false, e?.stack || String(e));
}
server.close();
await finish();
