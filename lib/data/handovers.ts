import 'server-only';
import type { HandoverFields, HandoverMeta, NoteDoc, ProjectDoc } from '../db';
import { readable, scoped, type Scope } from '../scope';
import type { Actor } from '../types';
import { isMember } from '../people';
import { InputError } from './errors';
import { writeNote } from './notes';

// A handover (docs/flows/agent-system.md 5.5, built in H5): the note a session leaves for the next one when it stops
// (end_work). A project note with the `handover` field; one per (project, title, writer), rewritten whole each time. It
// holds only what the State, git and notes do not: the next step, work in flight, what was tried, rules, checks. The
// next start_work for the person it is for shows it first (once, to the first fresh session), and the session that
// picked it up archives it when it ends.

export const HANDOVER_CAPS = { step: 600, item: 300, items: 6, total: 3000, title: 120 } as const;
const LIST_KEYS = ['in_flight', 'tried', 'rules', 'check'] as const;

/** Lower-case with spaces collapsed, to compare a line of the State with the handover text. */
const squash = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Refuses (never cuts) a handover that is too long or that copies the State: 2 or more Next or Later lines (20 or more
 * characters) found inside its text. `lines` are the State's Next and Later texts.
 */
export function checkHandover(f: HandoverFields, lines: string[]): void {
  const all = [f.step, ...LIST_KEYS.flatMap(k => f[k] ?? [])];
  if (f.step.length > HANDOVER_CAPS.step) throw new InputError(`The handover step is at most ${HANDOVER_CAPS.step} characters.`);
  for (const k of LIST_KEYS) {
    const l = f[k] ?? [];
    if (l.length > HANDOVER_CAPS.items) throw new InputError(`${k} takes at most ${HANDOVER_CAPS.items} items.`);
    if (l.some(x => x.length > HANDOVER_CAPS.item)) throw new InputError(`Each ${k} item is at most ${HANDOVER_CAPS.item} characters.`);
  }
  const total = all.reduce((n, x) => n + x.length, 0);
  if (total > HANDOVER_CAPS.total) throw new InputError(`A handover is at most ${HANDOVER_CAPS.total.toLocaleString('en-US')} characters in all (this one has ${total}). Keep only what the State, git and notes do not hold.`);
  const text = squash(all.join(' \n '));
  const copied = [...new Set(lines.map(squash).filter(l => l.length >= 20 && text.includes(l)))];
  if (copied.length >= 2) throw new InputError('That is in the State already: this handover repeats Next or Later lines. Leave them out (the next session reads the State) and keep only what the State, git and notes do not hold.');
}

/** What Work OS adds to the writer's fields: Where, the task it was on, and the Needs it is waiting on. */
export type HandoverAuto = { where?: string[]; task?: string; waiting?: string[] };

export function renderHandover(f: HandoverFields, auto: HandoverAuto = {}): string {
  const list = (h: string, items?: string[]) => (items?.length ? `\n\n## ${h}\n\n${items.map(x => `* ${x}`).join('\n')}` : '');
  return (
    `## Next step\n\n${f.step}` +
    list('Where', auto.where) +
    (auto.task ? `\n\n## Task\n\n${auto.task}` : '') +
    list('Waiting', auto.waiting) +
    list('In flight', f.in_flight) +
    list('Tried', f.tried) +
    list('Rules', f.rules) +
    list('Check', f.check)
  );
}

/** Who a handover is for: 'me' (the writer), 'anyone', or a member who can read the project. Returns a user id or 'anyone'. */
export async function resolveFor(s: Scope, project: Pick<ProjectDoc, 'visibility' | 'ownerId' | 'sharedWith'>, v: string | undefined): Promise<string> {
  const w = (v ?? 'me').trim();
  if (!w || w.toLowerCase() === 'me') return s.userId;
  if (w.toLowerCase() === 'anyone') return 'anyone';
  const { findAssignee } = await import('./tasks');
  const id = await findAssignee(s.orgId, w);
  if (!(await isMember(s.orgId, id)) || !readable(project, id)) throw new InputError('That person cannot see this project, so a handover cannot be left for them. Pick someone who can, or share the project first.');
  return id;
}

export type WriteHandover = { project: ProjectDoc; me: string; label: string; title: string; fields: HandoverFields; auto: HandoverAuto; for: string };

/** Writes (or rewrites whole) the handover of this writer and title; a rewrite clears who picked it up and unarchives it. */
export async function writeHandover(s: Scope, w: WriteHandover, actor: Actor): Promise<{ id: string; title: string; created: boolean }> {
  const c = await scoped(s);
  const title = w.title.trim().slice(0, HANDOVER_CAPS.title) || 'Handover';
  const body = renderHandover(w.fields, w.auto);
  const cur = await c.notes.findOne({ projectId: w.project._id, taskId: null, title, 'handover.by': s.userId, deletedAt: null }, { projection: { _id: 1 } });
  const { note, created } = cur
    ? await writeNote(s, { noteId: cur._id, body, archived: false }, actor)
    : await writeNote(s, { project: w.project._id, title, body, archived: false }, actor);
  const meta: HandoverMeta = { by: s.userId, for: w.for, session: w.me, ...(w.label ? { label: w.label } : {}), fields: w.fields };
  await c.notes.updateOne({ _id: note.id }, { $set: { handover: meta } });
  return { id: note.id, title: note.title, created };
}

export type BriefHandover = { id: string; title: string; label: string; by: string; at: Date; markdown: string; /** Who created and who last edited the note (read before the pick-up line is appended): any text by someone else is labelled for the reader. */ createdBy: Actor; updatedBy: Actor };

/**
 * The handovers a start_work shows (newest first, at most 2 in full, the rest as id and title). `me` is the caller's
 * session key (presence row key). Shown when: not archived; for this caller; not written by this very session; the
 * caller has no `parent`; and nobody has picked it up and the session is fresh, or this same session picked it up
 * (a call after compaction shows it again). Showing it the first time marks it picked up.
 */
export async function handoversForBrief(s: Scope, projectId: string, o: { me: string; label: string; fresh: boolean; parent?: string; actor: Actor }): Promise<{ shown: BriefHandover[]; more: { id: string; title: string }[] }> {
  if (o.parent) return { shown: [], more: [] };
  const c = await scoped(s);
  const docs = await c.notes
    .find({ projectId, taskId: null, deletedAt: null, archived: false, handover: { $exists: true }, 'handover.for': { $in: [s.userId, 'anyone'] } })
    .sort({ updatedAt: -1 })
    .limit(20)
    .toArray();
  const mine = (d: NoteDoc) => d.handover!.by === s.userId && d.handover!.session === o.me;
  const eligible = docs.filter(d => {
    const h = d.handover!;
    if (mine(d)) return false;
    if (h.pickedUp) return h.pickedUp.session === o.me && h.pickedUp.by === s.userId;
    return o.fresh;
  });
  const shown: BriefHandover[] = [];
  for (const d of eligible.slice(0, 2)) {
    const h = d.handover!;
    let body = d.body;
    if (!h.pickedUp) {
      const at = new Date();
      const claimed = await c.notes.updateOne({ _id: d._id, 'handover.pickedUp': { $exists: false } }, { $set: { 'handover.pickedUp': { session: o.me, ...(o.label ? { label: o.label } : {}), at, by: s.userId } } });
      if (!claimed.modifiedCount) continue;
      const line = `Picked up by ${o.label || 'a session'}, ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      body = `${body}\n\n${line}`;
      // The note shows who took it; a failed rewrite must not hide the handover from the session that was handed it.
      await writeNote(s, { noteId: d._id, append: `\n\n${line}` }, o.actor).catch(() => null);
    }
    shown.push({ id: d._id, title: d.title, label: h.label ?? '', by: h.by, at: d.updatedAt, markdown: body, createdBy: d.createdBy, updatedBy: d.updatedBy });
  }
  const more = eligible.slice(2).map(d => ({ id: d._id, title: d.title }));
  return { shown, more };
}

/** Archives every handover this session picked up, except `keepId` (the one it is rewriting). Returns their ids. */
export async function archivePickedUp(s: Scope, projectId: string, me: string, keepId: string | undefined, actor: Actor): Promise<string[]> {
  const c = await scoped(s);
  const docs = await c.notes.find({ projectId, taskId: null, deletedAt: null, archived: false, 'handover.pickedUp.session': me, 'handover.pickedUp.by': s.userId, ...(keepId ? { _id: { $ne: keepId } } : {}) }, { projection: { _id: 1 } }).limit(10).toArray();
  const out: string[] = [];
  for (const d of docs) {
    await writeNote(s, { noteId: d._id, archived: true }, actor);
    out.push(d._id);
  }
  return out;
}

/** Open Needs this session asked on the project (what end_work lists as left over; it withdraws none). */
export async function openNeedsOf(s: Scope, projectId: string, row: { session?: string; agent: string }): Promise<{ ref: number; to: string; kind: string; ask: string }[]> {
  const q = { status: 'open' as const, projectId, 'from.actor.userId': s.userId, ...(row.session ? { 'from.session': row.session } : { 'from.session': { $exists: false }, 'from.actor.agent': row.agent }) };
  const docs = await (await scoped(s)).needs.find(q as never, { projection: { ref: 1, to: 1, kind: 1, ask: 1 } }).sort({ createdAt: 1 }).limit(10).toArray();
  return docs.map(d => ({ ref: d.ref, to: d.to, kind: d.kind, ask: d.ask }));
}

/** The feed row of an ended session: the friction line (and the handover id) on the project's State. */
export async function logSessionEnded(s: Scope, project: ProjectDoc, actor: Actor, friction: string, handoverId?: string): Promise<void> {
  const { logChange } = await import('./tasks');
  await logChange(await scoped(s), project, actor, 'session_ended', { subject: { kind: 'state', id: project._id, title: 'State' }, projectId: project._id, note: `${friction}${handoverId ? ` · handover ${handoverId}` : ''}` });
}
