import 'server-only';
import type { PresenceDoc, PresenceState, ProjectDoc } from '../db';
import { eventState, type EventKind, type EventName } from './presence-state';
import { scoped, type Scope } from '../scope';
import { placeIn } from './projects';

// Sessions working on a project (docs/flows/step-1.md section 5). A row per session, stamped with the project's placement
// (so the door shows it to the project's readers only, and the placement cascade moves it with the project) and kept
// out of the push-hint topics (lib/scope.ts TOPICS): a heartbeat refreshes nobody's page.
//
// Key of a row: the session id when the call carries one (the `session` argument or X-Work-OS-Session), else the key id
// (an OAuth client id is per client per person) plus the project. The person's id is part of the row id, so nobody can
// take over another person's row by sending their session id.

export const PRESENT_MIN = 30;
const REFRESH_MS = 60_000;

export type Ident = { userId: string; agent: string; keyId?: string; keyName?: string; session?: string };

/** The key of a session in messages (src, seenBy, toSids): the person's id and the session id, else the key id. The person's id always comes from the verified caller. */
export const sessionKey = (i: Ident) => `${i.userId}:${i.session ?? i.keyId ?? i.agent}`;
/** The same key, from a presence row. */
export const rowKey = (r: Pick<PresenceDoc, 'userId' | 'key'>) => `${r.userId}:${r.key}`;

/**
 * Which presence rows a to_session names: an exact session id (only among the caller's own rows), else an exact label
 * (case-insensitive, trimmed), else an exact client name. Never a substring. Several matches all count.
 */
export function matchSessions(allRows: PresenceDoc[], to: string, userId?: string): PresenceDoc[] {
  // Only the sender's own sessions are named by a label or id: a label with no live row of the sender's waits on the sender's own key.
  const rows = userId ? allRows.filter(r => r.userId === userId) : allRows;
  const raw = to.trim();
  const q = raw.toLowerCase();
  if (!q) return [];
  const byId = rows.filter(r => r.session === raw);
  if (byId.length) return byId;
  // The sender's own sessions come first: another person's rows match only when the sender has none that match.
  const pick = (hit: (r: PresenceDoc) => boolean) => {
    const all = rows.filter(hit);
    const own = userId ? all.filter(r => r.userId === userId) : [];
    return own.length ? own : all;
  };
  const byLabel = pick(r => (r.label ?? '').trim().toLowerCase() === q);
  if (byLabel.length) return byLabel;
  return pick(r => (r.ai ?? '').trim().toLowerCase() === q);
}

/** Does this look like a session id (a UUID, or the 32 hex of a hook session) rather than a label? Such a value is never kept as a label. */
export const idShaped = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()) || /^[0-9a-f]{32}$/i.test(v.trim());

/**
 * The presence row of a reading session, for messages: by session id; with no id only a row that start_work made with no
 * id (never a sibling session's row of the same key), with no time limit.
 */
export async function readerRow(s: Scope, i: Ident): Promise<PresenceDoc | null> {
  const c = await scoped(s);
  if (i.session) return c.presence.findOne({ userId: i.userId, session: i.session }, { sort: { lastSeen: -1 } });
  if (i.keyId) return c.presence.findOne({ userId: i.userId, keyId: i.keyId, session: { $exists: false } }, { sort: { lastSeen: -1 } });
  return null;
}

/** The row id of a hook session: the person, the session token's id and the project (the shape rowId makes for a session id). */
export const hookRowId = (userId: string, sid: string, projectId: string | null) => `${userId}:s:${sid}:${projectId ?? 'none'}`;
const rowId = (i: Ident, projectId: string | null) => (i.session ? hookRowId(i.userId, i.session, projectId) : `${i.userId}:k:${i.keyId ?? i.agent}:${projectId ?? 'none'}`);

// "No row for this caller" is remembered for a few seconds, so a caller who never calls start_work costs no read per tool call.
const none = new Map<string, number>();
const NONE_MS = 15_000;
const noneKey = (i: Ident) => `${i.userId}|${i.session ?? ''}|${i.keyId ?? ''}`;

/** Registers (or refreshes) the session as present on a project. Called by start_work. */
export type RosterReport = { hook?: number; model?: string; account?: string; parent?: string; slot?: string; machineName?: string; branch?: string; tool?: string };
const clip = (v: string | undefined, n: number) => (v ?? '').trim().slice(0, n);

export type LabelSource = NonNullable<PresenceDoc['labelSource']>;
export const TOOLS = ['desktop', 'vscode', 'terminal'] as const;
/** A name for a roster row: one line, no control characters, at most 120 characters. An old hook's plain "Claude Code" is no name. */
export function cleanLabel(v: string | undefined | null): string {
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return t === 'Claude Code' ? '' : t;
}
/**
 * The label change a write makes, or null for none (Identity step 4). Order: the session's own name (title) -> start_work's label -> Claude's
 * title (ai) -> the fallback; of the two explicit ones the last written wins; ai only fills where nothing explicit is set (and may replace an earlier
 * ai title or the fallback); the fallback only fills an empty label; a dispatched row keeps its forced label whatever else writes.
 */
export function labelPatch(ex: Pick<PresenceDoc, 'label' | 'labelSource' | 'dispatched'> | null, text: string, source: LabelSource): { label: string; labelSource: LabelSource; labelAt: Date } | null {
  const t = cleanLabel(text);
  if (!t) return null;
  const forced = !!ex?.dispatched;
  if (forced) return source === 'forced' ? { label: t, labelSource: 'forced', labelAt: new Date() } : null;
  const was: LabelSource | undefined = ex?.labelSource ?? (ex?.label ? 'label' : undefined);
  const explicitWas = was === 'title' || was === 'label' || was === 'forced';
  const ok = source === 'forced' || source === 'title' || source === 'label' || (source === 'ai' && !explicitWas) || (source === 'fallback' && !ex?.label);
  return ok ? { label: t, labelSource: source, labelAt: new Date() } : null;
}

/** `fresh`: this call made the row (a new session), not a re-call of one that was there (after compaction, or a later start_work). */
export async function registerPresence(s: Scope, i: Ident, project: ProjectDoc | null, o: { machine?: string; label?: string; /** Where `label` comes from (default: start_work's own label). */ labelSource?: LabelSource; /** Claude Code's own session UUID (the hook's start only). */ ccSession?: string; /** The state this start puts the session in (the hook's start only: on, or working after a compaction). */ activity?: 'on' | 'working'; /** H15: the task the dispatcher started it for. */ dispatched?: { taskId: string; ref: number } } & RosterReport): Promise<PresenceDoc & { fresh: boolean }> {
  const c = await scoped(s);
  const now = new Date();
  const _id = rowId(i, project?._id ?? null);
  // One machine name per PC (Identity step 3): a row the hook made carries the device itself (machine = device id, machineName = its name).
  // A later start_work from the agent that names the PC any other way (its hostname in another case, a nickname) must not replace that:
  // the plain name is ignored while the row has a device. A call that resolves to a device (same or another) still wins.
  const ex = await c.presence.findOne({ _id }, { projection: { machineName: 1, label: 1, labelSource: 1, dispatched: 1 } });
  const keepDevice = !!(o.machine && !o.machineName) && !!ex?.machineName;
  const lp = o.label ? labelPatch(ex ? { ...ex, dispatched: ex.dispatched ?? o.dispatched } : o.dispatched ? { label: '', dispatched: o.dispatched } : null, o.label, o.labelSource ?? (o.dispatched ? 'forced' : 'label')) : null;
  const tool = (TOOLS as readonly string[]).includes(o.tool ?? '') ? (o.tool as (typeof TOOLS)[number]) : undefined;
  const up = await c.presence.updateOne(
    { _id },
    {
      $set: {
        projectId: project?._id ?? null,
        userId: s.userId,
        key: i.session ?? i.keyId ?? i.agent,
        ...(i.session ? { session: i.session } : {}),
        ...(i.keyId ? { keyId: i.keyId } : {}),
        // A later start_work without a label keeps the earlier one (label addressing depends on it); which write wins is labelPatch's.
        ...(lp ?? {}),
        ...(tool ? { tool } : {}),
        ...(keepDevice ? {} : { machine: (o.machine ?? '').slice(0, 40) }),
        ai: (i.keyName || i.agent).slice(0, 80),
        agent: i.agent,
        // The hook protocol: only when this call says (an old hook's row stays 1 until a new hook starts it again).
        ...(o.hook ? { hook: o.hook } : {}),
        // The roster: only what this call reports (a later start_work without a model keeps the earlier one).
        ...(clip(o.model, 60) ? { model: clip(o.model, 60) } : {}),
        ...(clip(o.account, 80) ? { account: clip(o.account, 80) } : {}),
        ...(clip(o.parent, 64) ? { parent: clip(o.parent, 64) } : {}),
        ...(clip(o.slot, 20) ? { slot: clip(o.slot, 20) } : {}),
        ...(clip(o.branch, 120) ? { branch: clip(o.branch, 120) } : {}),
        ...(o.machine && o.machineName ? { machineName: o.machineName } : {}),
        ...(o.ccSession ? { ccSession: o.ccSession } : {}),
        ...(o.dispatched ? { dispatched: o.dispatched } : {}),
        ...(o.activity ? { activity: { state: o.activity, at: now } } : {}),
        lastSeen: now,
        // start_work hands over everything there is, so what is "new for you" starts here.
        forYouCursor: now,
        named: [],
        writesSinceSave: 0,
        ...placeIn(project, s.userId),
      },
      $setOnInsert: { createdAt: now, ...(lp ? {} : { label: '' }) },
      // A machine that is no longer one of the person's devices (or a name now reported plain) drops its device name.
      // A start_work after end_work is a session working again.
      $unset: { endedAt: '', ...(o.machine && !o.machineName && !keepDevice ? { machineName: '' } : {}) },
    },
    { upsert: true },
  );
  for (const k of [...none.keys()]) if (k.startsWith(`${i.userId}|`)) none.delete(k);
  return { ...(await c.presence.findOne({ _id }))!, fresh: up.upsertedCount > 0 };
}

/**
 * What the hook reports about a session that changed (POST /api/agent/event identity): its own name (a /rename), Claude's title and the model.
 * Only the token's own row; never creates one. Returns whether anything changed.
 */
export async function setIdentity(s: Scope, r: { sid: string; projectId: string | null }, id: { title?: string; aiTitle?: string; model?: string }): Promise<boolean> {
  const c = await scoped(s);
  const _id = hookRowId(s.userId, r.sid, r.projectId);
  const ex = await c.presence.findOne({ _id, userId: s.userId }, { projection: { label: 1, labelSource: 1, dispatched: 1, model: 1 } });
  if (!ex) return false;
  const set: Record<string, unknown> = {};
  const lp = (id.title ? labelPatch(ex, id.title, 'title') : null) ?? (id.aiTitle ? labelPatch(ex, id.aiTitle, 'ai') : null);
  if (lp && (lp.label !== ex.label || lp.labelSource !== ex.labelSource)) Object.assign(set, lp);
  const model = clip(id.model, 60);
  if (model && /^[A-Za-z0-9._:/-]+$/.test(model) && model !== ex.model) set.model = model;
  if (!Object.keys(set).length) return false;
  await c.presence.updateOne({ _id, userId: s.userId }, { $set: set });
  return true;
}

/** The caller's own presence row on one project (end_work: a session may have rows on several projects), or null. */
export async function rowFor(s: Scope, i: Ident, projectId: string): Promise<PresenceDoc | null> {
  return (await scoped(s)).presence.findOne({ _id: rowId(i, projectId), userId: i.userId });
}

/** The present row of this caller (by session id, else the most recent one of their key), or null. */
export async function presentRow(s: Scope, i: Ident): Promise<PresenceDoc | null> {
  const nk = noneKey(i);
  const seen = none.get(nk);
  if (seen && Date.now() - seen < NONE_MS) return null;
  const c = await scoped(s);
  let row: PresenceDoc | null = null;
  if (i.session) row = await c.presence.findOne({ userId: i.userId, session: i.session }, { sort: { lastSeen: -1 } });
  if (!row && i.keyId) row = await c.presence.findOne({ userId: i.userId, keyId: i.keyId, lastSeen: { $gt: new Date(Date.now() - PRESENT_MIN * 60_000) } }, { sort: { lastSeen: -1 } });
  if (!row) {
    if (none.size > 2000) none.clear();
    none.set(nk, Date.now());
  }
  return row;
}

/** Heartbeat: at most one write a minute per row. */
export async function touchPresence(s: Scope, row: PresenceDoc): Promise<void> {
  const now = Date.now();
  if (now - row.lastSeen.getTime() < REFRESH_MS) return;
  await (await scoped(s)).presence.updateOne({ _id: row._id, lastSeen: { $lt: new Date(now - REFRESH_MS) } }, { $set: { lastSeen: new Date(now) } });
}

/** Claims "what is new" for this session: moves the cursor from the value read to `to`. False if another call of the session took it first. */
export async function claimCursor(s: Scope, row: PresenceDoc, to: Date, named: string[]): Promise<boolean> {
  const r = await (await scoped(s)).presence.updateOne({ _id: row._id, forYouCursor: row.forYouCursor }, { $set: { forYouCursor: to, named: named.slice(-100) } });
  return r.matchedCount > 0;
}

/** Counts a write of the session since its last save_state; returns the new count. */
export async function countWrite(s: Scope, row: PresenceDoc): Promise<number> {
  const r = await (await scoped(s)).presence.findOneAndUpdate({ _id: row._id }, { $inc: { writesSinceSave: 1 } }, { returnDocument: 'after', projection: { writesSinceSave: 1 } });
  return r?.writesSinceSave ?? row.writesSinceSave + 1;
}

export async function resetWrites(s: Scope, row: PresenceDoc): Promise<void> {
  await (await scoped(s)).presence.updateOne({ _id: row._id }, { $set: { writesSinceSave: 0 } });
}

/** Sessions seen in the last PRESENT_MIN minutes on a project, except one row. */
export async function othersPresent(s: Scope, projectId: string, exceptId?: string): Promise<PresenceDoc[]> {
  const c = await scoped(s);
  return c.presence
    .find({ projectId, lastSeen: { $gt: new Date(Date.now() - PRESENT_MIN * 60_000) }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .sort({ lastSeen: -1 })
    .limit(30)
    .toArray();
}

/**
 * What the caller's machine field means: the id of one of their own computers when the name (or id) matches one (the
 * worker daemon knows it, and the roster then joins the daemon's report to the session), else the plain name they gave.
 */
export async function resolveMachine(s: Scope, reported?: string): Promise<{ machine: string; machineName?: string }> {
  const name = (reported ?? '').trim().slice(0, 40);
  if (!name) return { machine: '' };
  const ds = await (await scoped(s)).devices.find({ revokedAt: null }, { projection: { name: 1 } }).toArray();
  const d = ds.find(x => x._id === name || x.name.toLowerCase() === name.toLowerCase());
  return d ? { machine: d._id, machineName: d.name } : { machine: name };
}

/** set_doing: records the task the session is on (or clears it). Null when the caller is not a present session. */
export async function setDoing(s: Scope, i: Ident, taskId: string | null): Promise<PresenceDoc | null> {
  const row = await presentRow(s, i);
  if (!row) return null;
  const c = await scoped(s);
  await c.presence.updateOne({ _id: row._id }, taskId ? { $set: { doing: { taskId, at: new Date() }, lastSeen: new Date() } } : { $unset: { doing: '' }, $set: { lastSeen: new Date() } });
  return (await c.presence.findOne({ _id: row._id }))!;
}

const SKEW_MS = 5 * 60_000;
/** A repeat of the state already stored, within this long of the last event, needs no write (and no budget). */
const REPEAT_MS = 60_000;

/**
 * Is this event a repeat that changes nothing: a kind of notification with no effect, or the state the row already has,
 * recorded less than a minute ago? Such an event is answered from the row without a write and costs no hourly budget, so a
 * session making many tool calls never runs out of events. `state` is null when the row is gone (not free: it is charged).
 */
export async function isFreeEvent(s: Scope, r: { sid: string; projectId: string | null }, ev: { event: EventName; kind?: EventKind; files?: StopFiles; copy?: 'refused'; identity?: object; result?: string }): Promise<{ free: boolean; state: PresenceState | null; ignored?: boolean }> {
  const next = eventState(ev);
  const row = await (await scoped(s)).presence.findOne({ _id: hookRowId(s.userId, r.sid, r.projectId), userId: s.userId }, { projection: { activity: 1 } });
  if (!row) return { free: false, state: null };
  // An event that carries a count (a stop check, a refused copy write) is never free: it is written and charged.
  if (ev.files || ev.copy || ev.identity || ev.result !== undefined) return { free: false, state: row.activity?.state ?? null };
  const a = row.activity;
  if (!next) return { free: true, state: a?.state ?? null, ignored: true };
  const same = !!a && a.state === next.state && a.why === next.why && Date.now() - a.at.getTime() < REPEAT_MS;
  return { free: same, state: a?.state ?? null };
}

export type StopFiles = 'saved' | 'unsaved';

/** One counted WORK-STATE.md edit: the session's total, and the day's (UTC date), so the Monday numbers count a week and not a session's whole life. */
const copyInc = (what: 'refused' | 'forwarded') => ({ [`copyEdits.${what}`]: 1, [`copyEdits.days.${new Date().toISOString().slice(0, 10)}.${what}`]: 1 });

/**
 * One event from a session's Claude Code hook (POST /api/agent/event): sets `activity` from what happened and refreshes
 * lastSeen. Only the row `hookRowId(...)` is touched, never upserted. `at` is the hook's clock (ms), clamped to the server's
 * now plus or minus 5 minutes; an event not newer than the stored one changes nothing (async hooks arrive out of order).
 * Answers the state after the event (the stored one when the event was stale), `state: null` when the row is gone,
 * `ignored` for an event that changes nothing, and `changed` when the state differs from before.
 */
export async function recordEvent(
  s: Scope,
  r: { sid: string; projectId: string | null },
  ev: { event: EventName; kind?: EventKind; at?: number; files?: StopFiles; reminded?: boolean; copy?: 'refused' },
): Promise<{ state: PresenceState | null; changed: boolean; ignored?: boolean }> {
  const out = await recordState(s, r, ev);
  // The counts (H12): numbers and two words, on the token's own row only, never created here, whatever the state did.
  if (ev.files || ev.copy) {
    const _id = hookRowId(s.userId, r.sid, r.projectId);
    await (await scoped(s)).presence.updateOne(
      { _id, userId: s.userId },
      ev.files
        ? { $set: { stopCheck: { files: ev.files, ...(ev.reminded ? { reminded: true as const } : {}), at: new Date() } } }
        : { $inc: copyInc('refused') },
    );
  }
  return out;
}

export const LAST_RESULT_MAX = 300;
/** A lane result as stored: control characters and line breaks to spaces, one line, at most 300 characters (an ellipsis counts). */
export function cleanResult(v: string | undefined | null): string {
  const t = (v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > LAST_RESULT_MAX ? t.slice(0, LAST_RESULT_MAX - 1) + '\u2026' : t;
}
/**
 * A subagent's last message (the hook's SubagentStop, POST /api/agent/event result): the lane result of the token's own presence row,
 * cleaned and cut at 300 characters. Only that row, never created here; an empty text changes nothing. Returns whether it was written.
 */
export async function setLastResult(s: Scope, r: { sid: string; projectId: string | null }, text: string): Promise<boolean> {
  const t = cleanResult(text);
  if (!t) return false;
  const res = await (await scoped(s)).presence.updateOne({ _id: hookRowId(s.userId, r.sid, r.projectId), userId: s.userId }, { $set: { lastResult: { text: t, at: new Date() } } });
  return res.matchedCount > 0;
}

/** The token's own session counted one hand edit of WORK-STATE.md: refused or forwarded (POST /api/agent/state). Never creates a row. */
export async function countCopyEdit(s: Scope, r: { sid: string; projectId: string | null }, what: 'refused' | 'forwarded'): Promise<void> {
  await (await scoped(s)).presence.updateOne({ _id: hookRowId(s.userId, r.sid, r.projectId), userId: s.userId }, { $inc: copyInc(what) });
}

async function recordState(
  s: Scope,
  r: { sid: string; projectId: string | null },
  ev: { event: EventName; kind?: EventKind; at?: number },
): Promise<{ state: PresenceState | null; changed: boolean; ignored?: boolean }> {
  const next = eventState(ev);
  const c = await scoped(s);
  const _id = hookRowId(s.userId, r.sid, r.projectId);
  if (!next) {
    const row = await c.presence.findOne({ _id }, { projection: { activity: 1 } });
    return { state: row ? (row.activity?.state ?? null) : null, changed: false, ignored: true };
  }
  const now = Date.now();
  const at = new Date(Math.min(now + SKEW_MS, Math.max(now - SKEW_MS, Number.isFinite(ev.at) ? ev.at! : now)));
  const before = await c.presence.findOneAndUpdate(
    { _id, userId: s.userId, $or: [{ activity: { $exists: false } }, { 'activity.at': { $lt: at } }] },
    { $set: { activity: { state: next.state, at, ...(next.why ? { why: next.why } : {}) }, lastSeen: new Date(now) } },
    { returnDocument: 'before', projection: { activity: 1 } },
  );
  if (before) return { state: next.state, changed: before.activity?.state !== next.state };
  // Not updated: the row is gone, or the stored state is newer than this event.
  const row = await c.presence.findOne({ _id }, { projection: { activity: 1 } });
  return { state: row ? (row.activity?.state ?? null) : null, changed: false };
}

/** end_work: the session stops. Clears what it is doing and marks the row ended (the roster shows it off). */
export async function endPresence(s: Scope, row: PresenceDoc): Promise<void> {
  await (await scoped(s)).presence.updateOne({ _id: row._id }, { $unset: { doing: '' }, $set: { endedAt: new Date() } });
  for (const k of [...none.keys()]) if (k.startsWith(`${row.userId}|`)) none.delete(k);
}

/** The session was told these Orders versions (start_work, an acknowledged delivery): later changes reach it as news. */
export async function setOrdersSeen(s: Scope, rowId: string, seen: Record<string, number>): Promise<void> {
  const set = Object.fromEntries(Object.entries(seen).map(([id, v]) => [`ordersSeen.${id}`, v]));
  if (!Object.keys(set).length) return;
  await (await scoped(s)).presence.updateOne({ _id: rowId, userId: s.userId }, { $set: set });
  const { markOrdersDelivered } = await import('./orders');
  for (const [id, v] of Object.entries(seen)) await markOrdersDelivered(s, id, v);
}
