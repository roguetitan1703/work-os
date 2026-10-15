'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z, ZodError } from 'zod';
import { SESSION_COOKIE, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { InputError, NotFoundError } from '@/lib/data/errors';
import { linkFolder, resumeSession, searchFolders, startSession, stopSession, unlinkFolder, type FolderView } from '@/lib/data/launcher';

type R<T> = { ok: true; data: T } | { ok: false; error: string };

// Session launcher actions (docs/launcher.md). Each re-checks the session cookie: Start creates a
// job that opens Claude Code on a computer.
async function run<T>(projectId: string | null, fn: () => Promise<T>): Promise<R<T>> {
  try {
    if (!uiAuthDisabled() && !(await verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value))) throw new InputError('Not signed in');
    const data = await fn();
    if (projectId) revalidatePath(`/projects/${projectId}`);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => i.message).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error('[launcher action]', err);
    return { ok: false, error: 'Something went wrong' };
  }
}

const Id = z.string().min(1).max(120);
const Uuid = z.string().uuid();

export async function searchFoldersAction(deviceId: string, q: string): Promise<R<FolderView[]>> {
  return run(null, () => searchFolders(Id.parse(deviceId), z.string().max(60).parse(q ?? '')));
}

export async function linkFolderAction(projectId: string, key: string): Promise<R<null>> {
  return run(projectId, async () => {
    await linkFolder(Id.parse(projectId), Id.parse(key));
    return null;
  });
}

export async function unlinkFolderAction(projectId: string, key: string): Promise<R<null>> {
  return run(projectId, async () => {
    await unlinkFolder(Id.parse(projectId), Id.parse(key));
    return null;
  });
}

export async function startSessionAction(projectId: string, key: string, prompt: string): Promise<R<string>> {
  return run(projectId, () => startSession(Id.parse(projectId), Id.parse(key), z.string().max(4000).parse(prompt ?? '')));
}

export async function resumeSessionAction(projectId: string, sessionId: string): Promise<R<null>> {
  return run(projectId, async () => {
    await resumeSession(Id.parse(projectId), Uuid.parse(sessionId));
    return null;
  });
}

export async function stopSessionAction(projectId: string, sessionId: string): Promise<R<null>> {
  return run(projectId, async () => {
    await stopSession(Id.parse(projectId), Uuid.parse(sessionId));
    return null;
  });
}
