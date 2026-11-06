import 'server-only';
import { assignedTo } from '../assignees';
import { scoped, type Scope } from '../scope';
import { OPEN_STATUSES } from '../types';
import type { FeedTask } from '../calendar-ics';

const MAX_EVENTS = 2000;

/**
 * The tasks in the person's calendar feed (docs/calendar.md): open, not archived, with a due and/or start date, assigned
 * to them or owned by them. Read through the door, so the visibility rule applies: nothing private to someone else,
 * nothing from a project shared with a list they are not on. Only the fields the feed shows are read.
 */
export async function feedTasks(s: Scope): Promise<FeedTask[]> {
  const c = await scoped(s);
  const docs = await c.tasks
    .find(
      { archived: false, status: { $in: OPEN_STATUSES }, $and: [{ $or: [{ due: { $ne: null } }, { start: { $ne: null } }] }, { $or: [assignedTo(s.userId), { ownerId: s.userId }] }] },
      { projection: { ref: 1, title: 1, status: 1, priority: 1, due: 1, start: 1, updatedAt: 1 }, sort: { due: 1, ref: 1 }, limit: MAX_EVENTS },
    )
    .toArray();
  return docs.map(d => ({ id: String(d._id), ref: d.ref, title: d.title, status: d.status, priority: d.priority, due: d.due, start: d.start, updatedAt: d.updatedAt }));
}
