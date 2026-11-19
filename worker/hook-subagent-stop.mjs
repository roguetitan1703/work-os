// SubagentStop hook (Lanes step 3): a subagent ended. Its last message becomes its parent session's lane result: POST /api/agent/event
// { event: 'tool', result } with the parent's session token (the event passes the parent's session_id; the server writes the token's own
// row only, lastResult, 300 characters). The text is Claude Code's `last_assistant_message`, else the last assistant text at the end of
// the subagent's transcript (`agent_transcript_path`), else of the session's. Control characters out, one line, 300 characters.
// No token, no text or any failure sends nothing. Prints nothing.
import fs from 'node:fs';
import { cut, postEvent, str } from './hook-lib.mjs';

export const RESULT_MAX = 300;
const TAIL_BYTES = 128 * 1024;

/** One line for the lane: control characters (and the line breaks) become spaces, runs of spaces one, at most RESULT_MAX characters. */
export const cleanResult = (v) => cut(str(v).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' '), RESULT_MAX);

/** The last assistant text in the tail of a transcript file (JSONL), or ''. */
export function lastAssistantText(file) {
  try {
    if (!file) return '';
    const fd = fs.openSync(file, 'r');
    let tail = '';
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = tail.split('\n');
    // the first line of a cut tail may be partial: it fails to parse and is skipped
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (!o || (o.type !== 'assistant' && o.message?.role !== 'assistant')) continue;
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '';
      if (text.trim()) return text;
    }
  } catch { /* nothing */ }
  return '';
}

export async function subagentStop(input) {
  try {
    const sid = input.session_id;
    if (!sid) return null;
    const text = cleanResult(typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim() ? input.last_assistant_message : (lastAssistantText(input.agent_transcript_path) || lastAssistantText(input.transcript_path)));
    if (!text) return null;
    await postEvent(sid, 'tool', { result: text }, 2000);
  } catch { /* fail open */ }
  return null;
}

export const handle = subagentStop;
