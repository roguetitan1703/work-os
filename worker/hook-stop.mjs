// Stop hook: files changed since the session started and no save_state since: block once.
import fs from 'node:fs';
import { readMarker, sizeOf, statusHash, writeMarker } from './hook-lib.mjs';

/** Stop: the hook's JSON answer (or null). Blocks at most once per session. */
export async function stop(input) {
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
