import 'server-only';
import webpush from 'web-push';
import { collections, type AlertKind, type NotifyKind } from './db';
import { getUserSetting, scoped, setUserSetting, type Scope } from './scope';

// Where alerts go: in-app inbox (always), phone push (Web Push) and Discord DM, each
// switchable in Settings, plus per-alert-type switches. Also tracks "last seen" times
// for the status panel (Claude connector, Discord commands). Everything here is per person: their settings
// (notify:<userId>), their inbox, their push devices (docs/multi-user.md "Inbox, push, alerts").

export const ALERT_KINDS: { kind: AlertKind; label: string; hint: string }[] = [
  { kind: 'unblocked', label: 'Unblocked', hint: 'The last task it waited on is done' },
  { kind: 'assigned', label: 'Assigned to you', hint: 'Someone assigned a task to you' },
  { kind: 'overdue', label: 'Overdue', hint: 'Morning after, then every 2 days' },
  { kind: 'due_today', label: 'Due today', hint: '09:00' },
  { kind: 'due_tomorrow', label: 'Due tomorrow', hint: '18:00, P1 and P2' },
  { kind: 'never_started', label: 'P1 not started', hint: '24h after it was added' },
  { kind: 'stalled', label: 'Stalled', hint: 'In Progress, untouched 2 workdays' },
  { kind: 'claude_finished', label: 'Claude finished', hint: 'A task you gave to Claude is done' },
  { kind: 'claude_stopped', label: 'Claude stopped', hint: 'Claude stopped on a task without finishing it (blocked, closed or could not start)' },
  { kind: 'claude_stuck', label: 'Claude may be stuck', hint: 'Its session has been quiet for 20 minutes' },
];

/** Every switch under Settings → Notifications: the alert types plus inbox-only notices. */
export const NOTIFY_KINDS: { kind: NotifyKind; label: string; hint: string }[] = [
  ...ALERT_KINDS,
  { kind: 'claude_code_changes', label: 'Claude Code changes', hint: 'Claude Code changed or deleted a task it did not create (inbox)' },
  { kind: 'claude_waiting', label: 'Claude is asking', hint: 'A Claude item is waiting on your decision (inbox)' },
];

export type NotifySettings = {
  channels: { push: boolean; discord: boolean };
  kinds: Record<NotifyKind, boolean>;
};

const DEFAULTS: NotifySettings = {
  channels: { push: true, discord: true },
  kinds: { unblocked: true, assigned: true, overdue: true, due_today: true, due_tomorrow: true, never_started: true, stalled: true, claude_finished: true, claude_stopped: true, claude_stuck: true, claude_code_changes: true, claude_waiting: true },
};

export async function getNotifySettings(s: Scope): Promise<NotifySettings> {
  const saved = (await getUserSetting(s, 'notify'))?.notify;
  return { channels: { ...DEFAULTS.channels, ...saved?.channels }, kinds: { ...DEFAULTS.kinds, ...saved?.kinds } };
}

export async function setNotifySettings(s: Scope, next: NotifySettings): Promise<void> {
  await setUserSetting(s, 'notify', { notify: next, updatedAt: new Date() });
}

// ── In-app inbox ────────────────────────────────────────────────────────────

export type InboxItem = { id: string; kind: NotifyKind | 'test' | 'security'; title: string; body: string; url: string; createdAt: string; read: boolean };

/** s: the recipient. */
export async function addToInbox(s: Scope, items: { kind: NotifyKind | 'test' | 'security'; title: string; body: string; url: string }[]): Promise<void> {
  if (!items.length) return;
  const now = new Date();
  await (await scoped(s)).notifications.insertMany(
    items.map((i, n) => ({ _id: `${now.getTime()}-${n}-${Math.random().toString(36).slice(2, 7)}`, orgId: s.orgId, userId: s.userId, ...i, createdAt: now, readAt: null })),
  );
}

export async function listInbox(s: Scope, limit = 100): Promise<InboxItem[]> {
  const docs = await (await scoped(s)).notifications.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(d => ({ id: d._id, kind: d.kind, title: d.title, body: d.body, url: d.url, createdAt: d.createdAt.toISOString(), read: !!d.readAt }));
}

export async function unreadCount(s: Scope): Promise<number> {
  return (await scoped(s)).notifications.countDocuments({ readAt: null });
}

export async function markAllRead(s: Scope): Promise<void> {
  await (await scoped(s)).notifications.updateMany({ readAt: null }, { $set: { readAt: new Date() } });
}

/** System clean-up for everyone (the alerts cron). */
export async function pruneInbox(): Promise<void> {
  await (await collections()).notifications.deleteMany({ createdAt: { $lt: new Date(Date.now() - 60 * 86_400_000) } }); // scope-ok: system clean-up of old rows in every organization
}

// ── Phone push (Web Push) ───────────────────────────────────────────────────

export function pushConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

let vapidSet = false;
function ensureVapid() {
  if (vapidSet || !pushConfigured()) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  vapidSet = true;
}

export type PushSubJSON = { endpoint: string; keys: { p256dh: string; auth: string } };

/**
 * This browser now pushes to the signed-in person only. The endpoint identifies the browser, so when someone else signs
 * in on it and turns push on, the earlier person's subscription for it is removed (they would otherwise get this
 * person's alerts, or this person theirs).
 */
export async function savePushSubscription(s: Scope, sub: PushSubJSON, device: string): Promise<void> {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid subscription');
  await (await collections()).pushSubs.deleteOne({ _id: sub.endpoint, $or: [{ userId: { $ne: s.userId } }, { orgId: { $ne: s.orgId } }] }); // scope-ok: takeover of this browser's endpoint from whoever used it before
  await (await scoped(s)).pushSubs.updateOne(
    { _id: sub.endpoint },
    { $set: { keys: sub.keys, device: device.slice(0, 120), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}

export async function removePushSubscription(s: Scope, endpoint: string): Promise<void> {
  await (await scoped(s)).pushSubs.deleteOne({ _id: endpoint });
}

export async function pushDeviceCount(s: Scope): Promise<number> {
  return (await scoped(s)).pushSubs.countDocuments();
}

/** Send to the recipient's own devices; drops subscriptions the push service says are gone. Returns devices reached. */
export async function sendPush(s: Scope, msg: { title: string; body: string; url: string; tag?: string }): Promise<{ sent: number; failed: number; error?: string }> {
  if (!pushConfigured()) return { sent: 0, failed: 0, error: 'Push keys not set' };
  ensureVapid();
  const c = await scoped(s);
  const subs = await c.pushSubs.find({}).toArray();
  let sent = 0;
  let failed = 0;
  let error: string | undefined;
  await Promise.all(
    subs.map(async d => {
      try {
        await webpush.sendNotification({ endpoint: d._id, keys: d.keys }, JSON.stringify(msg), { TTL: 6 * 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        failed++;
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await c.pushSubs.deleteOne({ _id: d._id });
        else error = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  return { sent, failed, ...(error ? { error } : {}) };
}

// ── Status: last seen ───────────────────────────────────────────────────────

// "Last seen" is shown to the minute at most: one write per kind per person per minute per process is plenty.
const SEEN_EVERY_MS = 60_000;
const seenAt = new Map<string, number>();

export async function markSeen(s: Scope, what: 'mcp' | 'discord'): Promise<void> {
  const now = Date.now();
  const k = `${what}:${s.orgId}:${s.userId}`;
  if (now - (seenAt.get(k) ?? 0) < SEEN_EVERY_MS) return;
  if (seenAt.size > 1000) seenAt.clear();
  seenAt.set(k, now);
  try {
    await setUserSetting(s, 'status', { [what === 'mcp' ? 'lastMcpAt' : 'lastDiscordAt']: new Date() });
  } catch {
    // status is best-effort
  }
}

export async function lastSeen(s: Scope): Promise<{ mcp: string | null; discord: string | null }> {
  const d = await getUserSetting(s, 'status');
  return { mcp: d?.lastMcpAt?.toISOString() ?? null, discord: d?.lastDiscordAt?.toISOString() ?? null };
}
