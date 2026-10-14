import 'server-only';
import { collections, type AlertKind, type Collections, type TaskDoc } from './db';
export type { AlertKind };
import { APP_TZ, addDays, dateInTz, weekday } from './dates';
import { CLOSED_STATUSES, OPEN_STATUSES } from './types';
import { api, discordConfig, DiscordError } from './discord/client';
import { addToInbox, getNotifySettings, pushConfigured, sendPush } from './notify';

// Nudges sent to Om as Discord DMs from the existing bot. Runs every 15 minutes
// (/api/cron/alerts, triggered by an external scheduler) and right after writes that
// unblock a task. Every alert is logged by key so it is sent once (overdue: every 2 days).
//
//   due_tomorrow   18:00 the day before, P1/P2
//   due_today      09:00 digest of open tasks due today
//   overdue        09:00 the day after due, then at most every 2 days
//   stalled        In Progress, no activity for 2 workdays
//   never_started  P1 still Not Started 24h after creation
//   unblocked      as soon as the last task it waited on is closed
//   quiet hours    23:00–08:00 (held until morning)

export const ALERT_RULES = {
  quietStart: 23,
  quietEnd: 8,
  dueTodayHour: 9,
  dueTomorrowHour: 18,
  overdueEveryDays: 2,
  stalledWorkdays: 2,
  neverStartedHours: 24,
} as const;


export type AlertItem = { key: string; kind: AlertKind; ref: number; title: string; detail?: string; resend?: boolean };


export function hourInTz(d: Date = new Date(), tz = APP_TZ): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
}

export function isQuietHour(d: Date = new Date()): boolean {
  const h = hourInTz(d);
  return h >= ALERT_RULES.quietStart || h < ALERT_RULES.quietEnd;
}

/** Weekdays strictly after `from` up to and including `to` (YYYY-MM-DD). */
function workdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (weekday(d) !== 0 && weekday(d) !== 6) n++;
  return n;
}

// ── Unblocked: queued by the data layer when a task closes ──────────────────

/** Called after a task closes: queue an alert for each open task whose dependencies are now all closed. */
export async function queueUnblocked(c: Collections, closed: Pick<TaskDoc, '_id'>): Promise<void> {
  const waiting = await c.tasks.find({ dependsOn: closed._id, status: { $in: OPEN_STATUSES }, archived: false }, { projection: { dependsOn: 1 } }).toArray();
  for (const t of waiting) {
    const others = t.dependsOn.filter(id => id !== closed._id);
    const stillOpen = others.length ? await c.tasks.countDocuments({ _id: { $in: others }, status: { $in: OPEN_STATUSES } }) : 0;
    if (stillOpen) continue;
    await c.alertQueue.updateOne(
      { _id: `unblocked:${t._id}:${closed._id}` },
      { $setOnInsert: { kind: 'unblocked', taskId: t._id, byTaskId: closed._id, createdAt: new Date(), sentAt: null } },
      { upsert: true },
    );
  }
}

// ── What is due now ─────────────────────────────────────────────────────────

/** onlyQueued: just the queued "unblocked" alerts (sent right after a write), not the scheduled checks. */
export async function computeAlerts(now: Date = new Date(), opts: { onlyQueued?: boolean } = {}): Promise<{ items: AlertItem[]; quiet: boolean }> {
  const c = await collections();
  if (isQuietHour(now)) return { items: [], quiet: true };
  if (opts.onlyQueued) return { items: await queuedUnblocked(c), quiet: false };
  const today = dateInTz(now);
  const hour = hourInTz(now);
  const items: AlertItem[] = [];
  const open = await c.tasks.find({ status: { $in: OPEN_STATUSES }, archived: false }).toArray();
  const sent = new Map((await c.alertLog.find({ taskId: { $in: open.map(t => t._id) } }).toArray()).map(l => [l._id, l]));
  const was = (key: string) => sent.has(key);

  // due_today digest (one per day)
  if (hour >= ALERT_RULES.dueTodayHour) {
    for (const t of open.filter(t => t.due === today)) {
      const key = `due_today:${t._id}:${today}`;
      if (!was(key)) items.push({ key, kind: 'due_today', ref: t.ref, title: t.title, detail: t.priority });
    }
  }
  // due_tomorrow (P1/P2)
  if (hour >= ALERT_RULES.dueTomorrowHour) {
    for (const t of open.filter(t => t.due === addDays(today, 1) && (t.priority === 'P1' || t.priority === 'P2'))) {
      const key = `due_tomorrow:${t._id}:${t.due}`;
      if (!was(key)) items.push({ key, kind: 'due_tomorrow', ref: t.ref, title: t.title, detail: t.priority });
    }
  }
  // overdue: from the morning after, then every N days
  if (hour >= ALERT_RULES.dueTodayHour) {
    for (const t of open.filter(t => t.due && t.due < today)) {
      const key = `overdue:${t._id}:${t.due}`;
      const last = sent.get(key);
      const days = Math.round((Date.parse(today) - Date.parse(t.due!)) / 86_400_000);
      if (!last || now.getTime() - last.sentAt.getTime() >= ALERT_RULES.overdueEveryDays * 86_400_000 - 30 * 60_000) {
        items.push({ key, kind: 'overdue', ref: t.ref, title: t.title, detail: `${days} day${days === 1 ? '' : 's'} late`, resend: !!last });
      }
    }
  }
  // stalled: In Progress, untouched for N workdays (re-arms after any activity)
  for (const t of open.filter(t => t.status === 'In Progress')) {
    const lastDay = dateInTz(t.updatedAt);
    if (workdaysBetween(lastDay, today) < ALERT_RULES.stalledWorkdays) continue;
    const key = `stalled:${t._id}:${t.updatedAt.toISOString()}`;
    if (!was(key)) items.push({ key, kind: 'stalled', ref: t.ref, title: t.title, detail: `no activity since ${lastDay}, ${t.progress}%` });
  }
  // never_started: P1 Not Started for 24h
  for (const t of open.filter(t => t.priority === 'P1' && t.status === 'Not Started')) {
    if (now.getTime() - t.createdAt.getTime() < ALERT_RULES.neverStartedHours * 3_600_000) continue;
    const key = `never_started:${t._id}`;
    if (!was(key)) items.push({ key, kind: 'never_started', ref: t.ref, title: t.title });
  }
  items.push(...(await queuedUnblocked(c)));
  return { items, quiet: false };
}

async function queuedUnblocked(c: Collections): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  const queued = await c.alertQueue.find({ sentAt: null }).toArray();
  if (queued.length) {
    const ids = [...new Set(queued.flatMap(q => [q.taskId, q.byTaskId]))];
    const byId = new Map((await c.tasks.find({ _id: { $in: ids } }, { projection: { ref: 1, title: 1, status: 1 } }).toArray()).map(t => [t._id, t]));
    for (const q of queued) {
      const t = byId.get(q.taskId);
      const by = byId.get(q.byTaskId);
      if (!t || CLOSED_STATUSES.includes(t.status)) continue; // gone or already done: drop silently on send
      items.push({ key: q._id, kind: 'unblocked', ref: t.ref, title: t.title, detail: by ? `#${by.ref} ${by.title} is done` : 'the task it waited on was deleted' });
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

const g = globalThis as unknown as { __workosDm?: string };

async function dmChannel(): Promise<string> {
  const cfg = discordConfig();
  if (!cfg) throw new Error('Discord is not configured');
  g.__workosDm ??= (await api<{ id: string }>('/users/@me/channels', { method: 'POST', body: { recipient_id: cfg.ownerId } })).id;
  return g.__workosDm;
}

export async function sendDm(content: string): Promise<void> {
  const ch = await dmChannel();
  try {
    await api(`/channels/${ch}/messages`, { method: 'POST', body: { content, allowed_mentions: { parse: [] }, flags: 1 << 2 /* suppress embeds */ } });
  } catch (e) {
    if (e instanceof DiscordError && e.status === 403) {
      throw new Error('Discord refused the DM (403). In Discord: Delpat server → Privacy Settings → allow direct messages from server members.');
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
};

export async function runAlerts(opts: { dryRun?: boolean; baseUrl: string; now?: Date; onlyQueued?: boolean }): Promise<RunResult> {
  const { items: due, quiet } = await computeAlerts(opts.now, { onlyQueued: opts.onlyQueued });
  const settings = await getNotifySettings();
  const items = due.filter(i => settings.kinds[i.kind] !== false);
  const messages = formatAlerts(items, opts.baseUrl);
  const res: RunResult = { quiet, dryRun: !!opts.dryRun, sent: 0, messages, items };
  if (opts.dryRun || !due.length) return res;

  // Deliver: inbox always; push and Discord if enabled. A failing channel doesn't block the others.
  const errors: string[] = [];
  if (items.length) {
    await addToInbox(items.map(i => ({ kind: i.kind, title: `${KIND_TITLE[i.kind]}: #${i.ref} ${i.title}`, body: i.detail ?? '', url: `/tasks/${i.ref}` })));
    if (settings.channels.push && pushConfigured()) {
      const one = items.length === 1 ? items[0] : null;
      const r = await sendPush(
        one
          ? { title: `${KIND_TITLE[one.kind]} · #${one.ref}`, body: one.title + (one.detail ? ` (${one.detail})` : ''), url: `/tasks/${one.ref}`, tag: one.key }
          : { title: `Work OS · ${items.length} alerts`, body: items.slice(0, 4).map(i => `${KIND_TITLE[i.kind]}: ${i.title}`).join('\n'), url: '/notifications', tag: 'alerts' },
      );
      if (r.error) errors.push(`push: ${r.error}`);
    }
    if (settings.channels.discord && discordConfig()) {
      try {
        for (const m of messages) await sendDm(m);
        res.sent = messages.length;
      } catch (e) {
        errors.push(`discord: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Record everything that was due (including switched-off kinds) so nothing piles up.
  const c = await collections();
  const now = new Date();
  const logged = due.filter(i => i.kind !== 'unblocked');
  if (logged.length) {
    const taskIds = new Map((await c.tasks.find({ ref: { $in: logged.map(i => i.ref) } }, { projection: { ref: 1 } }).toArray()).map(t => [t.ref, t._id]));
    await c.alertLog.bulkWrite(
      logged.map(i => ({ updateOne: { filter: { _id: i.key }, update: { $set: { kind: i.kind, taskId: taskIds.get(i.ref), sentAt: now } }, upsert: true } })),
    );
  }
  await c.alertQueue.updateMany({ sentAt: null }, { $set: { sentAt: now } });
  return { ...res, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

/** Clear alert history older than 60 days. */
export async function pruneAlertLog(): Promise<void> {
  const c = await collections();
  const cutoff = new Date(Date.now() - 60 * 86_400_000);
  await c.alertLog.deleteMany({ sentAt: { $lt: cutoff } });
  await c.alertQueue.deleteMany({ sentAt: { $lt: cutoff } });
}

/**
 * After a write: if it queued an "unblocked" alert, send just that now instead of waiting for the
 * next scheduled run (the due/overdue digests keep their times). Never throws; does nothing during quiet hours or when Discord isn't set up.
 */
export async function flushQueuedAlerts(baseUrl: string): Promise<void> {
  try {
    if (isQuietHour()) return;
    const c = await collections();
    if (!(await c.alertQueue.countDocuments({ sentAt: null }))) return;
    const r = await runAlerts({ baseUrl, onlyQueued: true });
    if (r.error) console.error('[alerts]', r.error);
  } catch (e) {
    console.error('[alerts] flush failed:', e instanceof Error ? e.message : e);
  }
}

/** For the Connect page: when the scheduled check last ran and whether it looks stopped. */
export async function lastRunStatus(): Promise<{ lastRunAt: string | null; lastResult: string | null; stale: boolean }> {
  const s = await (await collections()).settings.findOne({ _id: 'alerts' });
  const at = s?.lastRunAt ?? null;
  return { lastRunAt: at?.toISOString() ?? null, lastResult: s?.lastResult ?? null, stale: !at || Date.now() - at.getTime() > 40 * 60_000 };
}
