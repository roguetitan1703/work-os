import { scanRoots, publicFolder } from './scan.mjs';
import { validateJob, insideRoot } from './validate.mjs';
import { matchesClaudeProcess } from './launch.mjs';
import { writeMarker, removeMarker } from './markers.mjs';
import { trustFolder } from './trust.mjs';

export const VERSION = '0.1.0';
const MISS_MS = 20000; // claude must be missing this long before the session counts as closed
const GRACE_MS = 45000; // a just-launched session may not show in the process list yet

// deps: { getConfig, state, save, api, launcher, listProcesses, killPid, now?, log? }
export function createCore(deps) {
  const { getConfig, state, save, api, launcher, listProcesses, killPid } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  state.doneJobs = Array.isArray(state.doneJobs) ? state.doneJobs : [];
  let links = [];
  let pendingResults = [];
  let lastStatus = 0;

  const roots = () => getConfig().roots;
  const errMsg = (e) => String((e && e.message) || e).slice(0, 300);

  function scan() {
    const cfg = getConfig();
    const found = scanRoots({ roots: cfg.roots, maxDepth: cfg.maxDepth, knownIds: state.ids });
    return found;
  }

  async function scanAndReport() {
    const found = scan();
    await api.postFolders(found.map(publicFolder));
    state.ids = {};
    state.folders = {};
    for (const f of found) { state.ids[f.path] = f.id; state.folders[f.id] = f.path; }
    state.lastScan = now();
    save();
    log(`scan reported ${found.length} folders`);
    return found.length;
  }

  function applyLinks(list) {
    links = Array.isArray(list) ? list : [];
    const linked = new Set();
    for (const l of links) {
      if (!l || typeof l.folderId !== 'string') continue;
      const dir = Object.prototype.hasOwnProperty.call(state.folders, l.folderId) ? insideRoot(state.folders[l.folderId], roots()) : null;
      if (!dir) continue;
      linked.add(l.folderId);
      try {
        const r = writeMarker(dir, { projectId: l.projectId, projectName: l.projectName, folderId: l.folderId });
        if (r !== 'foreign') state.markers[l.folderId] = true;
        trustFolder(dir, log);
      } catch (e) { log('marker write failed: ' + errMsg(e)); }
    }
    for (const id of Object.keys(state.markers)) {
      if (linked.has(id)) continue;
      const p = state.folders[id];
      if (p) { try { removeMarker(p); } catch {} }
      delete state.markers[id];
    }
    save();
  }

  async function handleJob(job) {
    const id = job && typeof job.id === 'string' ? job.id : 'unknown';
    // Already started (a re-offered job): never open a second window for the same session.
    if (job && job.kind === 'start' && typeof job.sessionId === 'string' && state.sessions[job.sessionId] && state.sessions[job.sessionId].folderId === job.folderId) return { id, ok: true };
    const v = validateJob(job, { folders: state.folders, roots: roots() });
    if (!v.ok) return { id, ok: false, error: v.error };
    try {
      if (job.kind === 'stop') {
        const s = state.sessions[job.sessionId];
        if (!s) return { id, ok: false, error: 'unknown session' };
        const procs = (await listProcesses()).filter((p) => matchesClaudeProcess(p, job.sessionId));
        s.state = 'stopped';
        if (!procs.length) return { id, ok: false, error: 'session not running' };
        for (const p of procs) { try { await killPid(p.pid); } catch {} }
        return { id, ok: true };
      }
      const link = links.find((l) => l.folderId === job.folderId);
      if (!link || !link.projectId) return { id, ok: false, error: 'folder not linked to a project' };
      const projectId = job.projectId || (link && link.projectId);
      const projectName = job.projectName || (link && link.projectName);
      if (projectId && projectName) writeMarker(v.dir, { projectId, projectName, folderId: job.folderId });
      if (projectId && projectName) state.markers[job.folderId] = true;
      trustFolder(v.dir, log);
      await launcher({ kind: job.kind, folder: v.dir, sessionId: job.sessionId, projectName: projectName || undefined, prompt: job.kind === 'start' && getConfig().allowPrompts !== false ? job.prompt || undefined : undefined });
      state.sessions[job.sessionId] = { folderId: job.folderId, state: 'running', startedAt: now() };
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, error: errMsg(e) };
    }
  }

  async function refreshSessions() {
    const ids = Object.keys(state.sessions).filter((k) => state.sessions[k].state === 'running');
    if (!ids.length) return;
    const procs = await listProcesses();
    for (const sid of ids) {
      const s = state.sessions[sid];
      const alive = procs.some((p) => matchesClaudeProcess(p, sid));
      if (alive) { delete s.missingSince; continue; }
      if (now() - s.startedAt <= GRACE_MS) continue;
      // One empty process listing (slow or failed query) must not close a live session: it has to be
      // missing on checks at least MISS_MS apart.
      if (!s.missingSince) s.missingSince = now();
      else if (now() - s.missingSince >= MISS_MS) s.state = 'dead';
    }
  }

  async function sendStatus() {
    try { await refreshSessions(); } catch (e) { log('liveness failed: ' + errMsg(e)); }
    const sessions = Object.entries(state.sessions).map(([sessionId, s]) => ({ sessionId, folderId: s.folderId, state: s.state }));
    // allowPrompts: tells the server whether a first message reaches Claude here. The task dispatcher only sends tasks to a worker that says true.
    const body = { worker: { version: VERSION, os: process.platform, allowPrompts: getConfig().allowPrompts !== false }, jobs: pendingResults, sessions };
    // Counts only (docs/launcher.md "Activity counts"); a failed count never blocks the heartbeat.
    if (deps.activity) {
      try {
        const ids = Object.keys(state.sessions).filter((k) => state.sessions[k].state === 'running');
        const a = await deps.activity(ids);
        if (a && a.list) { body.activity = a.counts; body.claudeSessions = a.list; } else body.activity = a;
      } catch (e) { log('activity count failed: ' + errMsg(e)); }
    }
    await api.postStatus(body);
    pendingResults = [];
    lastStatus = now();
    for (const sid of Object.keys(state.sessions)) if (state.sessions[sid].state !== 'running') delete state.sessions[sid];
    save();
  }

  // One poll cycle. Returns pollSeconds suggested by the server.
  async function pollOnce() {
    const res = await api.getJobs();
    state.lastPoll = now();
    if (res && res.enabled === false) { save(); return { pollSeconds: 30, disabled: true }; }
    applyLinks(res && res.links);
    const jobs = Array.isArray(res && res.jobs) ? res.jobs : [];
    for (const job of jobs) {
      const prior = job && state.doneJobs.find((d) => d.id === job.id);
      if (prior) { pendingResults.push({ id: prior.id, ok: prior.ok, ...(prior.error ? { error: prior.error } : {}) }); await sendStatus(); continue; }
      const r = await handleJob(job);
      pendingResults.push(r);
      if (job && typeof job.id === 'string') {
        state.doneJobs.push({ id: r.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
        state.doneJobs = state.doneJobs.slice(-200);
      }
      save();
      await sendStatus();
    }
    if (now() - lastStatus >= 55000) await sendStatus();
    save();
    const ps = Number(res && res.pollSeconds);
    return { pollSeconds: Number.isFinite(ps) ? Math.min(60, Math.max(3, ps)) : 10 };
  }

  return { scan, scanAndReport, pollOnce, applyLinks, handleJob, sendStatus, get links() { return links; } };
}
