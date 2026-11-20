// Work OS in Discord, plan v4 (Work OS note c7b491432a). The relay the live listener posts to, the bug channels, the track
// emoji, the buttons on the bot's reply, Connect Discord (OAuth), the agent tools and the DMs, against a stub Discord API
// (discord-stub.mjs) with signed interactions. Seed profile: none, server mode discord. Each section adds its checks here.
import { B, CRON, ME, call, cron, check, finish, launch, login, makeUser, mcp, mcpAs, mkKey, pick, rawDb, setOrgGuild, setProfile } from './lib.mjs';
import { createPrivateKey, sign } from 'node:crypto';
import { startStub, BOT } from './discord-stub.mjs';

const G1 = '444444444444444451';
const DA = '111111111111111131'; // the owner's Discord account
const DB = '111111111111111132'; // Bea's
const DX = '111111111111111133'; // someone with no Work OS link
const R_BOT = '555555555555555559';
const GEN = '666666666666666651';
const BUG = '666666666666666652';
const BLK = '666666666666666654';
const VIEW = 1 << 10;
const HIST = 1 << 16;

const stub = await startStub();
const { st } = stub;
const relay = (event, data, secret = CRON) =>
  fetch(`${B}/api/discord/gateway`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret === null ? {} : { authorization: `Bearer ${secret}` }) }, body: typeof data === 'string' ? data : JSON.stringify({ event, data }) });
const waitFor = async (fn, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 150));
  }
  return fn();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const snow = (ms, n = 0) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));
let seq = 0;
/** A raw message as the gateway and the REST API give it. */
function raw({ channel = BUG, author = { id: DX, username: 'akash', global_name: 'Akash' }, content = '', ago = 0, attachments = [], ref = null, mentions = [], type }) {
  const ms = Date.now() - ago;
  return {
    id: snow(ms, ++seq),
    channel_id: channel,
    type: type ?? (ref ? 19 : 0),
    author,
    content,
    timestamp: new Date(ms).toISOString(),
    mentions,
    mention_roles: [],
    mention_everyone: false,
    attachments,
    embeds: [],
    ...(ref ? { message_reference: { message_id: ref, channel_id: channel, guild_id: G1 } } : {}),
  };
}
const put = m => ((st.messages[m.channel_id] ??= []).push(m), m);
const live = m => relay('MESSAGE_CREATE', { ...m, guild_id: G1 });
const taskOf = id => rawDb.collection('tasks').findOne({ 'source.messageId': id });
const botPostsTo = id => st.posts.filter(p => p.body.message_reference?.message_id === id);
const leadMsgs = pid => rawDb.collection('messages').find({ projectId: pid, via: 'discord-issue' }).sort({ at: 1 }).toArray();

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
  check('relay: an event from a server no organization has set makes nothing', (await rawDb.collection('tasks').countDocuments({ 'source.kind': 'discord' })) === 0);

  // ---- the world: one server, two linked people, one person with no link ----
  const A = ME;
  const Bu = await makeUser({ email: 'bea@example.test', name: 'Bea Rao', orgId: A.orgId, role: 'member' });
  await setOrgGuild(A.orgId, G1);
  await setProfile(A, { discordId: DA, quietStart: 0, quietEnd: 0 });
  await setProfile(Bu, { discordId: DB, quietStart: 0, quietEnd: 0 });
  // Cy is made here, before the server first reads the member list (it is cached for a while): a linked member who is on no task.
  const DC = '111111111111111134';
  const Cy = await makeUser({ email: 'cy@example.test', name: 'Cy Nair', orgId: A.orgId, role: 'member' });
  await setProfile(Cy, { discordId: DC, quietStart: 0, quietEnd: 0 });
  // Dee and Eli have not connected Discord (the Connect tests); made here for the same reason.
  const Dee = await makeUser({ email: 'dee@example.test', name: 'Dee Iyer', orgId: A.orgId, role: 'member' });
  const Eli = await makeUser({ email: 'eli@example.test', name: 'Eli Das', orgId: A.orgId, role: 'member' });
  for (const who of [Dee, Eli]) await setProfile(who, { quietStart: 0, quietEnd: 0 });
  const ch = (id, name, extra = {}) => ({ id, type: 0, name, guild_id: G1, parent_id: null, position: 0, permission_overwrites: [], ...extra });
  st.guilds[G1] = {
    channels: [ch(GEN, 'general'), ch(BUG, 'delpat-os'), ch(BLK, 'secrets')],
    roles: [{ id: G1, name: '@everyone', permissions: String(VIEW | HIST) }, { id: R_BOT, name: 'bot', permissions: '0', tags: { bot_id: BOT } }],
    members: { [DA]: { roles: [], user: { id: DA, username: 'om' } }, [DB]: { roles: [], user: { id: DB, username: 'bea' } }, [DX]: { roles: [], user: { id: DX, username: 'akash' } }, [BOT]: { roles: [R_BOT], user: { id: BOT, username: 'workos-bot' } } },
  };
  await rawDb.collection('settings').updateOne({ _id: `discord:${A.orgId}` }, { $set: { blockedIds: [BLK] } });
  const pr = await call('add_project', { name: 'Delpat OS' });
  const pid = pr.created?.id ?? pr.project?.id ?? pr.id;
  const proj0 = await rawDb.collection('projects').findOne({ name: 'Delpat OS' });
  check('setup: the project exists', !!proj0, JSON.stringify(pr).slice(0, 200));
  const PID = proj0?._id ?? pid;

  // ---- 2. the project setting, and the first set ----
  const old = put(raw({ content: 'an old post from before the window', ago: 10 * 86_400_000 }));
  const p1 = put(raw({ content: 'The login page shows a blank screen on my phone', ago: 3 * 86_400_000, attachments: [{ filename: 'shot.png', url: `http://127.0.0.1:${process.env.E2E_DISCORD_PORT}/cdn/shot.png`, size: 100 }] }));
  const p2 = put(raw({ content: 'Dark mode hides the save button', ago: 2 * 86_400_000 }));
  const botOld = put(raw({ content: 'a bot post', ago: 86_400_000, author: { id: '777777777777777777', username: 'some-bot', bot: true } }));
  const r1 = put(raw({ content: 'it happens on iOS too', ago: 3600_000, ref: p1.id }));
  const unrelated = put(raw({ content: 'lunch?', ago: 1800_000, ref: botOld.id }));
  const br = await launch();
  const ctx = await br.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await login(page, { next: `/projects/${PID}?tab=info` });
  await page.goto(`${B}/projects/${PID}?tab=info`);
  const row = page.locator('[data-part="discord-channel"]');
  await row.waitFor({ timeout: 15000 });
  check('setting: the row shows None before a channel is set', /None/.test(await row.innerText()), await row.innerText());
  await row.locator('[data-discord-channel-change]').click();
  const sel = page.locator('[data-discord-channel-pick]');
  await sel.waitFor({ timeout: 8000 });
  await sel.click();
  const list = page.locator('[data-slot=select-content]').last();
  await list.waitFor({ timeout: 8000 });
  const opts = await list.getByRole('option').allInnerTexts();
  await page.keyboard.press('Escape');
  await page.locator('[data-slot=select-content]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  check('setting: the picker lists #delpat-os and #general', opts.some(o => /#delpat-os/.test(o)) && opts.some(o => /#general/.test(o)), opts.join(','));
  check('setting: a channel marked sensitive is not offered', !opts.some(o => /#secrets/.test(o)), opts.join(','));
  await pick(page, sel, BUG);
  await page.locator('[data-discord-channel-save]').click();
  await page.waitForFunction(() => /#delpat-os/.test(document.querySelector('[data-discord-channel-summary]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  const saved = await rawDb.collection('projects').findOne({ _id: PID });
  check('setting: saved on the project with the switch on', saved?.discordChannel?.channelId === BUG && saved.discordChannel.everyPost === true, JSON.stringify(saved?.discordChannel));
  check('setting: the row says what it is', /#delpat-os/.test(await row.innerText()) && /Every post is an issue/.test(await row.innerText()), await row.innerText());
  await page.screenshot({ path: `${process.env.E2E_SHOTS || '.'}/v4-project-row-1280.png` }).catch(() => {});

  const t1 = await waitFor(async () => (await taskOf(p1.id)) && (await taskOf(p2.id)) && (await taskOf(r1.id)) === null && (await rawDb.collection('tasks').countDocuments({ 'source.tracked': 'issue' })) >= 2, 15000);
  check('first set: the posts of the last 7 days are tasks', !!t1);
  const tOld = await taskOf(old.id);
  check('first set: a post older than 7 days is not recorded', tOld === null);
  check('first set: a bot post gets nothing', (await taskOf(botOld.id)) === null);
  const k1 = await taskOf(p1.id);
  check('first set: a post has priority P2, mode Code & Dev and the project', k1?.priority === 'P2' && k1.mode === 'Code & Dev' && k1.projectId === PID, JSON.stringify({ p: k1?.priority, m: k1?.mode }));
  check('first set: the author is the Discord display name when not linked', k1?.source?.author === 'Akash' && k1?.titleBy?.kind === 'discord-author', JSON.stringify(k1?.titleBy));
  check('first set: the source is the message (kind discord, its link)', k1?.source?.kind === 'discord' && k1.source.url === `https://discord.com/channels/${G1}/${BUG}/${p1.id}` && k1.source.tracked === 'issue', JSON.stringify(k1?.source));
  check('first set: attachments are stored as links', (k1?.links ?? []).some(l => l.label === 'shot.png' && /shot\.png/.test(l.url)), JSON.stringify(k1?.links));
  const reply1 = await waitFor(() => botPostsTo(p1.id)[0]);
  check('first set: the bot replies under the post with the task number and a link', !!reply1 && new RegExp(`^Recorded \\[#${k1?.ref}\\]\\(<[^>]*/tasks/${k1?.ref}>\\)$`).test(reply1.body.content), reply1?.body.content);
  const btns = reply1?.body.components ?? [];
  check('first set: the reply has Undo, Done and a For select', btns[0]?.components?.map(c => c.custom_id).join() === `wo:undo:${k1?.ref},wo:done:${k1?.ref}` && btns[1]?.components?.[0]?.custom_id === `wo:for:${k1?.ref}`, JSON.stringify(btns).slice(0, 300));
  check('first set: the For select lists the organization\'s members', (btns[1]?.components?.[0]?.options ?? []).length === 5, JSON.stringify(btns[1]?.components?.[0]?.options));
  check('first set: the reply is saved on the task', k1?.source?.replyId === reply1?.id, JSON.stringify(k1?.source));
  const c1 = await rawDb.collection('activity').find({ taskId: k1?._id, type: 'comment' }).toArray();
  check('first set: a reply in the window is a comment on its issue', c1.length === 1 && /iOS too/.test(c1[0].note ?? ''), JSON.stringify(c1.map(c => c.note)));
  check('first set: a reply to something else gets nothing', (await taskOf(unrelated.id)) === null && botPostsTo(unrelated.id).length === 0);
  const leads1 = await leadMsgs(PID);
  check('first set: the lead gets one message per issue and one per reply', leads1.length === 3 && leads1.filter(m => /^New issue #\d+ from Akash: /.test(m.body)).length === 2 && leads1.some(m => /^Reply on #\d+ from Akash: it happens on iOS too/.test(m.body)), leads1.map(m => m.body).join(' | '));
  check('first set: a screenshot is counted in the line', leads1.some(m => /Recorded|The login page shows a blank screen on my phone \(\+1 screenshot\)/.test(m.body) && /\(\+1 screenshot\)/.test(m.body)), leads1.map(m => m.body).join(' | '));
  check('first set: the message is marked as outside text (never an instruction)', leads1.every(m => m.via === 'discord-issue' && m.kind === 'fyi'), JSON.stringify(leads1.map(m => [m.via, m.kind])));
  const taskCount = await rawDb.collection('tasks').countDocuments({ 'source.tracked': 'issue' });
  const postsBefore = st.posts.length;
  // Saving the same channel again does not read it back.
  await row.locator('[data-discord-channel-change]').click();
  await page.locator('[data-discord-channel-save]').click();
  await sleep(1500);
  check('first set: runs once (saving again records nothing more)', (await rawDb.collection('tasks').countDocuments({ 'source.tracked': 'issue' })) === taskCount && st.posts.length === postsBefore);
  const after0 = (await rawDb.collection('projects').findOne({ _id: PID })).discordChannel.after;
  check('first set: the catch-up pointer is at the newest message', BigInt(after0 ?? '0') >= BigInt(r1.id), String(after0));

  // ---- 2. live posts ----
  const n1 = put(raw({ content: 'Export to PDF crashes on large tasks', author: { id: DB, username: 'bea', global_name: 'Bea (Discord)' } }));
  await live(n1);
  const k2 = await waitFor(() => taskOf(n1.id));
  check('live: one post gives one task', !!k2 && k2.title.startsWith('Export to PDF crashes'), k2?.title);
  check('live: a linked author is the Work OS person (their name, their text)', k2?.source?.author === 'Bea Rao' && k2?.titleBy?.kind === 'user' && k2.titleBy.userId === Bu.userId, JSON.stringify({ a: k2?.source?.author, b: k2?.titleBy }));
  const rep2 = await waitFor(() => botPostsTo(n1.id)[0]);
  const lead2 = await waitFor(async () => (await leadMsgs(PID)).find(m => m.body.includes(`#${k2?.ref} `)));
  check('live: one post gives one reply and one lead message', !!rep2 && botPostsTo(n1.id).length === 1 && !!lead2 && /^New issue #\d+ from Bea Rao: Export to PDF crashes on large tasks$/.test(lead2.body), lead2?.body);
  await live(n1);
  await Promise.all([live(n1), live(n1)]);
  await sleep(1500);
  check('live: the same event again (and twice at once) gives one task, one reply', (await rawDb.collection('tasks').countDocuments({ 'source.messageId': n1.id })) === 1 && botPostsTo(n1.id).length === 1);
  // a burst of the same new post delivered at once
  const n2 = put(raw({ content: 'Sidebar flickers when I resize' }));
  await Promise.all([live(n2), live(n2), live(n2)]);
  await waitFor(() => taskOf(n2.id));
  await sleep(1200);
  check('live: three deliveries at once give one task and one reply', (await rawDb.collection('tasks').countDocuments({ 'source.messageId': n2.id })) === 1 && botPostsTo(n2.id).length === 1);
  const before = st.posts.length;
  const bot = put(raw({ content: 'deploy finished', author: { id: '777777777777777777', username: 'ci', bot: true } }));
  const gen = put(raw({ channel: GEN, content: 'anyone seen the build' }));
  const rep3 = put(raw({ content: 'ok thanks', ref: bot.id }));
  const sticker = put(raw({ content: '' }));
  const sys = put(raw({ content: 'joined', type: 7 }));
  for (const m of [bot, gen, rep3, sticker, sys]) await live(m);
  await sleep(1500);
  check('live: a bot post, another channel, a reply to something else, an empty post and a system message give nothing', st.posts.length === before && [bot, gen, rep3, sticker, sys].every(m => !st.posts.some(p => p.body.message_reference?.message_id === m.id)) && (await rawDb.collection('tasks').countDocuments({ 'source.messageId': { $in: [bot.id, gen.id, rep3.id, sticker.id, sys.id] } })) === 0);
  // a reply to the post, and a reply to the bot's reply
  const rp = put(raw({ content: 'also on Android 14', ref: n1.id, author: { id: DX, username: 'akash', global_name: 'Akash' } }));
  await live(rp);
  const cm = await waitFor(async () => (await rawDb.collection('activity').find({ taskId: k2._id, type: 'comment' }).toArray())[0]);
  check('live: a reply to the post is a comment, by its author (an outside name here)', !!cm && /Akash \(Discord\): also on Android 14/.test(cm.note ?? ''), JSON.stringify(cm?.note));
  const rb = put(raw({ content: 'repro steps: open a 90 item task', ref: rep2.id, author: { id: DB, username: 'bea', global_name: 'Bea (Discord)' } }));
  await live(rb);
  const cms = await waitFor(async () => { const l = await rawDb.collection('activity').find({ taskId: k2._id, type: 'comment' }).toArray(); return l.length >= 2 ? l : null; });
  check('live: a reply to the bot\'s reply is a comment too, as the linked person', !!cms && cms.some(c => /repro steps/.test(c.note ?? '') && c.actor?.userId === Bu.userId), JSON.stringify(cms?.map(c => [c.note, c.actor])));
  const leadReplies = await waitFor(async () => { const l = (await leadMsgs(PID)).filter(m => /^Reply on #/.test(m.body)); return l.length >= 3 ? l : null; });
  check('live: each reply is a message to the lead', !!leadReplies, '');
  // a trashed task is recorded again
  const del = await mcp('delete_task', { task: k2.ref, title: k2.title });
  check('trash: the task is deleted', !!del?.deleted, JSON.stringify(del));
  await live(n1);
  const k2b = await waitFor(async () => (await rawDb.collection('tasks').findOne({ 'source.messageId': n1.id })));
  check('trash: a trashed task is recorded again when the post comes again', !!k2b && k2b._id !== k2._id, JSON.stringify(k2b?.ref));

  // ---- 1. the catch-up after a gap ----
  const miss1 = put(raw({ content: 'Missed while the listener was down: PDF margins are off' }));
  const missReply = put(raw({ content: 'confirmed on my side', ref: miss1.id, author: { id: DB, username: 'bea' } }));
  await relay('READY', { guildIds: [G1], userId: BOT });
  const km = await waitFor(() => taskOf(miss1.id));
  check('catch-up: a post missed during a gap is recorded after READY', !!km && km.title.startsWith('Missed while the listener was down'), km?.title);
  await waitFor(async () => (await rawDb.collection('activity').find({ taskId: km?._id, type: 'comment' }).toArray()).length === 1);
  check('catch-up: so is a reply in the gap', (await rawDb.collection('activity').find({ taskId: km?._id, type: 'comment' }).toArray()).length === 1);
  const posts1 = st.posts.length;
  await relay('READY', { guildIds: [G1], userId: BOT });
  await relay('RESUMED', { guildIds: [G1] });
  await sleep(2000);
  check('catch-up: READY and RESUMED again record nothing twice', st.posts.length === posts1 && (await rawDb.collection('tasks').countDocuments({ 'source.messageId': miss1.id })) === 1);
  const miss2 = put(raw({ content: 'Second gap: tooltip clipped' }));
  await relay('RESUMED', { guildIds: [G1] });
  check('catch-up: RESUMED reads the gap too', !!(await waitFor(() => taskOf(miss2.id))));

  // ---- the switch off: tracked messages only ----
  await row.locator('[data-discord-channel-change]').click();
  await page.locator('[data-discord-channel-every]').click();
  await page.locator('[data-discord-channel-save]').click();
  await page.waitForFunction(() => /Tracked messages only/.test(document.querySelector('[data-part="discord-channel"]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  const off = put(raw({ content: 'with the switch off this is not an issue' }));
  await live(off);
  await sleep(1500);
  check('switch off: a post is not recorded', (await taskOf(off.id)) === null && botPostsTo(off.id).length === 0);
  await ctx.close();
  await br.close();

  // ---- 3. the track emoji ----
  const setting = await rawDb.collection('settings').findOne({ _id: `discord:${A.orgId}` });
  const WOS = setting?.trackEmojiId;
  check('emoji: the server has :wos:, uploaded once through the bot, its id kept', !!WOS && st.emojis.length === 1 && st.emojis[0].name === 'wos' && /^data:image\/png;base64,/.test(st.emojis[0].image), JSON.stringify({ WOS, n: st.emojis.length }));
  await relay('READY', { guildIds: [G1], userId: BOT });
  await sleep(800);
  check('emoji: a second READY does not upload again', st.emojis.length === 1);
  const react = (user, m, emoji = { id: WOS, name: 'wos' }, channel = m.channel_id) =>
    relay('MESSAGE_REACTION_ADD', { user_id: user, channel_id: channel, message_id: m.id, guild_id: G1, emoji, member: { user: { id: user, bot: false } } });
  const mention = (id, name) => ({ id, username: name.toLowerCase(), global_name: name });

  // no @mention: the reactor; no project: private to them
  const e1 = put(raw({ channel: GEN, content: 'We should rotate the staging API keys this week' }));
  await react(DA, e1);
  const ke1 = await waitFor(() => taskOf(e1.id));
  check('emoji: a message with no @mention is for the person who reacted', !!ke1 && (ke1.assigneeIds ?? []).join() === A.userId, JSON.stringify(ke1?.assigneeIds));
  check('emoji: with no project it is private to them, no project', ke1?.projectId === null && ke1.visibility === 'private' && ke1.ownerId === A.userId, JSON.stringify({ p: ke1?.projectId, v: ke1?.visibility }));
  check('emoji: the title is drafted from the message and the source is the message', ke1?.title === 'We should rotate the staging API keys this week' && ke1.source?.tracked === 'emoji' && ke1.source.reactorId === A.userId, JSON.stringify({ t: ke1?.title, s: ke1?.source }));
  const re1 = await waitFor(() => botPostsTo(e1.id)[0]);
  check('emoji: the bot replies "Recorded #N · name" with the buttons', new RegExp(`^Recorded \\[#${ke1?.ref}\\]\\(<[^>]*/tasks/${ke1?.ref}>\\) · E2E Owner$`).test(re1?.body.content ?? '') && re1.body.components?.length === 2, re1?.body.content);
  await react(DB, e1);
  await react(DA, e1, { id: null, name: '📌' });
  await sleep(1500);
  check('emoji: a second reaction on a tracked message does nothing', (await rawDb.collection('tasks').countDocuments({ 'source.messageId': e1.id })) === 1 && botPostsTo(e1.id).length === 1);

  // @mentions: the linked people mentioned; the unlinked and bots are not people here
  const e2 = put(raw({ channel: GEN, content: 'Bea can you check the invoice export', mentions: [mention(DB, 'Bea (Discord)'), mention(DX, 'Akash'), { ...mention(BOT, 'bot'), bot: true }] }));
  await react(DA, e2, { id: null, name: '📌' });
  const ke2 = await waitFor(() => taskOf(e2.id));
  check('emoji: the pin works too; a mentioned linked person is the assignee (not the reactor)', !!ke2 && (ke2.assigneeIds ?? []).join() === Bu.userId, JSON.stringify(ke2?.assigneeIds));
  check('emoji: with no project it is private to that assignee', ke2?.visibility === 'private' && ke2.ownerId === Bu.userId, JSON.stringify({ v: ke2?.visibility, o: ke2?.ownerId }));
  const re2 = await waitFor(() => botPostsTo(e2.id)[0]);
  check('emoji: the reply names the assignee', /· Bea Rao$/.test(re2?.body.content ?? ''), re2?.body.content);
  // two linked people mentioned, in the project's channel: both are on it, in the project
  const e3 = put(raw({ channel: BUG, content: 'Login and signup both need the new copy', mentions: [mention(DB, 'Bea'), mention(DA, 'Om')], author: { id: DB, username: 'bea', global_name: 'Bea' } }));
  await react(DA, e3);
  const ke3 = await waitFor(() => taskOf(e3.id));
  check('emoji: in the project\'s channel it belongs to the project, shared like the project', ke3?.projectId === PID && ke3.visibility === 'org', JSON.stringify({ p: ke3?.projectId, v: ke3?.visibility }));
  check('emoji: several mentioned people are all on it', !!ke3 && [...(ke3.assigneeIds ?? [])].sort().join() === [A.userId, Bu.userId].sort().join(), JSON.stringify(ke3?.assigneeIds));
  const re3 = await waitFor(() => botPostsTo(e3.id)[0]);
  check('emoji: the reply names the people and the project', /^Recorded \[#\d+\]\(<[^>]*>\) · [A-Za-z0-9 ,]+ · Delpat OS$/.test(re3?.body.content ?? ''), re3?.body.content);
  // other emoji, the bot's own messages and a sensitive channel
  const e4 = put(raw({ channel: GEN, content: 'a thumbs up is not a task' }));
  await react(DA, e4, { id: null, name: '👍' });
  const e5 = put(raw({ channel: GEN, content: 'the bot said this', author: { id: BOT, username: 'workos-bot', bot: true } }));
  await react(DA, e5);
  const e6 = put(raw({ channel: BLK, content: 'the staging password is in the vault' }));
  await react(DA, e6);
  await sleep(1500);
  check('emoji: another emoji, the bot\'s own message and a sensitive channel give nothing', [e4, e5, e6].every(m => !st.posts.some(p => p.body.message_reference?.message_id === m.id)) && (await rawDb.collection('tasks').countDocuments({ 'source.messageId': { $in: [e4.id, e5.id, e6.id] } })) === 0);
  // someone who is not linked
  const e7 = put(raw({ channel: GEN, content: 'please look at the onboarding email' }));
  const postsBefore7 = st.posts.length;
  await react(DX, e7);
  const note7 = await waitFor(() => st.posts.slice(postsBefore7).find(p => p.body.message_reference?.message_id === e7.id));
  check('emoji: an unlinked reactor makes no task and is told to connect', !!note7 && /Connect Discord in Work OS first/.test(note7.body.content) && note7.body.content.startsWith(`<@${DX}>`) && (await taskOf(e7.id)) === null, note7?.body.content);
  check('emoji: the note mentions only that person and has no buttons', JSON.stringify(note7?.body.allowed_mentions?.users) === JSON.stringify([DX]) && !note7?.body.components, JSON.stringify(note7?.body.allowed_mentions));
  const e8 = put(raw({ channel: GEN, content: 'and another one' }));
  const postsBefore8 = st.posts.length;
  await react(DX, e8);
  await sleep(1200);
  check('emoji: the same person is not told again within the hour', st.posts.length === postsBefore8 && (await taskOf(e8.id)) === null);
  // an issue post is already tracked: the emoji on it does nothing
  const taskTotal = await rawDb.collection('tasks').countDocuments({});
  await react(DA, n1);
  await sleep(1000);
  check('emoji: a post already recorded as an issue is not tracked twice', (await rawDb.collection('tasks').countDocuments({ 'source.messageId': n1.id })) === 1 && (await rawDb.collection('tasks').countDocuments({})) === taskTotal);
  // ---- 4. the buttons on the bot's reply ----
  const DZ = '111111111111111135'; // no link, not the poster
  const pkey = createPrivateKey({ key: Buffer.from(process.env.E2E_DISCORD_PRIV || '', 'base64'), format: 'der', type: 'pkcs8' });
  let tn = 0;
  const press = async (user, customId, values, guild = G1) => {
    const body = JSON.stringify({ id: String(++tn), application_id: '999999999999999999', type: 3, token: `btn${tn}`, guild_id: guild, channel_id: BUG, member: { user: { id: user } }, data: { custom_id: customId, component_type: values ? 3 : 2, ...(values ? { values } : {}) } });
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await fetch(`${B}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sign(null, Buffer.from(ts + body), pkey).toString('hex'), 'x-signature-timestamp': ts }, body });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const eph = r => r.body?.type === 4 && r.body.data?.flags === 64;
  const trashed = ref => rawDb.collection('trash').countDocuments({ ref });
  const track4 = async (content, reactor = DB) => {
    const m = put(raw({ channel: BUG, content, author: { id: DX, username: 'akash', global_name: 'Akash' } }));
    await react(reactor, m);
    const t = await waitFor(() => taskOf(m.id));
    await waitFor(() => botPostsTo(m.id)[0]);
    return { m, t };
  };
  const u1 = await track4('The export button does nothing on Safari');
  const ref1 = u1.t?.ref;
  check('buttons: the task has its reactor and poster recorded', !!u1.t && u1.t.source.reactorId === Bu.userId && u1.t.source.authorId === DX && !!u1.t.source.replyId, JSON.stringify(u1.t?.source));
  // refused
  const rUndo = await press(DC, `wo:undo:${ref1}`);
  check('buttons: Undo by a member who is not on it is refused, privately', eph(rUndo) && new RegExp(`Only the people on #${ref1} can do that`).test(rUndo.body.data.content) && (await taskOf(u1.m.id)) !== null, JSON.stringify(rUndo.body));
  const rDone = await press(DC, `wo:done:${ref1}`);
  check('buttons: Done by a member who is not on it is refused', eph(rDone) && (await taskOf(u1.m.id)).status !== 'Done', JSON.stringify(rDone.body));
  const rUndoZ = await press(DZ, `wo:undo:${ref1}`);
  check('buttons: Undo by someone not linked and not the poster is refused', eph(rUndoZ) && (await taskOf(u1.m.id)) !== null, JSON.stringify(rUndoZ.body));
  const rDoneX = await press(DX, `wo:done:${ref1}`);
  check('buttons: the poster who is not linked cannot mark it Done', eph(rDoneX) && (await taskOf(u1.m.id)).status !== 'Done', JSON.stringify(rDoneX.body));
  const rGone = await press(DA, 'wo:done:999999');
  check('buttons: a task that is not there is said so', eph(rGone) && /not found/.test(rGone.body.data.content), JSON.stringify(rGone.body));
  const rOther = await press(DA, `wo:done:${ref1}`, undefined, '444444444444444499');
  check('buttons: a press from a server no organization has set does nothing', (await taskOf(u1.m.id)).status !== 'Done', JSON.stringify(rOther.body));
  // For
  const rForOk = await press(DC, `wo:for:${ref1}`, [Cy.userId]);
  const afterFor = await taskOf(u1.m.id);
  check('buttons: For by any linked member sets who it is for, and the reply is rewritten with the buttons', rForOk.body?.type === 7 && (afterFor.assigneeIds ?? []).join() === Cy.userId && /· Cy Nair/.test(rForOk.body.data.content) && rForOk.body.data.components?.length === 2, JSON.stringify({ b: rForOk.body, a: afterFor?.assigneeIds }));
  const rForZ = await press(DZ, `wo:for:${ref1}`, [Bu.userId]);
  check('buttons: For by someone not linked is refused and asks them to connect', eph(rForZ) && /Connect Discord/.test(rForZ.body.data.content) && ((await taskOf(u1.m.id)).assigneeIds ?? []).join() === Cy.userId, JSON.stringify(rForZ.body));
  const rForBad = await press(DC, `wo:for:${ref1}`, ['not-a-member']);
  check('buttons: For with someone outside the organization changes nothing', eph(rForBad) && ((await taskOf(u1.m.id)).assigneeIds ?? []).join() === Cy.userId, JSON.stringify(rForBad.body));
  const rForPriv = await press(DA, `wo:for:${ke1.ref}`, [Bu.userId]);
  check('buttons: For on a task with no project (private) says so and changes nothing', eph(rForPriv) && /private/.test(rForPriv.body.data.content) && ((await taskOf(e1.id)).assigneeIds ?? []).join() === A.userId, JSON.stringify(rForPriv.body));
  // Done
  const rDoneOk = await press(DC, `wo:done:${ref1}`);
  const doneDoc = await taskOf(u1.m.id);
  check('buttons: Done by a person on it completes it and the reply says Done with no buttons', rDoneOk.body?.type === 7 && doneDoc.status === 'Done' && new RegExp(`^Done \\[#${ref1}\\]`).test(rDoneOk.body.data.content) && rDoneOk.body.data.components?.length === 0, JSON.stringify(rDoneOk.body));
  // Undo
  const u2 = await track4('Footer links are broken on the pricing page');
  const rUndoPoster = await press(DX, `wo:undo:${u2.t.ref}`);
  check('buttons: Undo by the poster (not linked) removes the task and the reply says Removed', rUndoPoster.body?.type === 7 && /^Removed #/.test(rUndoPoster.body.data.content) && rUndoPoster.body.data.components?.length === 0 && (await taskOf(u2.m.id)) === null && (await trashed(u2.t.ref)) === 1, JSON.stringify(rUndoPoster.body));
  const u3 = await track4('Newsletter signup shows the wrong month');
  const rUndoReactor = await press(DB, `wo:undo:${u3.t.ref}`);
  check('buttons: Undo by the person who reacted works', rUndoReactor.body?.type === 7 && (await taskOf(u3.m.id)) === null, JSON.stringify(rUndoReactor.body));
  const u4 = await track4('The invite email goes to spam');
  const rUndoOwner = await press(DA, `wo:undo:${u4.t.ref}`);
  check('buttons: Undo by an organization owner works', rUndoOwner.body?.type === 7 && (await taskOf(u4.m.id)) === null, JSON.stringify(rUndoOwner.body));
  const again = await press(DA, `wo:undo:${u4.t.ref}`);
  check('buttons: a second Undo says it is not there', eph(again) && /not found/.test(again.body.data.content));
  const u5 = await track4('The avatar upload stalls at 99 percent');
  const rDoneOwner = await press(DA, `wo:done:${u5.t.ref}`);
  check('buttons: Done by an organization owner works', rDoneOwner.body?.type === 7 && (await taskOf(u5.m.id)).status === 'Done', JSON.stringify(rDoneOwner.body));
  // completing anywhere edits the reply
  const u6 = await track4('Search results ignore the date filter');
  const edits0 = st.edits.length;
  const done6 = await call('complete_task', { task: u6.t.ref, note: 'fixed' });
  const edit6 = await waitFor(() => st.edits.slice(edits0).find(e => e.body.content?.startsWith('Done')));
  check('buttons: completing the task elsewhere edits the bot reply to Done, with no buttons', !done6.ERROR && !!edit6 && new RegExp(`^Done \\[#${u6.t.ref}\\]`).test(edit6.body.content) && Array.isArray(edit6.body.components) && edit6.body.components.length === 0 && edit6.channel === BUG, JSON.stringify({ e: edit6, d: done6 }));
  // ---- 5. Connect Discord (OAuth) ----
  const DD = '111111111111111136'; // Dee's Discord account (on the server)
  const DN = '111111111111111137'; // an account that is not on the server
  st.guilds[G1].members[DD] = { roles: [], user: { id: DD, username: 'dee' } };
  const mem = e => rawDb.collection('settings').findOne({ _id: `profile:${e.userId}` });
  const cbOutcome = async (pg, qs) => {
    const r = await pg.request.get(`${B}/api/discord/connect/callback?${qs}`, { maxRedirects: 0 });
    return { status: r.status(), where: r.headers().location ?? '' };
  };
  const startConnect = async pg => {
    const r = await pg.request.get(`${B}/api/discord/connect`, { maxRedirects: 0 });
    const loc = r.headers().location ?? '';
    return { status: r.status(), loc, state: loc ? new URL(loc).searchParams.get('state') : null };
  };
  const deeKey = await mkKey({ agent: 'claude', userId: Dee.userId, orgId: Dee.orgId, name: 'dee chat' });
  const deeTool = await mcpAs(deeKey, 'discord_list_channels', {});
  check('unconnected: the Discord tools ask to connect first', deeTool.isError && /Connect your Discord account/i.test(deeTool.text), deeTool.text.slice(0, 160));
  const brC = await launch();
  const cxD = await brC.newContext({ viewport: { width: 1280, height: 900 } });
  const pgD = await cxD.newPage();
  const anon = await fetch(`${B}/api/discord/connect`, { redirect: 'manual' });
  check('connect: signed out, the start does not go to Discord', [303, 401].includes(anon.status) && !(anon.headers.get('location') ?? '').includes('oauth2'), `${anon.status} ${anon.headers.get('location')}`);
  const anonCb = await fetch(`${B}/api/discord/connect/callback?code=abc&state=${'a'.repeat(32)}`, { redirect: 'manual' });
  check('connect: signed out, the callback links nothing', [303, 401].includes(anonCb.status) && !(await rawDb.collection('settings').findOne({ discordId: 'abc' })));
  await login(pgD, { email: 'dee@example.test', next: '/today' });
  await pgD.goto(`${B}/today`);
  check('today: an unconnected person sees the Connect Discord card', await pgD.locator('[data-section="discord"]:visible').waitFor({ timeout: 15000 }).then(() => true, () => false));
  await pgD.goto(`${B}/settings?section=notifications`);
  check('settings: the Discord group has a Connect Discord button and no code box', (await pgD.locator('[data-discord-connect]').count()) === 1 && (await pgD.locator('[data-discord-link-code]').count()) === 0);
  const s1 = await startConnect(pgD);
  const au1 = s1.loc ? new URL(s1.loc) : null;
  check('connect: the start sends the person to Discord with the identify scope and our callback', s1.status === 303 && au1?.pathname === '/oauth2/authorize' && au1.searchParams.get('client_id') === '222222222222222222' && au1.searchParams.get('scope') === 'identify' && au1.searchParams.get('response_type') === 'code' && /\/api\/discord\/connect\/callback$/.test(au1.searchParams.get('redirect_uri') ?? '') && (s1.state ?? '').length >= 20, s1.loc);
  check('connect: the state is stored hashed, not as sent', !!(await mem(Dee))?.discordConnect?.hash && !JSON.stringify(await mem(Dee)).includes(s1.state));
  const bad1 = await cbOutcome(pgD, `code=whatever&state=${'z'.repeat(32)}`);
  check('connect: a state we did not make links nothing', /discord=failed/.test(bad1.where) && !(await mem(Dee))?.discordId, bad1.where);
  const bad2 = await cbOutcome(pgD, `code=unknown-code&state=${s1.state}`);
  check('connect: a code Discord does not know links nothing', /discord=failed/.test(bad2.where) && !(await mem(Dee))?.discordId, bad2.where);
  const bad3 = await cbOutcome(pgD, `code=unknown-code&state=${s1.state}`);
  check('connect: a state is used up in one step', /discord=failed/.test(bad3.where) && !(await mem(Dee))?.discordConnect);
  const s2 = await startConnect(pgD);
  const cancelled = await cbOutcome(pgD, `error=access_denied&state=${s2.state}`);
  check('connect: pressing Cancel at Discord links nothing', /discord=failed/.test(cancelled.where) && !(await mem(Dee))?.discordId);
  const s3 = await startConnect(pgD);
  st.codes['code-nonmember'] = { id: DN, username: 'outsider' };
  const nm = await cbOutcome(pgD, `code=code-nonmember&state=${s3.state}`);
  check('connect: an account that is not on the server is refused', /discord=notmember/.test(nm.where) && !(await mem(Dee))?.discordId, nm.where);
  // another signed-in person cannot finish Dee's connect
  const s4 = await startConnect(pgD);
  const brB = await launch();
  const cxB = await brB.newContext();
  const pgB = await cxB.newPage();
  await login(pgB, { email: 'bea@example.test', next: '/today' });
  st.codes['code-stolen'] = { id: DD, username: 'dee' };
  const stolen = await cbOutcome(pgB, `code=code-stolen&state=${s4.state}`);
  check('connect: another person cannot finish someone else\'s connect', /discord=failed/.test(stolen.where) && (await mem(Bu))?.discordId === DB && !(await mem(Dee))?.discordId, stolen.where);
  await cxB.close();
  await brB.close();
  // the good path
  const s5 = await startConnect(pgD);
  st.codes['code-dee'] = { id: DD, username: 'dee' };
  const good = await cbOutcome(pgD, `code=code-dee&state=${s5.state}`);
  const deeProf = await mem(Dee);
  check('connect: a good code links the account to the signed-in person', /discord=linked/.test(good.where) && deeProf?.discordId === DD && !deeProf.discordConnect, JSON.stringify({ w: good.where, d: deeProf?.discordId }));
  check('connect: the code is used up at Discord (token exchange sent the secret)', !st.codes['code-dee']);
  const reuse = await cbOutcome(pgD, `code=code-dee&state=${s5.state}`);
  check('connect: the same callback twice does nothing the second time', /discord=failed/.test(reuse.where));
  await pgD.goto(`${B}/settings?section=notifications&discord=linked`);
  check('settings: after connecting it says so and offers Unlink', await pgD.locator('[data-discord-linked]').waitFor({ timeout: 10000 }).then(() => true, () => false) && /Discord connected/.test(await pgD.locator('[data-discord-result="linked"]').innerText().catch(() => '')));
  await pgD.goto(`${B}/today`);
  await pgD.waitForLoadState('networkidle').catch(() => {});
  check('today: the card is gone once connected', (await pgD.locator('[data-section="discord"]:visible').count()) === 0);
  const asDee = await press(DD, `wo:undo:${ke1.ref}`);
  check('connect: the new link is what the buttons use (Dee is not on the task, so she is refused as Dee)', eph(asDee) && /Only the people|not found/.test(asDee.body.data.content), JSON.stringify(asDee.body));
  // one Discord account belongs to one person: Dee unlinks, then connects Bea's account, which moves to her
  await pgD.goto(`${B}/settings?section=notifications`);
  await pgD.locator('[data-discord-unlink]').click();
  await waitFor(async () => !(await mem(Dee))?.discordId);
  check('settings: Unlink clears the link', !(await mem(Dee))?.discordId);
  const s6 = await startConnect(pgD);
  st.codes['code-beas'] = { id: DB, username: 'bea' };
  await cbOutcome(pgD, `code=code-beas&state=${s6.state}`);
  check('connect: one Discord account belongs to one person: it moved from Bea to Dee', (await mem(Dee))?.discordId === DB && !(await mem(Bu))?.discordId, JSON.stringify({ d: (await mem(Dee))?.discordId, b: (await mem(Bu))?.discordId }));
  await cxD.close();
  await brC.close();
  // dismiss, remembered per person; and what it looks like
  const shots = process.env.E2E_SHOTS || '.';
  const brE = await launch();
  for (const [w, h, scheme] of [[1280, 900, 'light'], [1280, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
    const cx = await brE.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, hasTouch: w < 768 });
    const pg = await cx.newPage();
    await login(pg, { email: 'eli@example.test', next: '/today', phone: w < 768 });
    await pg.goto(`${B}/today`);
    await pg.locator('[data-section="discord"]:visible').waitFor({ timeout: 15000 });
    await pg.locator('[data-section="discord"]:visible').screenshot({ path: `${shots}/v4-today-card-${w}-${scheme}.png` });
    await pg.goto(`${B}/settings?section=notifications`);
    await pg.locator('[data-notifications-discord]').waitFor({ timeout: 15000 });
    await pg.locator('[data-notifications-discord]').screenshot({ path: `${shots}/v4-settings-${w}-${scheme}.png` });
    await cx.close();
  }
  const cxE = await brE.newContext({ viewport: { width: 1280, height: 900 } });
  const pgE = await cxE.newPage();
  await login(pgE, { email: 'eli@example.test', next: '/today' });
  await pgE.goto(`${B}/today`);
  await pgE.locator('[data-discord-card-dismiss]:visible').click();
  await pgE.locator('[data-section="discord"]:visible').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  check('today: Dismiss hides the card', (await pgE.locator('[data-section="discord"]:visible').count()) === 0);
  await pgE.reload();
  await pgE.waitForLoadState('networkidle').catch(() => {});
  check('today: it stays hidden for that person, and is saved on their profile', (await pgE.locator('[data-section="discord"]:visible').count()) === 0 && (await mem(Eli))?.discordCardHidden === true);
  await pgE.goto(`${B}/settings?section=notifications`);
  check('settings: after Dismiss the Connect button is still in Settings', (await pgE.locator('[data-discord-connect]').count()) === 1);
  await cxE.close();
  await brE.close();
  // ---- 7. DMs: only a Need that waited over a day (reels are owner alerts, lib/owner-alert.ts) ----
  const dmsTo = id => st.dms.filter(d => d.to === id);
  const dm0 = dmsTo(DA).length;
  const needNew = (await call('ask', { project: 'Delpat OS', to: 'me', kind: 'approve', ask: 'Ship the Safari fix this week?' })).need;
  const needOld = (await call('ask', { project: 'Delpat OS', to: 'me', kind: 'approve', ask: 'Rotate the staging keys before Friday?' })).need;
  check('dm: two Needs were asked', !!needNew?.id && !!needOld?.id, JSON.stringify({ n: needNew, o: needOld }));
  await rawDb.collection('needs').updateOne({ _id: needOld.id }, { $set: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
  // an alert of another kind (a task unblocked) is not sent to Discord any more
  const blocker = (await call('add_task', { title: 'DM test blocker' })).created.ref;
  await call('add_task', { title: 'DM test waiter', depends_on: [blocker] });
  await call('complete_task', { task: blocker, note: 'done' });
  await cron();
  await sleep(800);
  const got = dmsTo(DA).slice(dm0);
  const oldDm = got.filter(d => d.content.includes(`Need #${needOld.ref}`));
  check('dm: a Need open over 24 hours is sent once to the person\'s Discord', oldDm.length === 1 && /Waiting over a day/.test(oldDm[0].content) && /Rotate the staging keys/.test(oldDm[0].content), JSON.stringify(got.map(d => d.content)));
  check('dm: it has no buttons (Needs are answered in the app)', !oldDm[0]?.components, JSON.stringify(oldDm[0]?.components));
  check('dm: a Need open for less than a day gets none', !got.some(d => d.content.includes(`Need #${needNew.ref}`)));
  check('dm: other kinds (unblocked and the rest) are not sent to Discord', got.length === 1, JSON.stringify(got.map(d => d.content.slice(0, 80))));
  const marked = await rawDb.collection('needs').findOne({ _id: needOld.id });
  check('dm: the Need is marked, so it is never sent twice', !!marked?.discordDmAt);
  await cron();
  await cron();
  await sleep(500);
  check('dm: later runs send nothing more for it', dmsTo(DA).slice(dm0).filter(d => d.content.includes(`Need #${needOld.ref}`)).length === 1);
  // the person's switch for Discord DMs
  await rawDb.collection('settings').updateOne({ _id: `notify:${A.userId}` }, { $set: { area: 'notify', orgId: A.orgId, userId: A.userId, notify: { channels: { push: true, discord: false }, kinds: {} } } }, { upsert: true });
  const needOff = (await call('ask', { project: 'Delpat OS', to: 'me', kind: 'approve', ask: 'Does the pricing page need a rewrite?' })).need;
  await rawDb.collection('needs').updateOne({ _id: needOff.id }, { $set: { createdAt: new Date(Date.now() - 30 * 3_600_000) } });
  await sleep(100);
  await cron();
  await sleep(500);
  const offMarked = await rawDb.collection('needs').findOne({ _id: needOff.id });
  check('dm: with the Discord switch off, an old Need is not sent', !dmsTo(DA).some(d => d.content.includes(`Need #${needOff.ref}`)) && !offMarked?.discordDmAt, JSON.stringify(dmsTo(DA).map(d => d.content.slice(0, 60))));
} catch (e) {
  check('discord-v4 (error)', false, e?.stack || String(e));
}
stub.close();
await finish();
