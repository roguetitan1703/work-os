// Declutter, the pure half (docs/flows/agent-system.md section 7, H11): when a project is "due", which State lines and notes
// count, and the shape of one proposed change. No imports and no database, so tests/declutter-check.mjs can run it as it is.
// The database half (reading notes, tasks and Needs, then applying) is lib/data/declutter.ts.

export const GROWTH = { later: 60, next: 10, reviewGrowth: 10, staleDays: 14, quietDays: 14, noteDays: 30, items: 60, adds: 40, disk: 20, itemText: 300, asksPerHour: 3 } as const;

const DAY = 86_400_000;

export type DeclutterKind = 'archive_line' | 'done_next' | 'archive_note' | 'complete_task' | 'withdraw_need' | 'add_later' | 'add_task';
/** One proposed change. `id` is `kind:target` and stays the same between calls, so `skip` works across them. */
export type DeclutterItem = { id: string; kind: DeclutterKind; text: string; why: string; target?: string; /** What a new Later line waits on (add_later). */ waits?: string; /** archive_note: the page that stays (the newest live one); the apply checks it is still live. */ keep?: string };

/** The id of a proposed change: what kind of thing and which one (a line id, note id, task ref or Need ref). */
export function itemId(group: 'later' | 'next' | 'note' | 'task' | 'need' | 'add', target: string | number): string {
  return `${group}:${target}`;
}

type Line = { id: string; text: string; ref?: number; waitsOn?: string; at: Date };
export type StateLike = { next: Line[]; later: Line[]; declutter?: { checkedAt: Date; reasons: string[]; quietUntil?: Date; needId?: string; needRef?: number; reviewedAt?: Date; reviewedLater?: number; reviewedNext?: number } };

const CACHED_REASON = /^\d+ notes share a title$/;

/** A line Declutter would propose for being old: nobody waits on it, it is stale, and (a Next line) it has no task. A Next line with an open task never is. */
const proposableStale = (l: Line, inNext: boolean, now: Date) => isStale(l, now) && !(inNext && l.ref);

/**
 * The size part of "due": Later or Next over the limit, and the size not reviewed yet or grown by GROWTH.reviewGrowth lines since
 * the last review (`reviewed: true` on declutter stores the counts). Returns the reasons in the Due words, empty when none.
 */
export function sizeReasons(state: Pick<StateLike, 'next' | 'later' | 'declutter'>): string[] {
  const c = state.declutter;
  const grew = (now: number, was: number | undefined) => !c?.reviewedAt || was === undefined || now - was >= GROWTH.reviewGrowth;
  const out: string[] = [];
  if (state.later.length > GROWTH.later && grew(state.later.length, c?.reviewedLater)) out.push(`Later ${state.later.length} (over ${GROWTH.later})`);
  if (state.next.length > GROWTH.next && grew(state.next.length, c?.reviewedNext)) out.push(`Next ${state.next.length} (over ${GROWTH.next})`);
  return out;
}

/** A line of the size review: the oldest lines first, each with its date, what it waits on and its words. */
export type ReviewLine = { id: string; date: string; waitsOn?: string; text: string };

/** The Next and Later lines for a size review, oldest first (a line's `at` is when it was last written). */
export function reviewLines(state: Pick<StateLike, 'next' | 'later'>): { next: ReviewLine[]; later: ReviewLine[] } {
  const row = (l: Line): ReviewLine => ({ id: l.id, date: l.at.toISOString().slice(0, 10), ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), text: clip(l.text, 200) });
  const byAge = (a: Line, b: Line) => a.at.getTime() - b.at.getTime();
  return { next: [...state.next].sort(byAge).map(row), later: [...state.later].sort(byAge).map(row) };
}

/** A line is stale when nobody waits on it and it was last written GROWTH.staleDays or more days ago. A waiting line never is (16.9). */
export function isStale(l: Pick<Line, 'waitsOn' | 'at'>, now: Date): boolean {
  return !l.waitsOn && now.getTime() - l.at.getTime() >= GROWTH.staleDays * DAY;
}

export type Due = {
  due: boolean;
  /** Why, in short phrases (the counts from the State and the cached reasons). Empty when quiet. */
  reasons: string[];
  /** The one line for the start brief and end_work, or null when nothing is due or the project is quiet. */
  text: string | null;
  /** A declutter Need is open: the brief says so instead of "due". */
  openNeed?: number;
  /** Size is among the reasons: the declutter read then answers with a size review (review lines and the reviewed step). */
  review?: boolean;
};

/**
 * Is the project due? Pure: counts and stale lines come from the loaded State, the notes and Claude items part from the
 * cached daily check. Quiet (14 days after an answer or an applied Declutter) says nothing. An open declutter Need says that instead.
 */
export function dueReasons(state: StateLike | null, now: Date, project: string): Due {
  const cache = state?.declutter;
  if (cache?.needId && cache.needRef) {
    return { due: false, reasons: [], openNeed: cache.needRef, text: `Declutter Need #${cache.needRef} is open.` };
  }
  if (!state) return { due: false, reasons: [], text: null };
  if (cache?.quietUntil && cache.quietUntil.getTime() > now.getTime()) return { due: false, reasons: [], text: null };
  const reasons: string[] = [];
  const size = sizeReasons(state);
  reasons.push(...size);
  const stale = state.next.filter(l => proposableStale(l, true, now)).length + state.later.filter(l => proposableStale(l, false, now)).length;
  if (stale) reasons.push(`${stale} line${stale === 1 ? '' : 's'} untouched ${GROWTH.staleDays} days`);
  // Only a reason Declutter can still propose a change for: an older cache may hold a retired one ("7 open Claude items").
  for (const r of cache?.reasons ?? []) if (CACHED_REASON.test(r)) reasons.push(r);
  if (!reasons.length) return { due: false, reasons: [], text: null };
  return { due: true, reasons, ...(size.length ? { review: true } : {}), text: `Declutter due: ${reasons.join('; ')}. Call declutter {project: "${project}"}.` };
}

/**
 * The fallback after "Call declutter", for Claude Code only (the steps are Claude Code's): a session that connected before the
 * tool existed and has not re-read its tool list (start_work tells Claude Code to, app/api/mcp/[[...key]]/route.ts) cannot
 * call it until Work OS is reconnected. Added by briefField (lib/data/declutter.ts) for a Claude Code caller and by the Stop
 * hook's nudge (lib/data/nudges.ts).
 */
export const NO_DECLUTTER_TOOL = 'If your tools do not list declutter, ask your person to reconnect Work OS (/mcp, work-os, Reconnect).';

/**
 * Groups of rows that share a title key (two or more). `key` is lib/notes-match.ts titleKey. An empty key and "untitled" are
 * exempt (every new page starts as Untitled), and so is anything the caller marks `exempt` (handovers).
 */
export function duplicateGroups<T extends { title: string; exempt?: boolean }>(rows: T[], key: (t: string) => string): T[][] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    if (r.exempt) continue;
    const k = key(r.title);
    if (!k || k === 'untitled') continue;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].filter(g => g.length > 1);
}

const clip = (t: string, n: number = GROWTH.itemText) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/**
 * The State half of a proposal. Later lines: stale, or another Later line says the same (same key of the text; the newest stays).
 * Next lines: no task, not waiting, stale; and lines whose task is already closed (`closed`: refs of Done or Dropped tasks)
 * count as done. A line with a task that is still open is never proposed.
 */
export function stateItems(state: StateLike, now: Date, closed: Set<number>, key: (t: string) => string): DeclutterItem[] {
  const out: DeclutterItem[] = [];
  const seen = new Set<string>();
  for (const l of state.next) {
    if (l.ref && closed.has(l.ref)) {
      out.push({ id: itemId('next', l.id), kind: 'done_next', text: clip(l.text), why: `its task #${l.ref} is closed`, target: l.id });
      seen.add(l.id);
    } else if (!l.ref && isStale(l, now)) {
      out.push({ id: itemId('next', l.id), kind: 'archive_line', text: clip(l.text), why: `not touched for ${Math.floor((now.getTime() - l.at.getTime()) / DAY)} days, no task`, target: l.id });
    }
  }
  // Later: the newest of a set of duplicates stays.
  const newest = new Map<string, Line>();
  for (const l of state.later) {
    const k = key(l.text);
    const cur = newest.get(k);
    if (k && (!cur || l.at.getTime() > cur.at.getTime())) newest.set(k, l);
  }
  for (const l of state.later) {
    const k = key(l.text);
    const keep = k ? newest.get(k) : undefined;
    if (keep && keep.id !== l.id) out.push({ id: itemId('later', l.id), kind: 'archive_line', text: clip(l.text), why: 'another Later line says the same', target: l.id });
    else if (isStale(l, now)) out.push({ id: itemId('later', l.id), kind: 'archive_line', text: clip(l.text), why: `not touched for ${Math.floor((now.getTime() - l.at.getTime()) / DAY)} days`, target: l.id });
  }
  return out;
}

/**
 * Two live notes with one title: the most recently updated live one stays, the other live ones are proposed. An archived page
 * never stays in place of a live one and is never proposed; a group with fewer than two live pages proposes nothing.
 */
export function noteItems(groups: { id: string; title: string; updatedAt: Date; archived?: boolean }[][]): DeclutterItem[] {
  const out: DeclutterItem[] = [];
  for (const g of groups) {
    const sorted = g.filter(n => !n.archived).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    for (const n of sorted.slice(1)) out.push({ id: itemId('note', n.id), kind: 'archive_note', text: clip(`"${n.title}"`), why: `an older page with the same title as "${sorted[0].title}"`, target: n.id, keep: sorted[0].id });
  }
  return out;
}

/** How many live pages sit in groups that hold two or more live pages (what "notes share a title" counts). */
export function dupNoteCount(groups: { archived?: boolean }[][]): number {
  return groups.reduce((n, g) => { const live = g.filter(x => !x.archived).length; return n + (live > 1 ? live : 0); }, 0);
}

