// Work OS in Discord, plan v4 (Work OS note c7b491432a). The relay the live listener posts to, the bug channels, the track
// emoji, the buttons on the bot's reply, Connect Discord (OAuth), the agent tools and the DMs, against a stub Discord API
// (discord-stub.mjs) with signed interactions. Seed profile: none, server mode discord. Each section adds its checks here.
import { B, CRON, ME, call, check, finish, launch, login, makeUser, mcp, pick, rawDb, setOrgGuild, setProfile } from './lib.mjs';
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
  check('first set: the For select lists the organization\'s members', (btns[1]?.components?.[0]?.options ?? []).length === 2, JSON.stringify(btns[1]?.components?.[0]?.options));
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
} catch (e) {
  check('discord-v4 (error)', false, e?.stack || String(e));
}
stub.close();
await finish();
