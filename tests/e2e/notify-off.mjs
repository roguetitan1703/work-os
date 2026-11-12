// POST /api/cron/notify with NOTIFY_SECRET unset (run.sh mode "nonotify"): 503 for everyone, even a call that sends a bearer.
// Seed profile: none.
import { B, check, finish } from './lib.mjs';

const call = auth => fetch(`${B}/api/cron/notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ title: 'Reel' }) });
try {
  check('secret unset, no header -> 503', (await call('')).status === 503);
  check('secret unset, a bearer -> 503 (nothing matches an unset secret)', (await call('Bearer ')).status === 503 && (await call('Bearer undefined')).status === 503);
} catch (e) {
  check('notify-off suite (error)', false, e?.stack || String(e));
}
await finish();
