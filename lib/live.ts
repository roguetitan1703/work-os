import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

// Push (docs/multi-user.md "As built: phase 5 push"). Open pages and workers hold one Server-Sent Events stream each
// (app/api/stream, app/api/worker/stream). This is the in-process hub behind them:
//
//   hint(orgId, audience, topic)   "refresh <topic>" to the pages of the people in audience. Called by the data door
//                                  (lib/scope.ts) after every write, with the people who can read what changed.
//   wake(orgId, userId, deviceId?) "poll now" to that person's workers (or one computer of theirs).
//   closeFor / closeDevice         a removed member's streams, a revoked computer's streams.
//
// Events carry no data: a topic name (tasks, projects, notes, claude, inbox, review) and whether the change was the
// person's own. Pages fetch the page again through the normal, checked path; workers poll /api/worker/jobs.
// One process holds every stream (one EC2 server): with more than one instance this needs a shared bus.

export type Topic = 'tasks' | 'projects' | 'notes' | 'claude' | 'inbox' | 'review';
/** Who gets a hint: everyone in the organization ('*'), or these people. */
export type Audience = '*' | ReadonlySet<string>;

type Conn = {
  id: number;
  kind: 'page' | 'worker';
  orgId: string;
  userId: string;
  deviceId?: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
  /** Hints waiting for the next flush: topic -> every write was this person's own. */
  pending?: Map<Topic, boolean>;
  timer?: ReturnType<typeof setTimeout>;
};

type Hub = { conns: Map<number, Conn>; next: number };
// On globalThis: route handlers, actions and pages can each load their own copy of this module in one process.
const g = globalThis as unknown as { __workosLive?: Hub };
const hub: Hub = (g.__workosLive ??= { conns: new Map(), next: 1 });

/** Hints that arrive close together go out as one (a batch of 50 writes is one refresh). */
const COALESCE_MS = 250;

export function register(c: Omit<Conn, 'id'>): () => void {
  const conn: Conn = { ...c, id: hub.next++ };
  hub.conns.set(conn.id, conn);
  return () => {
    if (conn.timer) clearTimeout(conn.timer);
    hub.conns.delete(conn.id);
  };
}

/** Who in this organization has a page open. A write does no push work at all when nobody has. */
export function pageUsers(orgId: string): Set<string> {
  const out = new Set<string>();
  for (const c of hub.conns.values()) if (c.kind === 'page' && c.orgId === orgId) out.add(c.userId);
  return out;
}

export function hint(orgId: string, audience: Audience, topic: Topic, writer?: string | null): void {
  for (const c of hub.conns.values()) {
    if (c.kind !== 'page' || c.orgId !== orgId) continue;
    if (audience !== '*' && !audience.has(c.userId)) continue;
    const own = !!writer && writer === c.userId;
    const p = (c.pending ??= new Map());
    p.set(topic, p.has(topic) ? p.get(topic)! && own : own);
    c.timer ??= setTimeout(() => {
      c.timer = undefined;
      const out = c.pending;
      c.pending = undefined;
      for (const [t, self] of out ?? []) c.send('hint', self ? { t, s: 1 } : { t });
    }, COALESCE_MS);
  }
}

/** Tell a person's workers to poll now (deviceId: only that computer). */
export function wake(orgId: string, userId: string, deviceId?: string): void {
  for (const c of hub.conns.values()) {
    if (c.kind !== 'worker' || c.orgId !== orgId || c.userId !== userId) continue;
    if (deviceId && c.deviceId !== deviceId) continue;
    c.send('jobs', {});
  }
}

/** Close every stream of a person in an organization (removed member): pages and workers. */
export function closeFor(orgId: string, userId: string): number {
  let n = 0;
  for (const c of [...hub.conns.values()]) {
    if (c.orgId !== orgId || c.userId !== userId) continue;
    c.close();
    n++;
  }
  return n;
}

/** Close a computer's streams (revoked). */
export function closeDevice(deviceId: string): void {
  for (const c of [...hub.conns.values()]) if (c.kind === 'worker' && c.deviceId === deviceId) c.close();
}

/** Computers whose worker holds a stream right now (shown online, their last report counts as current). */
export function connectedDevice(deviceId: string): boolean {
  for (const c of hub.conns.values()) if (c.kind === 'worker' && c.deviceId === deviceId) return true;
  return false;
}

/** Counts for the status panel and tests. */
export function liveCounts(): { pages: number; workers: number } {
  let pages = 0;
  let workers = 0;
  for (const c of hub.conns.values()) {
    if (c.kind === 'page') pages++;
    else workers++;
  }
  return { pages, workers };
}

// Writes inside quietly() send no hints (a worker's heartbeat: reportStatus decides itself what is worth one).
const quiet = new AsyncLocalStorage<true>();
export const quietly = <T>(fn: () => T): T => quiet.run(true, fn);
export const isQuiet = (): boolean => quiet.getStore() === true;
