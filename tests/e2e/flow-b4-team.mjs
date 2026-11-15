// Flow B4, the team digest (plan-1-3 slice 6): one message a day to the organization's team Discord channel, through the
// bot, driven by the cron's ?at=. Shared projects only (private and chosen-people projects are left out), names only for
// Needs (the ask text only when the project's owner asked), mentions off, markdown links neutralised, the channel must be
// on the organization's own server, claimed once a day, and one organization's message never carries another's projects.
// Needs the app started with DISCORD_API_BASE at the stub below (run.sh "discord" mode). Seed: none.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { B, EMAIL, MCP, ME, PW, check, cron, finish, makeUser, mkKey, rawDb, setOrgGuild } from './lib.mjs';
import { must } from './flow-lib.mjs';

const G1 = '333333333333333333', G2 = '666666666666666666', G9 = '999999999999999999';
const CH1 = '444444444444444444', CH_OTHER = '555555555555555551', CH2 = '777777777777777777';
const GUILD_OF = { [CH1]: G1, [CH_OTHER]: G9, [CH2]: G2 };
const posts = [];
const failOn = new Set();
const stub = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => (b += d));
  q.on('end', () => {
    s.setHeader('content-type', 'application/json');
    let m = /^\/channels\/(\d+)$/.exec(q.url);
    if (m && q.method === 'GET') {
      if (GUILD_OF[m[1]]) return s.end(JSON.stringify({ id: m[1], guild_id: GUILD_OF[m[1]] }));
      s.statusCode = 404;
      return s.end('{"message":"Unknown Channel"}');
    }
    m = /\/channels\/(\d+)\/messages$/.exec(q.url);
    if (m && q.method === 'POST') {
      if (failOn.has(m[1])) { s.statusCode = 500; return s.end('{"message":"boom"}'); }
      posts.push({ channel: m[1], body: JSON.parse(b) });
      return s.end('{"id":"1"}');
    }
    s.end('{}');
  });
}).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');

// A server action is called the way a browser does: the build's manifest gives the export its id.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
const actionId = name => {
  for (const [id, v] of Object.entries(MANIFEST)) {
    const w = v.exportedName ? v : Object.values(v.workers)[0];
    if (`${w.filename}#${w.exportedName}` === name) return id;
  }
  return null;
};
async function signIn(email) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
async function saveChannel(cookie, channelId) {
  const id = actionId('app/(app)/settings/profile-actions.ts#saveTeamChannelAction');
  if (!id) return { ok: false, error: 'action not in the build', missing: true };
  const r = await fetch(B + '/settings', { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify([channelId]) });
  const t = await r.text();
  if (/"ok":true/.test(t)) return { ok: true };
  const refused = /not on this organization/i.test(t) ? "not on this organization's Discord server" : null;
  return { ok: false, error: refused ?? ((/"ok":false,"error":"([^"]*)"/.exec(t) ?? [])[1] ?? `status ${r.status} ${t.slice(0, 120)}`) };
}

try {
  await setOrgGuild(ME.orgId, G1);
  const mate = await makeUser({ email: 'b4t-mate@example.test', name: 'Team Mate', orgId: ME.orgId, role: 'member' });
  await makeUser({ email: 'b4t-admin@example.test', name: 'Team Admin', orgId: ME.orgId, role: 'admin' });
  const D = iso => new Date(iso);
  const done = async (title, project) => {
    const t = (await must(MCP, 'add_task', { title, project })).created;
    await rawDb.collection('tasks').updateOne({ orgId: ME.orgId, ref: t.ref }, { $set: { status: 'Done', progress: 100, doneOn: '2026-11-17', doneAt: D('2026-11-17T08:00:00Z') } });
    return t;
  };
  for (const name of ['TT Shared', 'TT Private', 'TT Chosen', 'TT Quiet']) await must(MCP, 'add_project', { name });
  const first = await must(MCP, 'save_state', { project: 'TT Shared', ops: [{ op: 'add_next', text: 'Wait for sign-off', waits_on: 'Dana from the client' }] });
  await must(MCP, 'save_state', { project: 'TT Shared', ops: [{ op: 'set_now', text: 'Ship it [re-login](https://evil.example/login) now @everyone' }], base_version: first.version });
  await must(MCP, 'save_state', { project: 'TT Private', ops: [{ op: 'add_next', text: 'PRIVATE-LINE', waits_on: 'PRIVATE-WAIT' }] });
  await must(MCP, 'save_state', { project: 'TT Chosen', ops: [{ op: 'add_next', text: 'CHOSEN-LINE', waits_on: 'CHOSEN-WAIT' }] });
  await done('Shared finished [click here](https://evil.example/x) yesterday', 'TT Shared');
  await done('PRIVATE-DONE yesterday', 'TT Private');
  await done('CHOSEN-DONE yesterday', 'TT Chosen');
  // placement: one private, one shared with chosen people (state and tasks stamped as their project is)
  const place = async (name, set) => {
    const p = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name });
    for (const c of ['projects', 'states', 'tasks']) await rawDb.collection(c).updateMany(c === 'projects' ? { _id: p._id } : { projectId: p._id }, { $set: set });
  };
  await place('TT Private', { visibility: 'private' });
  await place('TT Chosen', { visibility: 'members', sharedWith: [ME.userId, mate.userId] });
  // Needs: one the project's owner asked (its ask may show), one a teammate asked (name only), one on the private project
  const ownerKey = await mkKey({ agent: 'claude-code', name: 'tt owner' });
  const mateKey = await mkKey({ agent: 'claude-code', name: 'tt mate', userId: mate.userId, orgId: ME.orgId });
  // An ask shows only when the owner asked in person (actor kind 'user'), and not when it is app-only; one asked through an agent shows the name only
  const ownerAsk = await must(ownerKey, 'ask', { project: 'TT Shared', to: 'b4t-mate@example.test', kind: 'approve', ask: 'OWNER-ASK pick the colour' });
  const ownerApp = await must(ownerKey, 'ask', { project: 'TT Shared', to: 'b4t-mate@example.test', kind: 'do', ask: 'OWNER-APPONLY-ASK run the thing', app_only: true });
  await must(ownerKey, 'ask', { project: 'TT Shared', to: 'b4t-mate@example.test', kind: 'chase', ask: 'OWNER-AGENT-ASK chase them' });
  for (const n of [ownerAsk, ownerApp]) await rawDb.collection('needs').updateOne({ _id: n.need.id }, { $set: { 'from.actor': { kind: 'user', userId: ME.userId } } });
  await must(mateKey, 'ask', { project: 'TT Shared', to: EMAIL, kind: 'approve', ask: 'MATE-ASK-SECRET may I merge' });
  await must(ownerKey, 'ask', { project: 'TT Private', to: 'me', kind: 'approve', ask: 'PRIVATE-NEED-ASK' });

  // A second organization with its own server, channel and a shared project
  const o2 = await makeUser({ email: 'b4t-org2@example.test', name: 'Org Two', orgName: 'Org Two Inc' });
  await setOrgGuild(o2.orgId, G2);
  const key2 = await mkKey({ agent: 'claude', name: 'org2', userId: o2.userId, orgId: o2.orgId });
  await must(key2, 'add_project', { name: 'ORG2 Secret Shared' });
  await must(key2, 'save_state', { project: 'ORG2 Secret Shared', ops: [{ op: 'add_next', text: 'ORG2-LINE', waits_on: 'ORG2-WAIT' }] });
  await rawDb.collection('settings').updateOne({ _id: `discord:${o2.orgId}` }, { $set: { teamChannelId: CH2 } });

  const at = iso => `&at=${iso}`;
  const to = ch => posts.filter(p => p.channel === ch);

  // Who may set the channel (the owner or the operator only), and only a channel on the organization's own server
  const cOwner = await signIn(EMAIL), cMate = await signIn('b4t-mate@example.test'), cAdmin = await signIn('b4t-admin@example.test');
  const setting = async () => (await rawDb.collection('settings').findOne({ _id: `discord:${ME.orgId}` }))?.teamChannelId ?? null;
  const rm = await saveChannel(cMate, CH1);
  check('a member cannot set the team channel', !rm.ok && !rm.missing && (await setting()) === null, JSON.stringify(rm));
  const ra = await saveChannel(cAdmin, CH1);
  check('an admin cannot set the team channel (owner or operator only)', !ra.ok && !ra.missing && (await setting()) === null, JSON.stringify(ra));
  const ro = await saveChannel(cOwner, CH_OTHER);
  check('a channel on another server is refused when saved', !ro.ok && /not on this organization/i.test(ro.error ?? '') && (await setting()) === null, JSON.stringify(ro));
  const rn = await saveChannel(cOwner, '444444444444444499');
  check('a channel the bot cannot see is refused when saved', !rn.ok && (await setting()) === null, JSON.stringify(rn));

  // before any channel is set: nothing is posted for this organization
  await cron(at('2026-11-18T05:00:00Z'));
  check('no team channel set for this organization: nothing posted to its channel', to(CH1).length === 0, String(to(CH1).length));
  // the other organization's own message from that run is not under test here: forget it and let the day be claimed again
  posts.length = 0;
  await rawDb.collection('alertLog').deleteMany({ _id: { $regex: '^team_digest:' } });

  const rs = await saveChannel(cOwner, CH1);
  check("the owner can set a channel on the organization's own server", rs.ok && (await setting()) === CH1, JSON.stringify(rs));
  await cron(at('2026-11-18T02:00:00Z')); // 07:30 IST: before the hour
  check('before 09:00: nothing posted', posts.length === 0, String(posts.length));
  await cron(at('2026-11-18T05:00:00Z'));
  check("one message to the team channel, and one to the other organization's own channel", to(CH1).length === 1 && to(CH2).length === 1, JSON.stringify(posts.map(p => p.channel)));
  const text = to(CH1)[0]?.body?.content ?? '';
  check('it names the shared project: done yesterday, Now, and who it waits on', /TT Shared/.test(text) && /Shared finished click here yesterday/.test(text) && /Now: Ship it/.test(text) && /Waits on: .*Dana from the client/.test(text), text);
  check('markdown is neutralised: no masked link, no mention (the link text stays)', !/\]\(/.test(text) && !/evil\.example/.test(text) && /re-login/.test(text) && !/@everyone/.test(text), text);
  check("open Needs add their person by name: the owner's own ask shows, a teammate's does not", /Team Mate \(OWNER-ASK pick the colour\)/.test(text) && !/MATE-ASK-SECRET/.test(text), text);
  check("an owner-asked app-only Need's ask is absent, and so is an agent-asked one on the owner's project (names only)", !/OWNER-APPONLY-ASK|OWNER-AGENT-ASK/.test(text) && /Team Mate/.test(text), text);
  check('private and chosen-people projects are absent (names, State lines, done tasks, waits, Need asks)', !/TT Private|TT Chosen|PRIVATE|CHOSEN/.test(text), text);
  check('a shared project with nothing to report is left out', !/TT Quiet/.test(text), text);
  check('mentions are off', JSON.stringify(to(CH1)[0]?.body?.allowed_mentions) === '{"parse":[]}', JSON.stringify(to(CH1)[0]?.body?.allowed_mentions));
  const t2 = to(CH2)[0]?.body?.content ?? '';
  check('the other organization gets its own project in its own channel, and never ours', /ORG2 Secret Shared/.test(t2) && !/TT |OWNER-ASK|Dana/.test(t2), t2);
  check("...and our message never carries the other organization's projects", !/ORG2/.test(text));
  await cron(at('2026-11-18T05:15:00Z'));
  await cron(at('2026-11-18T06:00:00Z'));
  check('a second and third run the same day post nothing more', to(CH1).length === 1 && to(CH2).length === 1, `${to(CH1).length} ${to(CH2).length}`);
  check('claimed once in alertLog for the organization and day', (await rawDb.collection('alertLog').countDocuments({ _id: `team_digest:${ME.orgId}:2026-11-18` })) === 1);

  // three cron runs at once post once
  await Promise.all([cron(at('2026-11-19T05:00:00Z')), cron(at('2026-11-19T05:00:00Z')), cron(at('2026-11-19T05:00:00Z'))]);
  check('three cron runs at once: one message per organization', to(CH1).length === 2 && to(CH2).length === 2, `${to(CH1).length} ${to(CH2).length}`);

  // a failed send releases the claim, and the next run sends
  failOn.add(CH1);
  await cron(at('2026-11-20T05:00:00Z'));
  const key20 = `team_digest:${ME.orgId}:2026-11-20`;
  check('a failed send posts nothing and releases the claim', to(CH1).length === 2 && (await rawDb.collection('alertLog').countDocuments({ _id: key20 })) === 0, String(to(CH1).length));
  failOn.clear();
  await cron(at('2026-11-20T05:15:00Z'));
  check('the next run sends it and claims the day', to(CH1).length === 3 && (await rawDb.collection('alertLog').countDocuments({ _id: key20 })) === 1, String(to(CH1).length));

  // a channel that is not on the organization's server is never posted to, even if the setting got there
  await rawDb.collection('settings').updateOne({ _id: `discord:${ME.orgId}` }, { $set: { teamChannelId: CH_OTHER } });
  await cron(at('2026-11-23T05:00:00Z'));
  check('a channel outside the server gets nothing at send time, and the day is not claimed', to(CH_OTHER).length === 0 && (await rawDb.collection('alertLog').countDocuments({ _id: `team_digest:${ME.orgId}:2026-11-23` })) === 0, String(to(CH_OTHER).length));
} finally {
  stub.close();
}
await finish();
