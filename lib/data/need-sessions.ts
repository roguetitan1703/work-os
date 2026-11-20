import 'server-only';
import { scoped, type Scope } from '../scope';
import { presenceState } from './presence-state';
import { opaqueId } from './roster';
import type { Need } from './needs';

// A Need row names the session that asked it ("Payout export: waiting on you"), so answering and checking on the
// session is one screen (docs/HANDOVER.md section 8, "Sessions"). A Need records its asker's session id when the call
// passed one (needs.ts `from.session`); the session is the presence row of that person on that project with that id,
// read through the scoped door. Its state is computed now (presence-state.ts): an open Need makes it wait; once answered
// it reads what the session does (Working when it picked the answer up). The link opens it on the Claude page
// (`/claude?s=<id>`, the same id the roster gives the row: another person's row gets the one-way id).

const JUST_ANSWERED_MS = 5 * 60_000;
const WORD: Record<string, string> ={ working: 'Working', on: 'On', idle: 'Idle', off: 'Off', waiting: 'Waiting' };

/** The open Needs to `me` by the asking session's row id (after withAskerSessions): a session row's Answer opens its Need in place. */
export function asksBySession(needs: Need[], me: string): Record<string, Need> {
  const out: Record<string, Need> = {};
  for (const n of needs) if (n.status === 'open' && n.to === me && n.session?.id && !out[n.session.id]) out[n.session.id] = n;
  return out;
}

/** `needs` with `session` set where the asking session is known. One read for all of them. */
export async function withAskerSessions(s: Scope, needs: Need[]): Promise<Need[]> {
  const asked = needs.filter(n => n.from.session && 'userId' in n.from.actor);
  if (!asked.length) return needs;
  try {
    const c = await scoped(s);
    const sessions = [...new Set(asked.map(n => n.from.session!))];
    const rows = await c.presence
      .find(
        { projectId: { $in: [...new Set(asked.map(n => n.projectId))] }, userId: { $in: [...new Set(asked.map(n => (n.from.actor as { userId: string }).userId))] }, $or: [{ session: { $in: sessions } }, { key: { $in: sessions } }] },
        { projection: { userId: 1, projectId: 1, session: 1, key: 1, label: 1, lastSeen: 1, activity: 1, endedAt: 1 } },
      )
      .limit(200)
      .toArray();
    const now = Date.now();
    return needs.map(n => {
      if (!n.from.session || !('userId' in n.from.actor)) return n;
      const uid = n.from.actor.userId;
      const row = rows.find(r => r.userId === uid && r.projectId === n.projectId && (r.session === n.from.session || r.key === n.from.session));
      if (!row) return n;
      const open = n.status === 'open';
      let st: string = presenceState(row, { now, needs: open }).state;
      // The answer wakes the session that asked (needs.ts answerNeed signals it); its hook reports working only once it
      // has started on it, so for the first minutes after the answer a session that is not off reads Working.
      if (!open && st !== 'off' && n.answeredAt && now - Date.parse(n.answeredAt) < JUST_ANSWERED_MS) st = 'working';
      const label = n.from.label || row.label || 'Claude';
      const word = open && st !== 'off' ? (n.to === s.userId ? 'waiting on you' : 'waiting') : WORD[st] ?? st;
      const id = row.userId === s.userId ? row._id : opaqueId(row._id);
      return { ...n, session: { id, label, state: open && st !== 'off' ? 'waiting' : st, word, href: `/claude?s=${encodeURIComponent(id)}` } };
    });
  } catch (e) {
    console.error('[need sessions]', e);
    return needs;
  }
}
