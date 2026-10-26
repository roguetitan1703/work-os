// Discord per person (docs/multi-user.md phase 3): each person links their own Discord account with /link <code>,
// commands act as whoever linked the account that runs them, alert DMs go to the recipient's own account, and the
// Discord tools show each person only the channels their Discord account can see. Signed interactions (run.sh makes a
// throwaway key pair) against a stub Discord API. Seed profile: none.
import http from 'node:http';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { B, MCP, ME, check, finish, launch, login, makeUser, mkKey, rawDb, setOrgGuild, setProfile } from './lib.mjs';

const G1 = '444444444444444441'; // the first organization's server
const G2 = '444444444444444442'; // another organization's server
// (not alerts-once's ids: the app keeps a DM channel per account for the life of the server)
const DA = '111111111111111121'; // the owner's Discord account
const DB = '111111111111111122'; // Bea's
const DX = '111111111111111123'; // someone who never linked
const BOT = '999999999999999999';
const R_A = '555555555555555551';
const R_BOT = '555555555555555559';
const GENERAL = '666666666666666661';
const SECRET = '666666666666666662'; // only the owner's role (and the bot) can view it
const NOHIST = '666666666666666663'; // everyone may view, nobody but the bot may read its history
const THREAD = '666666666666666699'; // a blocked thread (never in the picker)
const APP = '222222222222222222';
const VIEW = 1 << 10;

// ---- stub Discord API ----
const dms = []; // { to, content }
const edits = []; // deferred replies, { token, content }
const json = (s, code, body) => { s.statusCode = code; s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(body)); };
const channels = [
  { id: GENERAL, type: 0, name: 'general', guild_id: G1, parent_id: null, position: 0, permission_overwrites: [] },
  { id: SECRET, type: 0, name: 'secret-plans', guild_id: G1, parent_id: null, position: 1, permission_overwrites: [
    { id: G1, type: 0, allow: '0', deny: String(VIEW) },
    { id: R_A, type: 0, allow: String(VIEW), deny: '0' },
    { id: R_BOT, type: 0, allow: String(VIEW), deny: '0' },
  ] },
  { id: NOHIST, type: 0, name: 'no-history', guild_id: G1, parent_id: null, position: 2, permission_overwrites: [
    { id: G1, type: 0, allow: '0', deny: String(1 << 16) },
    { id: R_BOT, type: 0, allow: String(1 << 16), deny: '0' },
  ] },
];
const members = { [DA]: { roles: [R_A], user: { id: DA, username: 'owner' } }, [DB]: { roles: [], user: { id: DB, username: 'bea' } }, [BOT]: { roles: [R_BOT], user: { id: BOT, username: 'bot' } } };
const stub = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => (b += d));
  q.on('end', () => {
    const u = q.url.split('?')[0];
    let m;
    if (u === '/users/@me') return json(s, 200, { id: BOT, username: 'bot' });
    if (u === '/applications/@me') return json(s, 200, { flags: 1 << 19 });
    if (u === '/users/@me/channels' && q.method === 'POST') return json(s, 200, { id: 'dm-' + JSON.parse(b).recipient_id });
    if ((m = u.match(/^\/channels\/dm-(\d+)\/messages$/)) && q.method === 'POST') { dms.push({ to: m[1], content: JSON.parse(b).content }); return json(s, 200, { id: '1' }); }
    if ((m = u.match(/^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/))) { edits.push({ token: m[1], content: JSON.parse(b).content }); return json(s, 200, {}); }
    if (u === `/guilds/${G1}`) return json(s, 200, { id: G1, owner_id: '1' });
    if (u === `/guilds/${G1}/channels`) return json(s, 200, channels);
    if (u === `/guilds/${G1}/threads/active`) return json(s, 200, { threads: [] });
    if (u === `/guilds/${G1}/roles`) return json(s, 200, [
      { id: G1, name: '@everyone', permissions: String(VIEW | (1 << 16)) },
      { id: R_A, name: 'owners', permissions: '0' },
      { id: R_BOT, name: 'bot', permissions: '0', tags: { bot_id: BOT } },
    ]);
    if ((m = u.match(/^\/guilds\/\d+\/members\/(\d+)$/))) return members[m[1]] ? json(s, 200, members[m[1]]) : json(s, 404, { message: 'Unknown Member' });
    if ((m = u.match(/^\/channels\/(\d+)\/messages$/))) return json(s, 200, []);
    if ((m = u.match(/^\/channels\/(\d+)$/))) { const c = channels.find(x => x.id === m[1]); return c ? json(s, 200, c) : json(s, 404, { message: 'Unknown Channel' }); }
    json(s, 404, { message: 'not stubbed' });
  });
}).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');

// ---- signed interactions ----
const key = createPrivateKey({ key: Buffer.from(process.env.E2E_DISCORD_PRIV || '', 'base64'), format: 'der', type: 'pkcs8' });
let n = 0;
async function interact(guild, user, data, type = 2) {
  const token = `tok${++n}`;
  const body = JSON.stringify({ id: String(n), application_id: APP, type, token, guild_id: guild, channel_id: GENERAL, member: { user: { id: user } }, data });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + body), key).toString('hex');
  const r = await fetch(`${B}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body });
  return { status: r.status, token, body: await r.json().catch(() => null) };
}
const say = r => r.body?.data?.content ?? '';
const link = (guild, user, code) => interact(guild, user, { name: 'link', type: 1, options: [{ name: 'code', type: 3, value: code }] });
const refChoices = async (guild, user) => (await interact(guild, user, { name: 'done', type: 1, options: [{ name: 'ref', type: 3, value: '', focused: true }] }, 4)).body?.data?.choices ?? [];
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 200)); } return fn(); };
const linkCode = async (who, code) => {
  const hash = createHash('sha256').update(`discord-link:${code}`).digest('hex');
  await rawDb.collection('settings').updateOne({ _id: `profile:${who.userId}` }, { $set: { area: 'profile', orgId: who.orgId, userId: who.userId, discordLink: { hash, expiresAt: new Date(Date.now() + 600_000) } } }, { upsert: true });
};
let rid = 0;
async function mcpAs(k, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  return { isError: !!b.result?.isError || !!b.error, text: b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b) };
}

try {
  const A = ME;
  // Bea is an admin of the organization (may edit the blocked list) with fewer Discord roles than the owner.
  const Bu = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: A.orgId, role: 'admin' });
  const Cu = await makeUser({ email: 'cy@example.test', name: 'Cy', orgName: 'Other Org' });
  const kB = await mkKey({ agent: 'claude', userId: Bu.userId, orgId: Bu.orgId, name: 'bea chat' });
  await setOrgGuild(A.orgId, G1);
  await setOrgGuild(Cu.orgId, G2);
  for (const who of [A, Bu]) await setProfile(who, { quietStart: 0, quietEnd: 0 }); // no quiet hours: DMs at any hour
  // Each has a private task (no project) the other must not see.
  const aTask = (await mcpAs(MCP, 'add_task', { title: 'Owner private discord task' })).text;
  const bTask = (await mcpAs(kB, 'add_task', { title: 'Bea private discord task' })).text;
  check('setup: both private tasks made', /created/.test(aTask) && /created/.test(bTask), aTask.slice(0, 80) + ' ' + bTask.slice(0, 80));

  // ---- nothing works before linking ----
  const before = await interact(G1, DA, { name: 'today', type: 1 });
  check('unlinked: a command says how to link', before.status === 200 && /not linked/i.test(say(before)), JSON.stringify(before.body).slice(0, 160));
  const unsigned = await fetch(`${B}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': String(Math.floor(Date.now() / 1000)) }, body: '{"type":1}' });
  check('unsigned: refused', unsigned.status === 401, String(unsigned.status));
  const bMcp0 = await mcpAs(kB, 'discord_list_channels', {});
  check('unlinked: Discord tools ask to link first', bMcp0.isError && /Link your Discord account/i.test(bMcp0.text), bMcp0.text.slice(0, 160));

  // ---- the owner links in Settings (the page makes the code) ----
  const br = await launch();
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await login(p, { next: '/settings?section=notifications' });
  await p.goto(`${B}/settings?section=notifications`);
  await p.locator('[data-discord-link-code]').click();
  await p.waitForFunction(() => /\/link [A-Z0-9]{8}/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  const code = (await p.locator('body').innerText()).match(/\/link ([A-Z0-9]{8})/)?.[1];
  check('settings: makes a one-time /link code', !!code, String(code));

  const wrongServer = await link(G2, DA, code);
  check('link: a code does not work on another organization\'s server', /unknown or expired/i.test(say(wrongServer)), say(wrongServer));
  const ok = await link(G1, DA, code);
  check('link: /link <code> on the server links the account', /^Linked/.test(say(ok)), say(ok));
  const aProf = await rawDb.collection('settings').findOne({ _id: `profile:${A.userId}` });
  check('link: stored on the owner\'s profile, code used up', aProf?.discordId === DA && !aProf.discordLink, JSON.stringify({ d: aProf?.discordId, l: !!aProf?.discordLink }));
  const again = await link(G1, DX, code);
  check('link: a code works once', /unknown or expired/i.test(say(again)), say(again));
  await p.reload();
  check('settings: shows the account as linked', await p.locator('[data-discord-linked]').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await ctx.close();
  await br.close();

  // ---- Bea links her own account ----
  await linkCode(Bu, 'BEACODE2');
  const expiredHash = createHash('sha256').update('discord-link:OLDCODE9').digest('hex');
  await rawDb.collection('settings').updateOne({ _id: `profile:${Cu.userId}` }, { $set: { area: 'profile', orgId: Cu.orgId, userId: Cu.userId, discordLink: { hash: expiredHash, expiresAt: new Date(Date.now() - 1000) } } }, { upsert: true });
  check('link: an expired code is refused', /unknown or expired/i.test(say(await link(G2, DX, 'OLDCODE9'))));
  check('link: Bea links hers', /^Linked/.test(say(await link(G1, DB, 'BEACODE2'))));

  // ---- commands act as whoever linked the account ----
  const aRefs = (await refChoices(G1, DA)).map(c => c.name).join(' | ');
  const bRefs = (await refChoices(G1, DB)).map(c => c.name).join(' | ');
  check('commands: the owner\'s account sees the owner\'s tasks, not Bea\'s', /Owner private discord task/.test(aRefs) && !/Bea private/.test(aRefs), aRefs);
  check('commands: Bea\'s account sees Bea\'s tasks, not the owner\'s', /Bea private discord task/.test(bRefs) && !/Owner private/.test(bRefs), bRefs);
  check('commands: an unlinked account in the server gets nothing', (await refChoices(G1, DX)).length === 0);
  check('commands: a linked account on another organization\'s server is not linked there', /not linked/i.test(say(await interact(G2, DA, { name: 'today', type: 1 }))));
  const made = await interact(G1, DB, { name: 'task', type: 1, options: [{ name: 'title', type: 3, value: 'Bea added from Discord' }] });
  const edit = await waitFor(() => edits.find(e => e.token === made.token));
  const t = await rawDb.collection('tasks').findOne({ title: 'Bea added from Discord' });
  check('commands: /task runs as Bea (her task, actor discord · Bea)', made.body?.type === 5 && /Added/.test(edit?.content ?? '') && t?.ownerId === Bu.userId, `${edit?.content} ${t?.ownerId === Bu.userId}`);
  const act = t ? await rawDb.collection('activity').findOne({ taskId: t._id, type: 'created' }) : null;
  check('commands: history says Discord, as Bea', act?.actor?.kind === 'discord' && act.actor.userId === Bu.userId, JSON.stringify(act?.actor));

  // ---- Discord tools: each person sees only what their Discord account can see ----
  const aList = await mcpAs(MCP, 'discord_list_channels', {});
  const bList = await mcpAs(kB, 'discord_list_channels', {});
  check('tools: the owner sees #general and #secret-plans', !aList.isError && /general/.test(aList.text) && /secret-plans/.test(aList.text), aList.text.slice(0, 200));
  check('tools: Bea sees #general but not #secret-plans', !bList.isError && /general/.test(bList.text) && !/secret-plans/.test(bList.text), bList.text.slice(0, 200));
  const bRead = await mcpAs(kB, 'discord_read_messages', { channel: SECRET });
  check('tools: Bea cannot read #secret-plans by id', bRead.isError && /cannot see it|not found/i.test(bRead.text), bRead.text.slice(0, 160));
  const aRead = await mcpAs(MCP, 'discord_read_messages', { channel: SECRET });
  check('tools: the owner can read it', !aRead.isError, aRead.text.slice(0, 160));
  const bLink = await mcpAs(kB, 'discord_message_to_task', { message_link: `https://discord.com/channels/${G1}/${SECRET}/777777777777777777` });
  check('tools: Bea cannot turn a #secret-plans message into a task', bLink.isError, bLink.text.slice(0, 160));

  // ---- alerts DM the recipient's own account ----
  for (const [k, who] of [[MCP, 'Owner'], [kB, 'Bea']]) {
    const blocker = JSON.parse((await mcpAs(k, 'add_task', { title: `${who} blocker for DM` })).text).created.ref;
    await mcpAs(k, 'add_task', { title: `${who} waiter for DM`, depends_on: [blocker] });
    await mcpAs(k, 'complete_task', { task: blocker, note: 'done' });
  }
  await waitFor(() => dms.filter(d => /waiter for DM/.test(d.content)).length >= 2);
  const toA = dms.filter(d => d.to === DA).map(d => d.content).join('\n');
  const toB = dms.filter(d => d.to === DB).map(d => d.content).join('\n');
  check('alerts: the owner\'s DM goes to the owner\'s account only', /Owner waiter for DM/.test(toA) && !/Bea waiter/.test(toA), toA.slice(0, 200));
  check('alerts: Bea\'s DM goes to Bea\'s account only', /Bea waiter for DM/.test(toB) && !/Owner waiter/.test(toB), toB.slice(0, 200));
  check('alerts: nothing to an unlinked account', !dms.some(d => d.to === DX));
  check('tools: a channel the person may view but not read the history of is not listed', !/no-history/.test(aList.text) && !/no-history/.test(bList.text), aList.text.slice(0, 200));

  // ---- the blocked list: saving keeps blocks on what the saver cannot see ----
  await rawDb.collection('settings').updateOne({ _id: `discord:${A.orgId}` }, { $set: { blockedIds: [SECRET, THREAD] } });
  {
    const br2 = await launch();
    const ctx2 = await br2.newContext({ viewport: { width: 1280, height: 800 } });
    const q = await ctx2.newPage();
    await login(q, { email: 'bea@example.test', next: '/settings?section=server' });
    await q.goto(`${B}/settings?section=server`);
    const gen = q.locator('label:has-text("#general") input[type=checkbox]');
    await gen.waitFor({ timeout: 10000 });
    check('blocked list: Bea\'s picker does not show #secret-plans', (await q.locator('label:has-text("#secret-plans")').count()) === 0);
    await gen.check();
    await q.getByRole('button', { name: 'Save', exact: true }).click();
    await q.waitForFunction(() => /Saved:/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
    await ctx2.close();
    await br2.close();
  }
  const blocked = (await rawDb.collection('settings').findOne({ _id: `discord:${A.orgId}` }))?.blockedIds ?? [];
  check('blocked list: Bea\'s save adds #general', blocked.includes(GENERAL), JSON.stringify(blocked));
  check('blocked list: #secret-plans (hidden from Bea) stays blocked', blocked.includes(SECRET), JSON.stringify(blocked));
  check('blocked list: a blocked thread stays blocked', blocked.includes(THREAD), JSON.stringify(blocked));

  // ---- one account, one person: linking it again moves it ----
  await linkCode(A, 'MOVECODE');
  check('move: Bea\'s account linked by the owner', /^Linked/.test(say(await link(G1, DB, 'MOVECODE'))));
  const bProf = await rawDb.collection('settings').findOne({ _id: `profile:${Bu.userId}` });
  const aProf2 = await rawDb.collection('settings').findOne({ _id: `profile:${A.userId}` });
  check('move: it left Bea and is the owner\'s now', !bProf?.discordId && aProf2?.discordId === DB, `${bProf?.discordId} ${aProf2?.discordId}`);

  // ---- a code is used up in one step: two /link at once, one wins ----
  await linkCode(Bu, 'RACECODE');
  const race = await Promise.all([link(G1, DX, 'RACECODE'), link(G1, '111111111111111124', 'RACECODE'), link(G1, '111111111111111125', 'RACECODE')]);
  const wins = race.filter(r => /^Linked/.test(say(r))).length;
  check('link: concurrent uses of one code link once', wins === 1, race.map(say).join(' | '));
} catch (e) {
  check('discord-link (error)', false, e?.stack || String(e));
}
stub.close();
await finish();
