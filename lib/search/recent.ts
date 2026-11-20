// The search's recent hits in the browser (components/global-search.tsx): one list per person and organization, so
// someone else signing in on the same browser never sees them, and all of them are forgotten at the sign-in page (where
// signing out lands). Client-safe.

const PREFIX = 'wos:search-recent';

/** The storage key of this person's recent hits in this organization. */
export const recentKey = (orgId: string, userId: string) => `${PREFIX}:${orgId}:${userId}`;

/** Forget every person's recent hits on this browser (the older unkeyed list too). */
export function forgetSearchRecent(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {}
}
