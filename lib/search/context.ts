import 'server-only';
import type { Document } from 'mongodb';
import type { ScopedCollections, Scope } from '../scope';
import type { KindResult, Hit, Query } from './match';
import { compareHits, wordRegex } from './match';

/** What every provider gets: the caller's door, the query and the project names it may read. */
export type Ctx = {
  c: ScopedCollections;
  s: Scope;
  query: Query;
  /** How many hits to return (the count covers every match read). */
  take: number;
  projects: Map<string, { name: string; status: string }>;
};

/** Documents read per kind before the exact match; more than this and the count is a floor. */
export const READ = 100;

/**
 * Fields with no index (descriptions, note text, comments) are searched among the most recently changed documents
 * only, so a search reads at most this many per kind however much data there is. Titles are searched over everything
 * (an index on orgId + title: the keys are scanned, only matching documents are read).
 */
export const RECENT = 500;

/** Every word in the title (the index pass). */
export const titleFilter = (words: string[]) => ({ $and: words.map(w => ({ title: wordRegex(w) })) });

type Aggregatable = { aggregate: (p: Document[]) => { toArray: () => Promise<Document[]> } };
/**
 * Up to READ documents matching `filter` among the RECENT most recently changed ones (`by`: a date with an index after
 * orgId), through the door (the scoped aggregate adds the organization and the visibility rule first).
 */
export function recentMatching(col: Aggregatable, by: string, pre: Document, filter: Document, projection: Document): Promise<Document[]> {
  return col.aggregate([{ $match: pre }, { $sort: { [by]: -1 } }, { $limit: RECENT }, { $match: filter }, { $limit: READ }, { $project: projection }]).toArray();
}

export const projectName = (ctx: Ctx, id: string | null | undefined) => (id ? (ctx.projects.get(id)?.name ?? '') : '');
export const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');
export const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

/**
 * Sort, count and cut a provider's hits. `read` is how many documents the query returned; `more` true when the
 * provider stopped early (enough hits for its group, the other fields not read), so the count is a floor.
 */
export function result(ctx: Ctx, hits: Hit[], read: number, more = false): KindResult {
  hits.sort(compareHits);
  return { hits: hits.slice(0, ctx.take), count: hits.length, ...(more || read >= READ ? { more: true } : {}) };
}
