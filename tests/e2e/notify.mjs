// POST /api/cron/notify: a script on the server alerts the owner (docs/hosting.md 9a). Checks: no/wrong secret 401, bad bodies 400,
// a good call lands in the owner's inbox and nobody else's, the secret in the URL or CRON_SECRET opens nothing, rate limit 429 (last).
// Seed profile: none. Plain mode: push and Discord are not configured, so inbox is the only channel.
import { B, CRON, NOTIFY, ME, check, finish, makeUser, rawDb } from './lib.mjs';

const call = (body, { auth = `Bearer ${NOTIFY}`, qs = '' } = {}) =>
  fetch(`${B}/api/cron/notify${qs}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const good = { title: 'Reel failed', body: 'Publish at 18:00 failed', url: '/tasks/12' };

try {
  const member = await makeUser({ email: 'notify-member@example.test', name: 'Mem', orgId: ME.orgId, role: 'member' });
  const admin = await makeUser({ email: 'notify-admin@example.test', name: 'Adm', orgId: ME.orgId, role: 'admin' });
  const inbox = id => rawDb.collection('notifications').find({ userId: id, title: /^Reel/ }).toArray();

  check('no header -> 401', (await call(good, { auth: '' })).status === 401);
  check('wrong secret -> 401', (await call(good, { auth: 'Bearer ' + 'x'.repeat(NOTIFY.length) })).status === 401);
  check('the cron secret does not open it -> 401', (await call(good, { auth: `Bearer ${CRON}` })).status === 401);
  check('the secret in the URL is not accepted -> 401', (await call(good, { auth: '', qs: `?key=${NOTIFY}&secret=${NOTIFY}` })).status === 401);
  check('GET -> 405', (await fetch(`${B}/api/cron/notify`, { headers: { authorization: `Bearer ${NOTIFY}` } })).status === 405);
  check('nothing stored by the refused calls', (await inbox(ME.userId)).length === 0);

  const bads = [
    ['not JSON', 'nope'], ['array', []], ['no title', { body: 'x' }], ['empty title', { title: '' }], ['title 121 chars', { title: 'r'.repeat(121) }], ['title not a string', { title: 5 }],
    ['body 1001 chars', { title: 'Reel', body: 'b'.repeat(1001) }], ['body not a string', { title: 'Reel', body: 7 }],
    ['http url', { title: 'Reel', url: 'http://example.com/x' }], ['javascript url', { title: 'Reel', url: 'javascript:alert(1)' }], ['protocol-relative url', { title: 'Reel', url: '//evil.example/x' }],
    ['relative without slash', { title: 'Reel', url: 'tasks/1' }], ['url not a string', { title: 'Reel', url: 3 }],
  ];
  for (const [n, b] of bads) check(`bad body (${n}) -> 400`, (await call(b)).status === 400);
  check('nothing stored by the bad calls', (await inbox(ME.userId)).length === 0);

  const r = await call(good);
  const j = await r.json().catch(() => ({}));
  check('good call -> 200 with { sent, errors } counts only', r.status === 200 && j.sent?.inbox === 1 && Array.isArray(j.errors) && !j.errors.length && !JSON.stringify(j).includes('Reel'), JSON.stringify(j));
  const mine = await inbox(ME.userId);
  check('the owner has it in the inbox, with the link and unread', mine.length === 1 && mine[0].body === good.body && mine[0].url === '/tasks/12' && mine[0].readAt === null, JSON.stringify(mine));
  check('a member does not', (await inbox(member.userId)).length === 0);
  check('an admin (not owner) does not', (await inbox(admin.userId)).length === 0);
  const other = await rawDb.collection('notifications').countDocuments({ title: /^Reel/, userId: { $ne: ME.userId } });
  check('nobody else in any organization has it', other === 0);
  const ok2 = await call({ title: 'Minimal' });
  check('title alone, and an https url, are fine', ok2.status === 200 && (await call({ title: 'Reel https', url: 'https://example.com/a' })).status === 200);

  // The rate limit is last: 20 an hour in all (calls so far that passed validation: 3).
  let n = 3;
  let first429 = null;
  for (let i = 0; i < 25 && first429 === null; i++) { const x = await call({ title: 'Reel flood ' + i }); n++; if (x.status === 429) first429 = n; else if (x.status !== 200) check('flood call ok', false, x.status); }
  check('the 21st accepted call -> 429', first429 === 21, String(first429));
  check('while limited, the secret still gates first (wrong secret -> 401, not 429)', (await call(good, { auth: 'Bearer ' + 'x'.repeat(NOTIFY.length) })).status === 401);
  check('while limited, a bad body is still 400 and the limit is not used up by it', (await call({})).status === 400);
} catch (e) {
  check('notify suite (error)', false, e?.stack || String(e));
}
await finish();
