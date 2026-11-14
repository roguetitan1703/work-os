import 'server-only';
import type { PresenceDoc } from '../db';
import { scoped, type Scope } from '../scope';

// The one place the roster reads Needs (lib/data/needs.ts, slice 4). A worker is "waiting on a person" when a Need it
// asked is open. A Need records its asker as `from.actor` (the agent kind and the person it works for) and, when the
// call passed one, `from.session`. So a Need with a session matches the worker with that session id; a Need with none
// matches the workers of the same person, same client kind, on the same project (the key or client plus project, as
// presence rows are keyed when no session id is given). Read through the scoped door: a Need the viewer cannot read
// makes no worker wait on the viewer's screen. Answers only a set of presence row ids, never the Need.

type Row = Pick<PresenceDoc, '_id' | 'session' | 'userId' | 'agent' | 'projectId' | 'keyId'>;

/** The ids of the presence rows that have an open Need. */
export async function openNeedRows(s: Scope, rows: Row[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  try {
    const projects = [...new Set(rows.map(r => r.projectId))];
    const needs = await (await scoped(s)).needs
      .find({ status: 'open', projectId: { $in: projects } }, { projection: { projectId: 1, from: 1 } })
      .limit(500)
      .toArray();
    const out = new Set<string>();
    for (const n of needs) {
      // Session ids are chosen by the client, so a session only counts together with the person who asked.
      const actor = n.from.actor;
      const uid = 'userId' in actor ? actor.userId : undefined;
      if (!uid) continue;
      for (const r of rows) {
        if (r.projectId !== n.projectId || r.userId !== uid) continue;
        if (n.from.session ? r.session === n.from.session : n.from.keyId && r.keyId ? n.from.keyId === r.keyId : actor.kind === 'agent' && actor.agent === r.agent) out.add(r._id);
      }
    }
    return out;
  } catch (e) {
    console.error('[roster needs]', e);
    return new Set();
  }
}
