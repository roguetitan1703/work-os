// Mail with no Connect client (MAILLOOM_AGENT_URL set, MAILLOOM_CLIENT_ID / MAILLOOM_CLIENT_SECRET
// unset; run.sh mode "mailpaste"): Settings › Connections › Mail shows the paste box, open, and no Connect button; the
// Connect callback answers 404; pasting a key still works. A small fake Mailloom (whoami only) on the discord stub's port.
import http from 'node:http';
import { B, check, finish, launch, login, rawDb, ME } from './lib.mjs';

const KEY = 'mlk_' + 'P'.repeat(43);
const stub = http.createServer((q, s) => {
  const key = (q.headers.authorization ?? '').replace(/^Bearer /, '');
  s.setHeader('content-type', 'application/json');
  if (key !== KEY) { s.statusCode = 401; return s.end(JSON.stringify({ code: 'INVALID_KEY', error: 'Unknown key' })); }
  if (q.url.endsWith('/whoami')) return s.end(JSON.stringify({ email: 'owner@delpat.test', key: { id: 'k_p', prefix: KEY.slice(0, 8), name: 'e2e', scopes: ['read'], created_at: '2026-11-01T00:00:00Z' }, limits: { sends_per_hour: 200, recipients_per_mail: 100 } }));
  s.statusCode = 404;
  s.end(JSON.stringify({ code: 'NOT_FOUND', error: 'not stubbed' }));
}).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');

try {
  const br = await launch();
  const c = await br.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await c.newPage();
  await login(p, { next: '/settings?section=connections' });
  await p.goto(`${B}/settings?section=connections`);
  check('no Connect client: the Mail row shows the paste box, open', await p.locator('[data-connection=mail] [data-mail-input]').waitFor({ timeout: 15000 }).then(() => true, () => false));
  check('no Connect client: no Connect button and nothing folded', (await p.locator('[data-mail-connect]').count()) === 0 && (await p.locator('[data-mail-paste]').count()) === 0);
  const cb = await c.request.get(`${B}/api/mail/callback?state=${'a'.repeat(43)}&code=x`, { maxRedirects: 0 });
  check('no Connect client: the callback answers 404', cb.status() === 404, String(cb.status()));
  await p.locator('[data-mail-input]').fill(KEY);
  await p.locator('[data-mail-save]').click();
  check('paste fallback: a pasted key links the mailbox', await p.locator('[data-mail-mailbox]').filter({ hasText: /owner@delpat\.test/ }).waitFor({ timeout: 10000 }).then(() => true, () => false));
  check('paste fallback: no Connect again button', (await p.locator('[data-mail-connect]').count()) === 0);
  const doc = await rawDb.collection('settings').findOne({ _id: `mail:${ME.userId}` });
  check('paste fallback: stored sealed, marked as pasted', !!doc?.mail?.sealed && doc.mail.via === 'paste' && !JSON.stringify(doc).includes(KEY));
  await c.close();
  await br.close();
} catch (e) {
  console.log('FAIL  suite crashed - ' + (e?.stack ?? e));
  stub.close();
  await finish(1);
}
stub.close();
await finish();
