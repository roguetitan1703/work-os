// SubagentStop hook: sends nothing. A session's last line (its lane result, `lastResult`) is the main conversation's own last result,
// sent by the Stop hook (hook-stop.mjs `resultOf`): a subagent's final message is its report to the parent, not what the session did
// (a live row once read "<analysis> I am an Opus builder subagent..."). The row stays installed so older installs keep a valid entry;
// the helpers below are shared with the Stop hook.
import fs from 'node:fs';
import { cut, str } from './hook-lib.mjs';

export const RESULT_MAX = 300;
const TAIL_BYTES = 128 * 1024;

/** One line for the lane: control characters (and the line breaks) become spaces, runs of spaces one, at most RESULT_MAX characters. */
const SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]+`, 'g'); // the line and paragraph separators
export const cleanResult = (v) => cut(str(v).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(SEPARATORS, ' '), RESULT_MAX);

/** A compaction summary or a subagent's analysis block is never a session's result. */
export const notAResult = (text) => /^\s*<(analysis|summary)>/i.test(text) || /^\s*This session is being continued from a previous conversation/i.test(text);

/**
 * The last assistant text of the main conversation in the tail of a transcript file (JSONL), or ''. Sidechain entries (a subagent's
 * messages in the parent's file), compaction summaries and analysis blocks are skipped.
 */
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
      if (!o || o.isSidechain || o.isCompactSummary || (o.type !== 'assistant' && o.message?.role !== 'assistant')) continue;
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '';
      if (text.trim() && !notAResult(text)) return text;
    }
  } catch { /* nothing */ }
  return '';
}

/** Sends nothing (see the top of this file). */
export async function subagentStop() {
  return null;
}

export const handle = subagentStop;
