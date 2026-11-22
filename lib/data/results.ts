import 'server-only';
import { inTransaction } from '../db';
import { scoped, type Scope } from '../scope';
import type { Actor } from '../actors';
import { RATINGS, type HandInResult, type Rating, type ResultKind, type Task } from '../types';
import { InputError, NotFoundError } from './errors';
import { getTask, updateTask } from './tasks';

// Results and review (docs/archive/plan-1-3.md slice 5, flows R1 and R2). hand_in is how an agent says what it did: Work OS
// keeps links and lines, never files. The gate that sends code, data and client work to review sits in updateTask
// (lib/data/tasks.ts), so it holds for every path to Done, not only this one.

export const HAND_IN_LIMITS = { changed: 2000, checked: 1000, where: 10, url: 500, label: 100, left: 20, leftLine: 300 } as const;

export type HandInInput = {
  changed: string;
  checked?: string;
  rating?: Rating | null;
  where?: { url: string; label?: string }[];
  left?: string[];
  kind?: ResultKind;
};

export function cleanHandIn(i: HandInInput): HandInResult {
  const changed = (i.changed ?? '').trim();
  if (!changed) throw new InputError('Say what changed.');
  if (changed.length > HAND_IN_LIMITS.changed) throw new InputError(`"changed" is at most ${HAND_IN_LIMITS.changed} characters.`);
  const checked = (i.checked ?? '').trim();
  if (checked.length > HAND_IN_LIMITS.checked) throw new InputError(`"checked" is at most ${HAND_IN_LIMITS.checked} characters.`);
  if (i.rating != null && !RATINGS.includes(i.rating)) throw new InputError(`"rating" is one of: ${RATINGS.join(', ')}.`);
  const where = (i.where ?? []).map(w => {
    const url = (w.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > HAND_IN_LIMITS.url) throw new InputError('Each "where" link is an http(s) address (a PR, a preview, a note, Delpat OS).');
    const label = w.label?.trim().slice(0, HAND_IN_LIMITS.label);
    return { url, ...(label ? { label } : {}) };
  });
  if (where.length > HAND_IN_LIMITS.where) throw new InputError(`At most ${HAND_IN_LIMITS.where} links in "where".`);
  const left = (i.left ?? []).map(l => l.trim()).filter(Boolean);
  if (left.length > HAND_IN_LIMITS.left) throw new InputError(`At most ${HAND_IN_LIMITS.left} lines in "left".`);
  if (left.some(l => l.length > HAND_IN_LIMITS.leftLine)) throw new InputError(`Each "left" line is at most ${HAND_IN_LIMITS.leftLine} characters.`);
  return { changed, checked, rating: i.rating ?? null, where, left };
}

/**
 * Hands a task in: stores the result on the task, sets its kind when one is given, and closes it. Closing goes through
 * updateTask, so an agent's hand_in of code, data or client work lands as a review Need to the owner and the task stays
 * open; check and report work finishes, and so does a person's. Returns the task and whether it closed.
 */
export async function handIn(s: Scope, key: string | number, input: HandInInput, actor: Actor): Promise<{ task: Task; closed: boolean }> {
  const result = cleanHandIn(input);
  return inTransaction(async () => {
    const cur = await getTask(s, key);
    if (!cur) throw new NotFoundError(`Task ${typeof key === 'number' ? '#' + key : key} not found`);
    if (cur.status === 'Done') throw new InputError(`#${cur.ref} is already Done.`);
    if (cur.status === 'Dropped' || cur.archived) throw new InputError(`#${cur.ref} is ${cur.archived ? 'archived' : 'dropped'}: reopen it first.`);
    const c = await scoped(s);
    await c.tasks.updateOne({ _id: cur.id }, { $set: { handIn: { ...result, at: new Date(), by: actor } } });
    const t = await updateTask(s, cur.id, { status: 'Done', ...(input.kind ? { resultKind: input.kind } : {}) }, actor, { note: result.changed.slice(0, 500) });
    return { task: t, closed: t.status === 'Done' };
  });
}
