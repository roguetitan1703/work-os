// Rate limits on the OAuth endpoints (docs/auth.md "Connecting Claude with OAuth"): registration is open, so it is limited
// (20 an hour per address) and so is the token endpoint (30 a minute). run.sh turns Better Auth's limits off for the
// other suites; this one needs them on: `E2E_AUTH_RATE_LIMIT=on bash tests/e2e/run.sh oauth-limits` (it skips itself otherwise).
import { B, check, finish } from './lib.mjs';

if (process.env.AUTH_RATE_LIMIT === 'off') {
  console.log('PASS  skipped: Better Auth rate limits are off (run with E2E_AUTH_RATE_LIMIT=on)');
  check('skipped without rate limits', true);
  await finish();
}
const reg = () => fetch(B + '/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'limit probe', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) }).then(r => r.status);
const statuses = [];
for (let i = 0; i < 30; i++) statuses.push(await reg());
const ok = statuses.filter(s => s === 200 || s === 201).length;
const limited = statuses.filter(s => s === 429).length;
check('register: the first 20 in an hour are accepted', ok === 20, statuses.join(','));
check('register: after that every one is refused with 429', limited === 10, statuses.join(','));
const tok = () => fetch(B + '/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=x&client_id=x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fx&code_verifier=' + 'x'.repeat(50) }).then(r => r.status);
const ts = [];
for (let i = 0; i < 40; i++) ts.push(await tok());
check('token: more than 30 a minute are refused with 429', ts.includes(429) && ts.filter(s => s === 429).length >= 5, ts.join(','));
check('token: the limit answers JSON-ish errors, never a server error', ts.every(s => s < 500), ts.join(','));
await finish();
