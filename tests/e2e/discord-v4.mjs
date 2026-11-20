// Work OS in Discord, plan v4 (Work OS note c7b491432a). The relay the live listener posts to, the bug channels, the track
// emoji, the buttons on the bot's reply, Connect Discord (OAuth), the agent tools and the DMs, against a stub Discord API
// (discord-stub.mjs) with signed interactions. Seed profile: none, server mode discord. Each section adds its checks here.
import { B, CRON, check, finish, rawDb } from './lib.mjs';
import { startStub } from './discord-stub.mjs';

const stub = await startStub();
const relay = (event, data, secret = CRON) =>
  fetch(`${B}/api/discord/gateway`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) }, body: typeof data === 'string' ? data : JSON.stringify({ event, data }) });

try {
  // ---- 1. the relay ----
  check('relay: no credential is refused', (await relay('READY', {}, null)).status === 401);
  check('relay: a wrong secret is refused', (await relay('READY', {}, 'not-the-secret-0123456789')).status === 401);
  check('relay: the app password is not the secret', (await relay('READY', {}, 'testpass-e2e-123')).status === 401);
  check('relay: a bad body is refused', (await relay('READY', 'not json')).status === 400);
  check('relay: an unknown event is refused', (await relay('TYPING_START', {})).status === 400);
  const arr = await fetch(`${B}/api/discord/gateway`, { method: 'POST', headers: { authorization: `Bearer ${CRON}` }, body: JSON.stringify({ event: 'READY', data: [1] }) });
  check('relay: data must be an object', arr.status === 400);
  check('relay: an oversize body is refused', (await relay('MESSAGE_CREATE', { x: 'a'.repeat(300_000) })).status === 413);
  check('relay: a good event is taken at once', (await relay('MESSAGE_CREATE', { guild_id: '444444444444444499', id: '1' })).status === 202);
  check('relay: a GET is not a way in', (await fetch(`${B}/api/discord/gateway`, { headers: { authorization: `Bearer ${CRON}` } })).status === 405);
  const tasks0 = await rawDb.collection('tasks').countDocuments({ 'source.kind': 'discord' });
  check('relay: an event from a server no organization has set makes nothing', tasks0 === 0, String(tasks0));
} catch (e) {
  check('discord-v4 (error)', false, e?.stack || String(e));
}
stub.close();
await finish();
