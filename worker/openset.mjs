// "Reopen after a restart": the worker remembers which sessions were open (a running process, per the session list)
// and, when it starts and finds some of them gone, keeps them as a pending set until the person reopens or dismisses.
// Local state only (state.openSet, state.reopen); an entry is a session id, where it was made, and the title/folder
// name the Claude page already shows. Never a path, never transcript text.

export const REOPEN_MAX_AGE_MS = 7 * 24 * 3600_000;
export const REOPEN_MAX = 20;
const keep = (s, at) => ({ sessionId: s.sessionId, origin: s.origin || 'other', title: String(s.title || '').slice(0, 80), folder: String(s.folder || '').slice(0, 80), at });

// list: the worker's session list (running flags). first: the first list since this worker started.
export function trackOpenSet(state, list, now, first) {
  const running = list.filter((s) => s.running);
  const runIds = new Set(running.map((s) => s.sessionId));
  state.reopen = Array.isArray(state.reopen) ? state.reopen : [];
  state.openSet = Array.isArray(state.openSet) ? state.openSet : [];
  if (first) {
    const have = new Set(state.reopen.map((s) => s.sessionId));
    for (const s of state.openSet) if (!runIds.has(s.sessionId) && !have.has(s.sessionId) && now - s.at <= REOPEN_MAX_AGE_MS) state.reopen.push(s);
  }
  // opened again (by hand or by a tap): no longer pending; old ones expire
  state.reopen = state.reopen.filter((s) => !runIds.has(s.sessionId) && now - s.at <= REOPEN_MAX_AGE_MS).slice(0, REOPEN_MAX);
  state.openSet = running.slice(0, 50).map((s) => keep(s, now));
}

// What the status carries: no timestamps, only what the page shows.
export const reopenReport = (state) => (state.reopen || []).map(({ sessionId, origin, title, folder }) => ({ sessionId, origin, title, folder }));
