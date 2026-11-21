// Each queued/scheduled alert delivered exactly once under concurrent flushes + cron.
// Needs the app started with DISCORD_API_BASE pointing at the stub below (run.sh does that for this suite). Seed profile: none.
import http from 'node:http';
import { call, check, db, cron, finish, ME, setOrgGuild, setProfile } from './lib.mjs';
// The owner has Discord linked, and still gets none of these alerts there (only reels and Needs waiting over a day go to Discord: discord-v4.mjs); no quiet hours, so any hour works.
await setOrgGuild(ME.orgId, '333333333333333333');
await setProfile(ME, { discordId: '111111111111111111', quietStart: 0, quietEnd: 0 });
const dms = [];
const stub = http.createServer((q, s) => { let b = ''; q.on('data', d => b += d); q.on('end', () => {
  s.setHeader('content-type', 'application/json');
  if (q.url.endsWith('/users/@me/channels')) return s.end('{"id":"dm1"}');
  if (/\/channels\/dm1\/messages$/.test(q.url) && q.method === 'POST') { dms.push(JSON.parse(b).content); return s.end('{"id":"1"}'); }
  s.end('{}');
}); }).listen(Number(process.env.E2E_DISCORD_PORT || 4401), '127.0.0.1');
const N = 8;
const tag = Date.now().toString(36);
const bl = [], dep = [];
for (let i = 0; i < N; i++) {
  const b = (await call('add_task', { title: `AO blocker ${tag} ${i}` })).created.ref; bl.push(b);
  dep.push((await call('add_task', { title: `AO waiter ${tag} ${i}`, depends_on: [b] })).created.ref);
}
const over = [];
for (let i = 0; i < 4; i++) over.push((await call('add_task', { title: `AO overdue ${tag} ${i}`, due: '2026-10-10' })).created.ref);
const preview = await cron('&dry=1');
const t0 = new Date(); dms.length = 0;
// close all blockers at once (each triggers a flush) while 6 cron runs overlap
await Promise.all([...bl.map(b => call('complete_task', { task: b, note: 'ao' })), ...Array.from({ length: 6 }, () => cron())]);
await new Promise(r => setTimeout(r, 4000));
const inbox = await db.collection('notifications').find({ createdAt: { $gte: t0 } }).toArray();
const cnt = (re) => inbox.filter(n => re.test(n.title)).length;
for (const r of dep) check(`unblocked #${r} in inbox exactly once`, cnt(new RegExp(`^Unblocked: #${r} `)) === 1, `got ${cnt(new RegExp(`^Unblocked: #${r} `))}`);
// Overdue alerts start at 09:00 in the person's zone (lib/alerts.ts); before that none is due, so only the rest is checked.
const morning = Number(new Intl.DateTimeFormat('en-GB', { timeZone: process.env.APP_TZ || 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date())) >= 9;
if (!morning) { console.log('(before 09:00: overdue alerts are not due yet; checked unblocked only)'); over.length = 0; }
// The morning's overdue now arrive in the daily digest (slice 2): one inbox row for all of them, no separate Overdue rows.
if (over.length) { check('overdue: one daily digest in the inbox, no separate Overdue rows', cnt(/^Your daily digest$/) === 1 && cnt(/^Overdue: /) === 0, `digest ${cnt(/^Your daily digest$/)}, overdue ${cnt(/^Overdue: /)}`); }
const all = (preview?.preview ?? []).join('\n');
// The digest's Today section lists the top 3 and folds the rest into "+N overdue, on Today" (docs/HANDOVER.md, daily digest: Today "top 3 ... "+N overdue, on Today""), so only 3 overdue are linked.
if (over.length > 3) { const hid = over.length - 3; check('digest folds the rest into "+N overdue, on Today"', all.includes(`+${hid} overdue, on Today`), `no +${hid} line`); }
check('no alert of these kinds is sent to Discord', dms.length === 0, `${dms.length} DMs: ${dms.join(' | ').slice(0, 200)}`);
const left = await db.collection('alertQueue').countDocuments({ sentAt: null });
check('queue fully claimed', left === 0, String(left));
// a later cron run sends nothing new
const before = dms.length; await cron(); await cron(); check('later runs send nothing', dms.length === before, `${dms.length - before} extra`);
stub.close();
await finish();
