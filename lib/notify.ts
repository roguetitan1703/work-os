import 'server-only';
import webpush from 'web-push';
import { collections, type AlertKind, type NotifyKind } from './db';

// Where alerts go: in-app inbox (always), phone push (Web Push) and Discord DM, each
// switchable in Settings, plus per-alert-type switches. Also tracks "last seen" times
// for the status panel (Claude connector, Discord commands).

export const ALERT_KINDS: { kind: AlertKind; label: string; hint: string }[] = [
  { kind: 'unblocked', label: 'Unblocked', hint: 'The last task it waited on is done' },
  { kind: 'overdue', label: 'Overdue', hint: 'Morning after, then every 2 days' },
  { kind: 'due_today', label: 'Due today', hint: '09:00' },
  { kind: 'due_tomorrow', label: 'Due tomorrow', hint: '18:00, P1 and P2' },
  { kind: 'never_started', label: 'P1 not started', hint: '24h after it was added' },
  { kind: 'stalled', label: 'Stalled', hint: 'In Progress, untouched 2 workdays' },
];

/** Every switch under Settings → Notifications: the alert types plus inbox-only notices. */
export const NOTIFY_KINDS: { kind: NotifyKind; label: string; hint: string }[] = [
  ...ALERT_KINDS,
  { kind: 'claude_code_changes', label: 'Claude Code changes', hint: 'Claude Code changed or deleted a task it did not create (inbox)' },
  { kind: 'claude_waiting', label: 'Claude needs you', hint: 'A Claude item is waiting on your decision (inbox)' },
];

export type NotifySettings = {
  channels: { push: boolean; discord: boolean };
  kinds: Record<NotifyKind, boolean>;
};

const DEFAULTS: NotifySettings = {
  channels: { push: true, discord: true },
  kinds: { unblocked: true, overdue: true, due_today: true, due_tomorrow: true, never_started: true, stalled: true, claude_code_changes: true, claude_waiting: true },
};

export async function getNotifySettings(): Promise<NotifySettings> {
  const doc = await (await collections()).settings.findOne({ _id: 'notify' });
  const saved = (doc as unknown as { notify?: Partial<NotifySettings> } | null)?.notify;
  return { channels: { ...DEFAULTS.channels, ...saved?.channels }, kinds: { ...DEFAULTS.kinds, ...saved?.kinds } };
}

export async function setNotifySettings(next: NotifySettings): Promise<void> {
  await (await collections()).settings.updateOne({ _id: 'notify' }, { $set: { notify: next, updatedAt: new Date() } as never }, { upsert: true });
}

// ── In-app inbox ────────────────────────────────────────────────────────────

export type InboxItem = { id: string; kind: NotifyKind | 'test' | 'security'; title: string; body: string; url: string; createdAt: string; read: boolean };

export async function addToInbox(items: { kind: NotifyKind | 'test' | 'security'; title: string; body: string; url: string }[]): Promise<void> {
  if (!items.length) return;
  const now = new Date();
  await (await collections()).notifications.insertMany(
    items.map((i, n) => ({ _id: `${now.getTime()}-${n}-${Math.random().toString(36).slice(2, 7)}`, ...i, createdAt: now, readAt: null })),
  );
}

export async function listInbox(limit = 100): Promise<InboxItem[]> {
  const docs = await (await collections()).notifications.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(d => ({ id: d._id, kind: d.kind, title: d.title, body: d.body, url: d.url, createdAt: d.createdAt.toISOString(), read: !!d.readAt }));
}

export async function unreadCount(): Promise<number> {
  return (await collections()).notifications.countDocuments({ readAt: null });
}

export async function markAllRead(): Promise<void> {
  await (await collections()).notifications.updateMany({ readAt: null }, { $set: { readAt: new Date() } });
}

export async function pruneInbox(): Promise<void> {
  await (await collections()).notifications.deleteMany({ createdAt: { $lt: new Date(Date.now() - 60 * 86_400_000) } });
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

export async function savePushSubscription(sub: PushSubJSON, device: string): Promise<void> {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid subscription');
  await (await collections()).pushSubs.updateOne(
    { _id: sub.endpoint },
    { $set: { keys: sub.keys, device: device.slice(0, 120), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await (await collections()).pushSubs.deleteOne({ _id: endpoint });
}

export async function pushDeviceCount(): Promise<number> {
  return (await collections()).pushSubs.countDocuments();
}

/** Send to every subscribed device; drops subscriptions the push service says are gone. Returns devices reached. */
export async function sendPush(msg: { title: string; body: string; url: string; tag?: string }): Promise<{ sent: number; failed: number; error?: string }> {
  if (!pushConfigured()) return { sent: 0, failed: 0, error: 'Push keys not set' };
  ensureVapid();
  const c = await collections();
  const subs = await c.pushSubs.find({}).toArray();
  let sent = 0;
  let failed = 0;
  let error: string | undefined;
  await Promise.all(
    subs.map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s._id, keys: s.keys }, JSON.stringify(msg), { TTL: 6 * 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        failed++;
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await c.pushSubs.deleteOne({ _id: s._id });
        else error = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  return { sent, failed, ...(error ? { error } : {}) };
}

// ── Status: last seen ───────────────────────────────────────────────────────

export async function markSeen(what: 'mcp' | 'discord'): Promise<void> {
  try {
    await (await collections()).settings.updateOne({ _id: 'status' }, { $set: { [what === 'mcp' ? 'lastMcpAt' : 'lastDiscordAt']: new Date() } as never }, { upsert: true });
  } catch {
    // status is best-effort
  }
}

export async function lastSeen(): Promise<{ mcp: string | null; discord: string | null }> {
  const d = (await (await collections()).settings.findOne({ _id: 'status' })) as unknown as { lastMcpAt?: Date; lastDiscordAt?: Date } | null;
  return { mcp: d?.lastMcpAt?.toISOString() ?? null, discord: d?.lastDiscordAt?.toISOString() ?? null };
}
