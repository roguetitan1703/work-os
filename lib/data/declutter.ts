import 'server-only';
import { scoped, type Scope } from '../scope';
import type { ProjectDoc, StateDoc } from '../db';
import { titleKey } from '../notes-match';
import { memberNames } from '../people';
import { setDeclutterCache } from './states';
import {
  GROWTH,
  duplicateGroups,
  itemId,
  itemPlan,
  noteItems,
  stateItems,
  type DeclutterItem,
} from '../declutter-core';

// Declutter, the database half (docs/flows/agent-system.md section 7, H11). Every read goes through scoped(s), so a proposal never
// names a line, note, task, Need or item the caller cannot read. The pure rules (thresholds, stale lines, duplicates, where an
// open Claude item goes) are in lib/declutter-core.ts.

const DAY = 86_400_000;

/**
 * The siblings a duplicate title is checked among (H14: top-level notes of one project, or the sub-pages of one parent;
 * archived pages count, trashed ones do not; handovers are exempt). TODO(H14 step 2): call its `sameTitle` sibling query
 * once that has merged, so there is one definition.
 */
async function noteGroups(s: Scope, projectId: string): Promise<{ id: string; title: string; updatedAt: Date; archived: boolean }[][]> {
  const c = await scoped(s);
  const proj = { projection: { title: 1, updatedAt: 1, archived: 1, parentId: 1, handover: 1 } } as const;
  const top = await c.notes.find({ projectId, taskId: null, deletedAt: null, $or: [{ parentId: null }, { parentId: { $exists: false } }] }, proj).toArray();
  const kids = top.length ? await c.notes.find({ parentId: { $in: top.map(n => n._id) }, deletedAt: null }, proj).toArray() : [];
  const pick = (ns: typeof top) => ns.map(n => ({ id: n._id, title: n.title, updatedAt: n.updatedAt, archived: n.archived, exempt: !!n.handover }));
  const groups = duplicateGroups(pick(top), titleKey);
  const byParent = new Map<string, typeof kids>();
  for (const k of kids) byParent.set(k.parentId!, [...(byParent.get(k.parentId!) ?? []), k]);
  for (const list of byParent.values()) groups.push(...duplicateGroups(pick(list), titleKey));
  return groups;
}

/**
 * The once-a-day part of the check: sibling notes with one title, and open Claude items. Stored on the State (no version
 * bump, no log, no feed), so a normal start costs no extra read. Keeps quietUntil and an open Need as they are.
 */
export async function refreshCache(s: Scope, project: ProjectDoc, state: StateDoc | null, now = new Date()): Promise<string[]> {
  if (!state) return [];
  const c = await scoped(s);
  const [groups, open] = await Promise.all([
    noteGroups(s, project._id),
    c.claudeItems.countDocuments({ projectId: project._id, state: { $in: ['queued', 'active', 'blocked'] } }),
  ]);
  const reasons: string[] = [];
  const dup = groups.filter(g => g.some(n => !n.archived)).reduce((n, g) => n + g.length, 0);
  if (dup) reasons.push(`${dup} notes share a title`);
  if (open) reasons.push(`${open} open Claude item${open === 1 ? '' : 's'}`);
  await setDeclutterCache(s, project._id, { ...(state.declutter ?? {}), checkedAt: now, reasons });
  return reasons;
}

/** True when the cached check is older than a day (or missing). */
export const cacheStale = (state: StateDoc | null, now = new Date()) => !!state && (!state.declutter?.checkedAt || now.getTime() - state.declutter.checkedAt.getTime() > DAY);

export type Proposal = {
  items: DeclutterItem[];
  /** For information only; never in the batch unless the session adds its id. */
  fyi: string[];
  counts: { later: number; next: number; notes: number; tasks: number; needs: number; claudeItems: number };
};

/**
 * What Work OS proposes for one project, as the caller (a project the caller cannot read is "not found": the State read
 * returns null). Nothing is written. Items have stable ids (`kind:target`) so `skip` works across calls; at most GROWTH.items.
 */
export async function buildProposal(s: Scope, project: ProjectDoc, now = new Date()): Promise<Proposal> {
  const c = await scoped(s);
  const pid = project._id;
  const state = await c.states.findOne({ _id: pid });
  const items: DeclutterItem[] = [];

  // State lines. A Next line's task is looked up by its ref, only among tasks the caller can read in this project.
  if (state) {
    const refs = [...new Set(state.next.map(l => l.ref).filter((r): r is number => !!r))];
    const closed = new Set<number>();
    if (refs.length) for (const t of await c.tasks.find({ ref: { $in: refs }, projectId: pid, status: { $in: ['Done', 'Dropped'] } }, { projection: { ref: 1 } }).toArray()) closed.add(t.ref);
    items.push(...stateItems(state, now, closed, titleKey));
  }

  // Sibling notes with one title: all but the newest, never one already archived.
  const groups = await noteGroups(s, pid);
  const live = new Set<string>();
  for (const g of groups) for (const n of g) if (!n.archived) live.add(n.id);
  items.push(...noteItems(groups).filter(i => live.has(i.target!)));

  // Tasks that are finished in all but status: 100 % progress, or a parent whose subtasks are all closed. Completed as the answerer.
  const open = await c.tasks
    .find({ projectId: pid, status: { $nin: ['Done', 'Dropped'] }, archived: false, $or: [{ progress: 100 }, { 'subtaskCount.total': { $gt: 0 } }] }, { projection: { ref: 1, title: 1, progress: 1, subtaskCount: 1 } })
    .toArray();
  let tasks = 0;
  for (const t of open) {
    const sc = t.subtaskCount;
    const allClosed = !!sc && sc.total > 0 && sc.done >= sc.total;
    if (t.progress >= 100 || allClosed) {
      tasks++;
      items.push({ id: itemId('task', t.ref), kind: 'complete_task', text: `#${t.ref} ${t.title}`.slice(0, GROWTH.itemText), why: allClosed ? 'all its subtasks are closed' : 'its progress is 100%', target: String(t.ref) });
    }
  }

  // Needs open for 14 days, apart from review and release Needs (those are never old clutter).
  const needs = await c.needs.find({ projectId: pid, status: 'open', kind: { $ne: 'review' }, release: { $ne: true }, createdAt: { $lt: new Date(now.getTime() - GROWTH.staleDays * DAY) } }, { projection: { ref: 1, ask: 1, createdAt: 1 } }).toArray();
  for (const n of needs) items.push({ id: itemId('need', n.ref), kind: 'withdraw_need', text: `#${n.ref} ${n.ask}`.slice(0, GROWTH.itemText), why: `open ${Math.floor((now.getTime() - n.createdAt.getTime()) / DAY)} days`, target: String(n.ref) });

  // Open Claude items move to tasks and Later lines (they retire; see the plan, decision 11).
  const names = await memberNames(s.orgId);
  const cis = await c.claudeItems.find({ projectId: pid, state: { $in: ['queued', 'active', 'blocked'] } }).sort({ order: 1 }).toArray();
  let claudeItems = 0;
  for (const d of cis) {
    const p = itemPlan({ ref: d.ref, title: d.title, why: d.why, doneWhen: d.doneWhen, kind: d.kind, waitingText: d.waitingText, waitingOn: d.waitingOn, state: d.state }, d.waitingOn ? names[d.waitingOn] : undefined);
    if (p) {
      claudeItems++;
      items.push(p);
    }
  }

  // Information only: notes nobody touched for 30 days.
  const old = await c.notes.find({ projectId: pid, taskId: null, deletedAt: null, archived: false, handover: { $exists: false }, updatedAt: { $lt: new Date(now.getTime() - GROWTH.noteDays * DAY) } }, { projection: { title: 1 }, limit: 20 }).toArray();
  const fyi = old.length ? [`${old.length === 20 ? '20 or more' : old.length} page${old.length === 1 ? '' : 's'} untouched for ${GROWTH.noteDays} days (not proposed): ${old.slice(0, 5).map(n => `"${n.title}"`).join(', ')}${old.length > 5 ? ', …' : ''}`] : [];

  return {
    items: items.slice(0, GROWTH.items),
    fyi,
    counts: { later: state?.later.length ?? 0, next: state?.next.length ?? 0, notes: groups.reduce((n, g) => n + g.length, 0), tasks, needs: needs.length, claudeItems },
  };
}
