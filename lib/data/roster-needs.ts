import 'server-only';
import { getDb } from '../db';
import type { Scope } from '../scope';

// The one place the roster reads Needs (docs/flows/plan-1-3.md slice 4, built on another branch): "waiting on a person" is
// a worker with an open Need. Until the `needs` collection exists a find on it returns nothing, so the answer is "nobody
// is waiting" and the roster works without slice 4. When slice 4 lands, only this file may need adjusting to its field names.
//
// Assumed shape (plan-1-3.md, "A Need is one ask to one person"): { orgId, status: 'open' | ..., from: { session?: string, ... } }.
// It answers only "which of these session ids have an open Need", never the Need itself, and is asked only about sessions
// of workers the viewer can already see (the roster's rows come through the scoped door).

/** Of these session ids, the ones with an open Need. */
export async function openNeedSessions(s: Scope, sessions: string[]): Promise<Set<string>> {
  if (!sessions.length) return new Set();
  try {
    const db = await getDb(); // scope-ok: the organization is in the filter; returns only session ids of workers the roster already shows the viewer
    const rows = await db
      .collection('needs') // scope-ok: see above
      .find({ orgId: s.orgId, status: 'open', 'from.session': { $in: sessions } }, { projection: { 'from.session': 1 } })
      .limit(500)
      .toArray();
    return new Set(rows.map(r => (r as unknown as { from?: { session?: string } }).from?.session).filter((x): x is string => !!x));
  } catch (e) {
    console.error('[roster needs]', e);
    return new Set();
  }
}
