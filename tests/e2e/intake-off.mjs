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
  const g = await fetch(URL_, { redirect: 'manual' });
  check('GET: 405 with Allow: POST (not a login redirect)', g.status === 405 && g.headers.get('allow') === 'POST', String(g.status));
  check('unset: no task made', (await rawDb.collection('tasks').countDocuments({})) === 0);
} catch (e) {
  check('suite error', false, e?.stack || String(e));
}
await finish();
