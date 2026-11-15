'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { userActor } from '@/lib/actors';
import { memberNames } from '@/lib/people';
import { messageOut, sendMessage, setStatus, type MessageOut } from '@/lib/data/messages';
import { InputError, NotFoundError } from '@/lib/data/errors';

// The Inbox tab's writes (docs/flows/step-1.md section 4), as the signed-in person. A message sent here carries word
// `person`: the server sets it, there is no argument for it. Applying a decision adds it to the State's Decisions.

export type InboxResult = { ok: true; message?: MessageOut; target?: string; task?: string } | { ok: false; error: string };

const KINDS = new Set(['decision', 'request', 'question', 'fyi']);

async function run(projectId: string | null, fn: (s: { userId: string; orgId: string }, names: Record<string, string>) => Promise<InboxResult>): Promise<InboxResult> {
  try {
    const caller = await requireCaller();
    const s = { userId: caller.userId, orgId: caller.orgId };
    const names = await memberNames(caller.orgId);
    const r = await withCaller(caller, () => fn(s, names));
    if (projectId) revalidatePath(`/projects/${projectId}`);
    return r;
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}

export async function sendMessageAction(projectId: string, kind: string, body: string, toSession?: string): Promise<InboxResult> {
  if (!KINDS.has(kind)) return { ok: false, error: 'Unknown kind' };
  return run(String(projectId), async (s, names) => {
    const r = await sendMessage(s, String(projectId).slice(0, 80), { kind, body, ...(toSession?.trim() ? { to_session: toSession.trim() } : {}) }, { word: 'person', ai: 'Work OS app' });
    return { ok: true, message: messageOut(r.message, s.userId, names), target: r.target };
  });
}

export async function messageStatusAction(projectId: string, id: string, status: 'seen' | 'applied' | 'rejected', note?: string): Promise<InboxResult> {
  if (status !== 'seen' && status !== 'applied' && status !== 'rejected') return { ok: false, error: 'Unknown status' };
  return run(String(projectId), async (s, names) => {
    const r = await setStatus(s, String(id), status, { note, actor: userActor(s.userId) });
    return { ok: true, message: messageOut(r.message, s.userId, names) };
  });
}

export async function makeTaskFromMessageAction(projectId: string, id: string): Promise<InboxResult> {
  return run(String(projectId), async (s, names) => {
    const r = await setStatus(s, String(id), 'applied', { actor: userActor(s.userId), makeTask: true });
    return { ok: true, message: messageOut(r.message, s.userId, names), ...(r.task ? { task: `#${r.task.ref} ${r.task.title}` } : {}) };
  });
}
