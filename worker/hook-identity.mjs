// Identity from the session (Identity step 4; hooks protocol 3): who a session is, read by the hook from what Claude Code already
// keeps on this PC and sent to Work OS at SessionStart and when it changes (a prompt or a stop event).
//   title     the name the person gave the session (/rename: the latest `custom-title` record in the transcript)
//   aiTitle   the title Claude made for it (the latest `ai-title` record)
//   model     the model of the latest assistant message (`message.model`)
//   tool      where it runs: desktop, vscode or terminal (from CLAUDE_CODE_ENTRYPOINT; anything else sends none)
// Only these four short values leave the machine: titles are one line, cut to 120 characters; the model name is at most 60 characters of
// [A-Za-z0-9._:/-]. Nothing else from the transcript is kept or sent. The transcript is read from its last 256 KB only.
import fs from 'node:fs';

export const META_BYTES = 256 * 1024;
export const MAX_TITLE = 120;
const oneLine = (s, n) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The tail of a file as text (the cut first line dropped), or ''. */
function tailText(file, bytes = META_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    const n = Math.min(bytes, len);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, len - n);
    const text = buf.toString('utf8');
    return len > n ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/** { title?, aiTitle?, model? } from the end of a transcript file. Later records win. */
export function transcriptMeta(file) {
  if (typeof file !== 'string' || !file || !/\.jsonl$/i.test(file)) return {};
  const out = {};
  for (const line of tailText(file).split('\n')) {
    if (line.length < 20) continue;
    if (line.includes('"custom-title"') && line.includes('"customTitle"')) {
      try { const o = JSON.parse(line); if (o && o.type === 'custom-title' && typeof o.customTitle === 'string') { const t = oneLine(o.customTitle, MAX_TITLE); if (t) out.title = t; else delete out.title; } } catch {}
    } else if (line.includes('"ai-title"') && line.includes('"aiTitle"')) {
      try { const o = JSON.parse(line); if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string') { const t = oneLine(o.aiTitle, MAX_TITLE); if (t) out.aiTitle = t; } } catch {}
    } else if (line.includes('"type":"assistant"')) {
      // The model without parsing a long line: the first "model" key of an assistant record is the message's own.
      const m = /"model":"([A-Za-z0-9._:\/-]{1,60})"/.exec(line);
      if (m && m[1] !== '<synthetic>' && !/^synthetic$/i.test(m[1])) out.model = m[1];
    }
  }
  return out;
}

const TOOLS = { 'claude-desktop': 'desktop', 'claude-vscode': 'vscode', cli: 'terminal' };
/** Where this session runs, from the environment Claude Code gives its hooks: 'desktop', 'vscode', 'terminal', or undefined. */
export const toolOf = (env = process.env) => TOOLS[String(env.CLAUDE_CODE_ENTRYPOINT || '')];

/** What the start (and later events) say about the session: { title?, aiTitle?, model?, tool? } from the transcript and the environment. */
export function identityOf(transcript, env = process.env) {
  const t = toolOf(env);
  return { ...transcriptMeta(transcript), ...(t ? { tool: t } : {}) };
}

/** A short fingerprint of the identity, so an event carries it only when it changed. */
export const identityKey = (i) => [i.title || '', i.aiTitle || '', i.model || ''].join('\u0001');
