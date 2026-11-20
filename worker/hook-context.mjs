// Context warning (note 3e92845ac0), hook side. A project can set a warning line (150 or 200, thousands of tokens; the brief's contextWarn, kept
// in the session marker as ctxWarn). On a tool call the pre-tool hook reads the calling agent's own context size from the tail of its transcript
// (a local file read, no server call) and, once per 25k step past the line, tells that agent to write a code-map note; 50k past the line it
// tells the agent to stop. Never blocks, never throws: any error is no warning.
import fs from 'node:fs';
import path from 'node:path';
import { readMarker, updateMarker } from './hook-lib.mjs';

export const STEP_TOKENS = 25_000;
export const STOP_AFTER_TOKENS = 50_000;
export const TAIL_BYTES = 256 * 1024;
const WORK_MS = 50; // the most time the file work may take

/** The transcript of the agent that made this call: the session's own, or a subagent's beside it. Null when it cannot be told. */
export function transcriptOf(input) {
  const tp = typeof input?.transcript_path === 'string' ? input.transcript_path : '';
  if (!tp) return null;
  if (!input.agent_id) return tp;
  const id = String(input.agent_id);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  return path.join(path.dirname(tp), path.basename(tp, '.jsonl'), 'subagents', `agent-${id}.jsonl`);
}

/** The context size of the last assistant call in a block of transcript text (input + cache read + cache write tokens), or null. */
export function contextOfTail(text, deadline = Infinity) {
  const lines = String(text).split('\n');
  for (let n = lines.length - 1; n >= 0; n--) {
    if (Date.now() > deadline) return null;
    const line = lines[n];
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // a cut first line, or a garbage one
    const u = o && o.type === 'assistant' ? o.message?.usage : null;
    if (!u || typeof u !== 'object') continue;
    const sum = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);
    if (sum > 0) return sum;
  }
  return null;
}

/** The last 256 KB of a file as text, or null when it is missing or unreadable. */
export function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    const from = Math.max(0, len - TAIL_BYTES);
    const buf = Buffer.alloc(len - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/** What to say at this context size for this line (k): { step, text } or null below the line. step counts 25k from the line (0, 1, 2 ...). */
export function warningFor(tokens, lineK) {
  if (!Number.isFinite(tokens) || !(lineK > 0)) return null;
  const over = tokens - lineK * 1000;
  if (over < 0) return null;
  const step = Math.floor(over / STEP_TOKENS);
  const k = Math.round(tokens / 1000);
  const text = over >= STOP_AFTER_TOKENS
    ? `Work OS: context at ${k}k (warning line ${lineK}k): stop now, write the code-map note (files, key functions with line ranges, data flow, gotchas, 1-2k tokens) and report your context number.`
    : `Work OS: context at ${k}k (warning line ${lineK}k): finish this step, write a code-map note (files, key functions with line ranges, data flow, gotchas, 1-2k tokens), report your context number.`;
  return { step, text };
}

/**
 * The pre-tool hook's context warning for this call: the hook answer to print, or null. Nothing is read unless the session's marker has a line.
 * One warning per agent (the subagent's id, else "main") per step: the last step warned is kept in the marker.
 */
export function contextWarning(input) {
  try {
    const sid = input?.session_id;
    const marker = sid ? readMarker(sid) : null;
    const lineK = marker?.ctxWarn;
    if (lineK !== 150 && lineK !== 200) return null;
    const file = transcriptOf(input);
    if (!file) return null;
    const deadline = Date.now() + WORK_MS;
    const tail = readTail(file);
    if (tail === null) return null;
    const tokens = contextOfTail(tail, deadline);
    if (tokens === null) return null;
    const w = warningFor(tokens, lineK);
    if (!w) return null;
    const key = input.agent_id ? String(input.agent_id) : 'main';
    const last = marker.ctxSteps && Number.isInteger(marker.ctxSteps[key]) ? marker.ctxSteps[key] : -1;
    if (w.step <= last) return null;
    updateMarker(sid, (m) => ({ ...m, ctxSteps: { ...(m.ctxSteps || {}), [key]: w.step } }));
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: w.text } };
  } catch { return null; }
}
