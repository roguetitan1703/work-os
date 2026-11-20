// SessionStart hook (also after compaction): start_work for the repo in the cwd; the brief goes into the session's context.
// Signing in, the first that applies:
//   the worker    this PC's worker device key (wkr_, kept by the worker in DPAPI / Keychain) and the baseUrl of the
//                 worker config this copy was installed beside: POST /api/agent/start answers the brief and a session
//                 token (wst_) for this one session and project. The token is kept in <hooks folder>/sessions and
//                 shown instead of the device key after a compaction, and it is what lets the other hooks report the
//                 session's state. Only the installed copy takes this path: its own folder decides which config and key
//                 it reads (WORK_OS_URL and WORK_OS_WORKER_DIR are ignored here, so a repo's settings cannot send the
//                 device key elsewhere). Neither key nor token is ever printed.
//   WORK_OS_KEY   (in the "env" block of settings.json) a Work OS Claude Code key (wos_...): start_work on /api/mcp at
//                 WORK_OS_URL (default: the worker config's baseUrl). The only way for a PC without the worker, and
//                 the fallback on a PC with one when the worker gives no brief (folder not linked, key refused, no
//                 network). That session has no token, so it sends no state events.
import os from 'node:os';
import { identityKey, identityOf } from './hook-identity.mjs';
import { MAX_BRIEF, SESSION_TOKEN_RE, cut, deps, folderCandidates, frameInbox, git, keepProc, mcpCall, pruneOld, quickProcess, postAgent, quietPath, readKept, readMarker, keepToken, withinDeadline, repoFacts, run, sizeOf, statusHash, str, unfiledText, workerHome, writeMarker } from './hook-lib.mjs';

// The folder decides the project (H13): the body carries the ids of the worker folders that contain the session's folder
// (`folders`, longest first); the server takes the first one linked on this PC. The git remote is sent as information only.
// A folder no project owns is "unfiled": the session is told, once, to ask its person which project it is for and to file it
// with start_work (link), or to mark it not Work OS. Quiet (nothing printed): `claude -p` and SDK runs, temp folders, and a
// folder the person marked not Work OS.

/**
 * The brief through the worker's device key (POST /api/agent/start), or null. A session token kept from this session's
 * start is shown first; when it is refused (expired, revoked, another project) the device key opens a new session.
 * Returns { brief, token?, until? } (token and until only when a new session was made), or { unfiled: true, quiet } when
 * no project owns the folder (the server's 404), or null (over the limit, server trouble, no key).
 */
async function agentStart(body, kept, timeoutMs) {
  const home = workerHome();
  if (!home) return null;
  const post = (cred) => postAgent('/api/agent/start', cred, body, timeoutMs);
  if (kept && SESSION_TOKEN_RE.test(kept)) {
    const r = await post(kept);
    if (r.status === 200 && r.b?.brief) return { brief: r.b.brief, ...dispatchedOf(r.b) };
    if (r.status === 200 && r.b?.unfiled === true) return { unfiled: true, quiet: r.b.quiet === true }; // still no project; the token stays this session's
    if (r.status !== 401 && r.status !== 403) return null; // over the limit, server trouble: no brief this time
  }
  const key = deps.deviceKey(home);
  if (!key || !/^wkr_[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const r = await post(key);
  if (r.unfiled) return { unfiled: true, quiet: r.quiet === true };
  // Protocol 3: a folder no project owns is a session with no project; the answer carries a token that opens only events and waits.
  if (r.status === 200 && r.b?.unfiled === true) return { unfiled: true, quiet: r.b.quiet === true, ...(SESSION_TOKEN_RE.test(r.b.token || '') ? { token: r.b.token, until: Date.parse(r.b.expiresAt || '') || undefined } : {}) };
  if (r.status !== 200 || !r.b?.brief) return null;
  const token = SESSION_TOKEN_RE.test(r.b.token || '') ? r.b.token : undefined;
  const until = Date.parse(r.b.expiresAt || '') || undefined;
  return { brief: r.b.brief, token, until, ...dispatchedOf(r.b) };
}

/** H15: the task ref when the server says the task dispatcher started this session (whatever started it on this PC); kept in the marker. */
const dispatchedOf = (b) => (Number.isInteger(b?.dispatched) && b.dispatched > 0 && b.dispatched < 1e9 ? { dispatched: b.dispatched } : {});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ['startup', 'resume', 'clear', 'compact'];

/** What the hook knows about the session's folder: the start_work arguments (remote, branch and path are information) and the worker folder ids. */
function whereOf(cwd) {
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { remote, where: { ...(remote ? { remote } : {}), subdir: git(cwd, ['rev-parse', '--show-prefix']), branch, path: cwd, machine: os.hostname().slice(0, 40) } };
}

/** The marker of a session whose brief was shown: the baseline, project, production block and presence. */
function briefMarker(sid, input, cwd, old, r, reports, dispatched) {
  const transcript = typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : old?.transcript;
  writeMarker(sid, { ...(old?.promptAt ? { promptAt: old.promptAt } : {}), ...(transcript ? { transcript, ident: identityKey(identityOf(transcript)) } : {}), ...(dispatched ?? old?.dispatched ? { dispatched: dispatched ?? old.dispatched } : {}), status: old?.status ?? statusHash(cwd), offset: old?.offset ?? sizeOf(input.transcript_path), stopped: old?.stopped ?? false, project: r.project.name || old?.project, ...('production' in r ? (r.production ? { production: r.production } : {}) : old?.production ? { production: old.production } : {}), ...(typeof r.shortOrders === 'string' && r.shortOrders ? { short: r.shortOrders.slice(0, 1200), ...(Number.isInteger(r.shortOrdersVersion) ? { shortV: r.shortOrdersVersion } : {}) } : {}), ...(Array.isArray(r.orders) ? { orders: r.orders.map((o) => o && o.noteId).filter((i) => typeof i === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(i)).slice(0, 10) } : old?.orders ? { orders: old.orders } : {}), ...(sameFolderText(r.sameFolder) ? { sameFolder: sameFolderText(r.sameFolder), sharedFolder: true } : old?.sharedFolder ? { sharedFolder: true } : {}), ...(reports ? { presence: { state: input.source === 'compact' ? 'working' : 'on', at: Date.now(), postedAt: Date.now() } } : old?.presence ? { presence: old.presence } : {}) });
}

/**
 * The session is in an unfiled folder: the marker says so (the prompt hook asks again after the person filed it; `stopped` keeps
 * the stop check quiet) and the answer is the fixed unfiled text. Nothing in a temp folder.
 */
function unfiledAnswer(sid, input, cwd, remote, folders, candidates, silent = false) {
  const folder = folders[0] || null;
  // A session with a no-project token reports its state (the other hooks post when the marker has `presence`).
  const reports = !!(sid && readKept(sid));
  const presence = reports ? { presence: { state: input.source === 'compact' ? 'working' : 'on', at: Date.now(), postedAt: Date.now() } } : {};
  if (silent || quietPath(cwd)) {
    if (sid && reports) writeMarker(sid, { ...(transcriptOf(input) ? { transcript: transcriptOf(input), ident: identityKey(identityOf(transcriptOf(input))) } : {}), status: statusHash(cwd), offset: sizeOf(input.transcript_path), stopped: true, quiet: true, ...presence });
    return null;
  }
  if (sid) writeMarker(sid, { ...(transcriptOf(input) ? { transcript: transcriptOf(input), ident: identityKey(identityOf(transcriptOf(input))) } : {}), status: statusHash(cwd), offset: sizeOf(input.transcript_path), stopped: true, unfiled: true, folder, path: cwd, ...presence });
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: unfiledText({ path: cwd, remote, folder, machine: os.hostname().slice(0, 40), candidates, worker: !!workerHome() }) } };
}

/** The transcript path of a hook input, or ''. */
const transcriptOf = (input) => (typeof input.transcript_path === 'string' ? input.transcript_path : '');

/** SessionStart: the hook's JSON answer (or null for "print nothing"). */
export async function sessionStart(input) {
  // Which process the session runs in, for the worker (Identity step 3) and the wait's parent check; every start, so a resume names
  // its new process. The pid first, before the brief (CLAUDE_PID: cheap and local); its start time after the brief and only with
  // time left (hooks review M7: on Windows that is a PowerShell call).
  if (input.session_id) keepProc(input.session_id, quickProcess);
  try {
    return await startBrief(input);
  } finally {
    if (input.session_id && withinDeadline(5000) > 1500) keepProc(input.session_id);
    pruneOld();
  }
}

async function startBrief(input) {
  const cwd = input.cwd || process.cwd();
  const sid = input.session_id;
  const { remote, where } = whereOf(cwd);
  const folders = folderCandidates(cwd);
  const old = sid ? readMarker(sid) : null; // after compaction the baseline stays the one from the real start
  let r;
  let reports = false; // signed in with the worker (a session token): Work OS gets this session's state events
  let unfiled = null; // { candidates } when no project owns the folder
  // The worker first (a session token, so the state events are sent); the key only when the worker gives no brief.
  // head, dirty and worktrees fill Where on the server without a State version bump (the key path's start_work does not take them).
  const ids = { ...(UUID_RE.test(sid || '') ? { ccSession: sid } : {}), ...(SOURCES.includes(input.source) ? { source: input.source } : {}) };
  // Protocol 3: who the session is. The worker route takes title, aiTitle, model and tool; start_work (the key path) takes the name as its label and the model.
  const identity = identityOf(input.transcript_path);
  const keyIdentity = { ...(identity.title || identity.aiTitle ? { label: identity.title || identity.aiTitle } : {}), ...(identity.model ? { model: identity.model } : {}), ...(identity.account ? { account: identity.account } : {}) };
  let a = null;
  if (workerHome()) {
    try { a = await agentStart({ ...where, folders, ...repoFacts(cwd), ...ids, ...identity }, sid ? readKept(sid) : null); } catch { a = null; }
  }
  if (a?.unfiled && a.token && sid) keepToken(sid, a.token, a.until); // no project: the token opens only events and waits
  if (a?.brief) {
    reports = true;
    r = a.brief;
    if (a.token && sid) keepToken(sid, a.token, a.until);
  } else if (a?.unfiled && a.quiet) return unfiledAnswer(sid, input, cwd, remote, folders, undefined, true); // the person said this folder is not Work OS: on the roster, nothing printed
  else if (process.env.WORK_OS_KEY) {
    const text = await mcpCall('start_work', { ...where, ...keyIdentity, ...(run.project ? { project: run.project } : {}) }); // a cloud repo filed with --project starts on it
    if (text) { try { r = JSON.parse(text); } catch { r = null; } }
    if (r?.quiet) return null;
    if (r?.unmatched) unfiled = { candidates: r.candidates };
    else if (!r && a?.unfiled) unfiled = {};
    else if (!r) return null;
  } else if (a?.unfiled) unfiled = {};
  else return null;
  if (unfiled) return unfiledAnswer(sid, input, cwd, remote, folders, unfiled.candidates);
  if (!r || r.unmatched || !r.project) return null;
  if (sid) briefMarker(sid, input, cwd, old, r, reports, a?.brief ? a.dispatched : undefined);
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: formatBrief(r) } };
}

/**
 * The prompt hook's second try for a session that started unfiled (the person may have filed the folder since): the same
 * call as SessionStart through the worker, within `timeoutMs`. Filed: keeps the token, writes the marker as SessionStart
 * does and returns { filed: project name }. Still unfiled: { unfiled: true, quiet }. Anything else (limit, trouble): null.
 */
export async function refile(input, timeoutMs = 2000) {
  const cwd = input.cwd || process.cwd();
  const sid = input.session_id;
  if (!sid || (!workerHome() && !process.env.WORK_OS_KEY)) return null;
  const { where } = whereOf(cwd);
  const ids = { ...(UUID_RE.test(sid) ? { ccSession: sid } : {}), source: 'startup' };
  let a = null;
  if (workerHome()) {
    try { a = await agentStart({ ...where, folders: folderCandidates(cwd), ...repoFacts(cwd), ...ids, ...identityOf(input.transcript_path) }, readKept(sid), timeoutMs); } catch { return null; } // the kept token (a no-project session) keeps this one session
    if (a?.unfiled && a.quiet) return { unfiled: true, quiet: true };
    if (a?.brief?.project) {
      if (a.token) keepToken(sid, a.token, a.until);
      briefMarker(sid, { ...input, source: 'startup' }, cwd, null, a.brief, true, a.dispatched);
      return { filed: a.brief.project.name };
    }
    if (!a?.unfiled || !process.env.WORK_OS_KEY) return a?.unfiled ? { unfiled: true } : null;
  }
  // The key path (a PC without the worker, or a path link made with start_work link): start_work decides by the folder's path.
  let k = null;
  try { const t = await Promise.race([mcpCall('start_work', run.project ? { ...where, project: run.project } : where), new Promise((res) => setTimeout(() => res(null), timeoutMs))]); k = t ? JSON.parse(t) : null; } catch { return workerHome() ? { unfiled: true } : null; }
  if (!k) return workerHome() ? { unfiled: true } : null;
  if (k.quiet) return { unfiled: true, quiet: true };
  if (k.unmatched || !k.project) return { unfiled: true };
  briefMarker(sid, { ...input, source: 'startup' }, cwd, null, k, false);
  return { filed: k.project.name };
}

/** Lanes step 6: the same-folder warning for a brief's sameFolder ({ label, state, more? }), or ''. Labels are the caller's own sessions'; others only as a count. */
export function sameFolderText(sf) {
  if (!sf || typeof sf !== 'object') return '';
  const state = ['on', 'working', 'waiting', 'idle'].includes(sf.state) ? sf.state : 'on';
  const more = Number.isInteger(sf.more) && sf.more > 0 ? ` and ${sf.more} more` : '';
  return `Another session works in this folder: "${cut(str(sf.label) || 'another session', 60)}" (${state})${more}. Commits and the WORK-STATE.md copy collide; use a worktree.`;
}

/** The start_work answer as plain text, most important first; whole sections are added while they fit MAX_BRIEF. */
export function formatBrief(r) {
  const head = [
    `Work OS brief for project ${r.project.name} (${r.project.id}) from start_work. Session id: ${r.session}. ${r.sessionNote || ''}`.trim(),
    r.textRule ? `Text rule: ${r.textRule}` : '',
  ].filter(Boolean).join('\n');
  const sections = [];
  // A handover from the last session on this project (end_work) comes first: it says where to continue.
  const hv = Array.isArray(r.handover) ? r.handover : r.handover && typeof r.handover === 'object' ? [r.handover] : [];
  for (const h of hv) {
    const at = Date.parse(h.at || '');
    const time = at ? new Date(at).toTimeString().slice(0, 5) : '';
    sections.push(`## Handover (note ${h.id}, from ${cut(h.from || 'a session', 60)}${time ? `, ${time}` : ''}${h.writtenBy ? `, writtenBy ${cut(h.writtenBy, 40)}` : ''})\n${str(h.markdown).trim()}`);
  }
  if (Array.isArray(r.moreHandovers) && r.moreHandovers.length) sections.push(`## More handovers\n${r.moreHandovers.slice(0, 5).map(m => `- ${cut(m, 160)}`).join('\n')}\nPick one up with start_work pick_up (the note id).`);
  const same = sameFolderText(r.sameFolder);
  if (same) sections.push(`## Same folder
${same}`);
  const orders = Array.isArray(r.orders) ? r.orders : [];
  sections.push(orders.length
    ? orders.map(o => `## Orders (${o.layer}: ${o.title}${Number.isInteger(o.version) ? `, v${o.version}` : ''}${o.writtenBy ? `, writtenBy ${o.writtenBy}` : ''})\n${str(o.text).trim()}`).join('\n\n')
    : '## Orders\nnone set');
  // What changed in the Orders in the last 48 hours: who, when, why, the lines out and in. Right after the Orders themselves.
  const changed = Array.isArray(r.ordersChanged) ? r.ordersChanged.filter((c) => c && typeof c === 'object').slice(0, 5) : [];
  if (changed.length) {
    let block = '';
    for (const c of changed) {
      const at = Date.parse(c.at || '');
      const time = at ? new Date(at).toTimeString().slice(0, 5) : '';
      const head = `- ${c.layer} v${c.version} "${cut(c.title, 60)}" by ${cut(c.by || 'someone', 30)}${c.session ? ` (${cut(c.session, 40)})` : ''}${time ? `, ${time}` : ''}${c.writtenBy ? `, writtenBy ${cut(c.writtenBy, 40)}` : ''}${c.why ? `; why: ${cut(c.why, 160)}` : ''}${c.own ? '; undo in the app: Orders page, Changes' : ''}`;
      const lines = [...(Array.isArray(c.removed) ? c.removed : []).slice(0, 6).map((l) => `  - ${cut(l, 200)}`), ...(Array.isArray(c.added) ? c.added : []).slice(0, 6).map((l) => `  + ${cut(l, 200)}`)];
      const room = 1200 - block.length - (block ? 1 : 0);
      while (lines.length && [head, ...lines].join('\n').length > room) lines.pop();
      const next = [head, ...lines].join('\n');
      if (next.length > room) break;
      block += (block ? '\n' : '') + next;
    }
    if (block) sections.push(`## Orders changed\n${block}\nThese are your rules from now on.`);
  }
  const st = r.state && typeof r.state === 'object' ? r.state : null;
  if (st) {
    const next = (st.next || []).map((l, i) => `${i + 1}. ${cut(l.text, 400)}${l.waitsOn ? ` (waits on ${cut(l.waitsOn, 120)})` : ''} [${l.id}]`);
    const dec = (st.decisions || []).slice(-3).map(d => `- ${cut(d.text, 300)}`);
    sections.push([
      `## State v${st.version ?? r.stateVersion ?? '?'}`,
      `Now: ${st.now?.text ? cut(st.now.text, 600) : '(not set)'}`,
      next.length ? `Next:\n${next.join('\n')}` : 'Next: (empty)',
      `Later: ${(st.later || []).length} lines (get_state for them).`,
      Number(st.parkedTotal) > 0 ? `Parked: ${Number(st.parkedTotal)} lines (list_parked).` : '',
      dec.length ? `Latest decisions (${Number.isInteger(st.decisionsTotal) ? st.decisionsTotal : (st.decisions || []).length} in all; list_decisions):\n${dec.join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  } else sections.push(`## State\n${cut(r.state, 300)}`);
  if (r.needs) sections.push(`## Needs\n${cut(r.needs, 1200)}`);
  if (r.inbox && typeof r.inbox === 'object') {
    // Each message between two markers with a nonce, with who wrote it and what to do with it (the server's own treat line).
    const blocks = frameInbox(r.inbox.messages);
    sections.push(`## Messages for this session (${r.inbox.unread ?? 0} unread; read one in full with message_status {id}, answer with reply {id}, close with message_status and a status)${blocks ? '\n' + blocks : ''}`);
  }
  const ot = r.openTasks;
  if (ot && Array.isArray(ot.tasks)) {
    const lines = ot.tasks.slice(0, 15).map(t => `- #${t.ref ?? '?'} ${cut(t.title, 100)}${t.titleWrittenBy ? ` (title writtenBy ${t.titleWrittenBy})` : ''}${t.status ? ` (${t.status}${t.priority ? `, ${t.priority}` : ''}${t.due ? `, due ${t.due}` : ''})` : ''}`);
    sections.push(`## Open tasks (${ot.total}${ot.total > lines.length ? `; list_tasks for the rest` : ''})\n${lines.join('\n')}`);
  }
  if (Array.isArray(r.alsoHere) && r.alsoHere.length) {
    sections.push(`## Also working here\n${r.alsoHere.slice(0, 5).map(p => `- ${cut([p.label, p.for, p.machine, p.doing].filter(Boolean).join(', '), 120)} (${p.state ? `${p.state}, ` : ''}${p.minutesAgo} min ago)`).join('\n')}`);
  }
  let out = head;
  const left = [];
  for (const s of sections) {
    if (out.length + s.length + 2 <= MAX_BRIEF - 120) out += '\n\n' + s;
    else left.push(s.split('\n')[0].replace(/^## /, ''));
  }
  if (left.length) out += `\n\nLeft out to fit: ${left.join('; ')}. Call start_work or get_state to read them.`;
  return out.slice(0, MAX_BRIEF);
}

export const handle = sessionStart;

/**
 * What `node worker.mjs hooks check [folder]` runs (the installed copy's): would a session started in `cwd` get a brief,
 * and signed in how? Returns { ok, via: 'key'|'worker'|null, project?, reason? }. Makes the same call as SessionStart.
 */
export async function startCheck(cwd) {
  const no = (reason, via = null) => ({ ok: false, via, reason });
  const { where } = whereOf(cwd);
  const folders = folderCandidates(cwd);
  try {
    // The worker first, as SessionStart does; the key only when the worker gives no brief.
    const hasKey = !!process.env.WORK_OS_KEY;
    let why = null;
    let tried = false;
    let unfiled = null; // 'unfiled' | 'quiet' when the worker answered that no project owns the folder
    const home = workerHome();
    if (!home) why = 'this copy is not installed beside a worker (run: node worker.mjs hooks install)';
    else {
      const key = deps.deviceKey(home);
      if (!key || !/^wkr_[A-Za-z0-9_-]{43}$/.test(key)) why = 'no device key on this PC (run: node worker.mjs setup)';
      else {
        try {
          tried = true;
          const r = await postAgent('/api/agent/start', key, { ...where, folders });
          if (r.status === 200 && r.b?.brief?.project) return { ok: true, via: 'worker', project: r.b.brief.project.name };
          if (r.status === 404) { why = r.quiet ? 'this folder is marked not Work OS (Claude › Setup › Computers › Not Work OS folders)' : `this folder is not filed in Work OS${folders[0] ? ` (folder id ${folders[0]})` : ''}: link it in Work OS (Claude › Setup › Computers › Folders), or ask a session in it to file it`; unfiled = r.quiet ? 'quiet' : 'unfiled'; }
          else if (r.status === 401 || r.status === 403) why = `the server refused this PC's worker key (HTTP ${r.status})`;
          else why = `the server answered HTTP ${r.status}`;
        } catch (e) {
          if (!hasKey) throw e;
          why = `network: ${String(e.message || e).slice(0, 120)}`;
        }
      }
    }
    if (!hasKey) return { ...no(why, tried ? 'worker' : null), ...(unfiled ? { unfiled, ...(folders[0] ? { folder: folders[0] } : {}) } : {}) };
    const text = await mcpCall('start_work', run.project ? { ...where, project: run.project } : where);
    if (!text) return no(`${why ? why + '; and ' : ''}WORK_OS_KEY did not get a brief (key refused or not valid, or no network)`, 'key');
    let r; try { r = JSON.parse(text); } catch { return no('start_work answered something unreadable', 'key'); }
    return r?.project ? { ok: true, via: 'key', project: r.project.name } : { ...no('this folder is not filed in Work OS: no project owns it', 'key'), unfiled: r?.quiet ? 'quiet' : 'unfiled' };
  } catch (e) {
    return no(`network: ${String(e.message || e).slice(0, 120)}`);
  }
}
