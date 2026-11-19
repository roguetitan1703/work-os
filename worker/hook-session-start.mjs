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
import { MAX_BRIEF, SESSION_TOKEN_RE, cut, deps, frameInbox, git, mcpCall, postAgent, readKept, readMarker, keepToken, repoFacts, sizeOf, statusHash, str, workerHome, writeMarker } from './hook-lib.mjs';

/**
 * The brief through the worker's device key (POST /api/agent/start), or null. A session token kept from this session's
 * start is shown first; when it is refused (expired, revoked, another project) the device key opens a new session.
 * Returns { brief, token?, until? } (token and until only when a new session was made).
 */
async function agentStart(body, kept) {
  const home = workerHome();
  if (!home) return null;
  const post = (cred) => postAgent('/api/agent/start', cred, body);
  if (kept && SESSION_TOKEN_RE.test(kept)) {
    const r = await post(kept);
    if (r.status === 200 && r.b?.brief) return { brief: r.b.brief };
    if (r.status !== 401 && r.status !== 403) return null; // over the limit, server trouble: no brief this time
  }
  const key = deps.deviceKey(home);
  if (!key || !/^wkr_[A-Za-z0-9_-]{43}$/.test(key)) return null;
  const r = await post(key);
  if (r.status !== 200 || !r.b?.brief) return null;
  const token = SESSION_TOKEN_RE.test(r.b.token || '') ? r.b.token : undefined;
  const until = Date.parse(r.b.expiresAt || '') || undefined;
  return { brief: r.b.brief, token, until };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ['startup', 'resume', 'clear', 'compact'];

/** SessionStart: the hook's JSON answer (or null for "print nothing"). */
export async function sessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const sid = input.session_id;
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!remote && !branch) return null; // not a git folder
  const where = { ...(remote ? { remote } : {}), subdir: git(cwd, ['rev-parse', '--show-prefix']), branch, path: cwd, machine: os.hostname().slice(0, 40), label: 'Claude Code' };
  const old = sid ? readMarker(sid) : null; // after compaction the baseline stays the one from the real start
  let r;
  let reports = false; // signed in with the worker (a session token): Work OS gets this session's state events
  // The worker first (a session token, so the state events are sent); the key only when the worker gives no brief.
  // head, dirty and worktrees fill Where on the server without a State version bump (the key path's start_work does not take them).
  const ids = { ...(UUID_RE.test(sid || '') ? { ccSession: sid } : {}), ...(SOURCES.includes(input.source) ? { source: input.source } : {}) };
  let a = null;
  if (workerHome()) {
    try { a = await agentStart({ ...where, ...repoFacts(cwd), ...ids }, sid ? readKept(sid) : null); } catch { a = null; }
  }
  if (a) {
    reports = true;
    r = a.brief;
    if (a.token && sid) keepToken(sid, a.token, a.until);
  } else if (process.env.WORK_OS_KEY) {
    const text = await mcpCall('start_work', where);
    if (!text) return null;
    try { r = JSON.parse(text); } catch { return null; }
  } else return null;
  if (!r || r.unmatched || !r.project) return null;
  if (sid) {
    writeMarker(sid, { status: old?.status ?? statusHash(cwd), offset: old?.offset ?? sizeOf(input.transcript_path), stopped: old?.stopped ?? false, project: r.project.name || old?.project, ...(typeof r.shortOrders === 'string' && r.shortOrders ? { short: r.shortOrders.slice(0, 1200), ...(Number.isInteger(r.shortOrdersVersion) ? { shortV: r.shortOrdersVersion } : {}) } : {}), ...(reports ? { presence: { state: input.source === 'compact' ? 'working' : 'on', at: Date.now(), postedAt: Date.now() } } : old?.presence ? { presence: old.presence } : {}) });
  }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: formatBrief(r) } };
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
  if (Array.isArray(r.moreHandovers) && r.moreHandovers.length) sections.push(`## More handovers\n${r.moreHandovers.slice(0, 5).map(m => `- ${cut(m, 160)}`).join('\n')}\nRead one with read_note.`);
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
      dec.length ? `Latest decisions:\n${dec.join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  } else sections.push(`## State\n${cut(r.state, 300)}`);
  if (r.needs) sections.push(`## Needs\n${cut(r.needs, 1200)}`);
  if (r.inbox && typeof r.inbox === 'object') {
    // Each message between two markers with a nonce, with who wrote it and what to do with it (the server's own treat line).
    const blocks = frameInbox(r.inbox.messages);
    sections.push(`## Inbox (${r.inbox.unread ?? 0} unread; inbox for all; reply with reply {id}, close with message_status)${blocks ? '\n' + blocks : ''}`);
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
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!remote && !branch) return no('not a git folder');
  const where = { ...(remote ? { remote } : {}), subdir: git(cwd, ['rev-parse', '--show-prefix']), branch, path: cwd, machine: os.hostname().slice(0, 40), label: 'Claude Code' };
  try {
    // The worker first, as SessionStart does; the key only when the worker gives no brief.
    const hasKey = !!process.env.WORK_OS_KEY;
    let why = null;
    let tried = false;
    const home = workerHome();
    if (!home) why = 'this copy is not installed beside a worker (run: node worker.mjs hooks install)';
    else {
      const key = deps.deviceKey(home);
      if (!key || !/^wkr_[A-Za-z0-9_-]{43}$/.test(key)) why = 'no device key on this PC (run: node worker.mjs setup)';
      else {
        try {
          tried = true;
          const r = await postAgent('/api/agent/start', key, where);
          if (r.status === 200 && r.b?.brief?.project) return { ok: true, via: 'worker', project: r.b.brief.project.name };
          if (r.status === 404) why = 'this folder is not linked on this PC (Work OS: Claude › Setup › Computers › Folders)';
          else if (r.status === 401 || r.status === 403) why = `the server refused this PC's worker key (HTTP ${r.status})`;
          else why = `the server answered HTTP ${r.status}`;
        } catch (e) {
          if (!hasKey) throw e;
          why = `network: ${String(e.message || e).slice(0, 120)}`;
        }
      }
    }
    if (!hasKey) return no(why, tried ? 'worker' : null);
    const text = await mcpCall('start_work', where);
    if (!text) return no(`${why ? why + '; and ' : ''}WORK_OS_KEY did not get a brief (key refused or not valid, or no network)`, 'key');
    let r; try { r = JSON.parse(text); } catch { return no('start_work answered something unreadable', 'key'); }
    return r?.project ? { ok: true, via: 'key', project: r.project.name } : no('no project matches this folder', 'key');
  } catch (e) {
    return no(`network: ${String(e.message || e).slice(0, 120)}`);
  }
}
