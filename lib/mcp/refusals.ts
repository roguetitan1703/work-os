// The refused Work OS calls of each session (H10): `tool:kind`, never error text (it can quote titles and names).
// feedback and end_work attach the recent ones to the line they write, so the project's feed shows what was refused
// without the agent having to say it. The third same refusal in 30 minutes also gets one hint line on the refused answer
// (suggesting feedback); a feedback call silences it. In memory only: lost on a restart, bounded, and never read for anything else.

export const REFUSAL_KINDS = ['policy', 'input', 'not_found', 'internal'] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export const REFUSAL_TTL_MS = 30 * 60_000;
export const REFUSALS_PER_SESSION = 5;
export const REFUSAL_SESSIONS_MAX = 2000;

type Entry = { at: number; ref: string };
type Sess = { list: Entry[]; hintAt?: number };
/** Insertion order is age order: a session that refuses again moves to the end. hintAt: the last hint or feedback. */
const bySession = new Map<string, Sess>();

/** The same tool refused the same way this many times in 30 minutes earns the hint. */
export const HINT_REPEATS = 3;

const fresh = (list: Entry[], now: number) => list.filter(e => now - e.at < REFUSAL_TTL_MS);

function trim() {
  while (bySession.size > REFUSAL_SESSIONS_MAX) {
    const oldest = bySession.keys().next().value;
    if (oldest === undefined) break;
    bySession.delete(oldest);
  }
}

/**
 * Remember that `tool` was refused for the session (or key) `key`: the last 5 of the last 30 minutes are kept.
 * Returns the feedback hint when `hint` is true, the same tool:kind is now in the fresh list HINT_REPEATS times, and no hint
 * or feedback came in the last 30 minutes; else null. A refusal with `hint` false never sets the memory.
 */
export function noteRefusal(key: string, tool: string, kind: RefusalKind, now: number = Date.now(), hint: boolean = true): string | null {
  const prev = bySession.get(key);
  const ref = `${tool}:${kind}`;
  const list = [...fresh(prev?.list ?? [], now), { at: now, ref }].slice(-REFUSALS_PER_SESSION);
  const n = list.filter(e => e.ref === ref).length;
  const give = hint && n >= HINT_REPEATS && (prev?.hintAt === undefined || now - prev.hintAt >= REFUSAL_TTL_MS);
  bySession.delete(key);
  bySession.set(key, { list, hintAt: give ? now : prev?.hintAt });
  trim();
  return give
    ? `Looks hard? ${tool} was refused ${n} times in the last 30 minutes (${kind}). Tell Work OS in one line with feedback {project, text, tool: "${tool}"} and go on; your refused calls are attached for you.`
    : null;
}

/** The session sent feedback (recorded or a duplicate): no hint for the next 30 minutes. */
export function noteFeedback(key: string, now: number = Date.now()): void {
  const prev = bySession.get(key);
  bySession.delete(key);
  bySession.set(key, { list: prev?.list ?? [], hintAt: now });
  trim();
}

/** Add the hint as a paragraph at the end of a refused answer's first text block; anything else comes back unchanged. */
export function withHint<T extends { isError?: boolean; content?: unknown }>(res: T, hint: string): T {
  const c = res?.content;
  if (!res?.isError || !Array.isArray(c) || !c[0] || c[0].type !== 'text' || typeof c[0].text !== 'string') return res;
  return { ...res, content: [{ ...c[0], text: `${c[0].text}

${hint}` }, ...c.slice(1)] };
}

/** The session's refused calls of the last 30 minutes, oldest first (`tool:kind`, a repeat appears each time). */
export function recentRefusals(key: string, now: number = Date.now()): string[] {
  return fresh(bySession.get(key)?.list ?? [], now).map(e => e.ref);
}
