'use server';

import { revalidatePath } from 'next/cache';
import { z, ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller, type Caller } from '@/lib/caller';
import { InputError, NotFoundError } from '@/lib/data/errors';
import { dismissReopen, jobOutcome, linkFolder, openSessionInVscode, projectLauncher, relinkFolder, reopenAll, removeSession, resumeSession, searchFolders, startSession, stopSession, unhideSession, unlinkFolder, type FolderView } from '@/lib/data/launcher';
import { listProjectsNav } from '@/lib/data/projects';
import { startProjects, type StartProject } from '@/lib/data/claude-overview';

type R<T> = { ok: true; data: T } | { ok: false; error: string };

// Session launcher actions (docs/launcher.md). Each requires a signed-in caller (lib/caller.ts): Start creates a
// job that opens Claude Code on a computer.
async function run<T>(projectId: string | null, fn: (c: Caller) => Promise<T>): Promise<R<T>> {
  try {
    const caller = await requireCaller();
    const data = await withCaller(caller, () => fn(caller));
    if (projectId) revalidatePath(`/projects/${projectId}`);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => i.message).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError || err instanceof SafeError) return { ok: false, error: err.message };
    console.error('[launcher action]', err);
    return { ok: false, error: 'Something went wrong' };
  }
}

const Id = z.string().min(1).max(120);
const Uuid = z.string().uuid();

export async function searchFoldersAction(deviceId: string, q: string): Promise<R<FolderView[]>> {
  return run(null, c => searchFolders(c, Id.parse(deviceId), z.string().max(60).parse(q ?? '')));
}

export async function linkFolderAction(projectId: string, key: string): Promise<R<null>> {
  return run(projectId, async c => {
    await linkFolder(c, Id.parse(projectId), Id.parse(key));
    return null;
  });
}

export async function unlinkFolderAction(projectId: string, key: string): Promise<R<null>> {
  return run(projectId, async c => {
    await unlinkFolder(c, Id.parse(projectId), Id.parse(key));
    return null;
  });
}

/** One computer's folders (searchable) and the projects they can be linked to, for the computer page's picker. */
export async function folderPickerAction(deviceId: string, q: string): Promise<R<{ folders: FolderView[]; projects: { id: string; name: string }[] }>> {
  return run(null, async c => ({
    folders: await searchFolders(c, Id.parse(deviceId), z.string().max(60).parse(q ?? '')),
    projects: (await listProjectsNav(c)).filter(p => p.status !== 'archived').map(p => ({ id: p.id, name: p.name })),
  }));
}

/** The computer page's "Link to project": move one of the caller's folders to a project, or off (projectId null). */
export async function relinkFolderAction(key: string, projectId: string | null): Promise<R<null>> {
  return run(projectId, async c => {
    await relinkFolder(c, Id.parse(key), projectId === null ? null : Id.parse(projectId));
    return null;
  });
}

export async function startSessionAction(projectId: string, key: string, prompt: string): Promise<R<string>> {
  return run(projectId, c => startSession(c, Id.parse(projectId), Id.parse(key), z.string().max(4000).parse(prompt ?? '')));
}

export async function resumeSessionAction(projectId: string, sessionId: string): Promise<R<null>> {
  return run(projectId, async c => {
    await resumeSession(c, Id.parse(projectId), Uuid.parse(sessionId));
    return null;
  });
}

/**
 * Open a session in VS Code on its computer (the Claude Code extension shows it). Returns the job id; jobOutcomeAction says
 * how it went. The computer's worker finds the folder itself and applies the checks a resume makes.
 */
export async function openInVscodeAction(deviceId: string, sessionId: string): Promise<R<string>> {
  return run(null, c => openSessionInVscode(c, Id.parse(deviceId), Uuid.parse(sessionId)));
}

/** "Reopen all": the computer's worker reopens the sessions it remembers were open before it restarted. */
export async function reopenAllAction(deviceId: string): Promise<R<string>> {
  return run(null, async c => {
    const id = await reopenAll(c, Id.parse(deviceId));
    revalidatePath('/claude');
    return id;
  });
}

export async function dismissReopenAction(deviceId: string): Promise<R<null>> {
  return run(null, async c => {
    await dismissReopen(c, Id.parse(deviceId));
    revalidatePath('/claude');
    return null;
  });
}

/** Has a job finished, and how? (For the toast after Open in VS Code and Reopen all.) */
export async function jobOutcomeAction(jobId: string): Promise<R<{ done: boolean; ok?: boolean; error?: string }>> {
  return run(null, c => jobOutcome(c, Id.parse(jobId)));
}

export async function stopSessionAction(projectId: string, sessionId: string): Promise<R<null>> {
  return run(projectId, async c => {
    await stopSession(c, Id.parse(projectId), Uuid.parse(sessionId));
    return null;
  });
}

export async function removeSessionAction(projectId: string, sessionId: string): Promise<R<null>> {
  return run(projectId, async c => {
    await removeSession(c, Id.parse(projectId), Uuid.parse(sessionId));
    return null;
  });
}

export async function unhideSessionAction(projectId: string, sessionId: string): Promise<R<null>> {
  return run(projectId, async c => {
    await unhideSession(c, Id.parse(projectId), Uuid.parse(sessionId));
    return null;
  });
}

// ── Start Claude flow (components/start-claude.tsx) ─────────────────────────

export async function startProjectsAction(): Promise<R<StartProject[]>> {
  return run(null, c => startProjects(c));
}

/** Linked folders, same-repo suggestions and computers for one project. */
export async function startOptionsAction(projectId: string): Promise<R<{ folders: FolderView[]; suggestions: FolderView[]; devices: { id: string; name: string }[] }>> {
  return run(null, async c => {
    const { folders, suggestions, devices } = await projectLauncher(c, Id.parse(projectId));
    return { folders: folders.filter(f => !f.missing), suggestions, devices };
  });
}

/** "Link and start": link the folder to the project, then start a session in it. */
export async function linkAndStartAction(projectId: string, key: string, prompt: string): Promise<R<string>> {
  return run(projectId, async c => {
    const text = z.string().max(4000).parse(prompt ?? '');
    await linkFolder(c, Id.parse(projectId), Id.parse(key));
    return startSession(c, Id.parse(projectId), Id.parse(key), text);
  });
}
