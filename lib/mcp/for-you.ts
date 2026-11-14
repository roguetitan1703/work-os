import 'server-only';
import type { PresenceDoc } from '../db';
import { scoped, type Scope } from '../scope';
import { claimCursor, countWrite, presentRow, resetWrites, touchPresence, type Ident } from '../data/presence';
import type { ToolName } from './docs';

// The "for you" line (docs/flows/step-1.md section 5). Every Work OS tool answer to a present session (one that called
// start_work, or whose key has a recent presence row) may carry `forYou`: a few short lines naming what is new for it on
// its project since its cursor. IDs and counts only, never body text: what a teammate wrote is read through the tools,
// where it is labelled, never pushed here.
//
// One cursor (`forYouCursor`, a timestamp on the presence row) says what has been named. Items newer than it are named
// once and the cursor moves. A call that writes also moves it (to the end of the call), so a session is never told about
// what it just made itself. Calls that carry no session id use the most recent row of their key.
//
// Adding a source (a later slice: messages, answered Needs) is one object in SOURCES below: give it an id and a collect()
// that returns lines. Nothing else in this file or in the tool wrapper changes.

export type ForYouInput = { s: Scope; row: PresenceDoc; since: Date; projectName: string };
export type ForYouSource = {
  id: string;
  /** Lines naming what is new since `since` (ids and counts only). */
  collect(x: ForYouInput): Promise<string[]>;
};

const refs = (list: number[], total: number) => list.slice(0, 5).map(r => `#${r}`).join(', ') + (total > 5 ? ` and ${total - 5} more` : '');

const newTasks: ForYouSource = {
  id: 'tasks',
  async collect({ s, row, since, projectName }) {
    const c = await scoped(s);
    const t = await c.tasks.find({ projectId: row.projectId, createdAt: { $gt: since } }, { projection: { ref: 1 } }).sort({ createdAt: 1 }).limit(21).toArray();
    if (!t.length) return [];
    const n = t.length > 20 ? '20+' : String(t.length);
    return [`${n} new task${t.length === 1 ? '' : 's'} on ${projectName}: ${refs(t.slice(0, 5).map(x => x.ref), t.length > 5 ? 6 : t.length)}`];
  },
};

const newNext: ForYouSource = {
  id: 'next',
  async collect({ s, row, since, projectName }) {
    const st = await (await scoped(s)).states.findOne({ _id: row.projectId }, { projection: { next: 1 } });
    const fresh = (st?.next ?? []).filter(l => l.at > since);
    if (!fresh.length) return [];
    return [`${fresh.length} new line${fresh.length === 1 ? '' : 's'} in Next on ${projectName} (${fresh.slice(0, 5).map(l => l.id).join(', ')})`];
  },
};

/** The sources, in the order their lines appear. */
export const SOURCES: ForYouSource[] = [newTasks, newNext];

/** A session that has made this many writes since its last save_state is reminded (and again at each multiple). */
export const SAVE_NUDGE = 10;
const SAVES = new Set<ToolName>(['save_state', 'import_state']);

export type Pending = { s: Scope; row: PresenceDoc; startedAt: Date; lines: string[] };

/** Before the tool runs: who is present, and what is new for them. Never throws (a failure here must not fail the tool). */
export async function forYouBefore(s: Scope, ident: Ident, tool: ToolName): Promise<Pending | null> {
  if (tool === 'start_work') return null; // the brief carries everything; it registers the session itself
  try {
    const row = await presentRow(s, ident);
    if (!row) return null;
    const startedAt = new Date();
    const since = row.forYouCursor;
    const c = await scoped(s);
    const project = await c.projects.findOne({ _id: row.projectId }, { projection: { name: 1 } });
    if (!project) return null;
    const lines: string[] = [];
    for (const src of SOURCES) lines.push(...(await src.collect({ s, row, since, projectName: project.name })));
    return { s, row, startedAt, lines };
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
    // Items are named once: the call that moves the cursor from the value it read is the one that names them. A call that
    // wrote moves it to the end of the call (the session is not told about its own work); one that only read moves it to
    // where it started (what arrived while it ran is named next time).
    const to = write ? new Date() : lines.length ? p.startedAt : null;
    if (to && !(await claimCursor(p.s, p.row, to).catch(() => false))) lines = [];
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
