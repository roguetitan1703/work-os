import 'server-only';
import type { ScopedCollections, Scope } from '../scope';
import type { KindResult, Hit, Query } from './match';
import { compareHits } from './match';

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

export const projectName = (ctx: Ctx, id: string | null | undefined) => (id ? (ctx.projects.get(id)?.name ?? '') : '');
export const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ');
export const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

/** Sort, count and cut a provider's hits. `read` is how many documents the query returned. */
export function result(ctx: Ctx, hits: Hit[], read: number): KindResult {
  hits.sort(compareHits);
  return { hits: hits.slice(0, ctx.take), count: hits.length, ...(read >= READ ? { more: true } : {}) };
}
