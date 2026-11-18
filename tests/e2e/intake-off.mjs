// The Mailloom report intake when the server has no MAILLOOM_INTAKE_TOKEN / MAILLOOM_INTAKE_PROJECT (plain mode):
// every POST is a 503 from the route itself (not the proxy's login gate), other methods 405. Seed: none.
import { B, check, finish, rawDb } from './lib.mjs';

const URL_ = B + '/api/intake/mailloom';
const body = JSON.stringify({ report_id: 'off-1', reporter: 'someone@example.test', title: 'Off', description_markdown: 'x' });
try {
  for (const [label, auth] of [['no token', null], ['a token', 'Bearer ' + 'x'.repeat(48)]]) {
    const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body, redirect: 'manual' });
    const j = await r.json().catch(() => null);
    check(`unset, ${label}: 503 with a plain error`, r.status === 503 && /not configured/i.test(j?.error ?? ''), `${r.status} ${JSON.stringify(j)}`);
    check(`unset, ${label}: no-store`, /no-store/.test(r.headers.get('cache-control') ?? ''));
  }
  for (const [label, auth] of [['no token', null], ['a token', 'Bearer ' + 'x'.repeat(48)]]) {
    const r = await fetch(URL_ + '/notice', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ text: 'off' }), redirect: 'manual' });
    const j = await r.json().catch(() => null);
    check(`notice unset, ${label}: 503 with a plain error`, r.status === 503 && /not configured/i.test(j?.error ?? ''), `${r.status} ${JSON.stringify(j)}`);
  }
  // Only the two exact intake paths skip the login gate: anything else under /api/intake is the proxy's 401.
  for (const p of ['/api/intake/other', '/api/intake/mailloomx', '/api/intake/mailloom/notice/x']) {
    const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual' });
    check(`proxy guards ${p}: 401 without the route's own header`, r.status === 401 && !r.headers.get('www-authenticate'), String(r.status));
  }
  const g = await fetch(URL_, { redirect: 'manual' });
  check('GET: 405 with Allow: POST (not a login redirect)', g.status === 405 && g.headers.get('allow') === 'POST', String(g.status));
  check('unset: no task made', (await rawDb.collection('tasks').countDocuments({})) === 0);
} catch (e) {
  check('suite error', false, e?.stack || String(e));
}
await finish();
