'use server';

import { revalidatePath } from 'next/cache';
import { deleteNote, NoteConflictError, purgeNote, restoreNote, writeNote } from '@/lib/data/notes';
import { listTasks } from '@/lib/data/tasks';
import { listProjectsBasic } from '@/lib/data/projects';
import { asCaller } from '@/lib/caller';
import { userActor } from '@/lib/actors';
import type { Scope } from '@/lib/scope';
import { SHELVES, UNTITLED, type Shelf } from '@/lib/notes-shelves';

// Every action requires a signed-in caller (lib/caller.ts); proxy.ts is only the first gate. They act in the caller's
// scope, as the caller (actor kind 'user').

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
    const { note } = await asCaller(c => writeNote(c, { task: input.task, project: input.project, title: input.title || UNTITLED }, userActor(c.userId)));
    refresh(note);
    return { id: note.id };
  } catch (e) {
    return { error: msg(e, 'Could not create the note') };
  }
}

export async function createSubPageAction(parentId: string, title = UNTITLED): Promise<{ id: string; title: string } | { error: string }> {
  try {
    const { note } = await asCaller(c => writeNote(c, { parentId, title, linkInParent: false }, userActor(c.userId)));
    refresh(note);
    return { id: note.id, title: note.title };
  } catch (e) {
    return { error: msg(e, 'Could not create the page') };
  }
}

export async function saveNoteAction(
  id: string,
  patch: { title?: string; blocks?: unknown[]; archived?: boolean; expectUpdatedAt?: string },
): Promise<{ ok: true; updatedAt: string; titleRefused?: { id: string; title: string; kept: string } } | { error: string; conflict?: true }> {
  try {
    // Autosave sends title and blocks together: the blocks save, a title that clashes with a sibling's stays as it was.
    const { note, titleRefused } = await asCaller(c => writeNote(c, { noteId: id, title: patch.title, blocks: patch.blocks, archived: patch.archived, expectUpdatedAt: patch.expectUpdatedAt, titleClash: 'keep' }, userActor(c.userId)));
    if (patch.title !== undefined || patch.archived !== undefined) refresh(note);
    return { ok: true, updatedAt: note.updatedAt, ...(titleRefused ? { titleRefused: { ...titleRefused, kept: note.title } } : {}) };
  } catch (e) {
    if (e instanceof NoteConflictError) return { error: e.message, conflict: true };
    return { error: msg(e, 'Could not save') };
  }
}

/** Moves a project note to a shelf (null puts it back where it belongs by default). */
export async function setShelfAction(id: string, shelf: Shelf | null): Promise<{ ok: true } | { error: string }> {
  if (shelf !== null && !SHELVES.some(x => x.id === shelf)) return { error: 'That is not a shelf' };
  try {
    const { note } = await asCaller(c => writeNote(c, { noteId: id, shelf }, userActor(c.userId)));
    refresh(note);
    return { ok: true };
  } catch (e) {
    return { error: msg(e, 'Could not move the note') };
  }
}

export async function deleteNoteAction(id: string): Promise<{ ok: true; parentId: string | null } | { error: string }> {
  try {
    await asCaller(c => deleteNote(c, id, userActor(c.userId)));
    revalidatePath('/notes');
    return { ok: true, parentId: null };
  } catch (e) {
    return { error: msg(e, 'Could not delete') };
  }
}

export async function restoreNoteAction(id: string): Promise<{ ok: true } | { error: string }> {
  try {
    refresh(await asCaller(c => restoreNote(c, id, userActor(c.userId))));
    return { ok: true };
  } catch (e) {
    return { error: msg(e, 'Could not restore') };
  }
}

/** Delete a note in the trash for good (Review › Trash). */
export async function purgeNoteAction(id: string): Promise<{ ok: true } | { error: string }> {
  try {
    await asCaller(c => purgeNote(c, id, userActor(c.userId)));
    revalidatePath('/review');
    return { ok: true };
  } catch (e) {
    return { error: msg(e, 'Could not delete') };
  }
}

export type MentionItem = { kind: 'task' | 'project'; target: string; label: string; hint: string };

/** For the @ menu: open tasks (by ref or title) and active projects. */
export async function searchMentionsAction(query: string): Promise<MentionItem[]> {
  return asCaller(c => searchMentions(c, query));
}

async function searchMentions(s: Scope, query: string): Promise<MentionItem[]> {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  const [tasks, projects] = await Promise.all([listTasks(s, { open: true, limit: 400 }), listProjectsBasic(s)]);
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
