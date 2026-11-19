// The refused Work OS calls of each session (H10): `tool:kind`, never error text (it can quote titles and names).
// feedback and end_work attach the recent ones to the line they write, so the project's feed shows what was refused
// without the agent having to say it. In memory only: lost on a restart, bounded, and never read for anything else.

export const REFUSAL_KINDS = ['policy', 'input', 'not_found', 'internal'] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export const REFUSAL_TTL_MS = 30 * 60_000;
export const REFUSALS_PER_SESSION = 5;
export const REFUSAL_SESSIONS_MAX = 2000;

type Entry = { at: number; ref: string };
/** Insertion order is age order: a session that refuses again moves to the end. */
const bySession = new Map<string, Entry[]>();

const fresh = (list: Entry[], now: number) => list.filter(e => now - e.at < REFUSAL_TTL_MS);

/** Remember that `tool` was refused for the session (or key) `key`: the last 5 of the last 30 minutes are kept. */
export function noteRefusal(key: string, tool: string, kind: RefusalKind, now: number = Date.now()): void {
  const list = [...fresh(bySession.get(key) ?? [], now), { at: now, ref: `${tool}:${kind}` }].slice(-REFUSALS_PER_SESSION);
  bySession.delete(key);
  bySession.set(key, list);
  while (bySession.size > REFUSAL_SESSIONS_MAX) {
    const oldest = bySession.keys().next().value;
    if (oldest === undefined) break;
    bySession.delete(oldest);
  }
}

/** The session's refused calls of the last 30 minutes, oldest first (`tool:kind`, a repeat appears each time). */
export function recentRefusals(key: string, now: number = Date.now()): string[] {
  return fresh(bySession.get(key) ?? [], now).map(e => e.ref);
}
