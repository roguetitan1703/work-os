// Stop hook: files changed since the session started and no save_state since: block once.
import fs from 'node:fs';
import { MAX_BRIEF, deliverText, keepAck, postEvent, readMarker, sizeOf, statusHash, writeMarker } from './hook-lib.mjs';

/**
 * Stop: the hook's JSON answer (or null). The save check blocks at most once per session; messages that came during the turn ride
 * along in its reason (one reason, the save request first). Not blocking means the turn ended: Work OS is told (idle), and when it
 * answers with a message that may wake the session (a direct request, question or decision, or an answered Need) and this stop is
 * not itself the answer to a block, the turn goes on once with that text as the reason.
 */
export async function stop(input) {
  const sid = input.session_id;
  const r = await decide(input);
  if (r) {
    const a = sid ? await postEvent(sid, 'tool', { deliver: true }) : null; // still working: it is delivered inside the turn
    const text = deliverText(a);
    if (text) keepAck(sid, a);
    return text ? { ...r, reason: `${r.reason}\n\n${text}`.slice(0, MAX_BRIEF) } : r;
  }
  if (!sid) return null;
  const again = !!input.stop_hook_active;
  const a = await postEvent(sid, 'stop', again ? {} : { deliver: true });
  const d = a?.status === 200 ? a.b?.deliver : null;
  if (!again && d?.wakeable === true && deliverText(a)) {
    const m = readMarker(sid);
    if (m) writeMarker(sid, { ...m, lastTool: 0 }); // the turn goes on: the next tool batch tells Work OS it is working again
    keepAck(sid, a);
    return { decision: 'block', reason: deliverText(a) };
  }
  return null;
}

async function decide(input) {
  const sid = input.session_id;
  if (!sid || input.stop_hook_active) return null;
  const m = readMarker(sid);
  if (!m || m.stopped) return null; // asked already since the last save
  const cwd = input.cwd || process.cwd();
  const now = statusHash(cwd);
  if (now === m.status) return null; // nothing changed since the start or the last save
  // A save the post-tool hook did not see (installed mid-session): a real tool call in the transcript, not the word
  // "save_state" (the injected brief contains that word and the transcript keeps hook text).
  let saved = false;
  const f = input.transcript_path;
  try {
    if (f) { const fd = fs.openSync(f, 'r'); try { const size = fs.fstatSync(fd).size; const buf = Buffer.alloc(Math.max(0, size - (m.offset || 0))); fs.readSync(fd, buf, 0, buf.length, m.offset || 0); saved = SAVE_CALL.test(buf.toString('utf8')); } finally { fs.closeSync(fd); } }
  } catch {}
  if (saved) { writeMarker(sid, { ...m, status: now, offset: sizeOf(f) }); return null; }
  writeMarker(sid, { ...m, stopped: true, offset: sizeOf(f) });
  return { decision: 'block', reason: 'Files changed in this session and the State was not saved since. Call save_state (with the session id from start_work) with what is now true: Now, Next, Later and any decision. Then finish. Asked once until the next save.' };
}
const SAVE_CALL = /"name"\s*:\s*"mcp__[^"]+__(save_state|import_state|end_work)"/;

export const handle = stop;
