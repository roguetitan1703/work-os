// Flow B4, the team digest (plan-1-3 slice 6 part): one message a day to the organization's team Discord channel, through
// the bot, driven by the cron's ?at=. Shared projects only (private and chosen-people projects are left out), mentions off,
// claimed once a day. Needs the app started with DISCORD_API_BASE at the stub below (run.sh "discord" mode). Seed: none.
import http from 'node:http';
import { MCP, ME, check, cron, finish, makeUser, rawDb, setOrgGuild } from './lib.mjs';
import { must } from './flow-lib.mjs';

const CHANNEL = '444444444444444444';
const posts = [];
const stub = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => (b += d));
  q.on('end', () => {
    s.setHeader('content-type', 'application/json');
    const m = /\/channels\/(\d+)\/messages$/.exec(q.url);
    if (m && q.method === 'POST') { posts.push({ channel: m[1], body: JSON.parse(b) }); return s.end('{"id":"1"}'); }
    s.end('{}');
  });
}).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');

try {
  await setOrgGuild(ME.orgId, '333333333333333333');
  const mate = await makeUser({ email: 'b4t-mate@example.test', name: 'Team Mate', orgId: ME.orgId, role: 'member' });
  const D = iso => new Date(iso);
  const done = async (title, project) => {
    const t = (await must(MCP, 'add_task', { title, project })).created;
    await rawDb.collection('tasks').updateOne({ orgId: ME.orgId, ref: t.ref }, { $set: { status: 'Done', progress: 100, doneOn: '2026-11-17', doneAt: D('2026-11-17T08:00:00Z') } });
    return t;
  };
  for (const name of ['TT Shared', 'TT Private', 'TT Chosen', 'TT Quiet']) await must(MCP, 'add_project', { name });
  const first = await must(MCP, 'save_state', { project: 'TT Shared', ops: [{ op: 'add_next', text: 'Wait for sign-off', waits_on: 'Dana from the client' }] });
  await must(MCP, 'save_state', { project: 'TT Shared', ops: [{ op: 'set_now', text: 'Ship the shared thing' }], base_version: first.version });
  await must(MCP, 'save_state', { project: 'TT Private', ops: [{ op: 'add_next', text: 'PRIVATE-LINE', waits_on: 'PRIVATE-WAIT' }] });
  await must(MCP, 'save_state', { project: 'TT Chosen', ops: [{ op: 'add_next', text: 'CHOSEN-LINE', waits_on: 'CHOSEN-WAIT' }] });
  await done('Shared finished yesterday', 'TT Shared');
  await done('PRIVATE-DONE yesterday', 'TT Private');
  await done('CHOSEN-DONE yesterday', 'TT Chosen');
  // placement: one private, one shared with chosen people (state and tasks stamped as their project is)
  const place = async (name, set) => {
    const p = await rawDb.collection('projects').findOne({ orgId: ME.orgId, name });
    for (const c of ['projects', 'states', 'tasks']) await rawDb.collection(c).updateMany(c === 'projects' ? { _id: p._id } : { projectId: p._id }, { $set: set });
  };
  await place('TT Private', { visibility: 'private' });
  await place('TT Chosen', { visibility: 'members', sharedWith: [ME.userId, mate.userId] });

  const at = iso => `&at=${iso}`;
  // before any channel is set: nothing is posted
  await cron(at('2026-11-18T05:00:00Z'));
  check('no team channel set: nothing posted', posts.length === 0, String(posts.length));

  await rawDb.collection('settings').updateOne({ _id: `discord:${ME.orgId}` }, { $set: { teamChannelId: CHANNEL } });
  await cron(at('2026-11-18T02:00:00Z')); // 07:30 IST: before the hour
  check('before 09:00: nothing posted', posts.length === 0, String(posts.length));
  await cron(at('2026-11-18T05:00:00Z'));
  check('one message to the team channel', posts.length === 1 && posts[0].channel === CHANNEL, JSON.stringify(posts.map(p => p.channel)));
  const text = posts[0]?.body?.content ?? '';
  check('it names the shared project: done yesterday, Now, and who it waits on', /TT Shared/.test(text) && /Shared finished yesterday/.test(text) && /Now: Ship the shared thing|Now:/.test(text) && /Waits on: Dana from the client/.test(text), text);
  check('private and chosen-people projects are absent (names, State lines, done tasks, waits)', !/TT Private|TT Chosen|PRIVATE|CHOSEN/.test(text), text);
  check('a shared project with nothing to report is left out', !/TT Quiet/.test(text), text);
  check('mentions are off', JSON.stringify(posts[0]?.body?.allowed_mentions) === '{"parse":[]}', JSON.stringify(posts[0]?.body?.allowed_mentions));
  await cron(at('2026-11-18T05:15:00Z'));
  await cron(at('2026-11-18T06:00:00Z'));
  check('a second and third run the same day post nothing more', posts.length === 1, String(posts.length));
  const claims = await rawDb.collection('alertLog').countDocuments({ _id: `team_digest:${ME.orgId}:2026-11-18` });
  check('claimed once in alertLog for the organization and day', claims === 1, String(claims));
  await cron(at('2026-11-19T05:00:00Z'));
  check('the next day posts again (its State still has a Now and a wait): two messages in all', posts.length === 2, String(posts.length));
} finally {
  stub.close();
}
await finish();
