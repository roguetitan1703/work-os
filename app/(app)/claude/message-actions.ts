'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { userActor } from '@/lib/actors';
import { messageOwnSession, reply, setStatus } from '@/lib/data/messages';
import { InputError, NotFoundError } from '@/lib/data/errors';

// The writes of Messages for you on Claude › Now (Identity step 6), as the signed-in person. A reply carries word `person`: the server sets it,
// there is no argument for it. Applying a decision adds it to the State's Decisions; a request becomes a task by "Make a task".

export type MessageResult = { ok: true; task?: string; note?: string } | { ok: false; error: string };

async function run(fn: (s: { userId: string; orgId: string }) => Promise<MessageResult>): Promise<MessageResult> {
  try {
    const caller = await requireCaller();
    const r = await withCaller(caller, () => fn({ userId: caller.userId, orgId: caller.orgId }));
    revalidatePath('/claude');
    return r;
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    if (err instanceof InputError || err instanceof NotFoundError) return { ok: false, error: err.message };
    console.error(err);
    return { ok: false, error: err instanceof SafeError ? err.message : 'Something went wrong' };
  }
}

export async function messageStatusAction(id: string, status: 'applied' | 'rejected', note?: string): Promise<MessageResult> {
  if (status !== 'applied' && status !== 'rejected') return { ok: false, error: 'Unknown status' };
  return run(async s => {
    await setStatus(s, String(id), status, { note, actor: userActor(s.userId) });
    return { ok: true };
  });
}

export async function makeTaskFromMessageAction(id: string): Promise<MessageResult> {
  return run(async s => {
    const r = await setStatus(s, String(id), 'applied', { actor: userActor(s.userId), makeTask: true });
    return { ok: true, ...(r.task ? { task: `#${r.task.ref} ${r.task.title}` } : {}) };
  });
}

/** A session row's Message: a request to one of the caller's own sessions (lib/data/messages.ts messageOwnSession). */
export async function messageSessionAction(sessionId: string, body: string): Promise<MessageResult> {
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: 'Write a message first' };
  const id = String(sessionId ?? '').slice(0, 200);
  if (!id) return { ok: false, error: 'No session' };
  return run(async s => {
    const r = await messageOwnSession(s, id, text.slice(0, 4000));
    return { ok: true, note: r.target };
  });
}

export async function replyToMessageAction(id: string, body: string): Promise<MessageResult> {
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: 'Write a reply first' };
  return run(async s => {
    await reply(s, String(id), text.slice(0, 4000), { word: 'person', ai: 'Work OS app' });
    return { ok: true };
  });
}
