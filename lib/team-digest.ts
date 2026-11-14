import 'server-only';
import { clockInTz, dateInTz, DEFAULT_TZ, previousWorkdayStart } from './dates';
import { api, DiscordError, discordConfig } from './discord/client';
import { memberNames } from './people';
import { getOrgSetting, orgWide, setOrgSetting } from './scope';

// The team digest (flow B4, plan-1-3 slice 6): one message a day, from the bot, to the organization's team channel
// (a Discord channel id the owner or operator sets in Settings › Server › Discord; org setting `discord`, field
// `teamChannelId`). For each project shared with everyone: what was done yesterday, the State's Now, and who the State
// waits on. Projects that are private or shared with chosen people are never in it. Mentions are off in the message.
// Claimed once a day per organization in alertLog (key team_digest:<org>:<date>, userId 'team'); a failed send
// releases the claim so the next run tries again. Hour: ALERT_RULES.dueTodayHour in the deployment's timezone.
// Needs (step 2) join "who it waits on" through waitsOn(); today only the State's Next/Later lines carry it.

const SNOWFLAKE = /^\d{15,22}$/;
const HOUR = 9;

export async function teamChannelId(orgId: string): Promise<string | null> {
  const c = (await getOrgSetting(orgId, 'discord'))?.teamChannelId;
  return typeof c === 'string' && SNOWFLAKE.test(c) ? c : null;
}

export async function setTeamChannelId(orgId: string, channelId: string | null): Promise<void> {
  if (channelId !== null && !SNOWFLAKE.test(channelId)) throw new DiscordError('A channel id is 15 to 22 digits (Discord: right-click the channel, Copy Channel ID).', 0, '');
  await setOrgSetting(orgId, 'discord', { teamChannelId: channelId, updatedAt: new Date() });
}

type Line = { text: string; waitsOn?: string };
/** Who a project's State waits on: the Next and Later lines' `waitsOn` (a hook: Needs add theirs here in step 2). */
function waitsOn(state: { next?: Line[]; later?: Line[] } | undefined, names: Record<string, string>): string[] {
  const w = [...(state?.next ?? []), ...(state?.later ?? [])].map(l => l.waitsOn).filter((x): x is string => !!x);
  return [...new Set(w.map(x => (names[x] ?? x).slice(0, 40)))];
}

/** The message text for `today` (YYYY-MM-DD in the deployment's timezone), or null when there is nothing to say. */
export async function buildTeamDigest(orgId: string, today: string, tz: string): Promise<string | null> {
  const c = await orgWide(orgId);
  const names = await memberNames(orgId);
  const from = dateInTz(previousWorkdayStart(today, tz), tz);
  // Only projects shared with everyone ('org'): never a private one, never one shared with chosen people.
  const projects = await c.projects.find({ visibility: 'org' }, { projection: { name: 1 } }).sort({ nameLower: 1 }).toArray();
  if (!projects.length) return null;
  const ids = projects.map(p => p._id);
  const states = new Map((await c.states.find({ projectId: { $in: ids } }).toArray()).map(s => [s.projectId, s]));
  const done = await c.tasks.find({ projectId: { $in: ids }, visibility: 'org', status: 'Done', doneOn: { $gte: from, $lt: today } }, { projection: { projectId: 1, ref: 1, title: 1 } }).sort({ ref: 1 }).toArray();
  const lines: string[] = [];
  for (const p of projects) {
    const st = states.get(p._id);
    const d = done.filter(t => t.projectId === p._id);
    const now = st?.now?.text;
    const waits = waitsOn(st, names);
    if (!d.length && !now && !waits.length) continue;
    lines.push(`**${p.name}**`);
    if (d.length) lines.push(`• Done: ${d.slice(0, 3).map(t => `#${t.ref} ${t.title}`).join('; ')}${d.length > 3 ? ` and ${d.length - 3} more` : ''}`);
    if (now) lines.push(`• Now: ${now.slice(0, 200)}`);
    if (waits.length) lines.push(`• Waits on: ${waits.join(', ')}`);
    lines.push('');
  }
  if (!lines.length) return null;
  let text = `📋 **Team digest**\n\n${lines.join('\n')}`.trimEnd();
  if (text.length > 1900) text = text.slice(0, 1890).trimEnd() + '\n…';
  return text;
}

/** One organization's team digest: claim, build, send. Returns true when a message went out. Never throws. */
export async function runTeamDigest(orgId: string, opts: { now?: Date } = {}): Promise<boolean> {
  try {
    const channel = await teamChannelId(orgId);
    if (!channel || !discordConfig()) return false;
    const now = opts.now ?? new Date();
    const tz = DEFAULT_TZ;
    if (clockInTz(now, tz).hour < HOUR) return false;
    const today = dateInTz(now, tz);
    const c = await orgWide(orgId);
    const key = `team_digest:${orgId}:${today}`;
    if (await c.alertLog.findOne({ _id: key }, { projection: { _id: 1 } })) return false;
    try {
      await c.alertLog.insertOne({ _id: key, orgId, userId: 'team', kind: 'digest', sentAt: now });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return false; // another run has it
      throw e;
    }
    const text = await buildTeamDigest(orgId, today, tz);
    if (!text) return false; // nothing to say today: the day stays claimed
    try {
      await api(`/channels/${channel}/messages`, { method: 'POST', body: { content: text, allowed_mentions: { parse: [] }, flags: 1 << 2 } });
      return true;
    } catch (e) {
      await c.alertLog.deleteOne({ _id: key }); // try again at the next run
      console.error('[team digest]', e instanceof Error ? e.message : e);
      return false;
    }
  } catch (e) {
    console.error('[team digest] failed:', e instanceof Error ? e.message : e);
    return false;
  }
}
