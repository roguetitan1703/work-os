#!/usr/bin/env node
// Phase 3 of docs/multi-user.md: what was built into the code becomes data. Everything goes to the first organization
// and its owner, whose it was:
//
//   timetable, routine, review     schedule:<owner's id>   the old weekday timetable, the "Fiverr Ritual" routine card,
//   questions, help                                         the weekly review questions and the help text
//                                                           (scripts/lib/legacy-week.mjs)
//   modes                          modes:<orgId>           the eight modes, with their descriptions
//   timezone                       profile:<owner's id>    --tz, else APP_TZ, else Asia/Kolkata
//   Discord account                profile:<owner's id>    DISCORD_OWNER_ID (until now the one person the bot served)
//   Discord server                 discord:<orgId>         DISCORD_GUILD_ID
//   weekly reviews                 the owner's             shipped / slipped / … fields → answers
//   routine logs                   the owner's             bidsPlaced → count
//
// Nothing already set is overwritten (someone may have set up their schedule in the app first). Afterwards
// DISCORD_GUILD_ID and DISCORD_OWNER_ID are no longer read and can be removed.
//
//   node scripts/migrate-phase3.mjs --db <database>                    dry run: says what it would change
//   node scripts/migrate-phase3.mjs --db <database> --apply            does it
//   node scripts/migrate-phase3.mjs --db <database> --tz Europe/Berlin the owner's timezone (default APP_TZ, else Asia/Kolkata)
//
// Environment: MONGODB_URI (or a MONGO_*_URI name, as the app reads it). The database is never taken from the
// environment. Idempotent: a second run finds nothing to do. Prints counts only, never ids, titles or text.
import { MongoClient } from 'mongodb';
import {
  LEGACY_BLOCKS,
  LEGACY_COLORS,
  LEGACY_HELP,
  LEGACY_MODES,
  LEGACY_REVIEW,
  LEGACY_ROUTINE,
  LEGACY_TASK_MODES,
  LEGACY_TIMEZONE,
} from './lib/legacy-week.mjs';

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const die = msg => {
  console.error(msg);
  process.exit(2);
};

const source = arg('--db');
const APPLY = args.includes('--apply');
if (!source) die('Name the database: node scripts/migrate-phase3.mjs --db <database> [--apply] [--tz <IANA zone>]');

const tz = arg('--tz') || process.env.APP_TZ?.trim() || LEGACY_TIMEZONE;
try {
  new Intl.DateTimeFormat('en-US', { timeZone: tz });
} catch {
  die(`"${tz}" is not a timezone (e.g. Asia/Kolkata).`);
}
const SNOWFLAKE = /^\d{15,22}$/;
const ownerDiscord = process.env.DISCORD_OWNER_ID?.trim() || '';
const guildId = process.env.DISCORD_GUILD_ID?.trim() || '';
if (ownerDiscord && !SNOWFLAKE.test(ownerDiscord)) die('DISCORD_OWNER_ID is set but is not a Discord id.');
if (guildId && !SNOWFLAKE.test(guildId)) die('DISCORD_GUILD_ID is set but is not a Discord id.');

const uri =
  process.env.MONGODB_URI ||
  Object.entries(process.env).find(([k, v]) => /(^|_)MONGODB_URI$|(^|_)MONGO_URL$|(^|_)MONGO_URI$/i.test(k) && v?.startsWith('mongodb'))?.[1];
if (!uri) die('MONGODB_URI is not set.');

const host = u => u.replace(/\/\/[^@]*@/, '//<credentials>@').replace(/\?.*$/, '');
const done = [];
const did = (what, n = 1) => n && done.push([what, n]);

const REVIEW_KEYS = LEGACY_REVIEW.map(f => f.key);

const client = new MongoClient(uri);
await client.connect();
try {
  const db = client.db(source);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN (nothing changes; add --apply)'} on database "${source}" at ${host(uri)}\n`);

  const org = await db.collection('organization').find({}).sort({ createdAt: 1 }).limit(1).next();
  if (!org) die('No organization yet: run scripts/migrate-auth.mjs first.');
  const orgId = String(org._id);
  const ownerMember = await db.collection('member').find({ organizationId: { $in: [org._id, orgId] }, role: 'owner' }).sort({ createdAt: 1 }).limit(1).next();
  if (!ownerMember) die('The first organization has no owner.');
  const owner = String(ownerMember.userId);
  const settings = db.collection('settings');
  const upsert = async (_id, set) => {
    if (APPLY) await settings.updateOne({ _id }, { $set: set }, { upsert: true });
  };

  // ── The owner's week ──
  const sched = await settings.findOne({ _id: `schedule:${owner}` });
  if (!sched?.schedule?.blocks?.length && !sched?.schedule?.routine) {
    await upsert(`schedule:${owner}`, {
      area: 'schedule',
      orgId,
      userId: owner,
      schedule: {
        blocks: LEGACY_BLOCKS,
        colors: LEGACY_COLORS,
        taskModes: LEGACY_TASK_MODES,
        routine: LEGACY_ROUTINE,
        review: LEGACY_REVIEW,
        help: LEGACY_HELP,
      },
      updatedAt: new Date(),
    });
    did(`schedule: ${LEGACY_BLOCKS.length} timetable blocks, the routine, ${LEGACY_REVIEW.length} review questions, ${LEGACY_HELP.length} help sections`);
  }

  // ── The organization's modes ──
  const modes = await settings.findOne({ _id: `modes:${orgId}` });
  if (!modes?.modes?.length) {
    await upsert(`modes:${orgId}`, { area: 'modes', orgId, modes: LEGACY_MODES, updatedAt: new Date() });
    did(`modes: ${LEGACY_MODES.length}`);
  }

  // ── The owner's profile: timezone and Discord account ──
  const profile = await settings.findOne({ _id: `profile:${owner}` });
  const p = {};
  if (!profile?.timezone) p.timezone = tz;
  if (ownerDiscord && !profile?.discordId) {
    const taken = await settings.findOne({ area: 'profile', orgId, discordId: ownerDiscord });
    if (!taken) p.discordId = ownerDiscord;
    else console.log('  ! DISCORD_OWNER_ID is already linked to someone in the organization; not changed.');
  }
  if (Object.keys(p).length) {
    await upsert(`profile:${owner}`, { area: 'profile', orgId, userId: owner, ...p, updatedAt: new Date() });
    if (p.timezone) did(`profile: timezone ${tz}`);
    if (p.discordId) did('profile: Discord account (DISCORD_OWNER_ID)');
  }

  // ── The organization's Discord server ──
  if (guildId) {
    const disc = await settings.findOne({ _id: `discord:${orgId}` });
    const taken = await settings.findOne({ area: 'discord', guildId, _id: { $ne: `discord:${orgId}` } });
    if (taken) console.log('  ! DISCORD_GUILD_ID already belongs to another organization; not changed.');
    else if (!disc?.guildId) {
      await upsert(`discord:${orgId}`, { area: 'discord', orgId, guildId, updatedAt: new Date() });
      did('Discord server (DISCORD_GUILD_ID)');
    }
  }

  // ── Weekly reviews: the fixed fields → answers ──
  const legacyReviews = await db
    .collection('reviews')
    .find({ $or: REVIEW_KEYS.map(k => ({ [k]: { $exists: true } })) })
    .toArray();
  for (const r of legacyReviews) {
    const answers = { ...(r.answers ?? {}) };
    for (const k of REVIEW_KEYS) if ((typeof r[k] === 'string' || typeof r[k] === 'number') && answers[k] === undefined) answers[k] = r[k];
    if (APPLY) await db.collection('reviews').updateOne({ _id: r._id }, { $set: { answers }, $unset: Object.fromEntries(REVIEW_KEYS.map(k => [k, ''])) });
  }
  did('weekly reviews: fields → answers', legacyReviews.length);

  // ── Routine logs: bidsPlaced → count ──
  const logs = await db.collection('ritualLogs').find({ bidsPlaced: { $exists: true } }).toArray();
  for (const l of logs) {
    const count = typeof l.count === 'number' ? l.count : Number(l.bidsPlaced) || 0;
    if (APPLY) await db.collection('ritualLogs').updateOne({ _id: l._id }, { $set: { count }, $unset: { bidsPlaced: '' } });
  }
  did('routine logs: bidsPlaced → count', logs.length);

  console.log(done.length ? done.map(([k, n]) => `  ${APPLY ? '✓' : '-'} ${k}${n === 1 ? '' : `: ${n}`}`).join('\n') : '  Nothing to do: everything is already data.');
  if (!APPLY) console.log('\nDry run: nothing was changed.');
  if (APPLY && (guildId || ownerDiscord)) console.log('\nDISCORD_GUILD_ID and DISCORD_OWNER_ID are no longer read; remove them from the deployment.');
  console.log('After a Discord server is set, register the commands again (Settings › Connections › Discord): they gain /link.');
} finally {
  await client.close();
}
