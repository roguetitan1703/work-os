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
// Limits: a person holds at most PAGE_CAP page streams and a computer WORKER_CAP worker streams; a new one past that
// closes the oldest (bye 'limit'). A person or computer just closed cannot register for CLOSED_HOLD_MS, so a stream
// that passed its check just before the removal and registers just after it is refused.
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
  close: (reason?: 'closed' | 'limit') => void;
  /** Hints waiting for the next flush: topic -> every write was this person's own. */
  pending?: Map<Topic, boolean>;
  timer?: ReturnType<typeof setTimeout>;
};

type Waiter = { id: number; key: string; done: (r: 'signal' | 'timeout' | 'bumped') => void };
type Hub = { conns: Map<number, Conn>; next: number; closed: Map<string, number>; waiters: Map<string, Waiter>; nextWaiter: number };
// On globalThis: route handlers, actions and pages can each load their own copy of this module in one process.
const g = globalThis as unknown as { __workosLive?: Hub };
const hub: Hub = (g.__workosLive ??= { conns: new Map(), next: 1, closed: new Map(), waiters: new Map(), nextWaiter: 1 });
hub.closed ??= new Map();
hub.waiters ??= new Map();
hub.nextWaiter ??= 1;

export const PAGE_CAP = 10;
export const WORKER_CAP = 2;
const CLOSED_HOLD_MS = 30_000;

const memberKey = (orgId: string, userId: string) => `u:${orgId}:${userId}`;
const deviceKey = (deviceId: string) => `d:${deviceId}`;

function hold(key: string): void {
  const now = Date.now();
  for (const [k, at] of hub.closed) if (now - at > CLOSED_HOLD_MS) hub.closed.delete(k);
  hub.closed.set(key, now);
}
const held = (key: string): boolean => {
  const at = hub.closed.get(key);
  return at !== undefined && Date.now() - at <= CLOSED_HOLD_MS;
};

/** Hints that arrive close together go out as one (a batch of 50 writes is one refresh). */
const COALESCE_MS = 250;

/** Adds a stream; null when its person or computer was closed moments ago (the caller ends it with bye 'closed'). */
export function register(c: Omit<Conn, 'id'>): (() => void) | null {
  if (held(memberKey(c.orgId, c.userId)) || (c.deviceId && held(deviceKey(c.deviceId)))) return null;
  // Past the cap the oldest go (Map order is open order). Pages count per person across organizations.
  const same = [...hub.conns.values()].filter(x =>
    c.kind === 'page' ? x.kind === 'page' && x.userId === c.userId : x.kind === 'worker' && x.deviceId === c.deviceId,
  );
  const cap = c.kind === 'page' ? PAGE_CAP : WORKER_CAP;
  for (const old of same.slice(0, Math.max(0, same.length - cap + 1))) old.close('limit');
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

/**
 * Idle Claude Code sessions waiting for a message (POST /api/agent/wait): one waiter per session key, at most WAITER_CAP in
 * all. A new waiter for a session answers the old one 'bumped' (a session has one hook waiting at a time); past the cap the
 * oldest of all is bumped. Signals carry a session key and no data: the waiter reads the database itself, through its own door.
 */
export const WAITER_CAP = 500;
const waitKey = (orgId: string, sessionKey: string) => `${orgId}|${sessionKey}`;

/** Resolves 'signal' when signalSessions names this session, 'timeout' after `ms`, 'bumped' when a newer waiter took its place. */
export function waitFor(orgId: string, sessionKey: string, ms: number): Promise<'signal' | 'timeout' | 'bumped'> {
  const key = waitKey(orgId, sessionKey);
  hub.waiters.get(key)?.done('bumped');
  while (hub.waiters.size >= WAITER_CAP) hub.waiters.values().next().value?.done('bumped');
  return new Promise(resolve => {
    const id = hub.nextWaiter++;
    const timer = setTimeout(() => w.done('timeout'), Math.max(0, ms));
    const w: Waiter = {
      id,
      key,
      done: r => {
        clearTimeout(timer);
        if (hub.waiters.get(key)?.id === id) hub.waiters.delete(key);
        resolve(r);
      },
    };
    hub.waiters.set(key, w);
  });
}

/** Tell these sessions (keys: userId:session) of an organization that something may be waiting for them. */
export function signalSessions(orgId: string, keys: readonly string[]): void {
  for (const k of keys) hub.waiters.get(waitKey(orgId, k))?.done('signal');
}

/** Idle sessions waiting right now (tests and the status panel). */
export const waiterCount = (): number => hub.waiters.size;

/** Close every stream of a person in an organization (removed member): pages and workers. */
export function closeFor(orgId: string, userId: string): number {
  hold(memberKey(orgId, userId));
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
  hold(deviceKey(deviceId));
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
