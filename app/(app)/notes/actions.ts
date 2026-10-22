'use server';

import { revalidatePath } from 'next/cache';
import { deleteNote, NoteConflictError, restoreNote, writeNote } from '@/lib/data/notes';
import { listTasks } from '@/lib/data/tasks';
import { listProjectsBasic } from '@/lib/data/projects';
import { asCaller } from '@/lib/caller';

// Every action requires a signed-in caller (lib/caller.ts); proxy.ts is only the first gate.

const ACTOR = 'me' as const;

function refresh(n: { id: string; taskRef: number | null; projectId: string | null; parentId?: string | null }) {
  revalidatePath('/notes');
  revalidatePath(`/notes/${n.id}`);
  if (n.parentId) revalidatePath(`/notes/${n.parentId}`);
  if (n.taskRef) revalidatePath(`/tasks/${n.taskRef}`);
  if (n.projectId) revalidatePath(`/projects/${n.projectId}`);
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export async function createNoteAction(input: { task?: number; project?: string; title?: string }): Promise<{ id: string } | { error: string }> {
  try {
    const { note } = await asCaller(() => writeNote({ task: input.task, project: input.project, title: input.title || 'Untitled' }, ACTOR));
    refresh(note);
    return { id: note.id };
  } catch (e) {
    return { error: msg(e, 'Could not create the note') };
  }
}

export async function createSubPageAction(parentId: string, title = 'Untitled'): Promise<{ id: string; title: string } | { error: string }> {
  try {
    const { note } = await asCaller(() => writeNote({ parentId, title, linkInParent: false }, ACTOR));
    refresh(note);
    return { id: note.id, title: note.title };
  } catch (e) {
    return { error: msg(e, 'Could not create the page') };
  }
}

export async function saveNoteAction(
  id: string,
  patch: { title?: string; blocks?: unknown[]; archived?: boolean; expectUpdatedAt?: string },
): Promise<{ ok: true; updatedAt: string } | { error: string; conflict?: true }> {
  try {
    const { note } = await asCaller(() => writeNote({ noteId: id, ...patch }, ACTOR));
    if (patch.title !== undefined || patch.archived !== undefined) refresh(note);
    return { ok: true, updatedAt: note.updatedAt };
  } catch (e) {
    if (e instanceof NoteConflictError) return { error: e.message, conflict: true };
    return { error: msg(e, 'Could not save') };
  }
}

export async function deleteNoteAction(id: string): Promise<{ ok: true; parentId: string | null } | { error: string }> {
  try {
    await asCaller(() => deleteNote(id, ACTOR));
    revalidatePath('/notes');
    return { ok: true, parentId: null };
  } catch (e) {
    return { error: msg(e, 'Could not delete') };
  }
}

export async function restoreNoteAction(id: string): Promise<{ ok: true } | { error: string }> {
  try {
    refresh(await asCaller(() => restoreNote(id, ACTOR)));
    return { ok: true };
  } catch (e) {
    return { error: msg(e, 'Could not restore') };
  }
}

export type MentionItem = { kind: 'task' | 'project'; target: string; label: string; hint: string };

/** For the @ menu: open tasks (by ref or title) and active projects. */
export async function searchMentionsAction(query: string): Promise<MentionItem[]> {
  return asCaller(() => searchMentions(query));
}

async function searchMentions(query: string): Promise<MentionItem[]> {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  const [tasks, projects] = await Promise.all([listTasks({ open: true, limit: 400 }), listProjectsBasic()]);
  const t = tasks
    .filter(x => !q || String(x.ref).startsWith(q) || x.title.toLowerCase().includes(q))
    .slice(0, 8)
    .map(x => ({ kind: 'task' as const, target: String(x.ref), label: `#${x.ref} ${x.title}`, hint: x.status }));
  const p = projects
    .filter(x => (x.status === 'active' || x.status === 'paused') && (!q || x.name.toLowerCase().includes(q)))
    .slice(0, 5)
    .map(x => ({ kind: 'project' as const, target: x.id, label: x.name, hint: 'Project' }));
  return [...t, ...p];
}
