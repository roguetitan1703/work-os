'use server';

import { getCaller } from '@/lib/caller';
import { searchAll, type SearchResult } from '@/lib/data/search';

/** Global search. The sign-in proxy (proxy.ts) already guards every action POST; this checks the caller again (it reads all data). */
export async function searchAction(q: string): Promise<SearchResult | null> {
  if (!(await getCaller())) return null;
  return searchAll(typeof q === 'string' ? q : '');
}
