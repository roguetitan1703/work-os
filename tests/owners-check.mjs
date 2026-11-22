// Ratchet for the owned questions (docs/ARCHITECTURE.md): a question such as "is this session alive" has one owner module.
// tests/owners.json lists, per question, the patterns that answer it again by hand, the files that may (owners today, and
// target owners that may not exist yet), the folders or files searched, and today's count per other file (the baseline).
// Run: npm run check:owners. It fails when:
//   - a file answers a question more often than its baseline allows (call the owner instead); a target owner that
//     exists is counted like any other file until it moves to owners;
//   - a file answers it less often than its baseline (lock that in: npm run check:owners -- --update), unless --no-stale;
//   - in a git checkout, tests/owners.json is looser than on a base (the merge-base of HEAD with origin/dev, with the
//     upstream of dev, with dev, and with OWNERS_BASE when set): a count above the base's, a file the base does not list,
//     a baseline the base has gone missing, or a question's owners, target, scan or patterns changed without
//     docs/ARCHITECTURE.md changing too;
//   - a file is new in a question's owners or target and no line added to docs/ARCHITECTURE.md names it;
//   - a question changed together with docs/ARCHITECTURE.md answers the base's own question (its patterns and scan) more
//     often than the base's baseline allows, outside the owners it has now; or a question the base counts answers for
//     is gone;
//   - in a git checkout no base can be read: a shallow clone, no merge-base with origin/dev or dev, an OWNERS_BASE that
//     has none, or a base that has this script but no tests/owners.json.
// Outside git (the server build folder) the base comparison is skipped.
// --update only lowers. --init records the baseline of a question that has none; it refuses an id the base already has,
// unless that question's owners, target, scan or patterns changed together with docs/ARCHITECTURE.md (then it re-measures).
// --rename <old> <new> moves a file's counts after a git mv (stage the move, so git sees the rename).
// OWNERS_ROOT and OWNERS_FILE point it at another tree, only with OWNERS_TEST=1 (tests/owners-check.test.mjs); every ok
// line then ends with [test mode: OWNERS_TEST=1], so pasted output shows it.
// OWNERS_BASE adds a base, never replaces one (the pre-push hook passes the remote's sha).
// The files in .githooks/gate-files (this script, the hook, the other check scripts, the check scripts in package.json,
// the tsconfigs, .npmrc) are the gate itself, and a checkout runs its own copy of them. A NOTE line names the ones that
// differ from a base; the reviewer reads that diff. The pre-push hook prints the same against the remote's copy of the list.
// git runs with no GIT_* variable of the caller, so a GIT_DIR left by another hook cannot point the bases elsewhere.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST = process.env.OWNERS_TEST === '1';
if (!TEST && (process.env.OWNERS_ROOT || process.env.OWNERS_FILE)) console.error('check:owners: OWNERS_ROOT and OWNERS_FILE are read only with OWNERS_TEST=1 (tests/owners-check.test.mjs); checking this checkout instead.');
const ROOT = resolve((TEST && process.env.OWNERS_ROOT) || join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const FILE = resolve((TEST && process.env.OWNERS_FILE) || join(ROOT, 'tests/owners.json'));
const DOC = 'docs/ARCHITECTURE.md';
const tag = TEST ? ' [test mode: OWNERS_TEST=1]' : '';
const args = process.argv.slice(2);
const update = args.includes('--update');
const init = args.includes('--init');
const noStale = args.includes('--no-stale');
const ri = args.indexOf('--rename');
const rename = ri >= 0 ? args.slice(ri + 1, ri + 3) : null;
if (rename && rename.length < 2) { console.error('usage: npm run check:owners -- --rename <old path> <new path>'); process.exit(1); }

const cfg = JSON.parse(readFileSync(FILE, 'utf8'));
cfg.baseline ??= {};
const posix = p => p.split(sep).join('/');
const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const save = () => writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');
const shape = q => JSON.stringify(q ? [q.owners, q.target, q.scan, q.patterns] : null);
// The files a question does not count: its owners, and its target owners while they do not exist.
const allowedOf = q => new Set([...q.owners, ...q.target.filter(f => !existsSync(join(ROOT, f)))]);
const named = q => new Set(q ? [...q.owners, ...q.target] : []);

if (rename) {
  const [from, to] = rename;
  let moved = 0;
  for (const [id, base] of Object.entries(cfg.baseline)) {
    if (!(from in base)) continue;
    if (to in base) { console.error(`--rename: ${id} already lists ${to}; nothing changed`); process.exit(1); }
    base[to] = base[from];
    delete base[from];
    cfg.baseline[id] = sorted(base);
    moved++;
  }
  save();
  console.log(moved ? `owners baseline: ${from} is now ${to} in ${moved} question(s)` : `no baseline lists ${from}`);
  process.exit(0);
}

// git in ROOT, found from the folder alone; null when git, the repo or the ref is missing.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
const git = (...a) => {
  try { return execFileSync('git', a, { cwd: ROOT, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};
const bases = [];
const notCompared = why => {
  console.error(`check:owners failed: not compared: ${why}`);
  process.exit(1);
};
const inGit = git('rev-parse', '--is-inside-work-tree') === 'true';
if (inGit) {
  if (git('rev-parse', '--is-shallow-repository') === 'true') notCompared('this is a shallow clone, so the merge-base cannot be found. Run git fetch --unshallow, then run it again.');
  const extra = process.env.OWNERS_BASE;
  let found = 0;
  for (const ref of ['origin/dev', 'dev@{upstream}', 'dev', ...(extra ? [extra] : [])]) {
    const at = git('merge-base', 'HEAD', ref);
    if (!at && ref === extra) notCompared(`OWNERS_BASE ${extra} has no merge-base with HEAD in this clone. Run git fetch, then run it again.`);
    if (at) found++;
    if (!at || bases.some(b => b.at === at)) continue;
    // The base is read at the fixed path, whatever OWNERS_FILE says.
    const text = git('show', `${at}:./tests/owners.json`);
    if (!text) {
      if (git('cat-file', '-e', `${at}:./tests/owners-check.mjs`) !== null) notCompared(`${ref} (${at.slice(0, 7)}) has tests/owners-check.mjs but no tests/owners.json. Restore it: git checkout ${at.slice(0, 7)} -- tests/owners.json`);
      continue; // the base is from before the check existed
    }
    const docChanged = !!git('diff', '--name-only', at, '--', DOC);
    const docAdded = docChanged ? (git('diff', at, '--', DOC) ?? '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')) : [];
    const renamed = new Map();
    for (const l of (git('diff', '-M', '--name-status', '--relative', at) ?? '').split('\n')) {
      const [s, a, b] = l.split('\t');
      if (s?.startsWith('R') && b) renamed.set(b, a);
    }
    const c = JSON.parse(text);
    bases.push({ name: `${ref} (${at.slice(0, 7)})`, at, q: c.questions ?? {}, b: c.baseline ?? {}, docChanged, docAdded, renamed });
  }
  if (!found) notCompared('neither origin/dev nor dev has a merge-base with HEAD here. Run git fetch origin, then run it again.');
  // The gate itself (.githooks/gate-files, one git pathspec per line). It passes or fails its own change, so a change to
  // it is named here for the reviewer (AGENTS.md, Checks). package.json counts only for its check scripts.
  const listed = existsSync(join(ROOT, '.githooks/gate-files')) ? readFileSync(join(ROOT, '.githooks/gate-files'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
  const gate = listed.length ? [...new Set([...listed, '.githooks'])] : ['package.json', '.githooks', 'tests/owners-check.mjs'];
  const shown = gate.map(p => (p.includes('*') ? `'${p}'` : p)).join(' ');
  const gateScripts = text => {
    try { return JSON.stringify(Object.entries(JSON.parse(text).scripts ?? {}).filter(([k]) => /^(pre|post)?(check|typecheck|test:|build)/.test(k)).sort()); } catch { return null; }
  };
  const pkg = join(ROOT, 'package.json');
  const mine = gateScripts(existsSync(pkg) ? readFileSync(pkg, 'utf8') : '{}');
  for (const B of bases) {
    const differ = (git('diff', '--name-only', B.at, '--', ...gate.filter(p => p !== 'package.json')) ?? '').split('\n').filter(Boolean);
    if (gateScripts(git('show', `${B.at}:./package.json`) ?? '{}') !== mine) differ.push('the check scripts in package.json');
    if (differ.length) console.log(`NOTE: the gate differs from ${B.name}: ${differ.join(', ')}. The reviewer reads it: git diff ${B.at.slice(0, 7)} -- ${shown}`);
  }
}
// A question may be re-measured against a base only when it changed there together with docs/ARCHITECTURE.md.
const reopened = (B, id) => B.docChanged && shape(B.q[id]) !== shape(cfg.questions[id]);
const heldBy = id => bases.find(B => B.b[id] && !reopened(B, id));

function* walk(p) {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    const rel = posix(relative(ROOT, p));
    if (rel === 'worker/test') return; // the worker's tests, not its code
    // Only the root node_modules and .next are skipped (what .gitignore ignores); a folder of that name deeper is code.
    for (const f of readdirSync(p)) if (rel || !['node_modules', '.next'].includes(f)) yield* walk(join(p, f));
  } else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p)) yield p;
}

// The code only: comments and import/export-from statements become spaces, newlines stay, so line numbers hold.
function codeOnly(src) {
  let out = '';
  let q = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const d = src[i + 1] ?? '';
    if (q) {
      if (c === '\\') { out += c + d; i += 2; continue; }
      if (c === q || (c === '\n' && q !== '`')) q = null;
      out += c; i++;
      continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const j = e < 0 ? src.length : e + 2;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    if (c === '\\') { out += c + d; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    out += c; i++;
  }
  return out.replace(/^[ \t]*(import\b|export\s*(\*|\{|type\s*\{))[^;'"`]*?\bfrom\s*(['"])[^'"\n]*\3;?|^[ \t]*import\s*(['"])[^'"\n]*\4;?/gm, m => m.replace(/[^\n]/g, ' '));
}
const lineAt = (text, i) => { let n = 1; for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++; return n; };

// Per file the question does not allow: how many times its code matches one of q's patterns, and where.
function measure(q, allowed = allowedOf(q)) {
  const res = q.patterns.map(p => ({ name: p.name, re: new RegExp(p.re, 'g') }));
  const counts = {};
  const where = {};
  const seen = new Set();
  for (const dir of q.scan) {
    for (const p of walk(join(ROOT, dir))) {
      const rel = posix(relative(ROOT, p));
      if (allowed.has(rel) || seen.has(rel)) continue;
      seen.add(rel);
      const src = readFileSync(p, 'utf8');
      const text = codeOnly(src);
      const lines = src.split('\n');
      for (const r of res) {
        for (const m of text.matchAll(r.re)) {
          const n = lineAt(text, m.index);
          counts[rel] = (counts[rel] ?? 0) + 1;
          (where[rel] ??= []).push(`    ${rel}:${n} ${r.name}: ${lines[n - 1].trim().slice(0, 120)}`);
        }
      }
    }
  }
  return { counts, where };
}

const fails = [];
const now = {};
for (const [id, q] of Object.entries(cfg.questions)) {
  for (const f of q.owners) if (!existsSync(join(ROOT, f))) fails.push(`${id}: owner ${f} does not exist; fix tests/owners.json and ${DOC}`);
  const { counts, where } = measure(q);
  now[id] = sorted(counts);
  const base = cfg.baseline[id];
  if (!base) continue;
  for (const [f, n] of Object.entries(counts)) {
    const b = base[f] ?? 0;
    const grown = q.target.includes(f) ? ` ${f} is a target owner and exists now: move it to owners and rewrite its row in ${DOC} in the same commit.` : '';
    if (n > b) fails.push(`${f}: ${n} answer(s) to "${q.question}" outside its owner (allowed ${b}). ${q.how}${grown} Owner: ${q.owners.concat(q.target).join(', ') || 'none yet'} (${DOC}).\n${where[f].join('\n')}`);
  }
}

const missing = Object.keys(cfg.questions).filter(id => !cfg.baseline[id]);
if (init) {
  const refused = missing.filter(heldBy);
  if (refused.length) {
    const B = heldBy(refused[0]);
    console.error(`check:owners --init refused: ${refused.join(', ')} already has a baseline on ${B.name}. A baseline is never recorded again; restore it: git checkout ${B.at.slice(0, 7)} -- tests/owners.json`);
    process.exit(1);
  }
  for (const id of missing) cfg.baseline[id] = now[id];
  save();
  const total = id => Object.values(now[id]).reduce((a, b) => a + b, 0);
  console.log(missing.length ? `owners baseline written for: ${missing.map(id => `${id} ${total(id)}`).join(', ')}` : 'every question has a baseline already; it only goes down (--update)');
  process.exit(0);
}
for (const id of missing) {
  const B = heldBy(id);
  fails.push(B ? `${id}: its baseline is missing here but ${B.name} has one. Restore it: git checkout ${B.at.slice(0, 7)} -- tests/owners.json` : `${id}: a new question with no baseline: run npm run check:owners -- --init (with its row in ${DOC})`);
}

for (const B of bases) {
  for (const id of new Set([...Object.keys(B.q), ...Object.keys(cfg.questions)])) {
    if (shape(B.q[id]) !== shape(cfg.questions[id]) && !B.docChanged) fails.push(`${id}: its owners, target, scan or patterns differ from ${B.name}, but ${DOC} did not change. A change to an owned question changes its row there in the same commit.`);
    // A file that becomes an owner or a target owner is named in a line this change adds to docs/ARCHITECTURE.md.
    if (!cfg.questions[id] || !B.docChanged) continue;
    const had = named(B.q[id]);
    for (const f of named(cfg.questions[id])) {
      if (!had.has(f) && !B.docAdded.some(l => l.includes(f))) fails.push(`${id}: ${f} is new in its owners or target, but no line this change adds to ${DOC} names it. Write the new owner into the question's row there.`);
    }
  }
  for (const [id, mine] of Object.entries(cfg.baseline)) {
    const theirs = B.b[id];
    if (!theirs || !cfg.questions[id] || reopened(B, id)) continue;
    for (const [f, n] of Object.entries(mine)) {
      const from = f in theirs ? f : B.renamed.get(f);
      const b = from ? theirs[from] ?? 0 : 0;
      if (n > b) fails.push(`${id}: tests/owners.json allows ${n} in ${f}, ${B.name} allows ${b}${from && from !== f ? ` (as ${from})` : ''}. A baseline is never raised: call the owner (${DOC}).`);
    }
  }
  // A question changed together with docs/ARCHITECTURE.md is measured again for what it adds; what the base counted
  // never goes up. A question the base counts answers for never goes away.
  for (const [id, theirs] of Object.entries(B.b)) {
    const q = cfg.questions[id];
    const total = Object.values(theirs).reduce((a, b) => a + b, 0);
    if (!q) {
      if (total) fails.push(`${id}: the question is gone, but ${B.name} counts ${total} answer(s) to it outside its owner. Keep its id; change its row in ${DOC} instead.`);
      continue;
    }
    if (!reopened(B, id) || !B.q[id]) continue;
    for (const [f, n] of Object.entries(measure(B.q[id], allowedOf(q)).counts)) {
      const from = f in theirs ? f : B.renamed.get(f);
      const b = from ? theirs[from] ?? 0 : 0;
      if (n > b) fails.push(`${id}: ${f} answers the question as ${B.name} asks it ${n} time(s), and ${B.name} allows ${b}${from && from !== f ? ` (as ${from})` : ''}. Changing the question does not raise its baseline: call the owner (${DOC}).`);
    }
  }
}

if (fails.length) {
  console.error('check:owners failed:\n' + fails.map(l => '  ' + l).join('\n'));
  process.exit(1);
}
const lower = [];
for (const [id, base] of Object.entries(cfg.baseline)) {
  if (!cfg.questions[id]) { lower.push(`${id} (no such question)`); continue; }
  for (const [f, b] of Object.entries(base)) if ((now[id][f] ?? 0) < b) lower.push(`${id} ${f} ${b} -> ${now[id][f] ?? 0}`);
}
const against = bases.length ? `compared with ${bases.map(B => B.name).join(', ')}` : `not compared with a base: ${inGit ? 'no base has tests/owners.json yet' : 'no git here'}`;
if (!lower.length) console.log(`check:owners ok (${against})${tag}`);
else if (update) {
  const out = {};
  for (const id of Object.keys(cfg.questions)) {
    out[id] = {};
    for (const f of Object.keys(cfg.baseline[id]).sort()) { const n = Math.min(now[id][f] ?? 0, cfg.baseline[id][f]); if (n) out[id][f] = n; }
  }
  cfg.baseline = out;
  save();
  console.log(`owners baseline lowered: ${lower.join('; ')}`);
} else if (noStale) console.log(`check:owners ok (${against})${tag}. Below the baseline: ${lower.join('; ')}. Lock it in: npm run check:owners -- --update`);
else {
  console.error(`check:owners failed: below the baseline, so the freed room could fill up again: ${lower.join('; ')}. Run npm run check:owners -- --update and commit tests/owners.json.`);
  process.exit(1);
}
