import 'server-only';
import { asActor, type TextAuthor } from '../actors';
import type { Document } from 'mongodb';
import type { ChecklistItem, Link, TaskSource } from '../types';
import { scoped, type Scope } from '../scope';

// Who wrote the text Claude reads (docs/dispatcher.md "Whose words count"). Only the person Claude acts for gives it
// instructions; text written by anyone else (a teammate's description, checklist item, link, blocked reason, comment or
// note, or a Discord message turned into a task) is information about the work, and get_task, read_note and the Give
// to Claude sheet say so, naming who wrote it.
//
// Tasks store the author with the text (lib/data/tasks.ts, on every write): titleBy, descriptionBy, blockedReasonBy,
// tagsBy, and `by` on each checklist item and link. Tasks from before that have none: each field's author is then the
// newest history entry that set that exact field (one query for the task; per-field targeted queries when a flood
// makes it too long, so nothing is pushed out of sight). If there is none, the creator wrote it, unless anyone other than the reader is in the task's history: then
// it is "author unknown", never the reader. Notes keep who created them and who changed them last.

/** True when the reader (`me`) wrote it: they, their Claude, their Discord link, or the system. */
export function isMine(a: unknown, me: string): boolean {
  if (a && typeof a === 'object' && 'kind' in a && (a.kind === 'discord-author' || a.kind === 'unknown')) return false;
  const x = asActor(a);
  if (x.kind === 'system') return true;
  return !('userId' in x) || !x.userId || x.userId === me;
}

export const UNKNOWN: TextAuthor = { kind: 'unknown' };

/** A name someone else chose, as it goes into a label: control and format characters out, quotes made single, 40 characters at most. */
export function cleanName(name: string): string {
  return [...name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/"/g, "'").replace(/\s+/g, ' ').trim()].slice(0, 40).join('');
}

const special = (a: unknown): { kind: 'unknown' } | { kind: 'discord-author'; name: string } | null =>
  a && typeof a === 'object' && 'kind' in a && (a.kind === 'unknown' || a.kind === 'discord-author') ? (a as { kind: 'unknown' } | { kind: 'discord-author'; name: string }) : null;

/** How Claude sees an author who is not the reader: `a teammate named "Bea"`, `Discord user "x"`, `author unknown`. */
export function authorLabel(a: unknown, people: Record<string, string>): string {
  const sp = special(a);
  if (sp?.kind === 'unknown') return 'author unknown';
  if (sp?.kind === 'discord-author') return `Discord user "${cleanName(String(sp.name ?? '')) || 'unknown'}"`;
  const x = asActor(a);
  const teammate = (id: string) => {
    const n = people[id];
    if (n === undefined) return 'a former member';
    const c = cleanName(n);
    return c ? `a teammate named "${c}"` : 'a teammate with no name';
  };
  switch (x.kind) {
    case 'user':
      return teammate(x.userId);
    case 'agent':
      return `${x.agent === 'claude' ? 'Claude' : 'Claude Code'} acting for ${teammate(x.userId)}`;
    case 'discord':
      return x.userId ? `${teammate(x.userId)} (through Discord)` : 'Discord';
    default:
      return 'Work OS';
  }
}

/** The short name the Give to Claude sheet shows the giver: "Bea", "Discord user x", "someone (unknown)". */
export function authorName(a: unknown, people: Record<string, string>): string {
  const sp = special(a);
  if (sp?.kind === 'unknown') return 'someone (unknown)';
  if (sp?.kind === 'discord-author') return `Discord user ${cleanName(String(sp.name ?? '')) || 'unknown'}`;
  const x = asActor(a);
  const id = 'userId' in x ? x.userId : undefined;
  if (!id) return 'Discord';
  return people[id] !== undefined ? cleanName(people[id]) || 'a teammate' : 'a former member';
}

export type TaskAuthors = {
  title: TextAuthor;
  description: TextAuthor;
  blockedReason: TextAuthor;
  tags: TextAuthor;
  /** Same order as the task's checklist. */
  checklist: TextAuthor[];
  /** Same order as the task's links. */
  links: TextAuthor[];
};

/** The parts of a task (stored or as the app sees it) that authors are worked out for. */
export type TaskText = {
  createdBy: unknown;
  title: string;
  description?: string;
  blockedReason?: string;
  tags?: string[];
  checklist: ChecklistItem[];
  links?: Link[];
  source?: TaskSource;
  titleBy?: TextAuthor;
  descriptionBy?: TextAuthor;
  blockedReasonBy?: TextAuthor;
  tagsBy?: TextAuthor;
} & ({ _id: string } | { id: string });

const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const itemText = (v: unknown) => String(v).replace(/^\[[ x]\] /, '');
const listHas = (list: unknown, v: string, strip = false) => Array.isArray(list) && list.some(x => (strip ? itemText(x) : x) === v);

/** The author of each piece of a task's text: stored with it, else from the history (see the top of this file). */
export async function taskAuthors(s: Scope, t: TaskText): Promise<TaskAuthors> {
  const taskId = '_id' in t ? t._id : t.id;
  const creator = asActor(t.createdBy) as TextAuthor;
  const links = t.links ?? [];
  const legacy =
    !t.titleBy ||
    (!t.descriptionBy && !!t.description?.trim()) ||
    (!t.blockedReasonBy && !!t.blockedReason?.trim()) ||
    (!t.tagsBy && !!t.tags?.length) ||
    t.checklist.some(i => !i.by) ||
    links.some(l => !l.by);
  if (!legacy) {
    return {
      title: t.titleBy!,
      description: t.descriptionBy ?? creator,
      blockedReason: t.blockedReasonBy ?? creator,
      tags: t.tagsBy ?? creator,
      checklist: t.checklist.map(i => i.by!),
      links: links.map(l => l.by!),
    };
  }
  const c = await scoped(s);
  const fromDiscord: TextAuthor | null = t.source?.kind === 'discord' ? { kind: 'discord-author', name: t.source.author ?? '' } : null;
  const itemConds = (text: string) => [{ type: 'checklist', note: { $regex: `(^|; )added "${esc(text)}"(;|$)` } }, { 'changes.checklist.to': { $in: [`[ ] ${text}`, `[x] ${text}`] } }];
  const linkCond = (key: string) => ({ 'changes.links.to': key });
  const foreign = { 'actor.userId': { $exists: true, $nin: [s.userId, ''] } };
  const fieldCond = (f: string) => ({ [`changes.${f}`]: { $exists: true } });
  // One query for the whole task: every entry that set one of these fields, added one of these items or links, or was
  // made by someone other than the reader. Only when a task has more such entries than the limit (a flood) does each
  // field get its own targeted query, so nothing is ever cut off.
  type H = { actor: unknown; type: string; note?: string; changes?: Record<string, { from?: unknown; to?: unknown }> };
  const LIMIT = 300;
  const ors: Document[] = [fieldCond('title'), fieldCond('description'), fieldCond('blockedReason'), fieldCond('tags'), foreign];
  for (const i of t.checklist) if (!i.by) ors.push(...itemConds(i.text));
  for (const l of links) if (!l.by) ors.push(linkCond(l.label || l.url));
  const proj = { actor: 1, type: 1, note: 1, 'changes.title': 1, 'changes.description': 1, 'changes.blockedReason.to': 1, 'changes.tags': 1, 'changes.checklist': 1, 'changes.links': 1 };
  const rows = (await c.activity.find({ taskId, $or: ors }, { projection: proj }).sort({ at: -1 }).limit(LIMIT).toArray()) as unknown as H[];
  const complete = rows.length < LIMIT;
  const isForeign = (h: H) => {
    const a = asActor(h.actor);
    return 'userId' in a && !!a.userId && a.userId !== s.userId;
  };
  const pick = async (inRows: (h: H) => boolean, query: Document): Promise<H | null> =>
    complete ? (rows.find(inRows) ?? null) : ((await c.activity.find({ taskId, ...query }, { projection: proj }).sort({ at: -1 }).limit(20).toArray()) as unknown as H[]).find(inRows) ?? null;
  let others: Promise<boolean> | null = null;
  // Nothing in the history set it: a Discord message's author (title and description of a task made from one), else
  // the creator, unless someone other than the reader shows up in the history.
  const fallback = async (discord = false): Promise<TextAuthor> => {
    if (discord && fromDiscord) return fromDiscord;
    others ??= complete ? Promise.resolve(rows.some(isForeign)) : c.activity.findOne({ taskId, ...foreign }, { projection: { _id: 1 } }).then(x => !!x);
    return (await others) ? UNKNOWN : creator;
  };
  // The newest entry that changed this field; its author counts only if it set the value the task has now.
  const newest = async (field: string, now?: (to: unknown) => boolean): Promise<TextAuthor | null> => {
    const h = await pick(x => !!x.changes?.[field], fieldCond(field));
    if (!h) return null;
    return !now || now(h.changes?.[field]?.to) ? (asActor(h.actor) as TextAuthor) : null;
  };
  const title = t.titleBy ?? (await newest('title')) ?? (await fallback(true));
  const description = t.descriptionBy ?? (t.description?.trim() ? ((await newest('description')) ?? (await fallback(true))) : creator);
  const blockedReason = t.blockedReasonBy ?? (t.blockedReason?.trim() ? ((await newest('blockedReason', to => to === t.blockedReason)) ?? (await fallback())) : creator);
  const tags = t.tagsBy ?? (t.tags?.length ? ((await newest('tags')) ?? (await fallback())) : creator);
  const checklist: TextAuthor[] = [];
  for (const i of t.checklist) {
    if (i.by) {
      checklist.push(i.by);
      continue;
    }
    // The newest entry that added this exact text: a checklist op (`added "x"`) or an edit whose list gained it.
    const added = new RegExp(`(^|; )added "${esc(i.text)}"(;|$)`);
    const h = await pick(
      x => (x.type === 'checklist' && added.test(x.note ?? '')) || (listHas(x.changes?.checklist?.to, i.text, true) && !listHas(x.changes?.checklist?.from, i.text, true)),
      { $or: itemConds(i.text) },
    );
    checklist.push(h ? (asActor(h.actor) as TextAuthor) : await fallback());
  }
  const linkAuthors: TextAuthor[] = [];
  for (const l of links) {
    if (l.by) {
      linkAuthors.push(l.by);
      continue;
    }
    // History keeps a link as its label, or its address when it has none.
    const key = l.label || l.url;
    const h = await pick(x => listHas(x.changes?.links?.to, key) && !listHas(x.changes?.links?.from, key), linkCond(key));
    linkAuthors.push(h ? (asActor(h.actor) as TextAuthor) : await fallback());
  }
  return { title, description, blockedReason, tags, checklist, links: linkAuthors };
}

/**
 * For the Give to Claude sheet: which parts of the task someone other than the giver wrote (title, description,
 * checklist, blocked reason, links, tags, note, comments; a Discord message's text counts), and their names.
 */
export async function othersText(s: Scope, t: TaskText & { _id: string }, people: Record<string, string>): Promise<{ parts: string[]; names: string[] }> {
  const a = await taskAuthors(s, t);
  const c = await scoped(s);
  const [note, comments] = await Promise.all([
    c.notes.findOne({ taskId: t._id, deletedAt: null }, { projection: { createdBy: 1, updatedBy: 1, body: 1 } }),
    c.activity.find({ taskId: t._id, type: 'comment', 'actor.userId': { $exists: true, $nin: [s.userId, ''] } }, { projection: { actor: 1 } }).limit(50).toArray(),
  ]);
  const parts: string[] = [];
  const names = new Set<string>();
  const add = (part: string, by: unknown[]) => {
    const theirs = by.filter(x => !isMine(x, s.userId));
    if (!theirs.length) return;
    parts.push(part);
    for (const x of theirs) names.add(authorName(x, people));
  };
  if (t.title.trim()) add('title', [a.title]);
  if (t.description?.trim()) add('description', [a.description]);
  add('checklist', a.checklist);
  if (t.blockedReason?.trim()) add('blocked reason', [a.blockedReason]);
  add('links', a.links);
  if (t.tags?.length) add('tags', [a.tags]);
  if (note && note.body.trim()) add('note', [note.createdBy, note.updatedBy]);
  add('comments', comments.map(x => x.actor));
  return { parts, names: [...names] };
}
