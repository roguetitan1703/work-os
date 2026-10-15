'use server';

import { cookies } from 'next/headers';
import { SESSION_COOKIE, uiAuthDisabled, verifySessionValue } from '@/lib/auth';
import { searchAll, type SearchResult } from '@/lib/data/search';

/** Global search. The sign-in proxy (proxy.ts) already guards every action POST; this checks the session again (it reads all data). */
export async function searchAction(q: string): Promise<SearchResult | null> {
  if (!uiAuthDisabled() && !(await verifySessionValue((await cookies()).get(SESSION_COOKIE)?.value))) return null;
  return searchAll(typeof q === 'string' ? q : '');
}
