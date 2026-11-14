// Flow DC1, answering a Need from its Discord DM (plan-1-3 slice 6): the DM carries one button per option
// (custom id wo:need:<id>:<option>); a press arrives as a signed interaction with no server, only `user`. Only the
// addressee's linked Discord account answers, once and atomically, with via 'discord'. Another member's press, an unlinked
// account, an app-only Need and an already-answered Need are refused. A private project's Need never reaches the team
// channel. Needs the app started with DISCORD_API_BASE at the stub below (run.sh "discord" mode). Seed: none.
import http from 'node:http';
import { createPrivateKey, sign } from 'node:crypto';
import { EMAIL, ME, B, check, cron, finish, makeUser, mkKey, rawDb, setOrgGuild, setProfile, MCP } from './lib.mjs';
import { must, sleep } from './flow-lib.mjs';

const G1 = '333333333333333333', TEAM = '444444444444444444';
const D_ME = '111100000000000001', D_MATE = '111100000000000002', D_STRANGER = '111100000000000009';
const dms = [], teamPosts = [];
const stub = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => (b += d));
  q.on('end', () => {
    s.setHeader('content-type', 'application/json');
    if (q.url.endsWith('/users/@me/channels')) return s.end(JSON.stringify({ id: `dm-${JSON.parse(b).recipient_id}` }));
    let m = /^\/channels\/(\d+)$/.exec(q.url);
    if (m && q.method === 'GET') return s.end(JSON.stringify({ id: m[1], guild_id: G1 }));
    m = /\/channels\/dm-(\d+)\/messages$/.exec(q.url);
    if (m && q.method === 'POST') { dms.push({ to: m[1], ...JSON.parse(b) }); return s.end('{"id":"1"}'); }
    m = /\/channels\/(\d+)\/messages$/.exec(q.url);
    if (m && q.method === 'POST') { teamPosts.push(JSON.parse(b)); return s.end('{"id":"2"}'); }
    s.end('{}');
  });
}).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');

const dkey = createPrivateKey({ key: Buffer.from(process.env.E2E_DISCORD_PRIV || '', 'base64'), format: 'der', type: 'pkcs8' });
let dn = 0;
/** A signed DM interaction (type 3, a button press): no guild, no member, only `user`. */
async function press(user, customId, { guild = null } = {}) {
  const where = guild ? { guild_id: guild, channel_id: '888800000000000001', member: { user: { id: user } } } : { channel_id: '999900000000000001', user: { id: user } };
  const body = JSON.stringify({ id: String(++dn), application_id: '222222222222222222', type: 3, token: `dc1tok${dn}`, ...where, data: { custom_id: customId, component_type: 2 }, message: { id: '1', content: 'x' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(ts + body), dkey).toString('hex');
  const r = await fetch(`${B}/api/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, type: json?.type, content: json?.data?.content ?? '' };
}

try {
  await setOrgGuild(ME.orgId, G1);
  const mate = await makeUser({ email: 'dc1-mate@example.test', name: 'DC Mate', orgId: ME.orgId, role: 'member' });
  // profiles first (the app caches them a minute); no quiet hours so any hour delivers
  await setProfile(ME, { discordId: D_ME, quietStart: 0, quietEnd: 0, timezone: 'Asia/Kolkata' });
  await setProfile(mate, { discordId: D_MATE, quietStart: 0, quietEnd: 0, timezone: 'Asia/Kolkata' });

  await must(MCP, 'add_project', { name: 'DC Shared' });
  await must(MCP, 'add_project', { name: 'DC Private' });
  const priv = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: 'DC Private' });
  for (const c of ['projects', 'states', 'tasks']) await rawDb.collection(c).updateMany(c === 'projects' ? { _id: priv._id } : { projectId: priv._id }, { $set: { visibility: 'private' } });

  const mateKey = await mkKey({ agent: 'claude-code', name: 'dc1 mate', userId: mate.userId, orgId: ME.orgId });
  const ownerKey = await mkKey({ agent: 'claude-code', name: 'dc1 owner' });
  const a1 = await must(mateKey, 'ask', { project: 'DC Shared', to: EMAIL, kind: 'approve', ask: 'DC1 may I ship it?' });
  const a2 = await must(mateKey, 'ask', { project: 'DC Shared', to: EMAIL, kind: 'approve', ask: 'DC1 rotate the key?', app_only: true });
  const a3 = await must(mateKey, 'ask', { project: 'DC Shared', to: EMAIL, kind: 'approve', ask: 'DC1 race: may I?' });
  const a4 = await must(ownerKey, 'ask', { project: 'DC Private', to: 'me', kind: 'approve', ask: 'DC1-PRIVATE-NEED-ASK secret' });
  const [n1, n2, n3, n4] = [a1, a2, a3, a4].map(a => a.need.id);
  // a sensitive ask is app-only whatever the asker said; a review never gets buttons (accepting it marks the task Done); markdown stays text
  const a5 = await must(ownerKey, 'ask', { project: 'DC Shared', to: 'me', kind: 'approve', ask: 'DC1 deploy to production?' });
  const MD_ASK = 'DC1 MD [x](https://evil.example/p) <@&123456789012345678> @everyone *bold* pick one';
  const a7 = await must(mateKey, 'ask', { project: 'DC Shared', to: EMAIL, kind: 'decide', ask: MD_ASK, options: [{ id: 'a', label: '**big** [x](https://evil.example/a)', means: 'first' }, { id: 'b', label: '@everyone <@&123456789012345678>', means: 'second' }] });
  await must(ownerKey, 'ask', { project: 'DC Shared', to: 'me', kind: 'approve', ask: 'DC1 punctuation Fix (v2) *now* ok?' });
  const [n5, n7] =[a5, a7].map(a => a.need.id);
  // a review Need (no tool asks one): a copy of a plain Need as a review, with its alert queued like the real one, so it is delivered in the same run
  const n6 = 'dc1-review-need-0001';
  const base = await rawDb.collection('needs').findOne({ _id: n5 });
  await rawDb.collection('needs').insertOne({ ...base, _id: n6, ref: 9001, kind: 'review', ask: 'DC1 review of the work', appOnly: false, options: [{ id: 'yes', label: 'Accept', means: 'Accept the work.' }, { id: 'no', label: 'Reject', means: 'Send it back.' }], createdAt: new Date() });
  await rawDb.collection('alertQueue').insertOne({ _id: `need:${n6}`, orgId: ME.orgId, userId: ME.userId, kind: 'need', taskId: '', byTaskId: '', needId: n6, createdAt: new Date(), sentAt: null });
  // an addressee whose Discord account changed (old buttons must stop working) and one with none (profiles are cached a minute, so these are set before anything reads them)
  const D_NEW = '111100000000000021', D_OLD = '111100000000000022', D_NONE = '111100000000000023';
  const relinked = await makeUser({ email: 'dc1-relinked@example.test', name: 'DC Relinked', orgId: ME.orgId, role: 'member' });
  const unlinked = await makeUser({ email: 'dc1-unlinked@example.test', name: 'DC Unlinked', orgId: ME.orgId, role: 'member' });
  await setProfile(relinked, { discordId: D_NEW, quietStart: 0, quietEnd: 0 });
  await setProfile(unlinked, { quietStart: 0, quietEnd: 0 });
  const nRel = (await must(ownerKey, 'ask', { project: 'DC Shared', to: 'dc1-relinked@example.test', kind: 'approve', ask: 'DC1 relinked person' })).need.id;
  const nUnl = (await must(ownerKey, 'ask', { project: 'DC Shared', to: 'dc1-unlinked@example.test', kind: 'approve', ask: 'DC1 unlinked person' })).need.id;
  const status = async id => rawDb.collection('needs').findOne({ _id: id });

  // 1. The DM: one message per Need with a button per option; the app-only one has a link and no buttons
  await cron();
  await sleep(2500);
  await cron();
  await sleep(1000);
  const mine = dms.filter(d => d.to === D_ME);
  const btnIds = d => (d.components ?? []).flatMap(r => r.components ?? []).map(c => c.custom_id);
  const dm1 = mine.find(d => btnIds(d).some(c => c.startsWith(`wo:need:${n1}:`)));
  check('the DM for a Need has a button per option, custom id wo:need:<id>:<option>', !!dm1 && btnIds(dm1).length >= 2 && btnIds(dm1).includes(`wo:need:${n1}:yes`), JSON.stringify(mine.map(btnIds)));
  check('the app-only Need has no buttons in its DM, only the link', !mine.some(d => btnIds(d).some(c => c.includes(n2))), JSON.stringify(mine.map(btnIds)));
  check('...and says where to answer it', mine.some(d => /\/today#need-/.test(d.content ?? '') && /rotate the key/.test(d.content ?? '')), mine.map(d => d.content).join(' | ').slice(0, 400));
  check('nobody else got a DM about it', dms.every(d => d.to === D_ME || d.to === D_NEW || !/DC1/.test(d.content ?? '')), JSON.stringify(dms.map(d => d.to)));

  // Escaping happens where Discord renders text: the DM is escaped, the in-app inbox row and the push text are not
  const punct = mine.find(d => /DC1 punctuation/.test(d.content ?? ''));
  const inboxRows = await rawDb.collection('notifications').find({ userId: ME.userId }).toArray();
  const punctRows = inboxRows.filter(r => /DC1 punctuation/.test(`${r.title} ${r.body}`));
  check('a title like "Fix (v2) *now*" is escaped in the Discord DM...', !!punct && /Fix \\\(v2\\\) \\\*now\\\*/.test(punct.content), punct?.content);
  check('...but the in-app inbox row has no backslashes (plain text)', punctRows.length > 0 && punctRows.every(r => !/\\/.test(`${r.title} ${r.body}`)) && punctRows.some(r => /Fix \(v2\) \*now\*/.test(`${r.title} ${r.body}`)), JSON.stringify(punctRows.map(r => [r.title, r.body])));

  await rawDb.collection('needs').updateMany({ ask: /DC1 punctuation/ }, { $set: { status: 'withdrawn', closedAt: new Date() } }); // keeps the asker under the five-open limit
  // 2. Refusals
  const rMate = await press(D_MATE, `wo:need:${n1}:yes`);
  check("another member's press is refused (type 4, says it is not theirs)", rMate.type === 4 && /not addressed to you/.test(rMate.content) && (await status(n1)).status === 'open', JSON.stringify(rMate));
  const rStr = await press(D_STRANGER, `wo:need:${n1}:yes`);
  check('an unlinked Discord account is refused the same way', rStr.type === 4 && /not addressed to you/.test(rStr.content) && (await status(n1)).status === 'open', JSON.stringify(rStr));
  const rNone = await press(D_ME, 'wo:need:nosuchneed1234:yes');
  check('a Need that does not exist reads the same as one that is not theirs', rNone.type === 4 && /not addressed to you/.test(rNone.content), JSON.stringify(rNone));
  const rApp = await press(D_ME, `wo:need:${n2}:yes`);
  check('an app-only Need is refused with the link, and stays open', rApp.type === 4 && /app only/.test(rApp.content) && /\/today#need-/.test(rApp.content) && (await status(n2)).status === 'open', JSON.stringify(rApp));
  const rBad = await press(D_ME, `wo:need:${n1}:maybe`);
  check('an option the Need does not have is refused', rBad.type === 4 && /not one of this Need/.test(rBad.content) && (await status(n1)).status === 'open', JSON.stringify(rBad));
  const rSrv = await press(D_ME, `wo:need:${n1}:yes`, { guild: G1 });
  check('in a server the same button points to the DM and answers nothing', rSrv.type === 4 && /direct message/.test(rSrv.content) && (await status(n1)).status === 'open', JSON.stringify(rSrv));
  const rPriv = await press(D_MATE, `wo:need:${n4}:yes`);
  check("someone else's press on a private project's Need is refused", rPriv.type === 4 && /not addressed to you/.test(rPriv.content) && (await status(n4)).status === 'open', JSON.stringify(rPriv));

  // 3. The addressee's press answers once, with via 'discord'
  const ok = await press(D_ME, `wo:need:${n1}:yes`);
  const d1 = await status(n1);
  check('the addressee\'s press answers the Need (type 7: the DM is updated, buttons gone)', ok.type === 7 && /Answered: /.test(ok.content) && d1.status === 'answered' && d1.answer?.option === 'yes' && d1.answer?.via === 'discord' && d1.answer?.by === ME.userId, JSON.stringify({ ok, answer: d1.answer }));
  const again = await press(D_ME, `wo:need:${n1}:no`);
  const d1b = await status(n1);
  check('a second press says it is already answered and changes nothing', again.type === 4 && /already answered/.test(again.content) && d1b.answer?.option === 'yes' && String(d1b.answeredAt) === String(d1.answeredAt), JSON.stringify(again));

  // 4. Two presses at once: exactly one answer
  const race = await Promise.all([press(D_ME, `wo:need:${n3}:yes`), press(D_ME, `wo:need:${n3}:no`), press(D_ME, `wo:need:${n3}:yes`)]);
  const won = race.filter(r => r.type === 7).length, lost = race.filter(r => r.type === 4 && /already answered/.test(r.content)).length;
  const d3 = await status(n3);
  check('three presses at once: one answers, the others are told it is answered', won === 1 && lost === 2 && d3.status === 'answered' && d3.answer?.via === 'discord', JSON.stringify(race.map(r => [r.type, r.content])));

  // 4b. Sensitive words force app-only; a review gets no buttons and a crafted press is refused
  const d5 = await status(n5);
  check('an ask that says "deploy to production" is app-only whatever the asker said: no buttons', d5.appOnly === true && !mine.some(d => btnIds(d).some(c => c.includes(n5))), JSON.stringify({ appOnly: d5.appOnly, btn: mine.map(btnIds) }));
  const rSens = await press(D_ME, `wo:need:${n5}:yes`);
  check('...and a crafted press on it is refused with the link', rSens.type === 4 && /app only/.test(rSens.content) && (await status(n5)).status === 'open', JSON.stringify(rSens));
  check('a review Need gets no buttons in its DM', !mine.some(d => btnIds(d).some(c => c.includes(n6))) && mine.some(d => /DC1 review of the work/.test(d.content ?? '')), JSON.stringify(mine.map(d => [d.content, btnIds(d).length])));
  const rRev = await press(D_ME, `wo:need:${n6}:yes`);
  check('a crafted press on a review Need is refused with the app link, and the Need stays open', rRev.type === 4 && /answered in the app/.test(rRev.content) && /\/today#need-/.test(rRev.content) && (await status(n6)).status === 'open', JSON.stringify(rRev));

  // 4c. Markdown and mentions in the ask and in option labels stay text: in the DM, on the buttons and in the reply
  const dm7 = mine.find(d => btnIds(d).some(c => c.startsWith(`wo:need:${n7}:`)));
  const labels7 = (dm7?.components ?? []).flatMap(r => r.components ?? []).map(c => c.label);
  const dmText7 = dm7?.content ?? '';
  check('the DM shows the ask as text: no masked link, no role mention, no @everyone, markdown escaped, mentions off', !!dm7 && !/evil\.example/.test(dmText7) && !/<@/.test(dmText7) && !/@everyone/.test(dmText7) && /\\\*bold\\\*/.test(dmText7) && (dm7.allowed_mentions?.parse ?? []).length === 0, dmText7);
  check('the button labels are plain text: no link, no mention', labels7.length === 2 && labels7.every(l => !/evil\.example|<@|@/.test(l)), JSON.stringify(labels7));
  const r7 = await press(D_ME, `wo:need:${n7}:a`);
  check('the reply to a press shows the option label escaped (no link, no mention)', r7.type === 7 && /^Answered: /.test(r7.content) && !/evil\.example/.test(r7.content) && /\\\*\\\*big\\\*\\\*/.test(r7.content), JSON.stringify(r7));

  // 4d. A Need that is no longer open, or no longer reachable, says so truthfully and changes nothing
  const wd = await must(ownerKey, 'ask', { project: 'DC Shared', to: 'me', kind: 'chase', ask: 'DC1 withdrawn one' });
  await must(ownerKey, 'withdraw_need', { id: wd.need.id });
  const rWd = await press(D_ME, `wo:need:${wd.need.id}:done`);
  check('a press on a withdrawn Need says it was withdrawn (not "answered")', rWd.type === 4 && /was withdrawn/.test(rWd.content) && !/answered/.test(rWd.content) && (await status(wd.need.id)).status === 'withdrawn', JSON.stringify(rWd));
  const task = (await must(MCP, 'add_task', { title: 'DC1 replace task', project: 'DC Shared' })).created;
  const r1 = await must(ownerKey, 'ask', { project: 'DC Shared', to: 'me', kind: 'do', task: task.ref, ask: 'DC1 first version' });
  await must(ownerKey, 'ask', { project: 'DC Shared', to: 'me', kind: 'do', task: task.ref, ask: 'DC1 second version' });
  const rRep = await press(D_ME, `wo:need:${r1.need.id}:done`);
  check('a press on a replaced Need says it was replaced', rRep.type === 4 && /was replaced/.test(rRep.content) && (await status(r1.need.id)).status === 'replaced', JSON.stringify(rRep));
  const ap = await must(ownerKey, 'ask', { project: 'DC Shared', to: 'me', kind: 'approve', ask: 'DC1 answered in the app first' });
  await rawDb.collection('needs').updateOne({ _id: ap.need.id }, { $set: { status: 'answered', answer: { option: 'no', by: ME.userId, via: 'app', at: new Date() }, answeredAt: new Date(), closedAt: new Date() } });
  const rAp = await press(D_ME, `wo:need:${ap.need.id}:yes`);
  const dAp = await status(ap.need.id);
  check('a press after the app answered it says already answered and leaves the app answer', rAp.type === 4 && /already answered/.test(rAp.content) && dAp.answer?.option === 'no' && dAp.answer?.via === 'app', JSON.stringify(rAp));
  await must(mateKey, 'add_project', { name: 'DC Lost' });
  const lost1 = await must(mateKey, 'ask', { project: 'DC Lost', to: EMAIL, kind: 'approve', ask: 'DC1 lost access' });
  const lostP = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name: 'DC Lost' });
  await rawDb.collection('projects').updateOne({ _id: lostP._id }, { $set: { visibility: 'private', ownerId: mate.userId } });
  await rawDb.collection('needs').updateMany({ projectId: lostP._id }, { $set: { visibility: 'private', ownerId: mate.userId } });
  const rLost = await press(D_ME, `wo:need:${lost1.need.id}:yes`);
  check('an addressee who lost access to the project is refused like a stranger, and the Need stays open', rLost.type === 4 && /not addressed to you/.test(rLost.content) && (await status(lost1.need.id)).status === 'open', JSON.stringify(rLost));
  const rRel = await press(D_OLD, `wo:need:${nRel}:yes`);
  check('an addressee relinked to another Discord account: the old account is refused', rRel.type === 4 && /not addressed to you/.test(rRel.content) && (await status(nRel)).status === 'open', JSON.stringify(rRel));
  const rUnl = await press(D_NONE, `wo:need:${nUnl}:yes`);
  check('an addressee with no linked account: nobody can answer from Discord', rUnl.type === 4 && /not addressed to you/.test(rUnl.content) && (await status(nUnl)).status === 'open', JSON.stringify(rUnl));
  const rNew = await press(D_NEW, `wo:need:${nRel}:yes`);
  check('...while the addressee\'s current account does answer', rNew.type === 7 && (await status(nRel)).answer?.via === 'discord', JSON.stringify(rNew));
  // a member removed from the organization: the press is refused (own organization, own server)
  const gone = await makeUser({ email: 'dc1-gone@example.test', name: 'DC Gone' });
  const D_GONE = '111100000000000031';
  await setOrgGuild(gone.orgId, '555555555555555555');
  await setProfile(gone, { discordId: D_GONE, quietStart: 0, quietEnd: 0 });
  const goneKey = await mkKey({ agent: 'claude-code', name: 'dc1 gone', userId: gone.userId, orgId: gone.orgId });
  await must(goneKey, 'add_project', { name: 'DC Gone Proj' });
  const gn2 = (await must(goneKey, 'ask', { project: 'DC Gone Proj', to: 'me', kind: 'do', ask: 'DC1 removed member' })).need.id;
  for (const m of await rawDb.collection('member').find({}).toArray()) if (String(m.userId) === gone.userId) await rawDb.collection('member').deleteOne({ _id: m._id });
  await sleep(62_000); // the app caches an organization's member list for a minute
  const rGone = await press(D_GONE, `wo:need:${gn2}:done`);
  check('a member removed from the organization is refused, and the Need stays open', rGone.type === 4 && /not addressed to you/.test(rGone.content) && (await status(gn2)).status === 'open', JSON.stringify(rGone));

  // 5. A private project's Need never reaches the team channel
  await rawDb.collection('settings').updateOne({ _id: `discord:${ME.orgId}` }, { $set: { teamChannelId: TEAM } });
  await rawDb.collection('alertLog').deleteMany({ _id: { $regex: '^team_digest:' } });
  await cron('&at=2026-11-18T05:00:00Z');
  await cron('&at=2026-11-18T05:30:00Z');
  const teamText = teamPosts.map(p => p.content).join('\n');
  check('the team channel never carries a private project\'s Need (ask, name or project)', !/DC1-PRIVATE-NEED-ASK|DC Private/.test(teamText), teamText.slice(0, 400));
  check('...and the shared Needs of an open kind show by name only (the asker is not the project owner)', !/DC1 rotate the key/.test(teamText), teamText.slice(0, 400));
} finally {
  stub.close();
}
await finish();
