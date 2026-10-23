import 'server-only';
import { asActor, type Actor } from '../actors';
import { scoped, type Scope } from '../scope';

// Who wrote the text Claude reads (docs/dispatcher.md "Whose words count"). Only the person Claude acts for gives it
// instructions; text written by anyone else (a teammate's description, checklist item, comment or note) is information
// about the work, and get_task, read_note and the Give to Claude sheet say so, naming who wrote it.
//
// Tasks keep no per-field author, so it comes from the history: the newest entry that set the title or description,
// the newest that added each checklist item's text, the creator for text never changed since. Notes keep who created
// them and who changed them last (no history of the edits in between).

/** The actor acted for `me`: the person, their Claude or Claude Code, their Discord link; old single-user entries and the system too. */
export function isMine(a: unknown, me: string): boolean {
  const x = asActor(a);
  if (x.kind === 'system') return true;
  if (x.kind === 'discord') return !x.userId || x.userId === me;
  return !x.userId || x.userId === me;
}

export type TaskTextAuthors = {
  title: Actor;
  description: Actor;
  /** Same order as the task's checklist. */
  checklist: Actor[];
};

type Item = { text: string };
type Hist = { actor: unknown; type: string; note?: string; changes?: Record<string, { from: unknown; to: unknown }> };

const itemText = (v: string) => v.replace(/^\[[ x]\] /, '');
const texts = (v: unknown): Set<string> => new Set(Array.isArray(v) ? v.map(x => itemText(String(x))) : []);

/** The author of a task's title, description and each checklist item, from its history. */
export async function taskTextAuthors(s: Scope, t: { _id: string; createdBy: unknown; checklist: Item[] }): Promise<TaskTextAuthors> {
  const c = await scoped(s);
  const hist = (await c.activity
    .find(
      { taskId: t._id, $or: [{ 'changes.title': { $exists: true } }, { 'changes.description': { $exists: true } }, { 'changes.checklist': { $exists: true } }, { type: 'checklist' }] },
      { projection: { actor: 1, type: 1, note: 1, 'changes.title.to': 1, 'changes.description.to': 1, 'changes.checklist': 1 } },
    )
    .sort({ at: -1 })
    .limit(500)
    .toArray()) as Hist[];
  const creator = asActor(t.createdBy);
  const title = hist.find(h => h.changes?.title);
  const description = hist.find(h => h.changes?.description);
  const checklist = t.checklist.map(item => {
    const by = hist.find(h => {
      if (h.type === 'checklist') return (h.note ?? '').includes(`added "${item.text}"`);
      const ch = h.changes?.checklist;
      return !!ch && texts(ch.to).has(item.text) && !texts(ch.from).has(item.text);
    });
    return by ? asActor(by.actor) : creator;
  });
  return { title: title ? asActor(title.actor) : creator, description: description ? asActor(description.actor) : creator, checklist };
}

/** Plain words for the Give to Claude sheet: which parts of the task someone else wrote, and their user ids. */
export async function othersText(s: Scope, t: { _id: string; createdBy: unknown; title: string; description: string; checklist: Item[] }): Promise<{ parts: string[]; userIds: string[] }> {
  const a = await taskTextAuthors(s, t);
  const note = await (await scoped(s)).notes.findOne({ taskId: t._id, deletedAt: null }, { projection: { createdBy: 1, updatedBy: 1, body: 1 } });
  const parts: string[] = [];
  const ids = new Set<string>();
  const add = (part: string, ...by: unknown[]) => {
    const theirs = by.map(asActor).filter(x => !isMine(x, s.userId));
    if (!theirs.length) return;
    parts.push(part);
    for (const x of theirs) if ('userId' in x && x.userId) ids.add(x.userId);
  };
  if (t.title.trim()) add('title', a.title);
  if (t.description.trim()) add('description', a.description);
  if (a.checklist.some(x => !isMine(x, s.userId))) add('checklist', ...a.checklist);
  if (note && note.body.trim()) add('note', note.createdBy, note.updatedBy);
  return { parts, userIds: [...ids] };
}
