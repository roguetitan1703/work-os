'use server';

import { getCaller } from '@/lib/caller';
import { searchAll, type SearchResult } from '@/lib/data/search';

/** Global search. The sign-in proxy (proxy.ts) already guards every action POST; this checks the caller again and searches only what they can see. */
export async function searchAction(q: string): Promise<SearchResult | null> {
  const c = await getCaller();
  if (!c) return null;
  return searchAll({ userId: c.userId, orgId: c.orgId }, typeof q === 'string' ? q : '');
}
