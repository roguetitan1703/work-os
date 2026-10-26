import 'server-only';
import { listApiKeys } from './api-keys';
import { pushConfigured, pushDeviceCount, lastSeen } from './notify';
import { lastRunStatus } from './alerts';
import { listAuthorizedApps } from './oauth';
import { listDevices } from './devices';
import { listMembers } from './members';
import { getDispatcherSettings } from './data/dispatcher';
import { getProfile } from './profile';
import { orgGuildId } from './discord/client';
import { isOperator } from './operator';
import { getUserSetting, scoped, setUserSetting } from './scope';
import type { Caller } from './caller';

// What the first-run checklist and Claude › Set up read, in one place: is Claude connected, has a computer checked in,
// is the switch on. Everything is read for the caller only (their keys, their apps, their computers, their settings).

/** A computer counts as online when it was heard from in the last two minutes (same rule as the Claude pages). */
export const ONLINE_MS = 2 * 60_000;
export const isOnline = (lastSeenAt: string | null) => !!lastSeenAt && Date.now() - Date.parse(lastSeenAt) < ONLINE_MS;

/** Step 1 of Set up: a signed-in app or a key exists, and one of them has been used at least once. */
export async function claudeConnection(c: Caller): Promise<{ set: boolean; done: boolean; lastUsedAt: string | null }> {
  const [keys, apps, seen] = await Promise.all([listApiKeys(c).catch(() => []), listAuthorizedApps(c).catch(() => []), lastSeen(c).catch(() => ({ mcp: null, discord: null }))]);
  const used = [...keys.map(k => k.lastUsedAt), ...apps.map(a => a.lastUsedAt), seen.mcp].filter((x): x is string => !!x).sort();
  return { set: keys.length + apps.length > 0, done: used.length > 0, lastUsedAt: used.pop() ?? null };
}

export type SetupState = {
  step1: { done: boolean; set: boolean; lastUsedAt: string | null };
  /** Step 2 is done once a computer has checked in. */
  step2: { done: boolean; computers: number; online: number };
  /** Step 3 is done when the switch is on and a computer is online. */
  step3: { done: boolean; enabled: boolean };
};

export async function setupState(c: Caller): Promise<SetupState> {
  const [conn, devices, disp] = await Promise.all([claudeConnection(c), listDevices(c).catch(() => []), getDispatcherSettings(c).catch(() => null)]);
  const online = devices.filter(d => isOnline(d.lastSeenAt)).length;
  const checkedIn = devices.some(d => !!d.lastSeenAt);
  const enabled = !!disp?.enabled;
  return {
    step1: { done: conn.done, set: conn.set, lastUsedAt: conn.lastUsedAt },
    step2: { done: checkedIn, computers: devices.length, online },
    step3: { done: enabled && online > 0, enabled },
  };
}

export type ChecklistRow = {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  optional?: boolean;
  /** Where the button goes; `action: 'quick-add'` opens the quick-add instead. */
  href?: string;
  action?: 'quick-add';
  button: string;
  /** Rows only the owner or the operator sees. */
  group?: 'owner' | 'operator';
};
export type Checklist = { rows: ChecklistRow[]; done: number; total: number; hidden: boolean; complete: boolean };

/** Hidden by the person ("Hide this"); stored with their profile, nothing else reads it. */
async function isHidden(c: Caller): Promise<boolean> {
  return (await getUserSetting(c, 'profile'))?.checklistHidden === true;
}

export async function setChecklistHidden(c: Caller, hidden: boolean): Promise<void> {
  await setUserSetting(c, 'profile', { checklistHidden: hidden });
}

/**
 * The first-run checklist. Each row ticks from real data. Owner rows (Invite your team, Create your first project) show
 * for owners only; server-health rows for the operator only (lib/operator.ts), never for members.
 */
export async function getChecklist(c: Caller): Promise<Checklist> {
  const owner = c.role === 'owner';
  const operator = isOperator(c);
  const col = await scoped(c);
  const [hidden, hasTask, devicesN, profile, guild, setup, members, hasProject, run] = await Promise.all([
    isHidden(c).catch(() => false),
    col.tasks.findOne({ $or: [{ ownerId: c.userId }, { assigneeId: c.userId }] }, { projection: { _id: 1 } }).then(Boolean).catch(() => false),
    pushDeviceCount(c).catch(() => 0),
    getProfile(c).catch(() => null),
    orgGuildId(c.orgId).catch(() => null),
    setupState(c),
    owner ? listMembers(c).catch(() => null) : Promise.resolve(null),
    owner ? col.projects.findOne({}, { projection: { _id: 1 } }).then(Boolean).catch(() => false) : Promise.resolve(false),
    operator ? lastRunStatus(c).catch(() => null) : Promise.resolve(null),
  ]);
  const rows: ChecklistRow[] = [];
  if (owner)
    rows.push(
      { id: 'invite', group: 'owner', label: 'Invite your team', hint: 'Work OS is better with the people you work with.', done: !!members && (members.members.length > 1 || members.invitations.length > 0), href: '/settings?section=team#invite', button: 'Invite' },
      { id: 'project', group: 'owner', label: 'Create your first project', hint: 'A project groups tasks, notes and Claude for one client or product.', done: hasProject, href: '/projects', button: 'New project' },
    );
  rows.push(
    { id: 'task', label: 'Add your first task', hint: 'Press N anywhere, or use the + button.', done: hasTask, action: 'quick-add', button: 'Add a task' },
    { id: 'alerts', label: 'Get alerts on your phone', hint: 'Install the app, allow notifications, send a test.', done: devicesN > 0, href: '/settings?section=notifications', button: 'Set up alerts' },
    { id: 'discord', label: 'Link Discord', optional: true, hint: 'Optional. Commands and alert messages on Discord.', done: !!profile?.discordId, href: guild ? '/settings?section=notifications#discord' : '/settings?section=connections', button: 'Link Discord' },
    { id: 'claude', label: 'Connect Claude', hint: 'So Claude can see and update your tasks.', done: setup.step1.done, href: '/claude?tab=setup', button: 'Connect Claude' },
    { id: 'pc', label: 'Let Claude work on your PC', optional: true, hint: 'Optional. Claude opens a Claude Code window on your PC.', done: setup.step2.done && setup.step3.done, href: '/claude?tab=setup', button: 'Set up' },
  );
  if (operator) {
    const cron = process.env.CRON_SECRET;
    rows.push(
      { id: 'server-push', group: 'operator', label: 'Server: phone push keys', hint: 'Without them no phone gets alerts.', done: pushConfigured(), href: '/settings?section=server', button: 'Open Server' },
      { id: 'server-alerts', group: 'operator', label: 'Server: alert checks running', hint: 'The scheduled job that sends alerts.', done: !!cron && cron.length >= 16 && !!run?.lastRunAt && !run.stale, href: '/settings?section=server', button: 'Open Server' },
    );
  }
  // Owner rows first, then the personal ones, then the operator's server rows.
  const rank = (r: ChecklistRow) => (r.group === 'owner' ? 0 : r.group === 'operator' ? 2 : 1);
  rows.sort((a, b) => rank(a) - rank(b));
  const done = rows.filter(r => r.done).length;
  return { rows, done, total: rows.length, hidden, complete: done === rows.length };
}
