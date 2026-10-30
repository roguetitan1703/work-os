import fs from 'node:fs';
import path from 'node:path';
import { scanRoots, publicFolder } from './scan.mjs';
import { sessionProcs } from './activity.mjs';
import { trackOpenSet, reopenReport } from './openset.mjs';
import { validateJob, insideRoot } from './validate.mjs';
import { matchesClaudeProcess } from './launch.mjs';
import { writeMarker, removeMarker } from './markers.mjs';
import { trustFolder } from './trust.mjs';
import { handleCloneJob, projectsDirOf } from './clone.mjs';

import { bundleId } from './config.mjs';

export const VERSION = '0.3.0';
const MISS_MS = 20000; // claude must be missing this long before the session counts as closed
const OPEN_WINDOW_MS = 60_000;
const OPEN_MAX_PER_MIN = 4;
const GRACE_MS = 45000; // a just-launched session may not show in the process list yet

// deps: { getConfig, state, save, api, launcher, listProcesses, killPid, now?, log? }
// Status (heartbeat, session list, counts) at most this often between jobs: each one is a server request.
export const STATUS_EVERY_MS = 110_000;
// With push up (push.mjs) and no Work OS session running, a status goes out only when what it says has changed; the
// open stream already tells the server the computer is on. At least this often anyway.
export const STATUS_IDLE_MS = 30 * 60_000;

export function createCore(deps) {
  const { getConfig, state, save, api, launcher, listProcesses, killPid } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  state.doneJobs = Array.isArray(state.doneJobs) ? state.doneJobs : [];
  let links = [];
  let pendingResults = [];
  let lastStatus = 0;
  let lastSent = '';
  let tracked = false; // the first session list since this worker started has been compared with the remembered open set
  let savedOpen = '';

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

  // Where a session may be opened: the folder it started in, read from its transcript on this computer, must be inside an
  // allowed root and at or below a scanned folder that is linked to a project (the checks a resume makes).
  function locate(sessionId) {
    const loc = deps.sessionLocal ? deps.sessionLocal(sessionId) : null;
    if (!loc) return { error: 'session not found on this computer' };
    if (!loc.cwd || !path.isAbsolute(loc.cwd)) return { error: 'session folder unknown' };
    const dir = insideRoot(loc.cwd, roots());
    if (!dir) return { error: 'folder outside allowed roots' };
    try { if (!fs.statSync(dir).isDirectory()) return { error: 'session folder unknown' }; } catch { return { error: 'session folder unknown' }; }
    for (const l of links) {
      if (!l || !l.projectId || typeof l.folderId !== 'string' || !Object.prototype.hasOwnProperty.call(state.folders, l.folderId)) continue;
      const base = insideRoot(state.folders[l.folderId], roots());
      if (!base) continue;
      const rel = path.relative(base, dir);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { dir, origin: loc.origin, link: l };
    }
    return { error: 'folder not linked to a project' };
  }

  async function openPending() {
    const pending = Array.isArray(state.reopen) ? state.reopen : [];
    state.reopen = [];
    if (!pending.length) return { id: '', ok: true };
    const running = sessionProcs(await listProcesses()).byId;
    let opened = 0;
    const why = new Set();
    const bg = [];
    for (const s of pending) {
      if (running.has(s.sessionId)) continue;
      const l = locate(s.sessionId);
      if (l.error) { why.add(l.error); continue; }
      try {
        if (s.origin === 'vscode') {
          if (!deps.openVscode) throw new Error('VS Code not found');
          bg.push(deps.openVscode({ folder: l.dir, sessionId: s.sessionId }).catch((e) => log('vscode open failed: ' + errMsg(e))));
        } else {
          trustFolder(l.dir, log);
          await launcher({ kind: 'resume', folder: l.dir, sessionId: s.sessionId, projectName: l.link.projectName || undefined });
        }
        opened++;
      } catch (e) { why.add(errMsg(e)); }
    }
    Promise.allSettled(bg).then(() => save());
    // ok only when every one that was not already running was opened; the message says how many and why not.
    const todo = pending.filter((s) => !running.has(s.sessionId)).length;
    return why.size ? { id: '', ok: false, error: `Opened ${opened} of ${todo}: ${[...why].join('; ')}`.slice(0, 300) } : { id: '', ok: true };
  }

  async function handleJob(job) {
    const id = job && typeof job.id === 'string' ? job.id : 'unknown';
    // Turbo mode (clone.mjs): a start job with no folder yet; the worker makes the folder, clones, links and starts.
    if (job && job.kind === 'start' && job.clone) return handleCloneJob(job, { getConfig, state, save, api, launcher, scanAndReport, scan, log, now });
    // Already started (a re-offered job): never open a second window for the same session.
    if (job && job.kind === 'start' && typeof job.sessionId === 'string' && state.sessions[job.sessionId] && state.sessions[job.sessionId].folderId === job.folderId) return { id, ok: true };
    const v = validateJob(job, { folders: state.folders, roots: roots() });
    if (!v.ok) return { id, ok: false, error: v.error };
    try {
      if (job.kind === 'dismiss') { state.reopen = []; save(); return { id, ok: true }; }
      if (job.kind === 'reopen') { const r = await openPending(); save(); return { ...r, id }; }
      if (job.kind === 'vscode') {
        if (!deps.openVscode) return { id, ok: false, error: 'Opening in VS Code is not available on this computer' };
        // The same session again within a minute (a double tap, or a job offered again after a crash) opens nothing more;
        // and no more than OPEN_MAX_PER_MIN opens a minute, whoever asks.
        const t = now();
        const opens = (state.vscodeOpens = (state.vscodeOpens || []).filter((o) => t - o.at < OPEN_WINDOW_MS));
        if (opens.some((o) => o.sessionId === job.sessionId)) return { id, ok: true };
        if (opens.length >= OPEN_MAX_PER_MIN) return { id, ok: false, error: 'Too many opens at once, try again in a minute' };
        const l = locate(job.sessionId);
        if (l.error) return { id, ok: false, error: l.error };
        opens.push({ sessionId: job.sessionId, at: t });
        save();
        await deps.openVscode({ folder: l.dir, sessionId: job.sessionId });
        return { id, ok: true };
      }
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

  // Turbo mode as the server shows it: whether this PC clones, and where (the projects folder; the one path that is sent, by design).
  function cloneInfo() {
    const cfg = getConfig();
    const dir = projectsDirOf(cfg);
    return { allowClone: cfg.allowClone !== false, ...(dir ? { projectsDir: dir } : {}) };
  }

  async function buildStatus() {
    try { await refreshSessions(); } catch (e) { log('liveness failed: ' + errMsg(e)); }
    const sessions = Object.entries(state.sessions).map(([sessionId, s]) => ({ sessionId, folderId: s.folderId, state: s.state }));
    // allowPrompts: tells the server whether a first message reaches Claude here. The task dispatcher only sends tasks to a worker that says true.
    const body = { worker: { version: VERSION, os: process.platform, ...(bundleId() ? { bundle: bundleId().slice(0, 12) } : {}), allowPrompts: getConfig().allowPrompts !== false, ...cloneInfo() }, jobs: pendingResults, sessions };
    // Counts only (docs/launcher.md "Activity counts"); a failed count never blocks the heartbeat.
    if (deps.activity) {
      try {
        const ids = Object.keys(state.sessions).filter((k) => state.sessions[k].state === 'running');
        const a = await deps.activity(ids);
        if (a && a.list) {
          body.activity = a.counts;
          body.claudeSessions = a.list;
          trackOpenSet(state, a.list, now(), !tracked);
          tracked = true;
          body.reopen = reopenReport(state);
          const snap = JSON.stringify([state.openSet, state.reopen]);
          if (snap !== savedOpen) { savedOpen = snap; save(); } // survives a crash: the next start compares with it
        } else body.activity = a;
      } catch (e) { log('activity count failed: ' + errMsg(e)); }
    }
    return body;
  }

  async function sendStatus(prebuilt) {
    const body = prebuilt || (await buildStatus());
    await api.postStatus(body);
    lastSent = statusKey(body);
    pendingResults = [];
    lastStatus = now();
    for (const sid of Object.keys(state.sessions)) if (state.sessions[sid].state !== 'running') delete state.sessions[sid];
    save();
  }

  const statusKey = (b) => JSON.stringify([b.worker, b.sessions, b.activity ?? null, b.claudeSessions ?? null, b.reopen ?? null]);
  const busy = () => pendingResults.length > 0 || Object.values(state.sessions).some((s) => s.state === 'running');

  // The status timer (every STATUS_EVERY_MS). pushUp: the push stream is connected (push.mjs). Without push, or with
  // a Work OS session running or job results to send, it is the heartbeat as before; with push and nothing running,
  // it sends only what changed (and at least every STATUS_IDLE_MS). Returns true if it sent.
  async function statusTick(pushUp) {
    if (!pushUp || busy()) {
      if (now() - lastStatus < STATUS_EVERY_MS) return false;
      await sendStatus();
      return true;
    }
    const body = await buildStatus();
    if (statusKey(body) === lastSent && now() - lastStatus < STATUS_IDLE_MS) return false;
    await sendStatus(body);
    return true;
  }

  // One poll cycle. Returns pollSeconds suggested by the server. opts.statusByTimer: the caller runs statusTick on
  // its own timer, so the poll does not send the periodic status (job results still go out at once).
  async function pollOnce(opts = {}) {
    const res = await api.getJobs();
    state.lastPoll = now();
    if (res && res.enabled === false) { save(); return { pollSeconds: 30, disabled: true }; }
    applyLinks(res && res.links);
    const jobs = Array.isArray(res && res.jobs) ? res.jobs : [];
    for (const job of jobs) {
      const prior = job && state.doneJobs.find((d) => d.id === job.id);
      if (prior) { pendingResults.push({ id: prior.id, ok: prior.ok, ...(prior.error ? { error: prior.error } : {}), ...(prior.folderId ? { folderId: prior.folderId } : {}), ...(prior.untrusted ? { untrusted: true } : {}) }); await sendStatus(); continue; }
      const r = await handleJob(job);
      pendingResults.push(r);
      if (job && typeof job.id === 'string') {
        state.doneJobs.push({ id: r.id, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.folderId ? { folderId: r.folderId } : {}), ...(r.untrusted ? { untrusted: true } : {}) });
        state.doneJobs = state.doneJobs.slice(-200);
      }
      save();
      await sendStatus();
    }
    if (!opts.statusByTimer && now() - lastStatus >= STATUS_EVERY_MS) await sendStatus();
    save();
    const ps = Number(res && res.pollSeconds);
    return { pollSeconds: Number.isFinite(ps) ? Math.min(60, Math.max(3, ps)) : 10 };
  }

  return { scan, scanAndReport, pollOnce, applyLinks, handleJob, sendStatus, statusTick, get links() { return links; } };
}
