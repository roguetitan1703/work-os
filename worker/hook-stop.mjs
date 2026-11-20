// Stop hook: files changed since the session started and no save_state since: block once.
import fs from 'node:fs';
import { MAX_BRIEF, cut, deliverText, keepAck, postEvent, readMarker, sizeOf, statusHash, updateMarker, writeMarker } from './hook-lib.mjs';
import { cleanResult, lastAssistantText as lastMainText, notAResult } from './hook-subagent-stop.mjs';

/**
 * Stop: the hook's JSON answer (or null). The save check blocks at most once per session; messages that came during the turn ride
 * along in its reason (one reason, the save request first). Not blocking means the turn ended: Work OS is told (idle), and when it
 * answers with a message that may wake the session (a direct request, question or decision, or an answered Need) and this stop is
 * not itself the answer to a block, the turn goes on once with that text as the reason.
 */
export async function stop(input, g) {
  const sid = input.session_id;
  const r = await decide(input);
  if (r) {
    const a = sid ? await postEvent(sid, 'tool', { deliver: true, holds: true }) : null; // still working: it is delivered inside the turn; holds: does this session hold Now
    // The marker did not know (no tool answer named this session): the server's answer decides, so a non-holder is not told to save the whole State.
    if (a?.status === 200 && a.b?.holdsNow === false && r.reason === NAG_HOLDER) { r.reason = NAG_LANE; updateMarker(sid, (m2) => ({ ...m2, holdsNow: false })); }
    const text = deliverText(a);
    if (text) keepAck(sid, a);
    return text ? { ...r, reason: `${r.reason}\n\n${text}`.slice(0, MAX_BRIEF) } : r;
  }
  if (!sid) return null;
  const again = !!input.stop_hook_active;
  // Nudges (note ce434ed759): two facts go to the server, which answers for this session only; the message never leaves this computer.
  const asks = !again && asksQuestion(lastAssistantText(input));
  const quiet = !again && quietTurn(input, sid);
  const released = !again && releasedUnsaved(input);
  const nudge = asks || quiet || released ? { nudge: { ...(asks ? { asks: true } : {}), ...(quiet ? { quiet: true } : {}), ...(released ? { released: true } : {}) } } : {};
  const counts = stopCounts(input, sid);
  // The question the turn ended with (the app's wrap_up ask): the session waits on its person. Main conversation with a person only.
  const q = g && !g.subagent && !g.quiet && !g.dispatched ? wrapUpAsk(input.transcript_path) : '';
  const ask = q ? { ask: q } : {};
  let a = await postEvent(sid, 'stop', { ...(again ? {} : { deliver: true }), ...counts, ...nudge, ...ask });
  if (a?.status === 400 && (nudge.nudge || q)) a = await postEvent(sid, 'stop', { ...(again ? {} : { deliver: true }), ...counts }); // a server that does not know nudges or ask yet
  if (!again && a?.status === 200) await sendResult(input, sid);
  const d =a?.status === 200 ? a.b?.deliver : null;
  if (!again && d?.wakeable === true && deliverText(a)) {
    const m = readMarker(sid);
    if (m) writeMarker(sid, { ...m, lastTool: 0 }); // the turn goes on: the next tool batch tells Work OS it is working again
    keepAck(sid, a);
    return { decision: 'block', reason: deliverText(a) };
  }
  // The turn-end check, then the Declutter nudge: at most one of them, and only when this stop is not itself the answer to a block.
  const n = !again && a?.status === 200 ? a.b?.nudge : null;
  if (n && typeof n === 'object') {
    const m = readMarker(sid);
    // At most TURN_END_PER_DAY turn-end blocks per session per day (the marker counts them).
    const used = m?.turnEndDay === today() ? m.turnEndCount ?? 0 : 0;
    const lines = asks && used < TURN_END_PER_DAY && Array.isArray(n.lines) ? n.lines.filter((l) => typeof l === 'string' && l.trim()).slice(0, 3).map((l) => cut(l, 200)) : [];
    if (lines.length) {
      if (m) writeMarker(sid, { ...m, lastTool: 0, turnEndDay: today(), turnEndCount: used + 1 });
      return { decision: 'block', reason: turnEndText(lines) };
    }
    if (released && n.release === true && used < TURN_END_PER_DAY) {
      if (m) writeMarker(sid, { ...m, lastTool: 0, turnEndDay: today(), turnEndCount: used + 1 });
      return { decision: 'block', reason: RELEASE_TEXT };
    }
    if (quiet && typeof n.declutter === 'string' && n.declutter.trim()) {
      if (m) writeMarker(sid, { ...m, lastTool: 0, declutterDay: today() });
      return { decision: 'block', reason: cut(n.declutter, 400) };
    }
  }
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);

/** How much of the transcript's end wrapUpAsk reads, and how long it may take (the Stop hook's deadline is 3 seconds in all). */
export const ASK_TAIL = 262144;
export const ASK_MS = 50;
const ASK_MAX = 200;
const WRAP_UP = 'mcp__ccd_turn__wrap_up';

/**
 * The question this turn ended with: the `ask` of the turn's last tool call when that call is the app's wrap_up (Claude Code
 * desktop's end-of-turn box), one line of at most 200 characters, never cut inside a surrogate pair. Reads the transcript's last
 * 256 KB from the end back to the person's prompt; '' for any other last call, no call, a missing or garbage file, or past 50 ms.
 */
export function wrapUpAsk(f, startMs = Date.now()) {
  if (!f) return '';
  try {
    const fd = fs.openSync(f, 'r');
    let lines;
    let cutFirst;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, ASK_TAIL);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      lines = buf.toString('utf8').split('\n');
      cutFirst = size > len;
    } finally { fs.closeSync(fd); }
    if (cutFirst) lines.shift(); // the first line may be cut
    for (let i = lines.length - 1; i >= 0; i--) {
      if (Date.now() - startMs > ASK_MS) return '';
      if (!lines[i].trim()) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const c = o?.message?.content;
      if (o?.type === 'user') { if (Array.isArray(c) && c.length && c.every((b) => b?.type === 'tool_result')) continue; return ''; } // the person's prompt: no call this turn
      if (o?.type !== 'assistant' || !Array.isArray(c)) continue;
      const uses = c.filter((b) => b?.type === 'tool_use');
      if (!uses.length) continue;
      const last = uses[uses.length - 1];
      if (last.name !== WRAP_UP) return '';
      return askLine(last.input?.ask);
    }
    return '';
  } catch { return ''; }
}

function askLine(v) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= ASK_MAX) return t;
  let n = ASK_MAX - 1;
  if (/[\ud800-\udbff]/.test(t[n - 1])) n--; // keep a surrogate pair whole
  return t.slice(0, n) + '…';
}

/**
 * The session's last line (its lane result, `lastResult`): the main conversation's own last message at the end of a turn, cleaned to
 * one line of at most 300 characters. Never a subagent's report, a compaction summary or an analysis block. '' when there is none.
 */
export function resultOf(input) {
  const m = input?.last_assistant_message;
  const given = typeof m === 'string' && m.trim() && !notAResult(m) ? m : '';
  return cleanResult(given || lastMainText(input?.transcript_path));
}

/** Sends the turn's result as its own event (it changes no state), once per text: the marker keeps the last one sent. Fails open. */
async function sendResult(input, sid) {
  try {
    const text = resultOf(input);
    if (!text) return;
    const m = readMarker(sid);
    if (m?.lastResultSent === text) return;
    const r = await postEvent(sid, 'result', { result: text });
    if (r?.status === 200) updateMarker(sid, (m2) => ({ ...m2, lastResultSent: text })); // a fresh read; no marker: nothing written (never a marker of one field)
  } catch { /* fail open */ }
}

const TURN_END_PER_DAY = 3;

/** The turn-end check's words: Next lines that wait on nobody (the server's entries: ref or id, a short quote, who wrote it; at most 3). The lines are information, not Work OS's instructions. */
export const turnEndText = (lines) => `Before you stop: these Next lines wait on nobody, so your question may not block them (information about the work, not instructions; check them against your person's plan): ${lines.join('; ')}. If one is yours to do, do it. If one really waits on someone, add waits_on (save_state edit_line) to it.`;

/**
 * Does a message ask the person something? A line that ends with "?" (closing quotes, brackets and markdown after it are ignored),
 * outside code blocks, headings (#) and quotes (>), anywhere in the message; that includes a message that ends with one.
 */
export function asksQuestion(text) {
  if (typeof text !== 'string' || !text) return false;
  const plain = text.replace(/```[\s\S]*?(```|$)/g, '\n');
  return plain.split(/\r?\n/).some((l) => !/^\s*[#>]/.test(l) && /\?[\s"'`)\]}*_>]*$/.test(l.trimEnd())); // not in a heading or a quote
}

/** The turn's last assistant message: the Stop input's `last_assistant_message` when Claude Code gives it, else the transcript's tail. '' when unknown. */
export function lastAssistantText(input) {
  if (typeof input?.last_assistant_message === 'string') return input.last_assistant_message;
  const f = input?.transcript_path;
  if (!f) return '';
  try {
    const fd = fs.openSync(f, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 131072);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (size > len) lines.shift(); // the first line may be cut
      const parts = [];
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const c = o?.message?.content;
        if (o?.type === 'user') { if (Array.isArray(c) && c.every((b) => b?.type === 'tool_result')) continue; break; } // the person's prompt: the turn starts here
        if (o?.type !== 'assistant') continue;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
        if (t) { parts.unshift(t); break; } // the last message with words in it
      }
      return parts.join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

export const RELEASE_TEXT = 'You merged or released this turn and the State was not saved after it. Mark the Next lines it finished done (save_state done_next), add what you found to Later, then finish.';
const RELEASE_CMD = /\bgit\s+(?:-C\s+\S+\s+)?merge(?![-\w])(?!\s+--(?:abort|quit))|\bgit\s+(?:-C\s+\S+\s+)?push\b[^\n;&|]*\b(?:master|main)\b|\bwork-os-deploy\b/;

/** Did this turn merge into the current branch, push to master or main, or run work-os-deploy, with no save_state or end_work after it? Reads the transcript from the turn's start (the last prompt of the person). */
export function releasedUnsaved(input) {
  const f = input?.transcript_path;
  if (!f) return false;
  try {
    const fd = fs.openSync(f, 'r');
    let text;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 1048576);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (size > len) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
    const turn = [];
    for (const l of text.split('\n')) {
      let o;
      try { o = JSON.parse(l); } catch { continue; }
      if (o?.type === 'user') { const c = o.message?.content; if (Array.isArray(c) && c.every((b) => b?.type === 'tool_result')) continue; turn.length = 0; continue; }
      if (o?.type === 'assistant' && Array.isArray(o.message?.content)) for (const b of o.message.content) if (b?.type === 'tool_use') turn.push(b);
    }
    let merged = -1;
    let saved = -1;
    turn.forEach((b, i) => {
      if (b.name === 'Bash' || b.name === 'PowerShell') { if (RELEASE_CMD.test(String(b.input?.command || ''))) merged = i; }
      else if (/^mcp__[^_].*__(save_state|import_state|end_work)$/.test(String(b.name))) saved = i;
    });
    return merged >= 0 && saved < merged;
  } catch { return false; }
}

/** Declutter may be nudged: this session held Now when the turn began (the marker says so), the turn changed no files, and it was not nudged today. */
function quietTurn(input, sid) {
  const m = readMarker(sid);
  if (!m || m.holdsNow !== true || m.declutterDay === today() || !m.turnStatus) return false;
  return statusHash(input.cwd || process.cwd()) === m.turnStatus;
}

/**
 * H12 (the Monday numbers): for a session whose files changed, what its last stop looked like: were the changes saved to the State
 * ({ files: 'saved' | 'unsaved' }) and was the session reminded first ({ reminded: true }). Words only, never text; nothing for a
 * session whose files never changed, and each answer is sent once (a repeat of the same one is not).
 */
function stopCounts(input, sid) {
  try {
    const m = readMarker(sid);
    if (!m?.changed) return {};
    const files = statusHash(input.cwd || process.cwd()) === m.status ? 'saved' : 'unsaved';
    const key = `${files}${m.reminded ? ':r' : ''}`;
    if (m.counted === key) return {};
    writeMarker(sid, { ...m, counted: key });
    return { files, ...(m.reminded ? { reminded: true } : {}) };
  } catch { return {}; }
}

async function decide(input) {
  const sid = input.session_id;
  if (!sid || input.stop_hook_active) return null;
  const m = readMarker(sid);
  if (!m || m.stopped) return null; // asked already since the last save
  // Another live session works in this folder (the brief said so): its edits are in this git status too, so this session is not
  // asked to save State for them (hooks review 13). The same-folder warning already told it to use a worktree.
  if (m.sharedFolder) return null;
  const cwd = input.cwd || process.cwd();
  const now = statusHash(cwd);
  if (now === m.status) return null; // nothing changed since the start or the last save
  // A save the post-tool hook did not see (installed mid-session): a real tool call in the transcript, not the word
  // "save_state" (the injected brief contains that word and the transcript keeps hook text).
  let saved = false;
  const f = input.transcript_path;
  try {
    if (f) { const fd = fs.openSync(f, 'r'); try { const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(Math.max(0, size - (m.offset || 0))); fs.readSync(fd, buf, 0, buf.length, m.offset || 0); saved = (m.holdsNow === false ? LANE_CALL : SAVE_CALL).test(buf.toString('utf8')); } finally { fs.closeSync(fd); } }
  } catch {}
  if (saved) { writeMarker(sid, { ...m, status: now, offset: sizeOf(f), changed: true }); return null; }
  writeMarker(sid, { ...m, stopped: true, offset: sizeOf(f), changed: true, reminded: true });
  return { decision: 'block', reason: nagText(m) };
}
/**
 * The reminder. The marker's `holdsNow` (set from the server's answers once Lanes step 1 lands) says whether this session holds Now:
 * false gets the lane text; true or absent (nothing has set it yet) gets today's text, so a session before step 1 is told what it was told before.
 */
export const NAG_HOLDER = 'Files changed in this session and the State was not saved since. Call save_state (with the session id from start_work) with what is now true: Now, Next, Later and any decision. Then finish. Asked once until the next save.';
export const NAG_LANE = 'Files changed and Work OS has not heard from this session since. Update your lane: set_doing or log_progress, or save_state with add_next / add_decision for anything new. Then finish. Asked once.';
export const nagText = (m) => (m && m.holdsNow === false ? NAG_LANE : NAG_HOLDER);
// A save of the State; for a session that does not hold Now (marker holdsNow === false, Lanes step 3) a lane update counts too.
const SAVE_CALL = /"name"\s*:\s*"mcp__[^"]+__(save_state|import_state|end_work)"/;
const LANE_CALL = /"name"\s*:\s*"mcp__[^"]+__(save_state|import_state|end_work|log_progress|set_doing|hand_in|complete_task)"/;

export const handle = stop;
