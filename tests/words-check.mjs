// Drift test for the words agents read (docs/HANDOVER.md section 3, "Words"): the server instructions stay under their
// character budget, and agent-facing text does not use retired words or call WORK-STATE.md the work list.
// Run: npm run check:words (also `npm run build` via prebuild). Needs Node 22.6+ (imports lib/mcp/docs.ts with type stripping).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const docs = await import(pathToFileURL(join(ROOT, 'lib/mcp/docs.ts')).href);
const { DEFAULT_MODES } = await import(pathToFileURL(join(ROOT, 'lib/modes.ts')).href);
const { serverInstructions, INSTRUCTIONS_BUDGET, RETIRED, RETIRED_LATER, STATE_FILE_OK } = docs;

// Agent-facing text: what agents read in tool descriptions, answers, hooks and the Claude page. Comment lines are skipped.
const SCANNED_DIRS = [
  ['lib/mcp', /\.ts$/],
  ['lib/mail', /\.ts$/],
  ['worker', /\.mjs$/],
  ['app/(app)/claude', /\.(ts|tsx)$/],
];
const SCANNED_FILES = ['lib/data/states.ts', 'lib/data/dispatcher.ts', 'lib/data/notes.ts', 'app/(app)/projects/[id]/state-card.tsx'];

function* walk(dir, re) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f === 'test') continue; // worker/test
      yield* walk(p, re);
    } else if (re.test(f)) yield p;
  }
}

const isComment = line => /^\s*(\/\/|\/\*|\*)/.test(line);
const rel = p => relative(ROOT, p).split('\\').join('/');
const lines = p => readFileSync(p, 'utf8').split(/\r?\n/);

export function wordsViolations() {
  const out = [];

  // 1-3. The instructions: budget, first line, retired words.
  const who = { name: 'Alex Johnson', modes: DEFAULT_MODES.map(m => m.name) };
  const withCode = serverInstructions(who, true);
  const connector = serverInstructions(who, false);
  for (const [label, text] of [['Claude Code key', withCode], ['connector', connector]]) {
    if (text.length > INSTRUCTIONS_BUDGET) out.push(`lib/mcp/docs.ts: the instructions for a ${label} are ${text.length} characters; the budget is ${INSTRUCTIONS_BUDGET}`);
    if (!text.startsWith('Call start_work first')) out.push(`lib/mcp/docs.ts: the instructions for a ${label} must start with "Call start_work first"`);
    if (RETIRED_LATER.test(text)) out.push(`lib/mcp/docs.ts: the instructions for a ${label} use "Claude item"`);
    for (const re of RETIRED) if (re.test(text)) out.push(`lib/mcp/docs.ts: the instructions for a ${label} use the retired word ${re}`);
  }

  // 3-5. Scanned files, line by line.
  const files = [];
  for (const [dir, re] of SCANNED_DIRS) files.push(...walk(join(ROOT, dir), re));
  for (const f of SCANNED_FILES) files.push(join(ROOT, f));
  const okForms = STATE_FILE_OK.map(s => s.toLowerCase());
  for (const f of files) {
    const name = rel(f);
    lines(f).forEach((raw, i) => {
      if (isComment(raw)) return;
      const at = `${name}:${i + 1}: ${raw.trim().slice(0, 120)}`;
      if (name === 'lib/data/dispatcher.ts' && RETIRED_LATER.test(raw)) out.push(`${at}  (retired: "Claude item")`);
      for (const re of RETIRED) if (re.test(raw)) out.push(`${at}  (retired: ${re})`);
      let l = raw.replace(/\u2019/g, "'").split("\\'").join("'").toLowerCase();
      for (const ok of okForms) l = l.split(ok).join('');
      l = l.split('work-state\\\\.md').join('').split('work-state\\.md').join('');
      if (l.includes('work-state')) out.push(`${at}  (WORK-STATE.md only as "a copy of the State": see STATE_FILE_OK in lib/mcp/docs.ts)`);
    });
  }
  return { violations: out, lengths: { withCode: withCode.length, connector: connector.length } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { violations, lengths } = wordsViolations();
  if (violations.length) {
    console.error(`Words check failed (docs/HANDOVER.md section 3, "Words"):\n${violations.join('\n')}`);
    process.exit(1);
  }
  console.log(`words check: ok (instructions ${lengths.withCode} characters for a Claude Code key, ${lengths.connector} for the connector; budget ${docs.INSTRUCTIONS_BUDGET})`);
}
