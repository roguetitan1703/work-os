'use server';

import { SafeError } from '@/lib/auth';
import { requireCaller, withCaller } from '@/lib/caller';
import { listAuthorizedApps, revokeAuthorizedApp, type AuthorizedApp } from '@/lib/oauth';

// Claude › Set up › Signed-in apps (docs/auth.md "Connecting Claude with OAuth"): revoke one of your own approved apps.
// Works only on the signed-in caller's own approvals in their organization (lib/oauth.ts).

type R<T> = { ok: true; data: T } | { ok: false; error: string };

export async function revokeAppAction(clientId: string): Promise<R<AuthorizedApp[]>> {
  try {
    const c = await requireCaller();
    return await withCaller(c, async () => {
      await revokeAuthorizedApp(c, String(clientId ?? ''));
      return { ok: true as const, data: await listAuthorizedApps(c) };
    });
  } catch (e) {
    if (e instanceof SafeError) return { ok: false, error: e.message };
    console.error('revoke app failed', e);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}
