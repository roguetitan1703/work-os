import 'server-only';
import { presenceState } from '../data/presence-state';
import type { PresenceState } from '../db';
import { matchesAll, tierOf, type Hit, type KindResult } from './match';
import { join, ms, projectName, result, type Ctx } from './context';

type Row = { _id: string; projectId: string | null; userId: string; label: string; branch?: string; machine: string; machineName?: string; lastSeen: Date; endedAt?: Date; activity?: { state: PresenceState; at: Date; why?: 'prompt'; open?: boolean }; doing?: { taskId: string }; lastResult?: { text: string } };

const WORD: Record<PresenceState, string> = { on: 'On', working: 'Working', waiting: 'Waiting', idle: 'Idle', off: 'Off' };
/** Session rows read (the newest; rows are kept a week). */
const ROWS = 300;

/**
 * Sessions (the agents' presence rows, placed like their project): label, project, branch, machine, the task in hand and
 * the last result line. Live first. The task in hand is read again through the door, so its title shows only to people
 * who can read the task.
 */
export async function searchSessions(ctx: Ctx): Promise<KindResult> {
  const { c, query, s } = ctx;
  const { words } = query;
  if (!words.length) return { hits: [], count: 0 };
  const rows = (await c.presence
    .find({}, { projection: { projectId: 1, userId: 1, label: 1, branch: 1, machine: 1, machineName: 1, lastSeen: 1, endedAt: 1, activity: 1, 'doing.taskId': 1, 'lastResult.text': 1 } })
    .sort({ lastSeen: -1 })
    .limit(ROWS)
    .toArray()) as Row[];
  const doingIds = [...new Set(rows.map(r => r.doing?.taskId).filter((x): x is string => !!x))];
  const tasks = doingIds.length ? ((await c.tasks.find({ _id: { $in: doingIds } }, { projection: { ref: 1, title: 1 } }).toArray()) as { _id: string; ref: number; title: string }[]) : [];
  const taskOf = new Map(tasks.map(t => [t._id, t]));
  const now = Date.now();
  const hits: Hit[] = [];
  for (const r of rows) {
    const task = r.doing ? taskOf.get(r.doing.taskId) : undefined;
    const machine = r.machineName ?? r.machine;
    const project = projectName(ctx, r.projectId);
    const label = r.label || 'Session';
    const mineRow = r.userId === s.userId; // a session's last line is its owner's alone
    if (!matchesAll([label, project, r.branch, machine, task?.title, task ? `#${task.ref}` : null, mineRow ? r.lastResult?.text : null], words)) continue;
    const st = presenceState(r, { now }).state;
    hits.push({
      kind: 'sessions',
      id: r._id,
      title: label,
      meta: join(task && `#${task.ref} ${task.title}`, r.branch, machine),
      snippet: mineRow && r.lastResult?.text ? r.lastResult.text.slice(0, 140) : undefined,
      right: join(project, WORD[st]),
      href: r.projectId ? `/projects/${encodeURIComponent(r.projectId)}` : '/claude',
      tier: tierOf(label, query),
      open: st !== 'off',
      mine: r.userId === s.userId,
      at: ms(r.lastSeen),
    });
  }
  return result(ctx, hits, 0);
}
