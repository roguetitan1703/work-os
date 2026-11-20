// Parked lines and decisions leave the State document for their own collections (`stateParked`, `stateDecisions`): one dated
// row per entry, no cap. This moves a State's legacy `parked` and `decisions` arrays into rows. The app runs it on the first
// touch of a project (lib/data/states.ts) and scripts/migrate-state-lists.mjs runs it over every project; both call this one
// function. Pure apart from the collections it is given: no imports, so the script loads it with type stripping.
//
// Rows are upserted by { orgId, projectId, id } with $setOnInsert, so a second run finds them and moves nothing. The counts are
// counted from the rows actually present (never assumed), the arrays are unset last, and the State version is not bumped
// (nothing visible changes). Run it inside a transaction: either a project is moved whole or not at all.

type Line = { id: string; text: string; at: Date; by: string; src?: string; when?: string; ref?: number; waitsOn?: string; hold?: unknown; left?: unknown };
type Decision = { id: string; at: Date; archivedAt?: Date; [k: string]: unknown };
export type LegacyState = { _id: string; orgId: string; projectId?: string; ownerId: string; visibility: string; sharedWith?: string[]; parked?: Line[]; decisions?: Decision[] };

/** The collections it needs, raw (the script) or through the door (the app); the minimum of the Mongo API it uses. */
type Col = {
  updateOne(filter: object, update: object, options?: object): Promise<{ upsertedCount?: number }>;
  countDocuments(filter: object, options?: object): Promise<number>;
};
export type MoveCols = { states: Col; parked: Col; decisions: Col };

export type MoveResult = { parkedRows: number; decisionRows: number; parkedCount: number; decisionsCount: number; moved: boolean };

/** A new random row id (24 hex characters). */
const rowId = (): string => {
  const c = globalThis.crypto;
  const b = new Uint8Array(12);
  c.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
};

/**
 * Moves `st.parked` and `st.decisions` into rows and sets the counts. With `recount` it also runs on a State that has no arrays
 * (the migration script's repair of drifted counts); otherwise such a State is left alone (returns null).
 */
export async function moveLegacyLists(cols: MoveCols, st: LegacyState, o: { session?: unknown; recount?: boolean; /** The collections are the app's door, which adds orgId to every filter itself (and refuses it twice): leave it out of ours. */ door?: boolean } = {}): Promise<MoveResult | null> {
  const hasArrays = Array.isArray(st.parked) || Array.isArray(st.decisions);
  if (!hasArrays && !o.recount) return null;
  const projectId = st.projectId ?? st._id;
  const opt = o.session ? { session: o.session } : {};
  const org = o.door ? {} : { orgId: st.orgId };
  // orgId comes from the filter's equality on upsert (and the door refuses it in an update), so it is not repeated here.
  const place = { ownerId: st.ownerId, visibility: st.visibility, ...(st.sharedWith ? { sharedWith: st.sharedWith } : {}) };
  let parkedRows = 0;
  let decisionRows = 0;
  // Parked: in array order. parkedAt is the line's own date, pushed up by a millisecond where it would not come after the previous line, so the order is kept.
  let prev = 0;
  for (const l of st.parked ?? []) {
    const parkedAt = Math.max(l.at.getTime(), prev + 1);
    prev = parkedAt;
    const row = { _id: rowId(), projectId, id: l.id, text: l.text, ...(l.when ? { when: l.when } : {}), ...(l.ref ? { ref: l.ref } : {}), ...(l.waitsOn ? { waitsOn: l.waitsOn } : {}), by: l.by, ...(l.src ? { src: l.src } : {}), at: l.at, parkedAt: new Date(parkedAt), ...place };
    const r = await cols.parked.updateOne({ ...org, projectId, id: l.id }, { $setOnInsert: row }, { upsert: true, ...opt });
    parkedRows += r.upsertedCount ?? 0;
  }
  // Decisions: the same rule for `at` (append order is kept; only a same-millisecond tie moves, by a millisecond).
  prev = 0;
  for (const d of st.decisions ?? []) {
    const at = Math.max(d.at.getTime(), prev + 1);
    prev = at;
    const row = { ...d, _id: rowId(), projectId, at: at === d.at.getTime() ? d.at : new Date(at), ...place };
    const r = await cols.decisions.updateOne({ ...org, projectId, id: d.id }, { $setOnInsert: row }, { upsert: true, ...opt });
    decisionRows += r.upsertedCount ?? 0;
  }
  const parkedCount = await cols.parked.countDocuments({ ...org, projectId }, opt);
  const decisionsCount = await cols.decisions.countDocuments({ ...org, projectId, archivedAt: null }, opt);
  await cols.states.updateOne({ _id: st._id }, { $set: { parkedCount, decisionsCount }, $unset: { parked: '', decisions: '' } }, opt);
  return { parkedRows, decisionRows, parkedCount, decisionsCount, moved: hasArrays };
}
