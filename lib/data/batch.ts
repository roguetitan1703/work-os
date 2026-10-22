import 'server-only';
import { ZodError } from 'zod';
import { inTransaction } from '../db';
import type { Scope } from '../scope';
import type { Actor, CodeLocation, Task, TaskInput, TaskPatch, Visibility } from '../types';
import { InputError, NotFoundError } from './errors';
import * as tasks from './tasks';
import * as projects from './projects';
import * as notes from './notes';

// Many changes in one atomic call: either every op applies or none does (MongoDB transaction).
// A create can carry `as: "$name"`; later ops may use "$name" anywhere a task is expected,
// including depends_on. dry_run executes everything and rolls back, returning what would happen.

export const MAX_OPS = 100;

type Key = string | number;

export type BatchOp =
  | ({ op: 'create_task'; as?: string; note?: string } & TaskInput)
  | ({ op: 'update_task'; task: Key; note?: string } & TaskPatch)
  | { op: 'log_progress'; task: Key; progress: number; note?: string; status?: TaskPatch['status']; blockedReason?: string }
  | { op: 'complete_task'; task: Key; note?: string }
  | { op: 'add_comment'; task: Key; text: string }
  | { op: 'edit_comment'; comment_id: string; text: string }
  | { op: 'delete_comment'; comment_id: string }
  | { op: 'update_checklist'; task: Key; add?: string[]; check?: Key[]; uncheck?: Key[]; remove?: Key[] }
  | { op: 'archive_task'; task: Key; archived?: boolean }
  | { op: 'delete_task'; task: Key; title: string; reason?: string }
  | { op: 'restore_task'; task: Key }
  | ({ op: 'write_note'; note_id?: string; task?: Key; project?: string; parent_id?: string; block_ops?: notes.BlockOp[] } & Omit<notes.NoteWrite, 'noteId' | 'task' | 'project' | 'parentId' | 'blockOps' | 'blocks'>)
  | { op: 'delete_note'; note_id: string; title: string }
  | { op: 'add_project'; name: string; client?: string; description?: string; status?: 'active' | 'paused' | 'done' | 'archived'; visibility?: Visibility; code?: CodeLocation[] | null }
  | { op: 'update_project'; project: string; name?: string; client?: string; description?: string; status?: 'active' | 'paused' | 'done' | 'archived'; visibility?: Visibility; code?: CodeLocation[] | null };

export type OpResult = { i: number; op: BatchOp['op']; ok: true; ref?: number; title?: string; detail?: string };

export type BatchResult = { dryRun: boolean; applied: boolean; count: number; results: OpResult[]; labels: Record<string, number> };

function errText(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  if (e instanceof Error) return e.message;
  return String(e);
}

export class BatchError extends InputError {
  constructor(
    public index: number,
    public opName: string,
    message: string,
  ) {
    super(`Op ${index + 1} (${opName}) failed: ${message.replace(/\.+$/, '')}. Nothing was changed.`);
  }
}

export async function applyChanges(s: Scope, ops: BatchOp[], actor: Actor, opts: { dryRun?: boolean } = {}): Promise<BatchResult> {
  if (!ops.length) throw new InputError('No operations given');
  if (ops.length > MAX_OPS) throw new InputError(`At most ${MAX_OPS} operations per batch (got ${ops.length})`);

  const run = async (): Promise<BatchResult> => {
    const labels = new Map<string, number>();
    const key = (k: Key): Key => {
      if (typeof k === 'string' && k.startsWith('$')) {
        const ref = labels.get(k);
        if (ref === undefined) throw new InputError(`${k} is not defined by an earlier create_task`);
        return ref;
      }
      return k;
    };
    const keys = (ks?: Key[]) => ks?.map(key);
    const results: OpResult[] = [];
    const done = (i: number, op: BatchOp['op'], t?: Pick<Task, 'ref' | 'title'>, detail?: string) =>
      results.push({ i: i + 1, op, ok: true, ...(t ? { ref: t.ref, title: t.title } : {}), ...(detail ? { detail } : {}) });

    for (const [i, o] of ops.entries()) {
      try {
        switch (o.op) {
          case 'create_task': {
            const { op: _op, as, note, ...input } = o;
            const t = await tasks.createTask(s, { ...input, dependsOn: keys(input.dependsOn) }, actor, { note });
            if (as) {
              if (!as.startsWith('$')) throw new InputError(`"as" must start with $, e.g. "$handover"`);
              if (labels.has(as)) throw new InputError(`${as} is already used`);
              labels.set(as, t.ref);
            }
            done(i, o.op, t, as);
            break;
          }
          case 'update_task': {
            const { op: _op, task, note, ...patch } = o;
            const t = await tasks.updateTask(s, key(task), { ...patch, ...(patch.dependsOn ? { dependsOn: keys(patch.dependsOn) } : {}) }, actor, { note });
            done(i, o.op, t);
            break;
          }
          case 'log_progress': {
            const t = await tasks.logProgress(s, key(o.task), o.progress, o.note, actor, o.status, o.blockedReason);
            done(i, o.op, t, `${t.progress}%`);
            break;
          }
          case 'complete_task': {
            const t = await tasks.completeTask(s, key(o.task), o.note, actor);
            done(i, o.op, t, t.nextRef ? `next occurrence #${t.nextRef}` : undefined);
            break;
          }
          case 'add_comment':
            done(i, o.op, await tasks.addComment(s, key(o.task), o.text, actor));
            break;
          case 'edit_comment': {
            const a = await tasks.editComment(s, o.comment_id, o.text, actor);
            done(i, o.op, { ref: a.taskRef, title: a.taskTitle });
            break;
          }
          case 'delete_comment': {
            const r = await tasks.deleteComment(s, o.comment_id, actor);
            done(i, o.op, undefined, `removed from #${r.taskRef}`);
            break;
          }
          case 'update_checklist':
            done(i, o.op, await tasks.updateChecklist(s, key(o.task), { add: o.add, check: o.check, uncheck: o.uncheck, remove: o.remove }, actor));
            break;
          case 'archive_task':
            done(i, o.op, await tasks.setArchived(s, key(o.task), o.archived ?? true, actor));
            break;
          case 'delete_task': {
            const r = await tasks.trashTask(s, key(o.task), actor, { reason: o.reason, expectTitle: o.title });
            done(i, o.op, r, `in trash for ${tasks.TRASH_DAYS} days`);
            break;
          }
          case 'restore_task':
            done(i, o.op, await tasks.restoreTask(s, key(o.task), actor));
            break;
          case 'write_note': {
            const { op: _op, note_id, task, project, parent_id, block_ops, ...w } = o;
            const r = await notes.writeNote(s, { ...w, noteId: note_id, task: task !== undefined ? key(task) : undefined, project, parentId: parent_id, blockOps: block_ops }, actor);
            done(i, o.op, undefined, `${r.created ? 'created' : 'updated'} note ${r.note.id} "${r.note.title}"`);
            break;
          }
          case 'delete_note': {
            const r = await notes.deleteNote(s, o.note_id, actor, { expectTitle: o.title });
            done(i, o.op, undefined, `deleted note "${r.title}"`);
            break;
          }
          case 'add_project': {
            const r = await projects.createProject(s, { name: o.name, client: o.client, description: o.description, status: o.status, visibility: o.visibility, code: o.code });
            done(i, o.op, undefined, `${r.project.name}${r.created ? '' : ' (already existed)'}`);
            break;
          }
          case 'update_project': {
            const p = await projects.getProject(s, o.project);
            if (!p) throw new NotFoundError(`Project "${o.project}" not found`);
            const { op: _op, project: _p, ...patch } = o;
            const r = await projects.updateProject(s, p.id, patch);
            done(i, o.op, undefined, r.name);
            break;
          }
          default:
            throw new InputError(`Unknown op "${(o as { op: string }).op}"`);
        }
      } catch (e) {
        if (e instanceof BatchError) throw e;
        throw new BatchError(i, o.op, errText(e));
      }
    }
    return { dryRun: !!opts.dryRun, applied: !opts.dryRun, count: results.length, results, labels: Object.fromEntries(labels) };
  };

  return inTransaction(run, { dryRun: opts.dryRun });
}
