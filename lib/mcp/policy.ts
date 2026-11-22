import 'server-only';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { collections, type PolicyEventDoc } from '../db';
import { forUser, readable, scoped, type Scope } from '../scope';
import { asActor, type AgentName } from '../actors';
import { authSecret } from '../auth';
import { InputError } from '../data/errors';
import * as tasks from '../data/tasks';
import { addToInbox, getNotifySettings } from '../notify';
import type { Task } from '../types';
import { assigneesOf } from '../assignees';

// Server-side rules for MCP callers. One place, called by every tool (lib/mcp/server.ts wraps
// each registered tool with beforeTool) and by apply_changes for its ops (checkBatch).
//
// The claude.ai connector (actor "claude", a Claude chat key) is unaffected by the rules below, except the mail runaway guards
// (MAIL_LIMITS: 200 deletes/moves and 100 sends per hour per person, every caller kind).
// Claude Code keys (actor "claude-code") get:
//   - no permanent deletion and no admin operations (BLOCKED; trash stays restorable)
//   - tool calls per rolling hour (policyEvents, Mongo; CALLS below): a key's sessions share 1,000 (reads and most writes are
//     refused past it) and each session has a share of 300; a write that saves State (SAVING_TOOLS) still goes through past
//     1,000 while its session is under 400 and the key under 1,500 (the hard cap: a session id is the caller's own word, so it never lifts that)
//   - at most 10 trash calls (delete_task / delete_note, single or in a batch) per 10 minutes, unless confirmed
//   - apply_changes that trashes > 10 items or changes > 50 tasks must be dry-run first; the dry run
//     returns a confirm token (HMAC of the op list + expiry, 10 min, the auth secret) that the real call passes
//   - an inbox notice (to the task's recipient) when it changes title/priority/due/project/status/archived of, or
//     trashes, a task it did not create
// policyEvents is per key (keyId), not organization data: it is read and written raw here (scope-ok).

/** agent: the key's kind; keyId: the API key; userId/orgId: its owner and organization (lib/caller.ts). The MCP server acts for them. */
export type Caller = { agent: AgentName; keyId?: string; keyName?: string; userId: string; orgId: string; /** A dispatched run's own key (lib/run-keys.ts): the task, and the worker session it runs as. */ dispatched?: { taskId: string; ref: number; sessionId: string } };

/** Tools a dispatched run never gets: the person's own mail and Discord (a task's text can come from a teammate). */
const DISPATCHED_REFUSED = /^(mail_|discord_)/;

/** The data scope a caller acts in. */
export const callerScope = (c: Caller): Scope => ({ userId: c.userId, orgId: c.orgId });

export const LIMITS = {
  /** The budget a key's sessions share for reads and most writes (CALLS.key; kept for older readers). */
  callsPerHour: 1000,
  trashPerWindow: 10,
  trashWindowMin: 10,
  batchTrashMax: 10,
  batchTaskChangesMax: 50,
  confirmTtlMin: 10,
} as const;

/**
 * The hourly call budget of a Claude Code key. Every MCP tool call counts once, reads included (subagents use their parent's key,
 * so their calls count too; the hook's /api/agent/* calls and the wait have their own budgets per session token and never count
 * here). All sessions of one key share `key`; one session (the session id it passes, else the key itself) may use `session`. A
 * write that saves State (SAVING_TOOLS) is never refused by the shared `key` budget while its session is under `sessionSave`:
 * only `hard` (all calls of the key) stops it.
 */
export const CALLS = { key: LIMITS.callsPerHour, session: 300, sessionSave: 400, hard: 1500 } as const;
/** The writes that save a session's work: a busy sibling session never blocks these. */
export const SAVING_TOOLS = new Set(['save_state', 'end_work', 'set_doing', 'log_progress', 'complete_task', 'hand_in']);

/**
 * Policy refusals; their message is shown to the caller. `rate` is true only for a rate-limit refusal (reserveCall refused the
 * call): feedback is rate-limited too, so that refusal never carries the feedback hint (lib/mcp/refusals.ts).
 */
export class PolicyError extends InputError {
  readonly rate: boolean;
  constructor(message: string, o: { rate?: true } = {}) {
    super(message);
    this.name = 'PolicyError';
    this.rate = o.rate === true;
  }
}

const isCode = (c: Caller) => c.agent === 'claude-code';

/** Created by this person's Claude Code (older entries have no user: they were all the first owner's). */
const byOwnCode = (c: Caller, createdBy: unknown) => {
  const a = asActor(createdBy);
  return a.kind === 'agent' && a.agent === 'claude-code' && (!a.userId || a.userId === c.userId);
};

/** Permanent deletion and admin operations, as tools or apply_changes ops. None exist on MCP today; listed so adding one can't silently open it to Claude Code. */
const BLOCKED = new Set(['answer_need', 'purge_trash', 'purge_task', 'empty_trash', 'delete_forever', 'purge_note', 'register_commands', 'import_tasks', 'admin']);
const TRASH_TOOLS = new Set(['delete_task', 'delete_note']);
const TRASH_OPS = new Set(['delete_task', 'delete_note']);
/** Ops that change an existing task (create_task and comments don't count toward the 50). */
const TASK_CHANGE_OPS = new Set(['update_task', 'log_progress', 'complete_task', 'update_checklist', 'archive_task', 'delete_task', 'restore_task']);
/** Fields whose change by Claude Code on someone else's task tells the task's owner. */
type WatchedField = 'title' | 'priority' | 'due' | 'projectId' | 'status' | 'archived';
const WATCHED: { arg: string; field: WatchedField; label: string }[] = [
  { arg: 'title', field: 'title', label: 'title' },
  { arg: 'priority', field: 'priority', label: 'priority' },
  { arg: 'due', field: 'due', label: 'due' },
  { arg: 'project', field: 'projectId', label: 'project' },
  { arg: 'status', field: 'status', label: 'status' },
  { arg: 'archived', field: 'archived', label: 'archived' },
];

/**
 * What each task-changing tool/op can change, beyond the args it names: log_progress and a
 * blocked_reason can move the status, complete_task always does, archive_task flips archived.
 * Every tool or op that changes an existing task must be listed here (checked by watchTargets).
 */
export function watchTarget(op: string, a: Record<string, unknown>): WatchTarget | null {
  const key = a.task as string | number;
  switch (op) {
    case 'update_task':
      return { key, args: a, also: a.blocked_reason !== undefined || a.blockedReason !== undefined || a.progress !== undefined ? ['status'] : [] };
    case 'log_progress':
      return { key, args: a, also: ['status'] };
    case 'complete_task':
    case 'hand_in':
      return { key, also: ['status'] };
    case 'archive_task':
      return { key, also: ['archived'] };
    case 'delete_task':
      return { key, trash: true };
    case 'restore_task':
      return { key, restore: true };
    default:
      return null; // comments, checklist ticks and restores don't change what the owner relies on
  }
}

type EventKind = 'call' | 'trash' | 'mail_trash' | 'mail_send' | 'intake' | 'agent';

async function countSince(keyId: string, kind: EventKind, since: Date, sid?: string): Promise<number> {
  const c = await collections(); // scope-ok: rate-limit events per API key
  const r = await c.policyEvents
    .aggregate<{ n: number }>([{ $match: { keyId, kind, at: { $gte: since }, ...(sid !== undefined ? { sid } : {}) } }, { $group: { _id: null, n: { $sum: { $ifNull: ['$n', 1] } } } }])
    .toArray();
  return r[0]?.n ?? 0;
}

async function record(keyId: string, kind: EventKind, n = 1, sid?: string): Promise<string> {
  const _id = randomUUID();
  await (await collections()).policyEvents.insertOne({ _id, keyId, kind, at: new Date(), ...(n !== 1 ? { n } : {}), ...(sid !== undefined ? { sid } : {}) }); // scope-ok: rate-limit events per API key
  return _id;
}

type CallCount = { key: number; session: number };
type CallOver = 'hard' | 'session' | 'key';
/**
 * Why a call is over budget, or null when it fits (the counts include the call itself). A call with no session id (the key's own
 * fallback: a client that passes no session) has no share of its own: it gets the key's budget, and no saving-write exemption,
 * since no share bounds it (independent review, 21 Nov).
 */
function overCall(t: CallCount, saving: boolean, hasSession: boolean): CallOver | null {
  if (t.key > CALLS.hard) return 'hard';
  if (!hasSession) return t.key > CALLS.key ? 'key' : null;
  if (t.session > (saving ? CALLS.sessionSave : CALLS.session)) return 'session';
  if (t.key > CALLS.key && !saving) return 'key';
  return null;
}

/** One call slot of a key for one session (`sid`): the race-safe reserve below, with the session's share and the saving-write rule. */
async function reserveCall(keyId: string, sid: string, saving: boolean, hasSession: boolean): Promise<{ id: string } | { id: null; why: CallOver; total: CallCount }> {
  const count = async (): Promise<CallCount> => {
    const since = new Date(Date.now() - 3_600_000);
    const [key, session] = await Promise.all([countSince(keyId, 'call', since), countSince(keyId, 'call', since, sid)]);
    return { key, session };
  };
  let total: CallCount = { key: 0, session: 0 };
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = await record(keyId, 'call', 1, sid);
    total = await count();
    if (!overCall(total, saving, hasSession)) return { id };
    await unrecord(id);
    await new Promise(r => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
    const settled = await count();
    const why = overCall({ key: settled.key + 1, session: settled.session + 1 }, saving, hasSession);
    if (why) return { id: null, why, total: settled };
  }
  return { id: null, why: overCall(total, saving, hasSession) ?? 'key', total: { key: total.key - 1, session: total.session - 1 } };
}

/** The 3 sessions of this key with the most calls this hour, by label. A key is one person's, so these are the caller's own sessions. */
async function topSessions(caller: Caller, keyId: string): Promise<string> {
  try {
    const c = await collections(); // scope-ok: rate-limit events per API key
    const top = await c.policyEvents
      .aggregate<{ _id: string | null; n: number }>([{ $match: { keyId, kind: 'call', at: { $gte: new Date(Date.now() - 3_600_000) } } }, { $group: { _id: '$sid', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }])
      .toArray();
    if (!top.length) return '';
    const keys = top.map(t => t._id).filter((k): k is string => typeof k === 'string');
    const rows = keys.length ? await (await scoped(callerScope(caller))).presence.find({ userId: caller.userId, key: { $in: keys } }, { projection: { key: 1, label: 1, lastSeen: 1 } }).sort({ lastSeen: -1 }).toArray() : [];
    const name = (k: string | null) => {
      const l = rows.find(r => r.key === k && r.label)?.label;
      return l ? `"${l.slice(0, 60)}"` : k === caller.keyId ? 'calls with no session id' : 'a session with no name';
    };
    return ` Most calls this hour: ${top.map(t => `${name(t._id)} ${t.n}`).join(', ')}.`;
  } catch {
    return '';
  }
}

async function unrecord(id: string | undefined): Promise<void> {
  if (id) await (await collections()).policyEvents.deleteOne({ _id: id }).catch(() => {}); // scope-ok: rate-limit events per API key
}

/**
 * Atomic limit check: record the event first, then count the window including it. If that is
 * over the limit, the event is removed and the call refused, so parallel calls can't all slip
 * under the cap (each one sees the others' events). Returns the event id, or null when refused.
 */
async function reserve(keyId: string, kind: EventKind, n: number, since: Date, limit: number): Promise<{ id: string; total: number } | { id: null; total: number }> {
  // Callers that all land at once each see the others' events and would all back out, refusing calls that
  // would fit. So after backing out, wait a random moment and look again: only a count that is still over
  // the limit without this call's own event is a real refusal. Never admits more than `limit`.
  let total = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const id = await record(keyId, kind, n);
    total = await countSince(keyId, kind, since);
    if (total <= limit) return { id, total };
    await unrecord(id);
    await new Promise(r => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
    const settled = await countSince(keyId, kind, since);
    if (settled + n > limit) return { id: null, total: settled };
  }
  return { id: null, total: total - n };
}

/** What an intake source may send per rolling hour (lib/intake.ts): each has its own counter. */
export const INTAKE_PER_HOUR = { mailloom: 60, 'mailloom-notice': 20 } as const;
export type IntakeSource = keyof typeof INTAKE_PER_HOUR;

/**
 * One slot of an intake source's hourly budget (the same race-safe reserve as the key budgets above). Refused: how many
 * seconds until the oldest one in the window ages out (for Retry-After). `release` gives the slot back when the
 * request then made nothing.
 */
export async function reserveIntake(source: IntakeSource): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; retryAfter: number }> {
  const keyId = `intake:${source}`;
  const since = new Date(Date.now() - 3_600_000);
  const r = await reserve(keyId, 'intake', 1, since, INTAKE_PER_HOUR[source]);
  if (r.id) {
    const id = r.id;
    return { ok: true, release: () => unrecord(id) };
  }
  const oldest = await (await collections()).policyEvents.find({ keyId, kind: 'intake', at: { $gte: since } }).sort({ at: 1 }).limit(1).next(); // scope-ok: rate-limit events per intake source
  const wait = oldest ? Math.ceil((oldest.at.getTime() + 3_600_000 - Date.now()) / 1000) : 60;
  return { ok: false, retryAfter: Math.min(3600, Math.max(1, wait)) };
}

/**
 * The Work OS hook's route (POST /api/agent/start, lib/agent-sessions.ts), per rolling hour: new sessions a computer's
 * device key may open, briefs one session token may fetch (start and every compaction), State calls (POST /api/agent/state) and session events (POST /api/agent/event) one session token may make. Its own counters, apart
 * from the key budgets above and the worker routes' per-minute limit. Messages into a session (docs/flows/agent-system.md 5.6):
 * deliver = reads of the unread messages by the event route (a hook asking), wake = idle sessions woken by a message or an answered
 * Need, cont = turns a Stop hook continued with one, wait = long polls of POST /api/agent/wait, renew = the hook's renew sign-ins
 * (POST /api/agent/start with renew), per computer and Claude Code session, apart from the 30 sign-ins an hour of `device`.
 */
export const AGENT_PER_HOUR = { device: 30, session: 20, state: 240, event: 300, deliver: 360, wake: 6, cont: 20, wait: 120, release: 60, renew: 20 } as const;

/** How many slots of an hourly agent budget are used (a peek: nothing is reserved). */
export async function agentUsed(kind: keyof typeof AGENT_PER_HOUR, id: string): Promise<number> {
  return countSince(`agent-${kind}:${id}`, 'agent', new Date(Date.now() - 3_600_000));
}

/** One slot of that budget (the same race-safe reserve as the key budgets); false when it is used up. */
export async function reserveAgent(kind: keyof typeof AGENT_PER_HOUR, id: string): Promise<boolean> {
  const r = await reserve(`agent-${kind}:${id}`, 'agent', 1, new Date(Date.now() - 3_600_000), AGENT_PER_HOUR[kind]);
  return !!r.id;
}

const trashWindowStart = () => new Date(Date.now() - LIMITS.trashWindowMin * 60_000);

/** Budgets are per key; an OAuth caller (a new client is registered on each connection) is budgeted per person so a new client is no fresh budget. */
const budgetKey = (c: Caller): string => (c.keyId?.startsWith('oauth_') ? `oauth_${c.userId}` : c.keyId!);

/**
 * Runaway guards for mail, generous on purpose, per person (not per key) and for every caller kind, the claude.ai
 * connector and the `claude` agent included: a loop that deletes or sends mail without end is stopped, real work never is.
 */
export const MAIL_LIMITS = { deletePerHour: 200, sendPerHour: 100 } as const;
const MAIL_TRASH_TOOLS = new Set(['mail_delete', 'mail_move']);
const MAIL_SEND_TOOLS = new Set(['mail_send', 'mail_reply', 'mail_forward']);

async function mailGuard(caller: Caller, tool: string): Promise<void> {
  const trash = MAIL_TRASH_TOOLS.has(tool);
  if (!trash && !MAIL_SEND_TOOLS.has(tool)) return;
  const limit = trash ? MAIL_LIMITS.deletePerHour : MAIL_LIMITS.sendPerHour;
  const r = await reserve(`mail:${caller.userId}`, trash ? 'mail_trash' : 'mail_send', 1, new Date(Date.now() - 3_600_000), limit);
  if (!r.id) {
    throw new PolicyError(
      trash
        ? `Too many mail deletes and moves: ${r.total} in the last hour (max ${limit}). Something may be looping. Wait a while, or do the rest in Mailloom.`
        : `Too many mails sent: ${r.total} in the last hour (max ${limit}). Something may be looping. Wait a while, or send the rest from Mailloom.`,
    );
  }
}

/** Runs before every tool call. Throws PolicyError to refuse. */
export async function beforeTool(caller: Caller, tool: string, o: { session?: string } = {}): Promise<void> {
  if (!isCode(caller)) return mailGuard(caller, tool);
  const keyId = budgetKey(caller);
  if (BLOCKED.has(tool)) throw new PolicyError(`${tool} is not available to Claude Code keys (permanent deletion and admin stay with you, in the app).`);
  if (caller.dispatched && DISPATCHED_REFUSED.test(tool)) throw new PolicyError(`${tool} is not available to a dispatched run (task #${caller.dispatched.ref}): mail and Discord stay with the person. add_comment on the task if you need something from them.`);
  if (caller.dispatched && tool === 'propose_order') throw new PolicyError(`A dispatched run (task #${caller.dispatched.ref}) changes no Orders and proposes none: tell the person in your report what you would change.`);
  const saving = SAVING_TOOLS.has(tool);
  const call = await reserveCall(keyId, o.session || caller.keyId || caller.agent, saving, !!o.session);
  if (call.id === null) {
    const t = call.total;
    const head =
      call.why === 'session'
        ? `Rate limit: this session made ${t.session} Work OS calls in the last hour (its share is ${CALLS.session}, or ${CALLS.sessionSave} for a write that saves State).`
        : call.why === 'hard'
          ? `Rate limit: this key made ${t.key} Work OS calls in the last hour (max ${CALLS.hard}, shared by every session of the key; this session made ${t.session}).`
          : !o.session
            ? `Rate limit: this key made ${t.key} Work OS calls in the last hour (max ${CALLS.key}, shared by every session of the key). This call passed no session, so it has no share of its own: pass session (the id start_work gave you) to get one.`
            : `Rate limit: this key made ${t.key} Work OS calls in the last hour (max ${CALLS.key} for reads and most writes, shared by every session of the key; this session made ${t.session}). Saving State (save_state, end_work, set_doing, log_progress, complete_task, hand_in) still works while this session is under ${CALLS.sessionSave}.`;
    throw new PolicyError(`${head}${await topSessions(caller, keyId)} Wait a few minutes, or batch work with apply_changes.`, { rate: true });
  }
  if (TRASH_TOOLS.has(tool)) {
    const t = await reserve(keyId, 'trash', 1, trashWindowStart(), LIMITS.trashPerWindow);
    if (!t.id) {
      throw new PolicyError(
        `Too many deletions: ${t.total} items moved to trash in the last ${LIMITS.trashWindowMin} minutes (max ${LIMITS.trashPerWindow}). Ask the user first, or use apply_changes with dry_run: true and its confirm token.`,
      );
    }
  }
  await mailGuard(caller, tool); // last, so a call refused above spends no mail slot
}

// ── apply_changes ───────────────────────────────────────────────────────────

type Op = { op: string; task?: unknown };

export function batchSize(ops: Op[]): { trash: number; tasksChanged: number } {
  const trash = ops.filter(o => TRASH_OPS.has(o.op)).length;
  const keys = new Set(ops.filter(o => TASK_CHANGE_OPS.has(o.op)).map(o => String(o.task).replace(/^#/, '')));
  return { trash, tasksChanged: keys.size };
}

function opsDigest(ops: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(ops)).digest('hex');
}

function sign(keyId: string, exp: number, digest: string): string | null {
  const secret = authSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`wos-confirm.v1.${keyId}.${exp}.${digest}`).digest('hex');
}

function makeConfirm(keyId: string, ops: unknown[]): string | null {
  const exp = Date.now() + LIMITS.confirmTtlMin * 60_000;
  const sig = sign(keyId, exp, opsDigest(ops));
  return sig ? `c1.${exp}.${sig}` : null;
}

/** The token's signature when it is valid for these ops, else null. */
function confirmSig(keyId: string, ops: unknown[], token: string): string | null {
  const [v, exp, sig] = token.split('.');
  if (v !== 'c1' || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = sign(keyId, Number(exp), opsDigest(ops));
  if (!want) return null;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(want, 'hex')) ? sig : null;
}

/**
 * Marks a confirm token used. Its signature is the document _id in policyEvents (unique), so a
 * second use fails with a duplicate key. Kept past the token's 10-minute life by the 2h TTL.
 */
async function burnConfirm(keyId: string, sig: string): Promise<string | null> {
  const _id = `confirm:${sig}`;
  try {
    // kind 'confirm' is never counted by countSince (it matches 'call' / 'trash' only).
    await (await collections()).policyEvents.insertOne({ _id, keyId, kind: 'confirm', at: new Date() } as unknown as PolicyEventDoc); // scope-ok: confirm tokens per API key
    return _id;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return null;
    throw e;
  }
}

export type BatchGate = { confirm?: string; release: () => Promise<void> };
const noop = async () => {};

/**
 * Checks an apply_changes call before it runs. `ops` must be exactly what the caller sent (after
 * schema parsing), so a dry run's confirm token matches the real call with the same ops.
 * Returns the confirm token for a dry run, and `release` to undo what was reserved (trash count,
 * used confirm token) if the batch then fails.
 */
export async function checkBatch(caller: Caller, ops: Op[], opts: { dryRun?: boolean; confirm?: string }): Promise<BatchGate> {
  if (!isCode(caller)) return { release: noop };
  const keyId = budgetKey(caller);
  const blocked = ops.find(o => BLOCKED.has(o.op));
  if (blocked) throw new PolicyError(`Op ${blocked.op} is not available to Claude Code keys (permanent deletion and admin stay with you, in the app).`);
  const size = batchSize(ops);
  if (opts.dryRun) {
    const confirm = makeConfirm(keyId, ops);
    return { ...(confirm ? { confirm } : {}), release: noop };
  }
  if (opts.confirm) {
    const sig = confirmSig(keyId, ops, opts.confirm);
    if (!sig) {
      throw new PolicyError('The confirm token is invalid or expired, or the ops changed since the dry run. Run apply_changes with dry_run: true again and pass the new confirm token with exactly the same ops.');
    }
    const used = await burnConfirm(keyId, sig);
    if (!used) throw new PolicyError('That confirm token was already used. Run apply_changes with dry_run: true again for a new one.');
    // A confirmed batch may go over the trash window, but its trashes still count toward it.
    const t = size.trash ? await record(keyId, 'trash', size.trash) : undefined;
    return { release: async () => Promise.all([unrecord(used), unrecord(t)]).then(noop) };
  }
  const reasons: string[] = [];
  if (size.trash > LIMITS.batchTrashMax) reasons.push(`it moves ${size.trash} items to trash (max ${LIMITS.batchTrashMax} without a preview)`);
  if (size.tasksChanged > LIMITS.batchTaskChangesMax) reasons.push(`it changes ${size.tasksChanged} tasks (max ${LIMITS.batchTaskChangesMax} without a preview)`);
  let trashId: string | undefined;
  if (!reasons.length && size.trash) {
    const t = await reserve(keyId, 'trash', size.trash, trashWindowStart(), LIMITS.trashPerWindow);
    if (!t.id) reasons.push(`with ${t.total} deletions in the last ${LIMITS.trashWindowMin} minutes it would exceed ${LIMITS.trashPerWindow}`);
    else trashId = t.id;
  }
  if (reasons.length) {
    throw new PolicyError(
      `Big change refused: ${reasons.join('; ')}. Run the same apply_changes with dry_run: true first, check the result, then call it again with the same ops and confirm: "<token from the dry run>" (valid ${LIMITS.confirmTtlMin} minutes, once).`,
    );
  }
  return { release: () => unrecord(trashId) };
}

// ── Tell a task's person when Claude Code changes it ────────────────────────

type Snap = Pick<Task, 'id' | 'ref' | 'title' | 'priority' | 'due' | 'projectId' | 'status' | 'archived' | 'createdBy' | 'ownerId' | 'visibility' | 'sharedWith' | 'assigneeIds'>;
export type Watch = { caller: Caller; before: Map<string, Snap>; trashed: Set<string>; restored: Set<string>; fields: Map<string, Set<string>> };

/** Things to watch in one call: task keys with the watched fields they set (args) or may change (also), and keys being trashed. */
export type WatchTarget = { key: string | number; args?: Record<string, unknown>; also?: string[]; trash?: boolean; restore?: boolean };

/** Snapshots the tasks a Claude Code call is about to change (before the change). No-op for other callers. */
export async function watchTasks(caller: Caller, targets: WatchTarget[]): Promise<Watch | null> {
  if (!isCode(caller)) return null;
  const w: Watch = { caller, before: new Map(), trashed: new Set(), restored: new Set(), fields: new Map() };
  const s = callerScope(caller);
  for (const t of targets) {
    if (typeof t.key === 'string' && t.key.startsWith('$')) continue; // created in this batch
    if (t.restore) {
      const m = String(t.key).match(/^#?(\d+)$/);
      const tr = await (await scoped(s)).trash.findOne(m ? { ref: Number(m[1]) } : { _id: String(t.key) }, { sort: { deletedAt: -1 }, projection: { task: 1 } });
      if (tr && !byOwnCode(caller, tr.task.createdBy)) {
        const d = tr.task;
        w.before.set(d._id, { id: d._id, ref: d.ref, title: d.title, priority: d.priority, due: d.due, projectId: d.projectId, status: d.status, archived: d.archived, createdBy: asActor(d.createdBy), ownerId: d.ownerId, visibility: d.visibility, sharedWith: d.sharedWith, assigneeIds: assigneesOf(d) });
        w.restored.add(tr.task._id);
      }
      continue;
    }
    const fields = WATCHED.filter(f => (t.args && t.args[f.arg] !== undefined) || t.also?.includes(f.label)).map(f => f.label);
    if (!t.trash && !fields.length) continue;
    const task = await tasks.getTask(s, t.key).catch(() => null);
    if (!task || byOwnCode(caller, task.createdBy)) continue;
    w.before.set(task.id, task);
    if (t.trash) w.trashed.add(task.id);
    const set = w.fields.get(task.id) ?? new Set<string>();
    fields.forEach(f => set.add(f));
    w.fields.set(task.id, set);
  }
  return w.before.size ? w : null;
}

const show = (v: unknown) => (v == null || v === '' ? 'none' : String(v));
const diffText = (label: string, from: unknown, to: unknown) =>
  label === 'archived' ? (to ? 'archived' : 'unarchived') : `${label} ${show(from)} → ${show(to)}`;

/** After a successful call: one inbox notice per person (each task's recipient) listing what changed. Best effort; never fails the call. */
export async function notifyChanges(w: Watch | null): Promise<void> {
  if (!w) return;
  const byRecipient = new Map<string, Map<string, Snap>>();
  for (const [id, b] of w.before) {
    // A restored task is told to whoever gets its alerts now (its placement and assignees as restored), not those of the
    // trash copy: someone who has lost access since must not hear of it.
    const at = w.restored.has(id) ? await tasks.getTask(callerScope(w.caller), id).catch(() => null) : b;
    if (!at) continue;
    for (const r of tasks.recipientsOf({ ownerId: at.ownerId, visibility: at.visibility, sharedWith: at.sharedWith, assigneeIds: at.assigneeIds })) byRecipient.set(r, (byRecipient.get(r) ?? new Map()).set(id, b));
  }
  for (const [userId, before] of byRecipient) await notifyOne(w, forUser(callerScope(w.caller), userId), before);
}

async function notifyOne(w: Watch, to: Scope, before: Map<string, Snap>): Promise<void> {
  try {
    const settings = await getNotifySettings(to);
    if (settings.kinds.claude_code_changes === false) return;
    const s = callerScope(w.caller);
    const lines: string[] = [];
    let firstRef: number | null = null;
    for (const [id, b] of before) {
      if (w.trashed.has(id) || w.restored.has(id)) {
        lines.push(`#${b.ref} ${b.title}: ${w.trashed.has(id) ? 'moved to trash' : 'restored from trash'}`);
        firstRef ??= b.ref;
        continue;
      }
      const now = await tasks.getTask(s, id).catch(() => null);
      // Read with the writer's scope: a task the change took out of the recipient's sight (moved to a project they are
      // not in) is not described to them.
      if (!now || !readable(now, to.userId)) continue;
      const diffs: string[] = [];
      for (const f of WATCHED) {
        if (!w.fields.get(id)?.has(f.label)) continue;
        if (show(b[f.field]) !== show(now[f.field])) diffs.push(diffText(f.label, b[f.field], now[f.field]));
      }
      if (diffs.length) {
        lines.push(`#${now.ref} ${b.title}: ${diffs.join(', ')}`);
        firstRef ??= now.ref;
      }
    }
    if (!lines.length) return;
    const mine = to.userId === w.caller.userId;
    const who = mine ? (w.caller.keyName ? `Claude Code (${w.caller.keyName})` : 'Claude Code') : "A teammate's Claude Code";
    await addToInbox(to, [
      {
        kind: 'claude_code_changes',
        title: lines.length === 1 ? `${who} changed #${firstRef}` : `${who} changed ${lines.length} of your tasks`,
        body: lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n…and ${lines.length - 20} more` : ''),
        url: lines.length === 1 ? `/tasks/${firstRef}` : '/review?view=activity&actor=claude-code',
      },
    ]);
  } catch (e) {
    console.error('[policy] notify failed', e);
  }
}
