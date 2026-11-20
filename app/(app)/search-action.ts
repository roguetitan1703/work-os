'use server';

import { asCaller } from '@/lib/caller';
import { searchAll } from '@/lib/search';
import { isKind, type SearchResult } from '@/lib/search/match';

/**
 * Global search (lib/search). The sign-in proxy (proxy.ts) already guards every action POST; this checks the caller
 * again and searches only what they can see. `kind` limits it to one kind (the filter), with more hits.
 */
export async function searchAction(q: string, kind?: string): Promise<SearchResult | null> {
  return asCaller(c => searchAll({ userId: c.userId, orgId: c.orgId }, typeof q === 'string' ? q : '', isKind(kind) ? kind : undefined)).catch(() => null);
}
