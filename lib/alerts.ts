import 'server-only';
import { collections, type AlertKind, type TaskDoc } from './db';
import { forUser, getUserSetting, orgWide, scoped, setUserSetting, type Scope, type ScopedCollections as Collections } from './scope';
import { simulatedStampsAllowed } from './cron-at';
import { getProfile, inQuietHours, type Profile } from './profile';
export type { AlertKind };
import { addDays, clockInTz, dateInTz, previousWorkdayStart, startOfDay, weekday } from './dates';
import { CLOSED_STATUSES, OPEN_STATUSES } from './types';
import { api, discordConfig, DiscordError } from './discord/client';
import { addToInbox, getNotifySettings, pushConfigured, sendPush } from './notify';
import { plainAlertText, stuckClaims } from './data/dispatcher';
import { recipientFilter, recipientsOf } from './data/tasks';
import { assigneesOf } from './assignees';
import { isMember, memberNames } from './people';
import { actorLabel } from './actors';
import { shortAsk } from './data/needs';
import { couldBeRunning } from './data/roster';
import { needButtons } from './discord/need-buttons';

// Nudges for each person about the tasks whose alerts go to them (recipientsOf: the assignees of a shared task, else
// its owner), to their inbox, their phones and (if they linked Discord) a Discord DM, by their own settings, in their
// own timezone.
// The cron (/api/cron/alerts, every 15 minutes) runs once per person; writes that unblock a task or end a dispatched
// one flush the queued alerts at once. Every alert is logged by key so it is sent once (overdue: every 2 days).
//
//   due_tomorrow   18:00 the day before, P1/P2
//   digest         once a day at the person's own hour (profile.digestHour, default 9), claimed by alertLog key
//                  digest:<date>:<userId>: what agents finished (alertQueue rows since the last digest), due and overdue, gone quiet,
//                  what moved yesterday (one line per project the person can read). While it is on (kinds.digest) the
//                  three alerts below wait for it and go into it; their log keys are claimed with it. After it has gone
//                  out, a task that becomes due, overdue or quiet still alerts on its own on the next run. Off = the
//                  alerts below work as they always did.
//   due_today      09:00 digest of open tasks due today (with the digest off, or after it went out)
//   overdue        09:00 the day after due, then at most every 2 days (same)
//   stalled        In Progress, no activity for 2 workdays (same)
//   never_started  P1 still Not Started 24h after creation
//   unblocked      as soon as the last task it waited on is closed
//   assigned       as soon as someone else assigns a task to you
//   claude_*       the task dispatcher (docs/dispatcher.md): finished / stopped (sent at once) and "may be stuck" (scheduled)
//   quiet hours    each person's own (default 23:00–08:00 in their timezone; held until they end)

export const ALERT_RULES = {
  dueTodayHour: 9,
  dueTomorrowHour: 18,
  overdueEveryDays: 2,
  stalledWorkdays: 2,
  neverStartedHours: 24,
} as const;


/** A section of the daily digest; rows with a ref link to the task. */
export type DigestSection = { head: string; rows: { ref?: number; text: string; detail?: string; /** A link target that is not the task (a Need opens on Today). */ url?: string; /** Link text when it is not "#ref". */ label?: string }[] };
export type Digest = { sections: DigestSection[]; /** One line for the inbox and push. */ summary: string; /** Nothing to say: the day is claimed, nothing is sent. */ empty: boolean; /** Log keys the digest takes over (due today, overdue, stalled), claimed with it. */ absorb: { key: string; kind: AlertKind; taskId: string }[] };

export type AlertItem = { key: string; kind: AlertKind; digest?: Digest; /** Where tapping its inbox row or push goes, when not the task. */ url?: string; ref: number; title: string; detail?: string; resend?: boolean; taskId?: string; prevSentAt?: Date; /** Inbox and push title, when the default "Kind: #ref title" does not fit. */ headline?: string; /** The link text when it is not "#ref". */ label?: string; /** need alerts: what Discord shows as buttons under the DM (never for an app-only Need). */ needId?: string; buttons?: { id: string; label: string }[] };

const CLAUDE_OUTCOMES = ['claude_finished', 'claude_stopped'] as const;
/** Event alerts that live in alertQueue and are claimed there (not in alertLog). */
const FROM_QUEUE = new Set<AlertKind>(['unblocked', 'assigned', 'need', ...CLAUDE_OUTCOMES]);


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
  const waiting = await c.tasks.find({ dependsOn: closed._id, status: { $in: OPEN_STATUSES }, archived: false }, { projection: { dependsOn: 1, ownerId: 1, visibility: 1, sharedWith: 1, assigneeIds: 1, assigneeId: 1 } }).toArray();
  for (const t of waiting) {
    const others = t.dependsOn.filter(id => id !== closed._id);
    const stillOpen = others.length ? await c.tasks.countDocuments({ _id: { $in: others }, status: { $in: OPEN_STATUSES } }) : 0;
    if (stillOpen) continue;
    // One per recipient (each assignee of a shared task); a task with one keeps the old key.
    const to = recipientsOf(t);
    for (const u of to) {
      await c.alertQueue.updateOne(
        { _id: to.length === 1 ? `unblocked:${t._id}:${closed._id}` : `unblocked:${t._id}:${closed._id}:${u}` },
        { $setOnInsert: { userId: u, kind: 'unblocked', taskId: t._id, byTaskId: closed._id, createdAt: new Date(), sentAt: null } },
        { upsert: true },
      );
    }
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
    .find({ status: { $in: OPEN_STATUSES }, archived: false, ...recipientFilter(s.userId) }, { projection: { ref: 1, title: 1, status: 1, priority: 1, due: 1, progress: 1, createdAt: 1, updatedAt: 1, ownerId: 1, need: 1 } })
    .toArray();
  const sent = new Map((await c.alertLog.find({ taskId: { $in: open.map(t => t._id) } }).toArray()).map(l => [l._id, l]));
  // The daily digest takes the morning's due today, overdue and stalled until it has gone out (it then holds them back
  // before its hour); after it, they alert as before.
  const digestOn = (await getNotifySettings(s)).kinds.digest !== false;
  const digestKey = `digest:${today}:${s.userId}`; // alertLog ids are shared by everyone, so the person is in the key
  const byDigest = digestOn && !(await c.alertLog.findOne({ _id: digestKey }, { projection: { _id: 1 } }));
  const was = (key: string) => sent.has(key);
  // Log keys are per task and occasion; an assignee's carry their user id too, so a task that changes hands still
  // alerts its new recipient (the owner's keep the old form, so nothing already sent goes out again).
  const keyOf = (base: string, t: { ownerId: string }) => (t.ownerId === s.userId ? base : `${base}:${s.userId}`);

  // due_today digest (one per day)
  if (!byDigest && hour >= ALERT_RULES.dueTodayHour) {
    for (const t of open.filter(t => t.due === today)) {
      const key = keyOf(`due_today:${t._id}:${today}`, t);
      if (!was(key)) items.push({ key, kind: 'due_today', taskId: t._id, ref: t.ref, title: t.title, detail: t.priority });
    }
  }
  // due_tomorrow (P1/P2)
  if (hour >= ALERT_RULES.dueTomorrowHour) {
    for (const t of open.filter(t => t.due === addDays(today, 1) && (t.priority === 'P1' || t.priority === 'P2'))) {
      const key = keyOf(`due_tomorrow:${t._id}:${t.due}`, t);
      if (!was(key)) items.push({ key, kind: 'due_tomorrow', taskId: t._id, ref: t.ref, title: t.title, detail: t.priority });
    }
  }
  // overdue: from the morning after, then every N days
  if (!byDigest && hour >= ALERT_RULES.dueTodayHour) {
    for (const t of open.filter(t => t.due && t.due < today)) {
      const key = keyOf(`overdue:${t._id}:${t.due}`, t);
      const last = sent.get(key);
      const days = Math.round((Date.parse(today) - Date.parse(t.due!)) / 86_400_000);
      if (!last || now.getTime() - last.sentAt.getTime() >= ALERT_RULES.overdueEveryDays * 86_400_000 - 30 * 60_000) {
        items.push({ key, kind: 'overdue', taskId: t._id, prevSentAt: last?.sentAt, ref: t.ref, title: t.title, detail: `${days} day${days === 1 ? '' : 's'} late`, resend: !!last });
      }
    }
  }
  // stalled: In Progress, untouched for N workdays (re-arms after any activity)
  // A task waiting on a Need is never "stalled": it waits on a person, and that has its own alert.
  for (const t of byDigest ? [] : open.filter(t => t.status === 'In Progress' && !t.need)) {
    const lastDay = dateInTz(t.updatedAt, tz);
    if (workdaysBetween(lastDay, today) < ALERT_RULES.stalledWorkdays) continue;
    const key = keyOf(`stalled:${t._id}:${t.updatedAt.toISOString()}`, t);
    if (!was(key)) items.push({ key, kind: 'stalled', taskId: t._id, ref: t.ref, title: t.title, detail: `no activity since ${lastDay}, ${t.progress}%` });
  }
  // never_started: P1 Not Started for 24h
  for (const t of open.filter(t => t.priority === 'P1' && t.status === 'Not Started')) {
    if (now.getTime() - t.createdAt.getTime() < ALERT_RULES.neverStartedHours * 3_600_000) continue;
    const key = keyOf(`never_started:${t._id}`, t);
    if (!was(key)) items.push({ key, kind: 'never_started', taskId: t._id, ref: t.ref, title: t.title });
  }
  // claude_stuck: a task Claude is working on, session quiet for 20 minutes (once per claim)
  for (const { t, quietMins } of await stuckClaims(s, now)) {
    const key = `claude_stuck:${t._id}:${t.claude!.claimedAt!.getTime()}`;
    if (!(await c.alertLog.findOne({ _id: key }, { projection: { _id: 1 } }))) items.push({ key, kind: 'claude_stuck', taskId: t._id, ref: t.ref, title: t.title, detail: `quiet for ${quietMins} min`, headline: `Claude may be stuck on #${t.ref}` });
  }
  if (byDigest && hour >= profile.digestHour) items.push(await buildDigest(s, c, { tz, today, key: digestKey, open, keyOf }));
  items.push(...(await queuedItems(c, opts.queuedIds)));
  return { items, quiet: false };
}

type OpenTask = Pick<TaskDoc, '_id' | 'ref' | 'title' | 'status' | 'priority' | 'due' | 'progress' | 'updatedAt' | 'ownerId' | 'need'>;

/** Projects where an agent could be running Next work and is not: the roster's couldBeRunning with the recipient's own scope (a project they cannot read never shows). */
export async function idleWithNextWork(s: Scope): Promise<DigestSection['rows']> {
  return (await couldBeRunning(s)).map(p => ({ text: `**${plainAlertText(p.projectName)}**`, detail: `${p.unblocked} Next line${p.unblocked === 1 ? '' : 's'} ready, none running: ${plainAlertText(p.first).slice(0, 80)}` }));
}

/**
 * The person's digest for `today`: what agents finished since the last digest, due and overdue, gone quiet, what moved
 * yesterday. Everything comes through the person's own door (their tasks, their queue, the projects they can read).
 */
async function buildDigest(
  s: Scope,
  c: Collections,
  x: { tz: string; today: string; key: string; open: OpenTask[]; keyOf: (base: string, t: { ownerId: string }) => string },
): Promise<AlertItem> {
  const { tz, today, open } = x;
  const sections: DigestSection[] = [];
  const absorb: Digest['absorb'] = [];

  // Needs you: the open Needs addressed to this person, first (they block someone). Through the person's own door.
  const allNeeds = await c.needs.find({ to: s.userId, status: 'open' }).sort({ createdAt: 1 }).limit(40).toArray();
  const needs = allNeeds.filter(n => n.kind !== 'review').slice(0, 20);
  const reviews = allNeeds.filter(n => n.kind === 'review');
  if (needs.length) {
    const people = await memberNames(s.orgId);
    sections.push({
      head: '🙋 **Needs you**',
      rows: needs.map(n => ({ label: `Need #${n.ref}`, url: `/today#need-${n.ref}`, text: plainAlertText(shortAsk(n.ask)), detail: `${plainAlertText(actorLabel(n.from.actor, s.userId, people))}${n.taskRef ? ` · on #${n.taskRef}` : ''}${n.appOnly ? ' · answer in the app' : ''}` })),
    });
  }

  // Finished, to review: the open review Needs (a hand_in) addressed to this person. Its own section, since it is a finished
  // piece to look at rather than a question; it is shown right after "Needs you". Their tasks are left out of "What agents finished".
  if (reviews.length) {
    const people = await memberNames(s.orgId);
    sections.push({
      head: '🔍 **Finished, to review**',
      rows: reviews.map(n => ({ label: `Need #${n.ref}`, url: `/today#need-${n.ref}`, text: plainAlertText(shortAsk(n.ask)), detail: `${plainAlertText(actorLabel(n.from.actor, s.userId, people))}${n.taskRef ? ` · on #${n.taskRef}` : ''}` })),
    });
  }
  const reviewTasks = new Set(reviews.flatMap(n => (n.taskId ? [n.taskId] : [])));

  // What agents finished: queue rows (already sent as alerts) created since the last digest.
  const lastAny = await c.alertLog.findOne({ kind: 'digest' }, { sort: { sentAt: -1 }, projection: { sentAt: 1 } });
  const since = lastAny ? lastAny.sentAt : previousWorkdayStart(today, tz);
  const outcomes = await c.alertQueue.find({ kind: { $in: [...CLAUDE_OUTCOMES] }, createdAt: { $gt: since } }).sort({ createdAt: 1 }).toArray();
  if (outcomes.length) {
    const byId = new Map((await c.tasks.find({ _id: { $in: outcomes.map(q => q.taskId) } }, { projection: { ref: 1, title: 1 } }).toArray()).map(t => [t._id, t]));
    const rows = outcomes.flatMap(q => {
      const t = byId.get(q.taskId);
      if (!t || reviewTasks.has(q.taskId)) return [];
      const why = plainAlertText(q.detail ?? '');
      return [{ ref: t.ref, text: t.title, detail: q.kind === 'claude_finished' ? 'finished, to review' : `stopped${why ? `: ${why}` : ''}` }];
    });
    if (rows.length) sections.push({ head: '✅ **What agents finished**', rows });
  }

  // Due and overdue (all of them, not only the ones not yet told).
  const due: DigestSection['rows'] = [];
  for (const t of open.filter(t => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!) || a.ref - b.ref)) {
    const days = Math.round((Date.parse(today) - Date.parse(t.due!)) / 86_400_000);
    due.push({ ref: t.ref, text: t.title, detail: `${days} day${days === 1 ? '' : 's'} late` });
    absorb.push({ key: x.keyOf(`overdue:${t._id}:${t.due}`, t), kind: 'overdue', taskId: t._id });
  }
  for (const t of open.filter(t => t.due === today).sort((a, b) => a.ref - b.ref)) {
    due.push({ ref: t.ref, text: t.title, detail: `due today, ${t.priority}` });
    absorb.push({ key: x.keyOf(`due_today:${t._id}:${today}`, t), kind: 'due_today', taskId: t._id });
  }
  if (due.length) sections.push({ head: '🔴 **Due and overdue**', rows: due });

  // Gone quiet: In Progress, untouched for the stalled rule's workdays.
  const quiet: DigestSection['rows'] = [];
  for (const t of open.filter(t => t.status === 'In Progress' && !t.need).sort((a, b) => a.ref - b.ref)) {
    const lastDay = dateInTz(t.updatedAt, tz);
    if (workdaysBetween(lastDay, today) < ALERT_RULES.stalledWorkdays) continue;
    quiet.push({ ref: t.ref, text: t.title, detail: `no change since ${lastDay}, ${t.progress}%` });
    absorb.push({ key: x.keyOf(`stalled:${t._id}:${t.updatedAt.toISOString()}`, t), kind: 'stalled', taskId: t._id });
  }
  if (quiet.length) sections.push({ head: '🧊 **Gone quiet**, In Progress but untouched', rows: quiet });

  // Idle with Next work ("cutroom could be running and isn't"): the roster's couldBeRunning, read with this person's own scope.
  const idle = await idleWithNextWork(s);
  if (idle.length) sections.push({ head: '💤 **Idle with Next work**', rows: idle });

  // Moved yesterday: one line per project (the previous working day up to today, so Monday covers the weekend). The
  // activity, the tasks and the projects all come through the door, so a project the person cannot read never shows.
  const acts = await c.activity.find({ at: { $gte: previousWorkdayStart(today, tz), $lt: startOfDay(today, tz) } }, { projection: { taskId: 1, type: 1 } }).toArray();
  if (acts.length) {
    const taskIds = [...new Set(acts.map(a => a.taskId))];
    const projOf = new Map((await c.tasks.find({ _id: { $in: taskIds }, projectId: { $ne: null } }, { projection: { projectId: 1 } }).toArray()).map(t => [t._id, t.projectId as string]));
    const names = new Map((await c.projects.find({ _id: { $in: [...new Set(projOf.values())] } }, { projection: { name: 1 } }).toArray()).map(p => [p._id, p.name]));
    const per = new Map<string, { moved: Set<string>; done: Set<string> }>();
    for (const a of acts) {
      const pid = projOf.get(a.taskId);
      if (!pid || !names.has(pid)) continue;
      const e = per.get(pid) ?? { moved: new Set<string>(), done: new Set<string>() };
      e.moved.add(a.taskId);
      if (a.type === 'completed') e.done.add(a.taskId);
      per.set(pid, e);
    }
    const rows = [...per.entries()]
      .map(([pid, e]) => ({ text: `**${names.get(pid)}**`, detail: `${e.moved.size} task${e.moved.size === 1 ? '' : 's'} moved${e.done.size ? `, ${e.done.size} done` : ''}` }))
      .sort((a, b) => a.text.localeCompare(b.text));
    if (rows.length) sections.push({ head: '🔄 **Moved yesterday**', rows });
  }

  const n = (h: string) => sections.find(sec => sec.head.includes(h))?.rows.length ?? 0;
  const summary = [n('Needs you') && `${n('Needs you')} need${n('Needs you') === 1 ? 's' : ''} you`, n('Finished, to review') && `${n('Finished, to review')} to review`, n('agents finished') && `${n('agents finished')} finished`, n('Due and overdue') && `${n('Due and overdue')} due or overdue`, n('Gone quiet') && `${n('Gone quiet')} quiet`, n('Moved') && `${n('Moved')} project${n('Moved') === 1 ? '' : 's'} moved`].filter(Boolean).join(' · ');
  // The first digest says why the morning alerts changed.
  const first = !(await c.alertLog.findOne({ kind: 'digest', empty: { $ne: true } }, { projection: { _id: 1 } }));
  const empty = !sections.length;
  if (first && !empty) sections.unshift({ head: 'ℹ️ **New: your daily digest**', rows: [{ text: 'The morning alerts (due today, overdue, stalled) now come in this one message, once a day. Something that turns due, overdue or quiet later still alerts on its own.' }] });
  return { key: x.key, kind: 'digest', ref: 0, title: 'Your daily digest', headline: 'Your daily digest', url: '/today', detail: summary, digest: { sections, summary, empty, absorb } };
}

/** ids: only these queue entries (the ones this run claimed); omitted = everything still unsent (dry run). */
async function queuedItems(c: Collections, ids?: string[]): Promise<AlertItem[]> {
  const items: AlertItem[] = [];
  const queued = await c.alertQueue.find(ids ? { _id: { $in: ids } } : { sentAt: null }).toArray();
  if (queued.length) {
    const taskIds = [...new Set(queued.flatMap(q => [q.taskId, q.byTaskId]))];
    const byId = new Map((await c.tasks.find({ _id: { $in: taskIds } }, { projection: { ref: 1, title: 1, status: 1, archived: 1, assigneeIds: 1, assigneeId: 1 } }).toArray()).map(t => [t._id, t]));
    const needIds = queued.flatMap(q => (q.kind === 'need' && q.needId ? [q.needId] : []));
    const needById = new Map((needIds.length ? await c.needs.find({ _id: { $in: needIds } }).toArray() : []).map(n => [n._id, n]));
    const people = needIds.length ? await memberNames(queued[0].orgId) : {};
    for (const q of queued) {
      const t = byId.get(q.taskId);
      if (q.kind === 'need') {
        // Dropped if it was answered, withdrawn or replaced before it went out, or the person can no longer read it.
        const n = needById.get(q.needId ?? '');
        if (!n || n.status !== 'open') continue;
        const who = plainAlertText(actorLabel(n.from.actor, q.userId, people));
        const ask = plainAlertText(shortAsk(n.ask));
        items.push({
          key: q._id,
          kind: 'need',
          ref: n.ref,
          label: `Need #${n.ref}`,
          url: `/today#need-${n.ref}`,
          title: ask,
          detail: `${who}${n.taskRef ? ` · on #${n.taskRef}` : ''}${n.appOnly ? ' · answer in the app' : ''}`,
          headline: `${who} asks you: ${ask}`,
          ...(n.appOnly ? {} : { needId: n._id, buttons: n.options.map(o => ({ id: o.id, label: o.label })) }),
        });
        continue;
      }
      if (q.kind === 'assigned') {
        // Dropped if they were taken off it again, or it closed or was archived, before it went out.
        if (!t || !assigneesOf(t).includes(q.userId) || CLOSED_STATUSES.includes(t.status) || t.archived) continue;
        const by = plainAlertText(q.detail ?? '');
        items.push({ key: q._id, kind: 'assigned', ref: t.ref, title: t.title, detail: by ? `by ${by}` : undefined, headline: `#${t.ref} assigned to you${by ? ` by ${by}` : ''}` });
        continue;
      }
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
  { kind: 'assigned', head: '👤 **Assigned to you**' },
  { kind: 'unblocked', head: '🔓 **Unblocked**, you can start these' },
  { kind: 'overdue', head: '🔴 **Overdue**' },
  { kind: 'due_today', head: '📅 **Due today**' },
  { kind: 'never_started', head: '⏳ **P1 not started yet** (24h+)' },
  { kind: 'stalled', head: '🧊 **Stalled**, In Progress but untouched' },
  { kind: 'due_tomorrow', head: '🗓️ **Due tomorrow**' },
  { kind: 'claude_finished', head: '✅ **Claude finished**' },
  { kind: 'claude_stopped', head: '🛑 **Claude stopped**' },
  { kind: 'claude_stuck', head: '🐢 **Claude may be stuck**' },
  { kind: 'need', head: '🙋 **Needs you**' },
];

export function formatAlerts(items: AlertItem[], baseUrl: string): string[] {
  const lines: string[] = [];
  for (const d of items.filter(i => i.kind === 'digest' && i.digest && !i.digest.empty)) {
    lines.push('📋 **Your daily digest**', '');
    for (const sec of d.digest!.sections) {
      lines.push(sec.head);
      for (const r of sec.rows) lines.push(`• ${r.url || r.ref ? `[${r.label ?? `#${r.ref}`}](<${baseUrl}${r.url ?? `/tasks/${r.ref}`}>) ` : ''}${plainAlertText(r.text)}${r.detail ? ` · ${plainAlertText(r.detail)}` : ''}`);
      lines.push('');
    }
  }
  for (const s of SECTIONS) {
    const list = items.filter(i => i.kind === s.kind).sort((a, b) => a.ref - b.ref);
    if (!list.length) continue;
    lines.push(s.head);
    for (const i of list) lines.push(`• [${i.label ?? `#${i.ref}`}](<${baseUrl}${i.url ?? `/tasks/${i.ref}`}>) ${i.title}${i.detail ? ` · ${i.detail}` : ''}`);
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
export async function sendDm(discordId: string, content: string, components?: unknown[]): Promise<void> {
  const ch = await dmChannel(discordId);
  try {
    await api(`/channels/${ch}/messages`, { method: 'POST', body: { content, allowed_mentions: { parse: [] }, flags: 1 << 2 /* suppress embeds */, ...(components ? { components } : {}) } });
  } catch (e) {
    if (e instanceof DiscordError && e.status === 403) {
      throw new Error("Discord refused the DM (403). In Discord: the organization's Discord server → Privacy Settings → allow direct messages from server members.");
    }
    throw e;
  }
}

export type RunResult = { quiet: boolean; dryRun: boolean; sent: number; messages: string[]; items: AlertItem[]; error?: string };

const KIND_TITLE: Record<AlertKind, string> = {
  digest: 'Daily digest',
  unblocked: 'Unblocked',
  assigned: 'Assigned to you',
  overdue: 'Overdue',
  due_today: 'Due today',
  due_tomorrow: 'Due tomorrow',
  never_started: 'P1 not started',
  stalled: 'Stalled',
  claude_finished: 'Claude finished',
  claude_stopped: 'Claude stopped',
  claude_stuck: 'Claude may be stuck',
  need: 'Needs you',
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
    // The run's time only in the e2e database (a test's ?at=, so resend arithmetic uses one clock); everywhere else the real clock, never a future stamp.
    const stamp = opts.now && simulatedStampsAllowed() ? opts.now : new Date();
    for (const i of due) {
      if (FROM_QUEUE.has(i.kind)) { won.push(i); continue; }
      try {
        if (i.kind === 'digest') {
          // One per day. Its time is the run's, so "since the last digest" is on the same clock as the queue rows.
          await c0.alertLog.insertOne({ _id: i.key, orgId: s.orgId, userId: s.userId, kind: 'digest', sentAt: stamp, ...(i.digest?.empty ? { empty: true } : {}) });
          // Won (the digest key is ours): it goes out whatever happens to the keys below.
          if (!i.digest?.empty) won.push(i);
          // The alerts it takes over are told by it, so claim their keys too. One key per task and occasion is shared by
          // everyone with the same form (a task that changed owner may carry the old owner's key): a clash on one key
          // is skipped, it must never cost the day's digest.
          for (const a of i.digest?.absorb ?? []) {
            try {
              await c0.alertLog.updateOne({ _id: a.key }, { $set: { sentAt: stamp }, $setOnInsert: { kind: a.kind, taskId: a.taskId } }, { upsert: true });
            } catch (e) {
              if (!(e && typeof e === 'object' && (e as { code?: number }).code === 11000)) console.error('[alerts] digest claim', e instanceof Error ? e.message : e);
            }
          }
          continue;
        }
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
    await addToInbox(s, items.map(i => ({ kind: i.kind, title: i.headline ?? `${KIND_TITLE[i.kind]}: #${i.ref} ${i.title}`, body: i.kind === 'digest' ? (i.detail ?? '') : i.headline ? i.title : (i.detail ?? ''), url: i.url ?? `/tasks/${i.ref}` })));
    if (settings.channels.push && pushConfigured()) {
      const one = items.length === 1 ? items[0] : null;
      const r = await sendPush(
        s,
        one
          ? { title: one.headline ?? `${KIND_TITLE[one.kind]} · #${one.ref}`, body: one.kind === 'digest' ? (one.detail || one.title) : one.title + (one.detail && !one.headline ? ` (${one.detail})` : ''), url: one.url ?? `/tasks/${one.ref}`, tag: one.key }
          : { title: `Work OS · ${items.length} alerts`, body: items.slice(0, 4).map(i => `${KIND_TITLE[i.kind]}: ${i.title}`).join('\n'), url: '/notifications', tag: 'alerts' },
      );
      if (r.error) errors.push(`push: ${r.error}`);
    }
    if (settings.channels.discord && discordConfig() && profile.discordId) {
      try {
        for (const m of messages) await sendDm(profile.discordId, m);
        res.sent = messages.length;
        // A Need can be answered right there: one small message per Need with its options as buttons (custom id
        // wo:need:<id>:<option>, answered through the DM path of the interactions route). App-only Needs get none.
        for (const i of items) if (i.kind === 'need' && i.needId && i.buttons?.length) await sendDm(profile.discordId, `🙋 **${i.label ?? 'Need'}**: ${i.title}`.slice(0, 1900), needButtons(i.needId, i.buttons));
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
      if (!(await isMember(s.orgId, userId))) continue; // removed from the organization: nothing goes to them
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
