'use server';

import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { messageOwnSession } from '@/lib/data/messages';
import { InputError, NotFoundError } from '@/lib/data/errors';

// The write of a session row's Message on Claude › Sessions, as the signed-in person.

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
