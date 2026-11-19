import 'server-only';
import { scoped, type Scope } from '../scope';
import type { ProjectDoc } from '../db';
import { InputError, NotFoundError } from './errors';
import { resolveProject } from './projects';
import { saveState, stateOfProject, type SaveResult } from './states';
import { completeTask, createTask, getTask, logChange } from './tasks';
import { writeNote } from './notes';
import { askNeed, withdrawForDeclutter, type Need } from './needs';
import { getItem, migrateItem } from './claude-items';
import { buildProposal } from './declutter';
import { userActor, type Actor } from '../actors';
import { GROWTH, type DeclutterItem } from '../declutter-core';
import type { NeedWord } from '../db';

// Declutter, apply and ask (docs/flows/agent-system.md section 7, H11). Apply runs as the person who answered (their own door:
// every target is read again through scoped(s) and must belong to the project), never as the asker, so a Yes cannot reach what
// that person cannot read, and a session cannot use it to reach what they cannot. Each item is idempotent: "already gone"
// counts as applied. Nothing is deleted: lines go to the State's archived lines, notes are archived, Claude items are dropped
// with movedTo, Needs are withdrawn, tasks completed.

const DAY = 86_400_000;
export type ApplyResult = { applied: string[]; failed: string[] };

const msg = (e: unknown) => (e instanceof Error ? e.message : 'failed').slice(0, 160);

/**
 * Applies the items to one project as `s` and records it: the State's quiet window (14 days), the Need no longer open on the
 * State, and one feed row. Returns what was applied and what failed ("id: reason").
 */
export async function applyDeclutter(s: Scope, project: ProjectDoc, items: DeclutterItem[], now = new Date()): Promise<ApplyResult> {
  const pid = project._id;
  const actor: Actor = userActor(s.userId);
  const c = await scoped(s);
  const applied: string[] = [];
  const failed: string[] = [];
  const fail = (i: DeclutterItem, e: unknown) => failed.push(`${i.id}: ${msg(e)}`);

  // 1. The State's own items, batched into saveState calls (at most 30 ops each; one version bump per call).
  const state = await stateOfProject(s, pid);
  const hasLine = (id: string | undefined) => !!id && !!state && (state.next.some(l => l.id === id) || state.later.some(l => l.id === id));
  const hasNext = (id: string | undefined) => !!id && !!state && state.next.some(l => l.id === id);
  type Op = Record<string, unknown>;
  const batch: { item: DeclutterItem; op: Op }[] = [];
  for (const i of items) {
    if (i.kind === 'archive_line') {
      if (hasLine(i.target)) batch.push({ item: i, op: { op: 'archive_line', id: i.target, why: 'Declutter' } });
      else applied.push(i.id);
    } else if (i.kind === 'done_next') {
      if (hasNext(i.target)) batch.push({ item: i, op: { op: 'done_next', id: i.target } });
      else applied.push(i.id);
    } else if (i.kind === 'add_later') {
      batch.push({ item: i, op: { op: 'add_later', text: i.text, ...(i.waits ? { waits_on: i.waits } : {}) } });
    }
  }
  for (const chunk of Array.from({ length: Math.ceil(batch.length / 30) }, (_, k) => batch.slice(k * 30, k * 30 + 30))) {
    let r: SaveResult | null = null;
    try {
      r = await saveState(s, pid, chunk.map(b => b.op), { actor, via: 'app' });
    } catch {
      // One bad item must not hold up the rest: do them one by one.
      for (const b of chunk) {
        try {
          await saveState(s, pid, [b.op], { actor, via: 'app' });
          applied.push(b.item.id);
        } catch (e) {
          fail(b.item, e);
        }
      }
      continue;
    }
    if (r.conflict) for (const b of chunk) failed.push(`${b.item.id}: the State changed`);
    else for (const b of chunk) applied.push(b.item.id);
  }

  // 2. Claude items. The line a Later item became is found by its text (newest first); the task by the number createTask returned.
  for (const i of items) {
    if (i.kind !== 'item_to_task' && i.kind !== 'item_to_later') continue;
    try {
      const item = await getItem(s, i.target ?? '');
      if (!item || item.projectId !== pid) throw new NotFoundError('Claude item not found in this project');
      if (!['queued', 'active', 'blocked'].includes(item.state)) {
        applied.push(i.id); // already moved or finished
        continue;
      }
      let movedTo: string;
      if (i.kind === 'item_to_task') {
        const t = await createTask(s, { title: item.title.slice(0, 300), project: pid, priority: 'P3', tags: ['from-claude-item'], description: [item.why, item.doneWhen ? `Done when: ${item.doneWhen}` : ''].filter(Boolean).join('\n\n').slice(0, 20_000) }, actor, { note: `From Claude item C${item.ref}` });
        movedTo = `#${t.ref}`;
      } else {
        await saveState(s, pid, [{ op: 'add_later', text: i.text, ...(i.waits ? { waits_on: i.waits } : {}) }], { actor, via: 'app' });
        const after = await stateOfProject(s, pid);
        const line = [...(after?.later ?? [])].reverse().find(l => l.text === i.text);
        movedTo = line ? `later:${line.id}` : 'later';
      }
      await migrateItem(s, item.id, movedTo);
      applied.push(i.id);
    } catch (e) {
      fail(i, e);
    }
  }

  // 3. Notes (archived), tasks (completed), Needs (withdrawn), tasks the session added.
  for (const i of items) {
    try {
      if (i.kind === 'archive_note') {
        const n = await c.notes.findOne({ _id: i.target ?? '', deletedAt: null }, { projection: { projectId: 1, parentId: 1, archived: 1 } });
        if (!n) throw new NotFoundError('page not found');
        const inProject = n.projectId === pid || (n.parentId ? (await c.notes.findOne({ _id: n.parentId }, { projection: { projectId: 1 } }))?.projectId === pid : false);
        if (!inProject) throw new NotFoundError('page not found in this project');
        if (!n.archived) await writeNote(s, { noteId: i.target, archived: true }, actor);
        applied.push(i.id);
      } else if (i.kind === 'complete_task') {
        const t = await getTask(s, Number(i.target));
        if (!t || t.projectId !== pid) throw new NotFoundError('task not found in this project');
        if (t.status !== 'Done' && t.status !== 'Dropped') await completeTask(s, t.ref, 'Declutter: finished in all but status', actor);
        applied.push(i.id);
      } else if (i.kind === 'withdraw_need') {
        await withdrawForDeclutter(s, pid, Number(i.target));
        applied.push(i.id);
      } else if (i.kind === 'add_task') {
        await createTask(s, { title: i.text.slice(0, 300), project: pid, priority: 'P3', ...(i.text.length > 300 ? { description: i.text } : {}) }, actor, { note: 'Added by a Declutter', authors: { title: userActor(s.userId) } });
        applied.push(i.id);
      }
    } catch (e) {
      fail(i, e);
    }
  }

  await recordApplied(s, project, applied.length, failed.length, now);
  return { applied, failed };
}

/** The project is quiet for 14 days, the Need (if any) is no longer open on the State, and one feed row says what happened. */
async function recordApplied(s: Scope, project: ProjectDoc, applied: number, failed: number, now: Date): Promise<void> {
  const c = await scoped(s);
  const st = await c.states.findOne({ _id: project._id }, { projection: { orgId: 1, ownerId: 1, visibility: 1, sharedWith: 1 } });
  if (!st) return;
  await setQuiet(s, project._id, now);
  if (applied || failed) {
    await logChange(c, st, userActor(s.userId), 'declutter_applied', { subject: { kind: 'state', id: project._id, title: 'State' }, projectId: project._id, note: `${applied} change${applied === 1 ? '' : 's'} applied${failed ? `, ${failed} failed` : ''}`, at: now });
  }
}

/** Quiet for GROWTH.quietDays: nothing says "due" on this project, and the State no longer names an open Need. */
export async function setQuiet(s: Scope, projectId: string, now = new Date()): Promise<void> {
  const c = await scoped(s);
  await c.states.updateOne(
    { _id: projectId },
    { $set: { 'declutter.checkedAt': now, 'declutter.reasons': [], 'declutter.quietUntil': new Date(now.getTime() + GROWTH.quietDays * DAY) }, $unset: { 'declutter.needId': '', 'declutter.needRef': '' } } as never,
  );
}

/**
 * A declutter Need was answered (called by answerNeed after its own transaction). Yes applies the stored items minus what the
 * person unticked, as that person; No applies nothing. Either way the project goes quiet. The result is stored on the Need.
 */
export async function applyAnswer(s: Scope, need: Need, yes: boolean): Promise<Need> {
  const d = need.declutter;
  if (!d) return need;
  const c = await scoped(s);
  const now = new Date();
  const project = await c.projects.findOne({ _id: need.projectId });
  if (!yes || !project) {
    await setQuiet(s, need.projectId, now);
    if (yes && !project) {
      const result = { applied: [], failed: d.items.map(i => `${i.id}: project not found`) };
      await c.needs.updateOne({ _id: need.id }, { $set: { 'declutter.result': result } });
      return { ...need, declutter: { ...d, result } };
    }
    return need;
  }
  const skip = new Set(d.skip ?? []);
  const result = await applyDeclutter(s, project, d.items.filter(i => !skip.has(i.id)), now);
  await c.needs.updateOne({ _id: need.id }, { $set: { 'declutter.result': result } });
  return { ...need, declutter: { ...d, result } };
}

export type AskDeclutterInput = {
  project: string;
  /** Item ids to leave out of the server's proposal. */
  skip?: string[];
  /** Items the session adds: a Later line (with what it waits on) or a task. */
  add?: { later?: string; waits_on?: string; task?: string }[];
  /** Lines for the session to do on disk after a Yes (worktrees, branches, files). The server never acts on them. */
  disk?: string[];
  actor: Actor;
  word: NeedWord;
  session?: string;
  keyId?: string;
  label?: string;
};

/**
 * Files the project's one declutter Need to the project's owner. The proposal is built again as the owner (so it never names
 * what they cannot read), minus `skip`, plus `add`. Refused when another session's declutter Need is open on the project;
 * the same session's replaces it. At most 3 asks per project per hour.
 */
export async function askDeclutter(s: Scope, input: AskDeclutterInput): Promise<{ need: Need; items: number }> {
  const c = await scoped(s);
  const project = await resolveProject(c, s, input.project, { create: false });
  if (!project) throw new NotFoundError(`Project "${input.project.trim().slice(0, 120)}" not found`);
  const now = new Date();

  const open = await c.needs.find({ projectId: project._id, status: 'open', declutter: { $exists: true } }).toArray();
  for (const n of open) {
    const same = (!n.from.keyId || n.from.keyId === input.keyId) && (!n.from.session || n.from.session === input.session);
    if (!same) throw new InputError(`Declutter Need #${n.ref} is open from another session: wait for the answer, or ask the person to withdraw it.`);
  }
  const hourAgo = new Date(now.getTime() - 3_600_000);
  if ((await c.needs.countDocuments({ projectId: project._id, declutter: { $exists: true }, createdAt: { $gt: hourAgo } })) >= GROWTH.asksPerHour) {
    throw new InputError(`That is ${GROWTH.asksPerHour} declutter asks for this project in the last hour. Wait before asking again.`);
  }

  const adds = input.add ?? [];
  const disk = (input.disk ?? []).map(x => x.trim()).filter(Boolean);
  if (adds.length > GROWTH.adds) throw new InputError(`add holds at most ${GROWTH.adds} lines or tasks.`);
  if (disk.length > GROWTH.disk) throw new InputError(`disk holds at most ${GROWTH.disk} lines.`);
  if (disk.some(x => x.length > 300)) throw new InputError('Each disk line is at most 300 characters.');

  // The owner decides, so the proposal is what the owner can read.
  const owner: Scope = { userId: project.ownerId, orgId: s.orgId };
  const proposal = await buildProposal(owner, project, now);
  const skip = new Set(input.skip ?? []);
  const items: DeclutterItem[] = proposal.items.filter(i => !skip.has(i.id));
  adds.forEach((a, k) => {
    const later = a.later?.trim();
    const task = a.task?.trim();
    if (!!later === !!task) throw new InputError(`add[${k}] is either {later, waits_on?} or {task}.`);
    const text = (later ?? task)!;
    if (text.length > 500) throw new InputError(`add[${k}] is over 500 characters.`);
    const waits = a.waits_on?.trim();
    if (waits && waits.length > 200) throw new InputError(`add[${k}].waits_on is over 200 characters.`);
    items.push({ id: `add:${k + 1}`, kind: later ? 'add_later' : 'add_task', text, why: 'added by the session', ...(later && waits ? { waits } : {}) });
  });
  if (!items.length) throw new InputError('Nothing to tidy: there are no changes to propose.');
  if (items.length > GROWTH.items) throw new InputError(`At most ${GROWTH.items} changes in one Need (this has ${items.length}): skip some, or add fewer.`);

  const { need } = await askNeed(s, {
    project: project._id,
    to: project.ownerId,
    kind: 'approve',
    ask: 'Declutter',
    declutter: { items, disk },
    actor: input.actor,
    word: input.word,
    session: input.session,
    keyId: input.keyId,
    label: input.label,
  });
  return { need, items: items.length };
}
