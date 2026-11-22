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
import { neutralAlertText, plainAlertText, stuckClaims } from './data/dispatcher';
import { listActivity, recipientFilter, recipientsOf } from './data/tasks';
import { assigneesOf } from './assignees';
import { isMember, memberNames } from './people';
import { actorLabel } from './actors';
import { reachesPhone, shortAsk } from './data/needs';
import { roster, unblockedNext } from './data/roster';

// Nudges for each person about the tasks whose alerts go to them (recipientsOf: the assignees of a shared task, else
// its owner), to their inbox, their phones and (if they linked Discord) a Discord DM, by their own settings, in their
// own timezone.
// The cron (/api/cron/alerts, every 15 minutes) runs once per person; writes that unblock a task or end a dispatched
// one flush the queued alerts at once. Every alert is logged by key so it is sent once (overdue: every 2 days).
//
//   due_tomorrow   18:00 the day before, P1/P2
//   digest         once a day at the person's own hour (profile.digestHour, default 9), claimed by alertLog key
//                  digest:<date>:<userId>: Needs you (answerable from Discord), Today (top 3 by rule), Since yesterday (one line per
//                  project that changed), Agents (running, stalled, could run); on Mondays, for the organization's owner, the
//                  Monday numbers and up to three proposals (lib/monday.ts). While it is on (kinds.digest) the
//                  three alerts below wait for it and go into it; their log keys are claimed with it. After it has gone
//                  out, a task that becomes due, overdue or quiet still alerts on its own on the next run. Off = the
//                  alerts below work as they always did.
//   due_today      09:00 digest of open tasks due today (with the digest off, or after it went out)
//   overdue        09:00 the day after due, then at most every 2 days (same)
//   stalled        In Progress, no activity for 2 workdays (same)
//   never_started  P1 still Not Started 24h after creation
//   unblocked      as soon as the last task it waited on is closed
//   assigned       as soon as someone else assigns a task to you
//   claude_*       the task dispatcher (docs/ops/dispatcher.md): finished / stopped (sent at once) and "may be stuck" (scheduled)
//   quiet hours    each person's own (default 23:00–08:00 in their timezone; held until they end)

export const ALERT_RULES = {
  dueTodayHour: 9,
  dueTomorrowHour: 18,
  overdueEveryDays: 2,
  stalledWorkdays: 2,
  neverStartedHours: 24,
} as const;


/** A section of the daily digest; rows with a ref link to the task. */
export type DigestSection = { head: string; /** Rows are numbered 1. 2. 3. instead of bulleted. */ numbered?: boolean; rows: { ref?: number; text: string; detail?: string; /** A link target that is not the task (a Need opens on Today). */ url?: string; /** Link text when it is not "#ref". */ label?: string }[] };
export type Digest = { sections: DigestSection[]; /** One line for the inbox and push. */ summary: string; /** Nothing to say: the day is claimed, nothing is sent. */ empty: boolean; /** Log keys the digest takes over (due today, overdue, stalled), claimed with it. */ absorb: { key: string; kind: AlertKind; taskId: string }[]; };

export type AlertItem = { key: string; kind: AlertKind; digest?: Digest; /** Where tapping its inbox row or push goes, when not the task. */ url?: string; ref: number; title: string; detail?: string; resend?: boolean; taskId?: string; prevSentAt?: Date; /** Inbox and push title, when the default "Kind: #ref title" does not fit. */ headline?: string; /** The link text when it is not "#ref". */ label?: string; };

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Wed 18 Nov" for a YYYY-MM-DD. */
function dayLabel(d: string): string {
  return `${DAYS[weekday(d)]} ${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "12 min", "3 h", "2 days": how long ago, for a quiet worker. */
function quietFor(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const MAX_NEED_LINES = 8;
const MAX_TODAY = 3;
const MAX_AGENT_LINES = 5;

/**
 * The person's digest for `today` (docs/HANDOVER.md, alerts): what needs them (answerable from Discord), what to do
 * today (the top 3 by rule), what happened per project since the last digest, and which agents run or stall. Everything
 * comes through the person's own door (their tasks, needs, State, projects, presence), so a project they cannot read
 * never shows. It still takes over the morning's due today, overdue and stalled alerts (`absorb`).
 */
async function buildDigest(
  s: Scope,
  c: Collections,
  x: { tz: string; today: string; key: string; open: OpenTask[]; keyOf: (base: string, t: { ownerId: string }) => string },
): Promise<AlertItem> {
  const { tz, today, open } = x;
  const sections: DigestSection[] = [];
  const absorb: Digest['absorb'] = [];

  const lastAny = await c.alertLog.findOne({ kind: 'digest' }, { sort: { sentAt: -1 }, projection: { sentAt: 1 } });
  const since = lastAny ? lastAny.sentAt : previousWorkdayStart(today, tz);
  const projectNames = new Map((await c.projects.find({}, { projection: { name: 1 } }).toArray()).map(p => [p._id, p.name]));

  // 1. Needs you: the open Needs addressed to this person, oldest first. Review Needs are folded in; Monday Needs wait for the Monday block. Through their own door.
  const allNeeds = await c.needs.find({ to: s.userId, status: 'open', batch: { $ne: 'monday' } }).sort({ createdAt: 1 }).limit(60).toArray();
  if (allNeeds.length) {
    const people = await memberNames(s.orgId);
    const rows: DigestSection['rows'] = allNeeds.slice(0, MAX_NEED_LINES).map(n => {
      const review = n.kind === 'review';
      const who = neutralAlertText(actorLabel(n.from.actor, s.userId, people));
      return {
        label: review ? `Review #${n.ref}` : `Need #${n.ref}`,
        url: `/today#need-${n.ref}`,
        text: `${projectNames.has(n.projectId) ? `${neutralAlertText(projectNames.get(n.projectId)!)}: ` : ''}${neutralAlertText(shortAsk(n.ask))}`,
        detail: `${who}${n.taskRef ? ` · on #${n.taskRef}` : ''}${n.appOnly || review ? ' · answer in the app' : ''}`,
      };
    });
    if (allNeeds.length > MAX_NEED_LINES) rows.push({ label: `+${allNeeds.length - MAX_NEED_LINES} more`, url: '/needs', text: 'in the app' });
    sections.push({ head: `🙋 **Needs you** (${allNeeds.length}, oldest first)`, rows });
  }

  // The morning's due today, overdue and stalled alerts are taken over (claimed with the digest), listed or not.
  const overdue = open.filter(t => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!) || a.ref - b.ref);
  const dueToday = open.filter(t => t.due === today).sort((a, b) => a.priority.localeCompare(b.priority) || a.ref - b.ref);
  for (const t of overdue) absorb.push({ key: x.keyOf(`overdue:${t._id}:${t.due}`, t), kind: 'overdue', taskId: t._id });
  for (const t of dueToday) absorb.push({ key: x.keyOf(`due_today:${t._id}:${today}`, t), kind: 'due_today', taskId: t._id });
  for (const t of open.filter(t => t.status === 'In Progress' && !t.need)) {
    if (workdaysBetween(dateInTz(t.updatedAt, tz), today) >= ALERT_RULES.stalledWorkdays) absorb.push({ key: x.keyOf(`stalled:${t._id}:${t.updatedAt.toISOString()}`, t), kind: 'stalled', taskId: t._id });
  }

  // 2. Today, top 3, picked by rule: overdue P1/P2, then due today, then Next line 1 of each active project they own.
  const picks: DigestSection['rows'] = [];
  const picked = new Set<string>();
  for (const t of overdue.filter(t => t.priority === 'P1' || t.priority === 'P2')) {
    if (picks.length >= MAX_TODAY) break;
    const days = Math.round((Date.parse(today) - Date.parse(t.due!)) / 86_400_000);
    picks.push({ ref: t.ref, text: t.title, detail: `${plural(days, 'day')} late, ${t.priority}` });
    picked.add(t._id);
  }
  for (const t of dueToday) {
    if (picks.length >= MAX_TODAY) break;
    picks.push({ ref: t.ref, text: t.title, detail: `due today, ${t.priority}` });
    picked.add(t._id);
  }
  if (picks.length < MAX_TODAY) {
    const mine = await c.projects.find({ status: 'active', ownerId: s.userId }, { projection: { name: 1 } }).toArray();
    const next = await unblockedNext(s, mine.map(p => p._id));
    const states = next.size ? await c.states.find({ projectId: { $in: [...next.keys()] } }, { projection: { projectId: 1, updatedAt: 1 } }).toArray() : [];
    const last = new Map(states.map(st => [st.projectId, st.updatedAt.getTime()]));
    // Projects have no priority field: the one touched most recently comes first.
    for (const p of mine.filter(p => next.has(p._id)).sort((a, b) => (last.get(b._id) ?? 0) - (last.get(a._id) ?? 0) || a.name.localeCompare(b.name))) {
      if (picks.length >= MAX_TODAY) break;
      const n = next.get(p._id)!;
      picks.push({ ...(n.firstRef ? { ref: n.firstRef } : {}), text: `${neutralAlertText(p.name)}: ${neutralAlertText(n.first).slice(0, 110)}`, detail: 'Next 1' });
    }
  }
  const lateLeft = overdue.filter(t => !picked.has(t._id)).length;
  if (picks.length) {
    const rows = picks.map(r => ({ ...r }));
    if (lateLeft) rows.push({ text: `+${lateLeft} overdue, on Today` });
    sections.push({ head: '🎯 **Today**', numbered: true, rows });
  }

  // 3. Since the last digest: one line per project they can read with something changed (read from the Activity feed: State lines, tasks done, Needs, messages).
  type Moved = { nextDone: number; nextAdded: number; now: boolean; decisions: number; done: number; asked: number; answered: number; msgs: number };
  const per = new Map<string, Moved>();
  const bump = (pid: string): Moved => {
    let e = per.get(pid);
    if (!e) per.set(pid, (e = { nextDone: 0, nextAdded: 0, now: false, decisions: 0, done: 0, asked: 0, answered: 0, msgs: 0 }));
    return e;
  };
  const nowText = new Map<string, string>();
  // One read of the Activity feed (through the reader's own door): State lines, tasks done, Needs and messages. Newest first.
  const feed = await listActivity(s, { since, types: ['next_done', 'next_added', 'state_now', 'decision', 'completed', 'need_asked', 'need_answered', 'message_sent'], limit: 1000 });
  const sinceIso = since.toISOString();
  const doneTaskIds: string[] = [];
  for (const a of feed) {
    if (a.at <= sinceIso) continue;
    if (a.type === 'completed') {
      if (a.taskId) doneTaskIds.push(a.taskId);
      continue;
    }
    if (!a.projectId) continue;
    const e = bump(a.projectId);
    if (a.type === 'next_done') e.nextDone++;
    else if (a.type === 'next_added') e.nextAdded++;
    else if (a.type === 'state_now') {
      e.now = true;
      if (a.note && !nowText.has(a.projectId)) nowText.set(a.projectId, a.note);
    } else if (a.type === 'decision') e.decisions++;
    else if (a.type === 'need_asked') e.asked++;
    else if (a.type === 'need_answered') e.answered++;
    else if (a.type === 'message_sent') e.msgs++;
  }
  if (doneTaskIds.length) {
    for (const t of await c.tasks.find({ _id: { $in: [...new Set(doneTaskIds)] }, projectId: { $ne: null } }, { projection: { projectId: 1 } }).toArray()) {
      // A task closed twice (reopened) counts once per close: count every completed row.
      bump(t.projectId as string).done += doneTaskIds.filter(id => id === t._id).length;
    }
  }
  const moved = [...per.entries()]
    .filter(([pid]) => projectNames.has(pid))
    .map(([pid, e]) => {
      const bits = [
        e.nextDone && `${plural(e.nextDone, 'Next line')} done`,
        e.nextAdded && `${e.nextAdded} added`,
        e.now && `Now changed${nowText.has(pid) ? `: "${neutralAlertText(nowText.get(pid)!).slice(0, 60)}"` : ''}`,
        e.decisions && plural(e.decisions, 'decision'),
        e.done && `${plural(e.done, 'task')} done`,
        e.asked && `${plural(e.asked, 'Need')} asked`,
        e.answered && `${e.answered} answered`,
        e.msgs && plural(e.msgs, 'message'),
      ].filter(Boolean);
      return { text: neutralAlertText(projectNames.get(pid)!), detail: bits.join(', ') };
    })
    .filter(r => r.detail)
    .sort((a, b) => a.text.localeCompare(b.text));
  if (moved.length) sections.push({ head: '🔄 **Since yesterday**', rows: moved });

  // 4. Agents: working and waiting sessions, stalled ones (idle or off while their project has unblocked Next lines), stops,
  // and projects that could be running and are not. The roster comes through the person's own door.
  const r = await roster(s);
  const nextByProject = await unblockedNext(s, [...new Set(r.workers.flatMap(w => (w.project ? [w.project.id] : [])))]);
  const agents: { rank: number; text: string; detail?: string }[] = [];
  const workerName = (w: (typeof r.workers)[number]) => `${neutralAlertText(w.project?.name ?? 'No project')} · ${neutralAlertText(w.label || w.ai)}${w.model ? ` (${neutralAlertText(w.model)})` : ''}`;
  let running = 0;
  let stalled = 0;
  for (const w of r.workers) {
    const left = w.project ? (nextByProject.get(w.project.id)?.n ?? 0) : 0;
    if (w.state === 'working') {
      running++;
      agents.push({ rank: 0, text: `Running: ${workerName(w)}`, detail: w.machine ? `on ${neutralAlertText(w.machine)}` : undefined });
    } else if (w.state === 'waiting') agents.push({ rank: 1, text: `Waiting on a Need: ${workerName(w)}` });
    else if (left && (w.state === 'idle' || w.state === 'off')) {
      stalled++;
      agents.push({ rank: 2, text: `Stalled: ${workerName(w)}`, detail: `quiet ${quietFor(Date.now() - Date.parse(w.lastSeen))}, ${plural(left, 'Next line')} ready` });
    }
  }
  const stops = await c.alertQueue.find({ kind: 'claude_stopped', createdAt: { $gt: since } }).sort({ createdAt: 1 }).toArray();
  if (stops.length) {
    const byId = new Map((await c.tasks.find({ _id: { $in: stops.map(q => q.taskId) } }, { projection: { ref: 1, title: 1 } }).toArray()).map(t => [t._id, t]));
    for (const q of stops) {
      const t = byId.get(q.taskId);
      if (t) agents.push({ rank: 3, text: `Stopped: #${t.ref} ${neutralAlertText(t.title)}`, detail: q.detail ? neutralAlertText(q.detail) : undefined });
    }
  }
  for (const p of r.couldBeRunning) agents.push({ rank: 4, text: `Could run: ${neutralAlertText(p.projectName)}`, detail: `${plural(p.unblocked, 'Next line')} ready, none running` });
  agents.sort((a, b) => a.rank - b.rank);
  const shown = agents.slice(0, MAX_AGENT_LINES);
  if (shown.length) sections.push({ head: '🤖 **Agents**', rows: shown.map(a => ({ text: a.text, detail: a.detail })) });

  // 5. Mondays, for the organization's owner only: four numbers and up to three proposals (lib/monday.ts). Silence means keep.
  let monday = false;
  if (weekday(today) === 1 && (await (await import('./caller')).roleOf(s.userId, s.orgId)) === 'owner') {
    sections.push(...(await (await import('./monday')).mondayBlock(s, { tz, today })));
    monday = true;
  }

  // The header line, also the inbox body and the push text.
  const summary = [
    dayLabel(today),
    allNeeds.length && `${allNeeds.length} need${allNeeds.length === 1 ? 's' : ''} you`,
    picks.length && `${picks.length} for today`,
    moved.length && `${plural(moved.length, 'project')} moved`,
    (running || stalled) && [running && `${running} running`, stalled && `${stalled} stalled`].filter(Boolean).join(', '),
    monday && 'Monday numbers',
  ].filter(Boolean).join(' · ');
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
        // And when the session that asked has ended or gone off since it was queued (H12), or it never reaches the phone.
        if (!(await reachesPhone(await orgWide(q.orgId), n, Date.now()))) continue;
        const who = neutralAlertText(actorLabel(n.from.actor, q.userId, people));
        const ask = neutralAlertText(shortAsk(n.ask));
        items.push({
          key: q._id,
          kind: 'need',
          ref: n.ref,
          label: `Need #${n.ref}`,
          url: `/today#need-${n.ref}`,
          title: ask,
          detail: `${who}${n.taskRef ? ` · on #${n.taskRef}` : ''}${n.appOnly || n.kind === 'review' ? ' · answer in the app' : ''}`,
          headline: `${who} asks you: ${ask}`,
        });
        continue;
      }
      if (q.kind === 'assigned') {
        // Dropped if they were taken off it again, or it closed or was archived, before it went out.
        if (!t || !assigneesOf(t).includes(q.userId) || CLOSED_STATUSES.includes(t.status) || t.archived) continue;
        const by = neutralAlertText(q.detail ?? '');
        items.push({ key: q._id, kind: 'assigned', ref: t.ref, title: t.title, detail: by ? `by ${by}` : undefined, headline: `#${t.ref} assigned to you${by ? ` by ${by}` : ''}` });
        continue;
      }
      if (q.kind === 'claude_finished' || q.kind === 'claude_stopped') {
        if (!t) continue;
        q.detail = neutralAlertText(q.detail ?? '');
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
    lines.push(`📋 **${plainAlertText(d.digest!.summary)}**`, '');
    for (const sec of d.digest!.sections) {
      lines.push(sec.head);
      sec.rows.forEach((r, n) => lines.push(`${sec.numbered && (r.ref || r.url || !r.text.startsWith('+')) ? `${n + 1}.` : '•'} ${r.url || r.ref ? `[${r.label ?? `#${r.ref}`}](<${baseUrl}${r.url ?? `/tasks/${r.ref}`}>) ` : ''}${plainAlertText(r.text)}${r.detail ? ` · ${plainAlertText(r.detail)}` : ''}`));
      lines.push('');
    }
  }
  for (const s of SECTIONS) {
    const list = items.filter(i => i.kind === s.kind).sort((a, b) => a.ref - b.ref);
    if (!list.length) continue;
    lines.push(s.head);
    for (const i of list) lines.push(`• [${i.label ?? `#${i.ref}`}](<${baseUrl}${i.url ?? `/tasks/${i.ref}`}>) ${plainAlertText(i.title)}${i.detail ? ` · ${plainAlertText(i.detail)}` : ''}`);
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
  // The one Discord DM an alert run still sends: a Need that has waited over a day (reel messages go through lib/owner-alert.ts).
  const needDmError = await dmOldNeeds(s, c0, profile, settings, opts.baseUrl, opts.now ?? new Date());
  if (!due.length) return needDmError ? { ...res, error: needDmError } : res; // claimed queue entries whose task closed meanwhile stay marked, so later flushes skip them

  // Deliver: inbox always; push if enabled. A failing channel doesn't block the others. Other alerts are never sent to Discord.
  const errors: string[] = needDmError ? [needDmError] : [];
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
  }

  // Queue entries and alertLog rows were claimed (marked) before delivery, so there is nothing left to record.
  return { ...res, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

/** A Need waits over a day before its Discord DM (once per Need): the person may have missed the app and the phone. */
const NEED_DM_AFTER_MS = 24 * 3_600_000;
/** ...and only until two days: a Need older than that never gets the DM (switching Discord on must not send a burst of old Needs). */
const NEED_DM_UNTIL_MS = 48 * 3_600_000;

/**
 * The DM for Needs that have waited over a day. Only for a person who linked Discord and has the Discord switch on; one message per
 * Need, never repeated (the Need is marked first, so overlapping runs send once); no buttons: the answer is given in the app. Returns an error text or null.
 */
async function dmOldNeeds(s: Scope, c: Collections, profile: { discordId: string | null }, settings: { channels: { discord?: boolean }; kinds: Record<string, boolean | undefined> }, baseUrl: string, now: Date): Promise<string | null> {
  if (!settings.channels.discord || settings.kinds.need === false || !discordConfig() || !profile.discordId) return null;
  try {
    const old = await c.needs.find({ to: s.userId, status: 'open', discordDmAt: { $exists: false }, createdAt: { $lte: new Date(now.getTime() - NEED_DM_AFTER_MS), $gt: new Date(now.getTime() - NEED_DM_UNTIL_MS) } }).sort({ createdAt: 1 }).limit(5).toArray();
    for (const n of old) {
      const claim = await c.needs.updateOne({ _id: n._id, discordDmAt: { $exists: false } }, { $set: { discordDmAt: now } });
      if (claim.modifiedCount !== 1) continue;
      const label = n.kind === 'review' ? `Review #${n.ref}` : `Need #${n.ref}`;
      await sendDm(profile.discordId, `🙋 Waiting over a day: [${label}](<${baseUrl}/today#need-${n.ref}>) ${plainAlertText(shortAsk(n.ask))}`.slice(0, 1900));
    }
    return null;
  } catch (e) {
    return `discord: ${e instanceof Error ? e.message : String(e)}`;
  }
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
