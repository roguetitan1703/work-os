import 'server-only';
import type { PresenceDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { claimCursor, countWrite, presentRow, resetWrites, rowKey, sessionKey, touchPresence, type Ident } from '../data/presence';
import { frameLine, unreadFor, type MessageOut } from '../data/messages';
import { memberNames } from '../people';
import { answeredNeedsSince, newNeedsForMe } from '../data/needs';
import { ordersChangesFor } from '../data/orders';
import { holdsOf } from '../data/nudges';
import { stateOfProject } from '../data/states';
import type { ToolName } from './docs';

// The "for you" line (docs/flows/step-1.md section 5). Every Work OS tool answer to a present session (one that called
// start_work, or whose key has a recent presence row) may carry `forYou`: a few short lines naming what is new for it on
// its project since its cursor. IDs, counts, kind and sender only, never body text: what a teammate wrote is read through the
// tools, where it is labelled. The text of a message is pushed into a Claude Code session only by its hook (lib/data/deliver.ts),
// inside a frame that says who wrote it and that it is not an instruction from the person.
//
// One cursor (`forYouCursor`, a timestamp on the presence row) says what has been named. It trails the start of the call
// by SKEW, never the end of it: a document is stamped before its transaction commits, so something a teammate made while
// the call ran can show up late. The skew window is read twice, so the row also keeps the last ~20 ids it named, and
// items are named once. A session is not told about what it made itself: sources skip items stamped with its own session
// or key (`src`). Calls that carry no session id use the most recent row of their key.
//
// Adding a source (a later slice: messages, answered Needs) is one object in SOURCES below: give it an id and a collect()
// that returns lines. Nothing else in this file or in the tool wrapper changes.

export const SKEW_MS = 2000;
export type ForYouInput = { s: Scope; row: PresenceDoc & { projectId: string }; since: Date; projectId: string; src?: string; named: Set<string> };
export type Named = { lines: string[]; ids: string[] };
export type ForYouSource = {
  id: string;
  /** Lines naming what is new since `since` (ids and counts only, never text; ids named before are skipped). */
  collect(x: ForYouInput): Promise<Named>;
};

const none: Named = { lines: [], ids: [] };
const refs = (list: number[], total: number) => list.slice(0, 5).map(r => `#${r}`).join(', ') + (total > 5 ? ` and ${total - 5} more` : '');

const newTasks: ForYouSource = {
  id: 'tasks',
  async collect({ s, row, since, projectId, src, named }) {
    const c = await scoped(s);
    const all = await c.tasks.find({ projectId, createdAt: { $gt: since }, ...(src ? { src: { $ne: src } } : {}) }, { projection: { ref: 1 } }).sort({ createdAt: 1 }).limit(41).toArray();
    const t = all.filter(x => !named.has(x._id)).slice(0, 21);
    void row;
    if (!t.length) return none;
    const n = t.length > 20 ? '20+' : String(t.length);
    return { lines: [`${n} new task${t.length === 1 ? '' : 's'} on project ${projectId}: ${refs(t.slice(0, 5).map(x => x.ref), t.length > 5 ? 6 : t.length)}`], ids: t.map(x => x._id) };
  },
};

const newNext: ForYouSource = {
  id: 'next',
  async collect({ s, since, projectId, src, named }) {
    const st = await (await scoped(s)).states.findOne({ _id: projectId }, { projection: { next: 1 } });
    const fresh = (st?.next ?? []).filter(l => l.at > since && !named.has(l.id) && !(src && l.src === src));
    if (!fresh.length) return none;
    return { lines: [`${fresh.length} new line${fresh.length === 1 ? '' : 's'} in Next on project ${projectId} (${fresh.slice(0, 5).map(l => l.id).join(', ')})`], ids: fresh.map(l => l.id) };
  },
};

/** "1 request from Akash Patel and 1 fyi from me on project p_1 (message_status reads one: m_1, m_2)": kind and sender, never the text. */
export function messageLine(ms: { _id: string; kind: MessageOut['kind']; from: { userId: string } }[], names: Record<string, string>, me: string, projectId: string): string {
  const groups = new Map<string, number>();
  for (const m of ms.slice(0, 40)) {
    const who = m.from.userId === me ? 'me' : frameLine(Object.hasOwn(names, m.from.userId) ? names[m.from.userId] : 'a former member', 40);
    const k = JSON.stringify([m.kind, who]);
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  const parts = [...groups].map(([k, n]) => {
    const [kind, who] = JSON.parse(k) as [string, string];
    return `${n} ${kind}${n > 1 && kind !== 'fyi' ? 's' : ''} from ${who}`;
  });
  const shown = parts.slice(0, 4);
  const said = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return `${said}${parts.length > 4 ? ` and ${parts.length - 4} more groups` : ''}${ms.length > 40 ? ' (40 or more)' : ''} on project ${projectId} (message_status reads one: ${ms.slice(0, 5).map(x => x._id).join(', ')})`;
}

const newMessages: ForYouSource = {
  id: 'messages',
  async collect({ s, row, since, projectId, src, named }) {
    // Only what is unread for this session (the same rule as the brief), oldest first.
    const m = (await unreadFor(s, { key: src ?? rowKey(row), userId: s.userId, row: !row.session || (src && src === rowKey(row)) ? row : null }, { projectId, since })).reverse().slice(0, 41);
    const fresh = m.filter(x => !named.has(x._id));
    if (!fresh.length) return none;
    return { lines: [messageLine(fresh, await memberNames(s.orgId), s.userId, projectId)], ids: fresh.map(x => x._id) };
  },
};

/** A Need this very session asked (or, with no session, this key): it is not "for you" to the one who asked it. */
const askedHere = (n: { from: { session?: string; keyId?: string } }, row: { session?: string; keyId?: string }) =>
  row.session ? n.from.session === row.session : !!row.keyId && n.from.keyId === row.keyId && !n.from.session;

// Needs (slice 4): ids and counts only; the answer itself is read through start_work or needs.
const needs: ForYouSource = {
  id: 'needs',
  async collect({ s, row, since, named }) {
    const lines: string[] = [];
    const ids: string[] = [];
    // The asker hears about its own answered Needs: this session's, or those of the same key when it passes no session id.
    const done = (await answeredNeedsSince(s, { session: row.session, keyId: row.keyId, projectId: row.projectId }, since)).filter(n => !named.has('ans:' + n.id));
    for (const n of done.slice(0, 5)) lines.push(`your Need #${n.ref} was answered`);
    if (done.length > 5) lines.push(`and ${done.length - 5} more of your Needs answered`);
    ids.push(...done.map(n => 'ans:' + n.id));
    // The person asked hears that there is one for them (only the first session of theirs on the project is told once per cursor).
    const mine = (await newNeedsForMe(s, row.projectId, since)).filter(n => !named.has('ask:' + n.id) && !askedHere(n, row));
    if (mine.length) lines.push(`${mine.length > 20 ? '20+' : mine.length} Need${mine.length === 1 ? '' : 's'} for you: ${mine.slice(0, 5).map(n => '#' + n.ref).join(', ')}`);
    ids.push(...mine.map(n => 'ask:' + n.id));
    return { lines, ids };
  },
};

/** Orders changed (H9): the layers served to this session have a version it was not told of. Ids (ord:<noteId>:<v>) and the page only; the diff comes through start_work or delivery, never in this line. Does not mark the version as seen. */
const ordersChanged: ForYouSource = {
  id: 'orders',
  async collect({ s, row, since, projectId, named }) {
    const ch = (await ordersChangesFor(s, projectId, { since, seen: row.ordersSeen, notSession: row.session, limit: 20 })).filter(x => !named.has(`ord:${x.noteId}:${x.version}`));
    if (!ch.length) return none;
    const newest = new Map<string, (typeof ch)[number]>();
    for (const x of ch) if (!newest.has(x.noteId) || newest.get(x.noteId)!.version < x.version) newest.set(x.noteId, x);
    const layer = { org: 'organisation', project: 'project', person: 'person' } as const;
    return { lines: [...newest.values()].slice(0, 3).map(x => `Orders changed: ${layer[x.layer]} v${x.version} (read_note ${x.noteId})`), ids: ch.map(x => `ord:${x.noteId}:${x.version}`) };
  },
};

/** The sources, in the order their lines appear. */
export const SOURCES: ForYouSource[] = [newMessages, newTasks, newNext, needs, ordersChanged];

/** A session that has made this many writes since its last save_state is reminded (and again at each multiple). */
export const SAVE_NUDGE = 10;
const SAVES = new Set<ToolName>(['save_state', 'import_state', 'end_work']);

/**
 * A caller with no presence row (claude.ai chat that never called start_work) hears of messages addressed to its own key (a
 * reply to it) once each, from a small in-memory memory per key (this process; at most 2,000 keys; a restart names them once
 * more), checked at most every 10 seconds. Ids, kind and sender only, like the row-based line.
 */
const REPLY_CHECK_MS = 10_000;
const replies = new Map<string, { checked: number; named: Set<string> }>();
async function replyLines(s: Scope, ident: Ident): Promise<string[]> {
  const key = sessionKey(ident);
  let e = replies.get(key);
  if (!e) {
    if (replies.size >= 2000) replies.delete(replies.keys().next().value!);
    e = { checked: 0, named: new Set() };
    replies.set(key, e);
  }
  if (Date.now() - e.checked < REPLY_CHECK_MS) return [];
  e.checked = Date.now();
  const mine = e;
  const ms = (await unreadFor(s, { key, userId: s.userId, row: null }, { since: new Date(Date.now() - 86_400_000) })).filter(m => m.toSids?.includes(key) && !mine.named.has(m._id));
  if (!ms.length) return [];
  for (const m of ms.slice(0, 40)) mine.named.add(m._id);
  if (mine.named.size > 200) for (const id of [...mine.named].slice(0, mine.named.size - 200)) mine.named.delete(id);
  const names = await memberNames(s.orgId);
  const byProject = new Map<string, typeof ms>();
  for (const m of ms) if (m.projectId) byProject.set(m.projectId, [...(byProject.get(m.projectId) ?? []), m]); // a message of two no-project sessions has no project's line
  return [...byProject].slice(0, 3).map(([p, list]) => messageLine(list, names, s.userId, p));
}

export type Pending = { s: Scope; /** Null for a caller with no presence row (it only hears replies). */ row: PresenceDoc | null; startedAt: Date; lines: string[]; ids: string[] };

/** Before the tool runs: who is present, and what is new for them. Never throws (a failure here must not fail the tool). */
export async function forYouBefore(s: Scope, ident: Ident, tool: ToolName): Promise<Pending | null> {
  if (tool === 'start_work') return null; // the brief carries everything; it registers the session itself
  try {
    const row = await presentRow(s, ident);
    if (!row) {
      const lines = await replyLines(s, ident);
      return lines.length ? { s, row: null, startedAt: new Date(), lines, ids: [] } : null;
    }
    const startedAt = new Date();
    const c = await scoped(s);
    // A session with no project (Identity step 5) hears nothing from a project; a project the caller can no longer read (made private, taken off) names nothing.
    if (!row.projectId) return null;
    const here = { ...row, projectId: row.projectId };
    if (!(await c.projects.findOne({ _id: here.projectId }, { projection: { _id: 1 } }))) return null;
    const named = new Set(row.named ?? []);
    const lines: string[] = [];
    const ids: string[] = [];
    for (const src of SOURCES) {
      const r = await src.collect({ s, row: here, since: row.forYouCursor, projectId: here.projectId, src: sessionKey(ident), named });
      lines.push(...r.lines);
      ids.push(...r.ids);
    }
    return { s, row, startedAt, lines, ids };
  } catch (e) {
    console.error('[for-you]', e);
    return null;
  }
}

type ToolResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/** After the tool ran: counts the write, claims the cursor, and returns the answer with `forYou` when there is anything to say. */
export async function forYouAfter(p: Pending | null, tool: ToolName, writes: boolean, res: unknown): Promise<unknown> {
  if (!p) return res;
  const r = res as ToolResult;
  try {
    const failed = !!r?.isError;
    const write = writes && !failed;
    let lines = p.lines;
    if (!p.row) return failed ? res : addLines(r, lines);
    // The cursor moves to just before the start of the call (never to its end), when something was named or it is a minute stale.
    const back = new Date(p.startedAt.getTime() - SKEW_MS);
    const to = back > p.row.forYouCursor ? back : p.row.forYouCursor; // never backwards
    if (lines.length || back.getTime() - p.row.forYouCursor.getTime() > 60_000) {
      if (!(await claimCursor(p.s, p.row, to, [...(p.row.named ?? []), ...p.ids]).catch(() => false))) lines = [];
    }
    if (!failed) {
      if (SAVES.has(tool)) await resetWrites(p.s, p.row);
      else if (write) {
        const n = await countWrite(p.s, p.row);
        // Only the session that holds the State's Now is asked to save the whole State; the others keep their lane (set_doing, log_progress).
        if (n > 0 && n % SAVE_NUDGE === 0 && p.row.projectId) {
          const st = await stateOfProject(p.s, p.row.projectId);
          if (st && holdsOf(st, p.row).now) lines = [...lines, `State not saved since ${n} writes: call save_state`];
        }
      }
    }
    await touchPresence(p.s, p.row);
    if (!lines.length || failed) return res;
    return addLines(r, lines);
  } catch (e) {
    console.error('[for-you]', e);
    return res;
  }
}

/** The answer with `forYou` in it (inside the JSON text when it is an object, else as one more block). */
function addLines(r: ToolResult, lines: string[]): unknown {
  const first = r.content?.[0];
  if (first?.type === 'text' && typeof first.text === 'string') {
    try {
      const body = JSON.parse(first.text);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return { ...r, content: [{ ...first, text: JSON.stringify({ ...body, forYou: lines }, null, 1) }, ...(r.content ?? []).slice(1)] };
      }
    } catch {
      /* not JSON: add a block instead */
    }
  }
  return { ...r, content: [...(r.content ?? []), { type: 'text', text: `forYou: ${lines.join('; ')}` }] };
}
