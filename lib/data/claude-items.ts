import 'server-only';
import type { ClaudeItemDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { asActor } from '../actors';
import type { ClaudeItem } from '../types';

// Claude items are retired (H11 steps 7 and 8, 18 Nov decision): the work list is the State and the tasks. What is left is
// the history: the `claudeItems` collection stays, and this file only reads it (the project page's "Old Claude items" fold,
// search finding C12). Nothing writes an item any more; scripts/migrate-claude-items.mjs moved the open ones.

export const itemRef = (ref: number) => `C${ref}`;

export function toItem(d: ClaudeItemDoc): ClaudeItem {
  const { _id, keyId: _k, group: _g, orgId: _o, ownerId: _w, visibility: _v, sharedWith: _sw, ...rest } = d;
  return {
    ...rest,
    id: _id,
    waitingOn: d.waitingOn ?? null,
    waitingText: d.waitingText ?? '',
    createdBy: asActor(d.createdBy),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    doneAt: d.doneAt?.toISOString() ?? null,
    claimedBy: d.claimedBy ? { session: d.claimedBy.session, at: d.claimedBy.at.toISOString() } : null,
    log: d.log.map(l => ({ ...l, actor: asActor(l.actor), at: l.at.toISOString() })),
  };
}

function refFilter(key: string | number): Partial<ClaudeItemDoc> {
  if (typeof key === 'number') return { ref: key };
  const m = key.trim().match(/^C?(\d+)$/i);
  return m ? { ref: Number(m[1]) } : { _id: key.trim() };
}

export async function getItem(s: Scope, key: string | number): Promise<ClaudeItem | null> {
  const c = await scoped(s);
  const d = await c.claudeItems.findOne(refFilter(key));
  return d ? toItem(d) : null;
}

/** A project's old Claude items, newest first (at most `limit`): the read-only fold on the project page. */
export async function oldItems(s: Scope, projectId: string, limit = 100): Promise<ClaudeItem[]> {
  const c = await scoped(s);
  return (await c.claudeItems.find({ projectId }).sort({ ref: -1 }).limit(limit).toArray()).map(toItem);
}
