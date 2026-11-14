import 'server-only';
import type { PresenceDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { claimCursor, countWrite, presentRow, resetWrites, touchPresence, type Ident } from '../data/presence';
import { answeredNeedsSince, newNeedsForMe } from '../data/needs';
import type { ToolName } from './docs';

// The "for you" line (docs/flows/step-1.md section 5). Every Work OS tool answer to a present session (one that called
// start_work, or whose key has a recent presence row) may carry `forYou`: a few short lines naming what is new for it on
// its project since its cursor. IDs and counts only, never body text: what a teammate wrote is read through the tools,
// where it is labelled, never pushed here.
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
export type ForYouInput = { s: Scope; row: PresenceDoc; since: Date; projectId: string; src?: string; named: Set<string> };
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

const newMessages: ForYouSource = {
  id: 'messages',
  async collect({ s, since, projectId, src, named }) {
    const m = await (await scoped(s)).messages
      .find({ projectId, at: { $gt: since }, ...(src ? { src: { $ne: src } } : {}) }, { projection: { _id: 1 } })
      .sort({ at: 1 })
      .limit(41)
      .toArray();
    const fresh = m.filter(x => !named.has(x._id));
    if (!fresh.length) return none;
    return { lines: [`${fresh.length > 40 ? '40+' : fresh.length} new message${fresh.length === 1 ? '' : 's'} on project ${projectId} (inbox: ${fresh.slice(0, 5).map(x => x._id).join(', ')})`], ids: fresh.map(x => x._id) };
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

/** The sources, in the order their lines appear. */
export const SOURCES: ForYouSource[] = [newMessages, newTasks, newNext, needs];

/** A session that has made this many writes since its last save_state is reminded (and again at each multiple). */
export const SAVE_NUDGE = 10;
const SAVES = new Set<ToolName>(['save_state', 'import_state']);

export type Pending = { s: Scope; row: PresenceDoc; startedAt: Date; lines: string[]; ids: string[] };

/** Before the tool runs: who is present, and what is new for them. Never throws (a failure here must not fail the tool). */
export async function forYouBefore(s: Scope, ident: Ident, tool: ToolName): Promise<Pending | null> {
  if (tool === 'start_work') return null; // the brief carries everything; it registers the session itself
  try {
    const row = await presentRow(s, ident);
    if (!row) return null;
    const startedAt = new Date();
    const c = await scoped(s);
    // A project the caller can no longer read (made private, taken off) names nothing.
    if (!(await c.projects.findOne({ _id: row.projectId }, { projection: { _id: 1 } }))) return null;
    const named = new Set(row.named ?? []);
    const lines: string[] = [];
    const ids: string[] = [];
    for (const src of SOURCES) {
      const r = await src.collect({ s, row, since: row.forYouCursor, projectId: row.projectId, src: `${s.userId}:${ident.session ?? ident.keyId}`, named });
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
        if (n > 0 && n % SAVE_NUDGE === 0) lines = [...lines, `State not saved since ${n} writes: call save_state`];
      }
    }
    await touchPresence(p.s, p.row);
    if (!lines.length || failed) return res;
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
  } catch (e) {
    console.error('[for-you]', e);
    return res;
  }
}
