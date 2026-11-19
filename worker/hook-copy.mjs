// WORK-STATE.md is a copy of the Work OS State, written only by the hooks (Om 18 Nov): the constants and helpers that
// hook-pre-tool.mjs (refuses hand edits) and hook-post-tool.mjs (writes it) share.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_BRIEF, git, markerDir, readMarker, sizeOf, statusHash, writeMarker } from './hook-lib.mjs';

export const COPY = 'WORK-STATE.md';
const COPY_HEAD = /^Copy of the Work OS state, version (\d+)\./;
const STAMP = /\n?<!-- work-os-copy sha1:([0-9a-f]{40}) -->\s*$/;
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
export const COPY_REASON = 'WORK-STATE.md is a copy of the State, written by the Work OS hook after every save_state; never edit it. Change the State with save_state (set_now, add_next, done_next, edit_line, add_later, add_decision) and the file follows. If get_state says "no State yet", make it now as its answer says.';

/** What a Work OS tool answered, as an object, or null (an error text, not JSON, nothing). */
export function answerOf(resp) {
  let text = resp;
  if (Array.isArray(resp)) text = resp.find((c) => c?.type === 'text')?.text;
  else if (resp && typeof resp === 'object' && Array.isArray(resp.content)) text = resp.content.find((c) => c?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try { const a = JSON.parse(text); return a && typeof a === 'object' ? a : null; } catch { return null; }
}
/** The markdown a Work OS State tool answered with, or null. */
export function stateMarkdown(resp) {
  const md = answerOf(resp)?.markdown;
  return typeof md === 'string' && COPY_HEAD.test(md) ? md : null;
}
export const projectOf = (md) => (md.match(/^# Work state: (.+)$/m) || [])[1]?.trim() || '';

/** After a save seen by post-tool: the next stop compares against this point, and may ask again after later changes. */
export function markSaved(input, cwd) {
  const sid = input.session_id;
  const m = sid && readMarker(sid);
  if (m) writeMarker(sid, { ...m, status: statusHash(cwd), stopped: false, offset: sizeOf(input.transcript_path) });
}

/** The WORK-STATE.md write for a State answer (or for md, a copy fetched from the server): the hook output, or null for nothing to do. */
export function copyState(input, cwd, md = stateMarkdown(input.tool_response)) {
  const w = writeCopy(input.session_id, cwd, md);
  return w ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: w.notes.join('\n\n').slice(0, MAX_BRIEF) } } : null;
}

/** Writes and commits WORK-STATE.md from md (commit: false writes only: the pre-tool hook must not run git commit, so a file it wrote is committed by the next post-tool). Returns { version, committed, notes }, or null when nothing was written. */
export function writeCopy(sid, cwd, md, { commit = true } = {}) {
  if (!md) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  // Builder worktrees are skipped: a generated file on two branches conflicts at every merge.
  const gitDir = path.resolve(top, git(top, ['rev-parse', '--git-dir']));
  if (gitDir !== path.resolve(top, git(top, ['rev-parse', '--git-common-dir']))) return null;
  const file = path.join(top, COPY);
  let old = null;
  try { old = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch {}
  // Only this repo's project: from the session's start_work, else from the copy already here.
  const want = (sid && readMarker(sid)?.project) || (old ? projectOf(old) : '');
  if (!want || want !== projectOf(md)) return null;
  const vNew = Number(md.match(COPY_HEAD)[1]);
  const vOld = Number((old?.match(COPY_HEAD) || [])[1] || -1);
  if (old !== null && vOld > vNew) return null; // never write an older State over a newer one
  const body = md.replace(/\r\n/g, '\n').trimEnd() + '\n';
  const next = `${body}<!-- work-os-copy sha1:${sha1(body)} -->\n`;
  const notes = [];
  const doCommit = commit && process.env.WORK_OS_COPY_COMMIT !== '0';
  const same = old !== null && old === next;
  // Only the version line differs: no write, no commit (a save every few minutes for weeks would be hundreds of commits).
  const lines = (s) => s.replace(STAMP, '').replace(/\r\n/g, '\n').split('\n').filter((l) => !COPY_HEAD.test(l)).join('\n').trimEnd();
  const sameLines = old !== null && lines(old) === lines(body);
  // Nothing new to write: done, unless an earlier write (an Edit forwarded by pre-tool) is still waiting for its commit.
  if ((same || sameLines) && !(doCommit && git(top, ['status', '--porcelain', '--', COPY]))) return null;
  if (old !== null) {
    const m = old.match(STAMP);
    const clean = m && sha1(old.replace(STAMP, '').trimEnd() + '\n') === m[1];
    if (!clean) {
      // A hand-kept file: keep a copy outside the repo and list the lines Work OS does not have.
      const have = new Set(body.split('\n').map((l) => l.trim()));
      const only = old.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !COPY_HEAD.test(l) && !have.has(l) && !STAMP.test(l));
      const bak = path.join(markerDir(), 'copies', `${path.basename(top).replace(/[^\w.-]/g, '_')}-${Date.now()}.md`);
      try { fs.mkdirSync(path.dirname(bak), { recursive: true }); fs.writeFileSync(bak, old); } catch {}
      if (only.length) notes.push(`The old WORK-STATE.md had ${only.length} line(s) that are not in the State. It is kept at ${bak} (and in git history). Add the ones still true with save_state:\n` + only.slice(0, 40).map((l) => '  ' + l.slice(0, 300)).join('\n') + (only.length > 40 ? `\n  ...and ${only.length - 40} more in the kept file` : ''));
    }
  }
  fs.writeFileSync(file, next);
  let committed = false;
  const branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const busy = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'].some((f) => fs.existsSync(path.join(gitDir, f)));
  if (doCommit && branch && branch !== 'HEAD' && !busy) {
    try {
      execFileSync('git', ['add', '--', COPY], { cwd: top, stdio: 'ignore', timeout: 5000 });
      execFileSync('git', ['commit', '--only', '-q', '-m', `WORK-STATE.md: copy of the Work OS State v${vNew}`, '--', COPY], { cwd: top, stdio: 'ignore', timeout: 15000 });
      committed = true;
    } catch {}
  }
  notes.unshift(`WORK-STATE.md now holds the Work OS State v${vNew}${committed ? ', committed on its own' : ' (not committed: a merge or rebase is under way, or no branch; the next save commits it)'}. Nothing to do: never edit that file.`);
  return { version: vNew, committed, notes };
}
