import 'server-only';
import { getDb } from './db';
import { discordConfig, guildContext } from './discord/client';
import { discordLinkOf } from './profile';
import { lastRunStatus } from './alerts';
import { lastSeen, pushConfigured, pushDeviceCount } from './notify';
import { converterCheck } from './notes-convert';
import { scoped, type Scope } from './scope';

// Live health of everything Work OS depends on, for the Settings → Status panel.

export type Level = 'ok' | 'warn' | 'error' | 'off';
export type Check = { name: string; level: Level; summary: string; detail?: string };

async function timed<T>(fn: () => Promise<T>, ms = 6000): Promise<T> {
  return Promise.race([fn(), new Promise<T>((_, no) => setTimeout(() => no(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

const ago = (iso: string | null) => {
  if (!iso) return null;
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** s: the person looking (their alert runs, connector use, push devices and their organization's task count). */
export async function systemStatus(s: Scope): Promise<Check[]> {
  // Time the database on its own, before the other checks start: the notes-converter check loads a
  // heavy module that blocks the event loop, which used to inflate the ping. The first ping can also
  // include opening the connection, so the second one is the round trip we show.
  const db = await timed(async () => {
    const d = await getDb(); // scope-ok: ping only; the task count below goes through the door
    let t = Date.now();
    await d.command({ ping: 1 });
    const first = Date.now() - t;
    t = Date.now();
    await d.command({ ping: 1 });
    const ms = Date.now() - t;
    const tasks = await (await scoped(s)).tasks.countDocuments();
    return { ms, first, tasks };
  }).catch((e: Error) => e);
  const [discord, alerts, seen, push, notes] = await Promise.all([
    timed(async () => {
      const link = discordConfig() ? await discordLinkOf(s) : null;
      return link ? guildContext(link) : null;
    }).catch((e: Error) => e),
    lastRunStatus(s).catch(() => null),
    lastSeen(s).catch(() => ({ mcp: null, discord: null })),
    pushDeviceCount(s).catch(() => 0),
    timed(converterCheck, 8000).catch((e: Error) => e.message),
  ]);

  const checks: Check[] = [];

  checks.push(
    db instanceof Error
      ? { name: 'Database', level: 'error', summary: 'Not reachable', detail: db.message }
      : { name: 'Database', level: db.ms > 150 ? 'warn' : 'ok', summary: `MongoDB Atlas · ${db.ms} ms`, detail: `${db.tasks} tasks${db.first > db.ms + 50 ? ` · first query ${db.first} ms (new connection)` : ``}` },
  );

  const region = process.env.VERCEL_REGION ?? 'local';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  checks.push({
    name: 'Server',
    level: region === 'local' || region === 'bom1' ? 'ok' : 'warn',
    summary: `Vercel ${region}${sha ? ` · ${sha}` : ''}`,
    detail: `${process.env.VERCEL_ENV ?? 'development'} · Node ${process.version}${region !== 'bom1' && region !== 'local' ? ' · not Mumbai: slower' : ''}`,
  });

  checks.push(
    { name: 'Claude connector', level: seen.mcp ? 'ok' : 'warn', summary: seen.mcp ? `Last used ${ago(seen.mcp)}` : 'Not used yet', detail: 'A Claude chat key from Settings › Connections, on claude.ai → Settings → Connectors' },
  );

  if (!discordConfig()) checks.push({ name: 'Discord bot', level: 'off', summary: 'Not configured' });
  else if (discord instanceof Error) checks.push({ name: 'Discord bot', level: 'error', summary: 'Discord API error', detail: discord.message });
  else if (discord) {
    const readable = discord.channels.filter(c => c.canRead).length;
    checks.push({
      name: 'Discord bot',
      level: discord.contentIntent ? 'ok' : 'warn',
      summary: `Connected · ${readable} channels readable`,
      detail: [
        discord.contentIntent ? null : 'Message Content Intent is OFF',
        discord.ownerId ? null : 'your Discord account is not linked',
        discord.blocked.size ? `${discord.blocked.size} blocked as sensitive` : 'no channels blocked',
        seen.discord ? `last command ${ago(seen.discord)}` : 'no commands used yet',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  } else checks.push({ name: 'Discord bot', level: 'off', summary: 'No Discord server set for this organization' });

  checks.push(
    !process.env.CRON_SECRET
      ? { name: 'Scheduled alerts', level: 'warn', summary: 'CRON_SECRET not set', detail: 'Alerts only fire on unblock until the 15-minute job is set up' }
      : !alerts?.lastRunAt
        ? { name: 'Scheduled alerts', level: 'warn', summary: 'No check has run yet', detail: 'Create the cron-job.org job (see Connect page)' }
        : { name: 'Scheduled alerts', level: alerts.stale ? 'warn' : 'ok', summary: `Last check ${ago(alerts.lastRunAt)}`, detail: alerts.lastResult ?? undefined },
  );

  checks.push(
    !pushConfigured()
      ? { name: 'Phone notifications', level: 'warn', summary: 'Push keys not set', detail: 'Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT in Vercel' }
      : { name: 'Phone notifications', level: push ? 'ok' : 'warn', summary: push ? `${push} device${push === 1 ? '' : 's'}` : 'No devices yet', detail: push ? undefined : 'Turn on "Notifications on this device" above' },
  );

  checks.push({ name: 'Notes converter', level: notes === 'ok' ? 'ok' : 'error', summary: notes === 'ok' ? 'Working' : 'Failing', detail: notes === 'ok' ? undefined : String(notes) });

  return checks;
}
