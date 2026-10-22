import 'server-only';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { collections, type PolicyEventDoc } from '../db';
import { authSecret } from '../auth';
import { InputError } from '../data/errors';
import * as tasks from '../data/tasks';
import { addToInbox, getNotifySettings } from '../notify';
import type { Actor, Task } from '../types';

// Server-side rules for MCP callers. One place, called by every tool (lib/mcp/server.ts wraps
// each registered tool with beforeTool) and by apply_changes for its ops (checkBatch).
//
// The claude.ai connector (actor "claude", a Claude chat key) is unaffected: every check returns at once.
// Claude Code keys (actor "claude-code") get:
//   - no permanent deletion and no admin operations (BLOCKED; trash stays restorable)
//   - at most 300 tool calls per rolling hour per key (policyEvents, Mongo)
//   - at most 10 trash calls (delete_task / delete_note, single or in a batch) per 10 minutes, unless confirmed
//   - apply_changes that trashes > 10 items or changes > 50 tasks must be dry-run first; the dry run
//     returns a confirm token (HMAC of the op list + expiry, 10 min, the auth secret) that the real call passes
//   - an inbox notice when it changes title/priority/due/project/status/archived of, or trashes, a task it did not create

/** keyId: the API key; userId/orgId: its owner and organization (lib/caller.ts). */
export type Caller = { actor: Actor; keyId?: string; keyName?: string; userId?: string; orgId?: string };

export const LIMITS = {
  callsPerHour: 300,
  trashPerWindow: 10,
  trashWindowMin: 10,
  batchTrashMax: 10,
  batchTaskChangesMax: 50,
  confirmTtlMin: 10,
} as const;

/** Policy refusals; their message is shown to the caller. */
export class PolicyError extends InputError {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const isCode = (c: Caller) => c.actor === 'claude-code';

/** Permanent deletion and admin operations, as tools or apply_changes ops. None exist on MCP today; listed so adding one can't silently open it to Claude Code. */
const BLOCKED = new Set(['purge_trash', 'purge_task', 'empty_trash', 'delete_forever', 'purge_note', 'register_commands', 'import_tasks', 'admin']);
const TRASH_TOOLS = new Set(['delete_task', 'delete_note']);
const TRASH_OPS = new Set(['delete_task', 'delete_note']);
/** Ops that change an existing task (create_task and comments don't count toward the 50). */
const TASK_CHANGE_OPS = new Set(['update_task', 'log_progress', 'complete_task', 'update_checklist', 'archive_task', 'delete_task', 'restore_task']);
/** Fields whose change by Claude Code on someone else's task tells Om. */
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
      return { key, also: ['status'] };
    case 'archive_task':
      return { key, also: ['archived'] };
    case 'delete_task':
      return { key, trash: true };
    case 'restore_task':
      return { key, restore: true };
    default:
      return null; // comments, checklist ticks and restores don't change what Om relies on
  }
}

async function countSince(keyId: string, kind: 'call' | 'trash', since: Date): Promise<number> {
  const c = await collections();
  const r = await c.policyEvents
    .aggregate<{ n: number }>([{ $match: { keyId, kind, at: { $gte: since } } }, { $group: { _id: null, n: { $sum: { $ifNull: ['$n', 1] } } } }])
    .toArray();
  return r[0]?.n ?? 0;
}

async function record(keyId: string, kind: 'call' | 'trash', n = 1): Promise<string> {
  const _id = randomUUID();
  await (await collections()).policyEvents.insertOne({ _id, keyId, kind, at: new Date(), ...(n !== 1 ? { n } : {}) });
  return _id;
}

async function unrecord(id: string | undefined): Promise<void> {
  if (id) await (await collections()).policyEvents.deleteOne({ _id: id }).catch(() => {});
}

/**
 * Atomic limit check: record the event first, then count the window including it. If that is
 * over the limit, the event is removed and the call refused, so parallel calls can't all slip
 * under the cap (each one sees the others' events). Returns the event id, or null when refused.
 */
async function reserve(keyId: string, kind: 'call' | 'trash', n: number, since: Date, limit: number): Promise<{ id: string; total: number } | { id: null; total: number }> {
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

const trashWindowStart = () => new Date(Date.now() - LIMITS.trashWindowMin * 60_000);

/** Runs before every tool call. Throws PolicyError to refuse. */
export async function beforeTool(caller: Caller, tool: string): Promise<void> {
  if (!isCode(caller)) return;
  const keyId = caller.keyId!;
  if (BLOCKED.has(tool)) throw new PolicyError(`${tool} is not available to Claude Code keys (permanent deletion and admin stay with Om).`);
  const call = await reserve(keyId, 'call', 1, new Date(Date.now() - 3_600_000), LIMITS.callsPerHour);
  if (!call.id) {
    throw new PolicyError(`Rate limit: this key made ${call.total} Work OS calls in the last hour (max ${LIMITS.callsPerHour}). Wait a few minutes, or batch work with apply_changes.`);
  }
  if (TRASH_TOOLS.has(tool)) {
    const t = await reserve(keyId, 'trash', 1, trashWindowStart(), LIMITS.trashPerWindow);
    if (!t.id) {
      throw new PolicyError(
        `Too many deletions: ${t.total} items moved to trash in the last ${LIMITS.trashWindowMin} minutes (max ${LIMITS.trashPerWindow}). Ask Om first, or use apply_changes with dry_run: true and its confirm token.`,
      );
    }
  }
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
    await (await collections()).policyEvents.insertOne({ _id, keyId, kind: 'confirm', at: new Date() } as unknown as PolicyEventDoc);
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
  const keyId = caller.keyId!;
  const blocked = ops.find(o => BLOCKED.has(o.op));
  if (blocked) throw new PolicyError(`Op ${blocked.op} is not available to Claude Code keys (permanent deletion and admin stay with Om).`);
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

// ── Notify Om when Claude Code changes his tasks ────────────────────────────

type Snap = Pick<Task, 'id' | 'ref' | 'title' | 'priority' | 'due' | 'projectId' | 'status' | 'archived' | 'createdBy'>;
export type Watch = { caller: Caller; before: Map<string, Snap>; trashed: Set<string>; restored: Set<string>; fields: Map<string, Set<string>> };

/** Things to watch in one call: task keys with the watched fields they set (args) or may change (also), and keys being trashed. */
export type WatchTarget = { key: string | number; args?: Record<string, unknown>; also?: string[]; trash?: boolean; restore?: boolean };

/** Snapshots the tasks a Claude Code call is about to change (before the change). No-op for other callers. */
export async function watchTasks(caller: Caller, targets: WatchTarget[]): Promise<Watch | null> {
  if (!isCode(caller)) return null;
  const w: Watch = { caller, before: new Map(), trashed: new Set(), restored: new Set(), fields: new Map() };
  for (const t of targets) {
    if (typeof t.key === 'string' && t.key.startsWith('$')) continue; // created in this batch
    if (t.restore) {
      const m = String(t.key).match(/^#?(\d+)$/);
      const tr = await (await collections()).trash.findOne(m ? { ref: Number(m[1]) } : { _id: String(t.key) }, { sort: { deletedAt: -1 }, projection: { task: 1 } });
      if (tr && tr.task.createdBy !== 'claude-code') {
        w.before.set(tr.task._id, { id: tr.task._id, ref: tr.task.ref, title: tr.task.title, priority: tr.task.priority, due: tr.task.due, projectId: tr.task.projectId, status: tr.task.status, archived: tr.task.archived, createdBy: tr.task.createdBy });
        w.restored.add(tr.task._id);
      }
      continue;
    }
    const fields = WATCHED.filter(f => (t.args && t.args[f.arg] !== undefined) || t.also?.includes(f.label)).map(f => f.label);
    if (!t.trash && !fields.length) continue;
    const task = await tasks.getTask(t.key).catch(() => null);
    if (!task || task.createdBy === 'claude-code') continue;
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

/** After a successful call: one inbox notice listing what changed. Best effort; never fails the call. */
export async function notifyChanges(w: Watch | null): Promise<void> {
  if (!w) return;
  try {
    const settings = await getNotifySettings();
    if (settings.kinds.claude_code_changes === false) return;
    const lines: string[] = [];
    let firstRef: number | null = null;
    for (const [id, b] of w.before) {
      if (w.trashed.has(id) || w.restored.has(id)) {
        lines.push(`#${b.ref} ${b.title}: ${w.trashed.has(id) ? 'moved to trash' : 'restored from trash'}`);
        firstRef ??= b.ref;
        continue;
      }
      const now = await tasks.getTask(id).catch(() => null);
      if (!now) continue;
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
    const who = w.caller.keyName ? `Claude Code (${w.caller.keyName})` : 'Claude Code';
    await addToInbox([
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
