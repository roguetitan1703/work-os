import 'server-only';
import { collections, type AlertKind, type TaskDoc } from './db';
import { forUser, getUserSetting, orgWide, scoped, setUserSetting, type Scope, type ScopedCollections as Collections } from './scope';
import { getProfile, inQuietHours, type Profile } from './profile';
export type { AlertKind };
import { addDays, clockInTz, dateInTz, weekday } from './dates';
import { CLOSED_STATUSES, OPEN_STATUSES } from './types';
import { api, discordConfig, DiscordError } from './discord/client';
import { addToInbox, getNotifySettings, pushConfigured, sendPush } from './notify';
import { plainAlertText, stuckClaims } from './data/dispatcher';
import { recipientFilter, recipientOf } from './data/tasks';

// Nudges for each person about the tasks whose alerts go to them (recipientOf: the assignee of a shared task, else
// its owner), to their inbox, their phones and (if they linked Discord) a Discord DM, by their own settings, in their
// own timezone.
// The cron (/api/cron/alerts, every 15 minutes) runs once per person; writes that unblock a task or end a dispatched
// one flush the queued alerts at once. Every alert is logged by key so it is sent once (overdue: every 2 days).
//
//   due_tomorrow   18:00 the day before, P1/P2
//   due_today      09:00 digest of open tasks due today
//   overdue        09:00 the day after due, then at most every 2 days
//   stalled        In Progress, no activity for 2 workdays
//   never_started  P1 still Not Started 24h after creation
//   unblocked      as soon as the last task it waited on is closed
//   claude_*       the task dispatcher (docs/dispatcher.md): finished / stopped (sent at once) and "may be stuck" (scheduled)
//   quiet hours    each person's own (default 23:00–08:00 in their timezone; held until they end)

export const ALERT_RULES = {
  dueTodayHour: 9,
  dueTomorrowHour: 18,
  overdueEveryDays: 2,
  stalledWorkdays: 2,
  neverStartedHours: 24,
} as const;


export type AlertItem = { key: string; kind: AlertKind; ref: number; title: string; detail?: string; resend?: boolean; taskId?: string; prevSentAt?: Date; /** Inbox and push title, when the default "Kind: #ref title" does not fit. */ headline?: string };

const CLAUDE_OUTCOMES = ['claude_finished', 'claude_stopped'] as const;
/** Event alerts that live in alertQueue and are claimed there (not in alertLog). */
const FROM_QUEUE = new Set<AlertKind>(['unblocked', ...CLAUDE_OUTCOMES]);


/** Is it inside this person's quiet hours (in their timezone)? */
export function isQuietHour(p: Profile, d: Date = new Date()): boolean {
  return inQuietHours(p, clockInTz(d, p.timezone).hour);
}

/** Weekdays strictly after `from` up to and including `to` (YYYY-MM-DD). */
function workdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (weekday(d) !== 0 && weekday(d) !== 6) n++;
  return n;
}

// ── Unblocked: queued by the data layer when a task closes ──────────────────

/**
 * Called after a task closes: queue an alert for each open task whose dependencies are now all closed, to that task's
 * recipient. Whole organization: a teammate's task waiting on this one is unblocked even if the closer cannot see it.
 */
export async function queueUnblocked(s: Scope, closed: Pick<TaskDoc, '_id'>): Promise<void> {
  const c = await orgWide(s.orgId);
  const waiting = await c.tasks.find({ dependsOn: closed._id, status: { $in: OPEN_STATUSES }, archived: false }, { projection: { dependsOn: 1, ownerId: 1, visibility: 1, assigneeId: 1 } }).toArray();
  for (const t of waiting) {
    const others = t.dependsOn.filter(id => id !== closed._id);
    const stillOpen = others.length ? await c.tasks.countDocuments({ _id: { $in: others }, status: { $in: OPEN_STATUSES } }) : 0;
    if (stillOpen) continue;
    await c.alertQueue.updateOne(
      { _id: `unblocked:${t._id}:${closed._id}` },
      { $setOnInsert: { userId: recipientOf(t), kind: 'unblocked', taskId: t._id, byTaskId: closed._id, createdAt: new Date(), sentAt: null } },
      { upsert: true },
    );
  }
}

// ── What is due now ─────────────────────────────────────────────────────────

/** onlyQueued: just the queued "unblocked" alerts (sent right after a write), not the scheduled checks. */
/** s: the recipient. Only tasks whose alerts go to them, and their own log and queue. */
export async function computeAlerts(s: Scope, now: Date = new Date(), opts: { onlyQueued?: boolean; queuedIds?: string[] } = {}): Promise<{ items: AlertItem[]; quiet: boolean }> {
  const c = await scoped(s);
  const profile = await getProfile(s);
  if (isQuietHour(profile, now)) return { items: [], quiet: true };
  if (opts.onlyQueued) return { items: await queuedItems(c, opts.queuedIds), quiet: false };
  const tz = profile.timezone;
  const today = dateInTz(now, tz);
  const hour = clockInTz(now, tz).hour;
  const items: AlertItem[] = [];
  const open = await c.tasks
    .find({ status: { $in: OPEN_STATUSES }, archived: false, ...recipientFilter(s.userId) }, { projection: { ref: 1, title: 1, status: 1, priority: 1, due: 1, progress: 1, createdAt: 1, updatedAt: 1 } })
    .toArray();
  const sent = new Map((await c.alertLog.find({ taskId: { $in: open.map(t => t._id) } }).toArray()).map(l => [l._id, l]));
  const was = (key: string) => sent.has(key);

  // due_today digest (one per day)
  if (hour >= ALERT_RULES.dueTodayHour) {
    for (const t of open.filter(t => t.due === today)) {
      const key = `due_today:${t._id}:${today}`;
      if (!was(key)) items.push({ key, kind: 'due_today', taskId: t._id, ref: t.ref, title: t.title, detail: t.priority });
    }
  }
  // due_tomorrow (P1/P2)
  if (hour >= ALERT_RULES.dueTomorrowHour) {
    for (const t of open.filter(t => t.due === addDays(today, 1) && (t.priority === 'P1' || t.priority === 'P2'))) {
      const key = `due_tomorrow:${t._id}:${t.due}`;
      if (!was(key)) items.push({ key, kind: 'due_tomorrow', taskId: t._id, ref: t.ref, title: t.title, detail: t.priority });
    }
  }
  // overdue: from the morning after, then every N days
  if (hour >= ALERT_RULES.dueTodayHour) {
    for (const t of open.filter(t => t.due && t.due < today)) {
      const key = `overdue:${t._id}:${t.due}`;
      const last = sent.get(key);
      const days = Math.round((Date.parse(today) - Date.parse(t.due!)) / 86_400_000);
      if (!last || now.getTime() - last.sentAt.getTime() >= ALERT_RULES.overdueEveryDays * 86_400_000 - 30 * 60_000) {
        items.push({ key, kind: 'overdue', taskId: t._id, prevSentAt: last?.sentAt, ref: t.ref, title: t.title, detail: `${days} day${days === 1 ? '' : 's'} late`, resend: !!last });
      }
    }
  }
  // stalled: In Progress, untouched for N workdays (re-arms after any activity)
  for (const t of open.filter(t => t.status === 'In Progress')) {
    const lastDay = dateInTz(t.updatedAt, tz);
    if (workdaysBetween(lastDay, today) < ALERT_RULES.stalledWorkdays) continue;
    const key = `stalled:${t._id}:${t.updatedAt.toISOString()}`;
    if (!was(key)) items.push({ key, kind: 'stalled', taskId: t._id, ref: t.ref, title: t.title, detail: `no activity since ${lastDay}, ${t.progress}%` });
  }
  // never_started: P1 Not Started for 24h
  for (const t of open.filter(t => t.priority === 'P1' && t.status === 'Not Started')) {
    if (now.getTime() - t.createdAt.getTime() < ALERT_RULES.neverStartedHours * 3_600_000) continue;
    const key = `never_started:${t._id}`;
    if (!was(key)) items.push({ key, kind: 'never_started', taskId: t._id, ref: t.ref, title: t.title });
  }
  // claude_stuck: a task Claude is working on, session quiet for 20 minutes (once per claim)
  for (const { t, quietMins } of await stuckClaims(s, now)) {
    const key = `claude_stuck:${t._id}:${t.claude!.claimedAt!.getTime()}`;
    if (!(await c.alertLog.findOne({ _id: key }, { projection: { _id: 1 } }))) items.push({ key, kind: 'claude_stuck', taskId: t._id, ref: t.ref, title: t.title, detail: `quiet for ${quietMins} min`, headline: `Claude may be stuck on #${t.ref}` });
  }
  items.push(...(await queuedItems(c, opts.queuedIds)));
  return { items, quiet: false };
}

/** ids: only these queue entries (the ones this run claimed); omitted = everything still unsent (dry run). */
async function queuedItems(c: Collections, ids?: string[]): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  const queued = await c.alertQueue.find(ids ? { _id: { $in: ids } } : { sentAt: null }).toArray();
  if (queued.length) {
    const taskIds = [...new Set(queued.flatMap(q => [q.taskId, q.byTaskId]))];
    const byId = new Map((await c.tasks.find({ _id: { $in: taskIds } }, { projection: { ref: 1, title: 1, status: 1 } }).toArray()).map(t => [t._id, t]));
    for (const q of queued) {
      const t = byId.get(q.taskId);
      if (q.kind === 'claude_finished' || q.kind === 'claude_stopped') {
        if (!t) continue;
        q.detail = plainAlertText(q.detail ?? '');
        items.push(
          q.kind === 'claude_finished'
            ? { key: q._id, kind: q.kind, ref: t.ref, title: t.title, detail: q.detail || undefined, headline: `Claude finished #${t.ref}` }
            : { key: q._id, kind: q.kind, ref: t.ref, title: t.title, detail: q.detail || undefined, headline: `Claude stopped on #${t.ref}${q.detail ? `: ${q.detail}` : ''}` },
        );
        continue;
      }
      const by = byId.get(q.byTaskId);
      if (!t || CLOSED_STATUSES.includes(t.status)) continue; // gone or already done: drop silently on send
      // `by` may be a task the recipient cannot see (someone's private task): then say only that it is done.
      items.push({ key: q._id, kind: 'unblocked', ref: t.ref, title: t.title, detail: by ? `#${by.ref} ${by.title} is done` : 'the task it waited on is done' });
    }
  }
  return items;
}

// ── Message ─────────────────────────────────────────────────────────────────

const SECTIONS: { kind: AlertKind; head: string }[] = [
  { kind: 'unblocked', head: '🔓 **Unblocked**, you can start these' },
  { kind: 'overdue', head: '🔴 **Overdue**' },
  { kind: 'due_today', head: '📅 **Due today**' },
  { kind: 'never_started', head: '⏳ **P1 not started yet** (24h+)' },
  { kind: 'stalled', head: '🧊 **Stalled**, In Progress but untouched' },
  { kind: 'due_tomorrow', head: '🗓️ **Due tomorrow**' },
  { kind: 'claude_finished', head: '✅ **Claude finished**' },
  { kind: 'claude_stopped', head: '🛑 **Claude stopped**' },
  { kind: 'claude_stuck', head: '🐢 **Claude may be stuck**' },
];

export function formatAlerts(items: AlertItem[], baseUrl: string): string[] {
  const lines: string[] = [];
  for (const s of SECTIONS) {
    const list = items.filter(i => i.kind === s.kind).sort((a, b) => a.ref - b.ref);
    if (!list.length) continue;
    lines.push(s.head);
    for (const i of list) lines.push(`• [#${i.ref}](<${baseUrl}/tasks/${i.ref}>) ${i.title}${i.detail ? ` · ${i.detail}` : ''}`);
    lines.push('');
  }
  // Split into ≤ 1900-char messages on line boundaries.
  const out: string[] = [];
  let cur = '';
  for (const l of lines) {
    if ((cur + l + '\n').length > 1900) {
      out.push(cur.trimEnd());
      cur = '';
    }
    cur += l + '\n';
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

// ── Send ────────────────────────────────────────────────────────────────────

const g = globalThis as unknown as { __workosDm?: Map<string, string> };

/** The DM channel with a person's linked Discord account (lib/profile.ts), opened once per process. */
async function dmChannel(discordId: string): Promise<string> {
  if (!discordConfig()) throw new Error('Discord is not configured');
  const map = (g.__workosDm ??= new Map());
  let ch = map.get(discordId);
  if (!ch) {
    ch = (await api<{ id: string }>('/users/@me/channels', { method: 'POST', body: { recipient_id: discordId } })).id;
    if (map.size > 1000) map.clear();
    map.set(discordId, ch);
  }
  return ch;
}

/** A DM to this Discord account (a person's linked one). */
export async function sendDm(discordId: string, content: string): Promise<void> {
  const ch = await dmChannel(discordId);
  try {
    await api(`/channels/${ch}/messages`, { method: 'POST', body: { content, allowed_mentions: { parse: [] }, flags: 1 << 2 /* suppress embeds */ } });
  } catch (e) {
    if (e instanceof DiscordError && e.status === 403) {
      throw new Error("Discord refused the DM (403). In Discord: the organization's Discord server → Privacy Settings → allow direct messages from server members.");
    }
    throw e;
  }
}

export type RunResult = { quiet: boolean; dryRun: boolean; sent: number; messages: string[]; items: AlertItem[]; error?: string };

const KIND_TITLE: Record<AlertKind, string> = {
  unblocked: 'Unblocked',
  overdue: 'Overdue',
  due_today: 'Due today',
  due_tomorrow: 'Due tomorrow',
  never_started: 'P1 not started',
  stalled: 'Stalled',
  claude_finished: 'Claude finished',
  claude_stopped: 'Claude stopped',
  claude_stuck: 'Claude may be stuck',
};

/** One person's alerts (s: the recipient), with their own settings and devices. */
export async function runAlerts(s: Scope, opts: { dryRun?: boolean; baseUrl: string; now?: Date; onlyQueued?: boolean }): Promise<RunResult> {
  const c0 = await scoped(s);
  const profile = await getProfile(s);
  const live = !opts.dryRun && !isQuietHour(profile, opts.now ?? new Date());
  // Claim queued alerts atomically before delivering: a conditional update per entry (sentAt null -> now) that only one
  // overlapping run can win, so each queued alert is delivered exactly once. Alerts queued meanwhile wait for the next run.
  let claimedIds: string[] | undefined;
  if (live) {
    const unsent = (await c0.alertQueue.find({ sentAt: null }, { projection: { _id: 1 } }).toArray()).map(q => q._id);
    const claimedAt = new Date();
    claimedIds = [];
    for (const id of unsent) {
      const r = await c0.alertQueue.updateOne({ _id: id, sentAt: null }, { $set: { sentAt: claimedAt } });
      if (r.modifiedCount === 1) claimedIds.push(id);
    }
  }
  const { items: computed, quiet } = await computeAlerts(s, opts.now, { onlyQueued: opts.onlyQueued, queuedIds: claimedIds });
  // Belt and braces: one item per key within a run.
  let due = [...new Map(computed.map(i => [i.key, i])).values()];
  if (live) {
    // Scheduled alerts: claim each in alertLog (insert, or conditional re-stamp for an overdue resend) so overlapping runs can't repeat them.
    const won: AlertItem[] = [];
    const stamp = new Date();
    for (const i of due) {
      if (FROM_QUEUE.has(i.kind)) { won.push(i); continue; }
      try {
        if (i.prevSentAt) {
          const r = await c0.alertLog.updateOne({ _id: i.key, sentAt: i.prevSentAt }, { $set: { sentAt: stamp } });
          if (r.modifiedCount === 1) won.push(i);
        } else {
          await c0.alertLog.insertOne({ _id: i.key, orgId: s.orgId, userId: s.userId, kind: i.kind, taskId: i.taskId, sentAt: stamp });
          won.push(i);
        }
      } catch (e) {
        if (!(e && typeof e === 'object' && (e as { code?: number }).code === 11000)) throw e; // duplicate key: another run has it
      }
    }
    due = won;
  }
  const settings = await getNotifySettings(s);
  const items = due.filter(i => settings.kinds[i.kind] !== false);
  const messages = formatAlerts(items, opts.baseUrl);
  const res: RunResult = { quiet, dryRun: !!opts.dryRun, sent: 0, messages, items };
  if (opts.dryRun || quiet) return res;
  if (!due.length) return res; // claimed queue entries whose task closed meanwhile stay marked, so later flushes skip them

  // Deliver: inbox always; push and Discord if enabled. A failing channel doesn't block the others.
  const errors: string[] = [];
  if (items.length) {
    await addToInbox(s, items.map(i => ({ kind: i.kind, title: i.headline ?? `${KIND_TITLE[i.kind]}: #${i.ref} ${i.title}`, body: i.headline ? i.title : (i.detail ?? ''), url: `/tasks/${i.ref}` })));
    if (settings.channels.push && pushConfigured()) {
      const one = items.length === 1 ? items[0] : null;
      const r = await sendPush(
        s,
        one
          ? { title: one.headline ?? `${KIND_TITLE[one.kind]} · #${one.ref}`, body: one.title + (one.detail && !one.headline ? ` (${one.detail})` : ''), url: `/tasks/${one.ref}`, tag: one.key }
          : { title: `Work OS · ${items.length} alerts`, body: items.slice(0, 4).map(i => `${KIND_TITLE[i.kind]}: ${i.title}`).join('\n'), url: '/notifications', tag: 'alerts' },
      );
      if (r.error) errors.push(`push: ${r.error}`);
    }
    if (settings.channels.discord && discordConfig() && profile.discordId) {
      try {
        for (const m of messages) await sendDm(profile.discordId, m);
        res.sent = messages.length;
      } catch (e) {
        errors.push(`discord: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Queue entries and alertLog rows were claimed (marked) before delivery, so there is nothing left to record.
  return { ...res, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

/** Clear alert history older than 60 days (everyone's: the cron). */
export async function pruneAlertLog(): Promise<void> {
  const c = await collections(); // scope-ok: system clean-up of old rows in every organization
  const cutoff = new Date(Date.now() - 60 * 86_400_000);
  await c.alertLog.deleteMany({ sentAt: { $lt: cutoff } });
  await c.alertQueue.deleteMany({ sentAt: { $lt: cutoff } });
}

/**
 * After a write: if it queued event alerts (unblocked, Claude finished or stopped), send just those now, each to its
 * recipient, instead of waiting for the next scheduled run (the due/overdue digests keep their times). The write may
 * have queued alerts for teammates, so this looks across the writer's organization. Never throws; a recipient in
 * their quiet hours gets nothing now (runAlerts holds it).
 */
export async function flushQueuedAlerts(s: Scope, baseUrl: string): Promise<void> {
  try {
    const c = await orgWide(s.orgId);
    const recipients = (await c.alertQueue.distinct('userId', { sentAt: null })) as string[];
    for (const userId of recipients) {
      const r = await runAlerts(forUser(s, userId), { baseUrl, onlyQueued: true });
      if (r.error) console.error('[alerts]', r.error);
    }
  } catch (e) {
    console.error('[alerts] flush failed:', e instanceof Error ? e.message : e);
  }
}

/** For the Connect page: when the scheduled check last ran for this person and whether it looks stopped. */
export async function lastRunStatus(s: Scope): Promise<{ lastRunAt: string | null; lastResult: string | null; stale: boolean }> {
  const d = await getUserSetting(s, 'alerts');
  const at = d?.lastRunAt ?? null;
  return { lastRunAt: at?.toISOString() ?? null, lastResult: d?.lastResult ?? null, stale: !at || Date.now() - at.getTime() > 40 * 60_000 };
}

/** The cron records each person's run. */
export async function recordRun(s: Scope, result: string): Promise<void> {
  await setUserSetting(s, 'alerts', { lastRunAt: new Date(), lastResult: result.slice(0, 300) });
}
