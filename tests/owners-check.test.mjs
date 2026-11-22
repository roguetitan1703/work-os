// The ratchet's own rules (tests/owners-check.mjs): a baseline never goes up, --init never records an existing question
// again, a file below its baseline fails until --update, the base is the git merge-base, and outside git only the counts
// are checked. Each test builds a small git repo in the temp folder and runs the script on it (OWNERS_ROOT, with
// OWNERS_TEST=1).
// Run: node --test tests/owners-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'owners-check.mjs');
const QUESTIONS = {
  copy: { question: 'Who copies?', owners: ['lib/owner.ts'], target: [], scan: ['lib'], how: 'Call the owner.', patterns: [{ name: 'copy', re: /\bCOPY\(/.source }] },
};

function repo(t, questions = QUESTIONS) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'wos-owners-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  const dir = join(top, 'repo');
  const put = (f, text) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); };
  // Git exports GIT_DIR (and more) to a hook run in a linked worktree; inherited, it would point these commits at the
  // real repo. So no GIT_* or OWNERS_* variable of the caller reaches git or the script here.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GIT|OWNERS)_/i.test(k)) delete env[k];
  Object.assign(env, { OWNERS_ROOT: dir, OWNERS_TEST: '1', GIT_CEILING_DIRECTORIES: top });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, env, encoding: 'utf8' });
  const run = (...a) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...a], { cwd: dir, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const json = () => JSON.parse(readFileSync(join(dir, 'tests/owners.json'), 'utf8'));
  const setJson = c => put('tests/owners.json', JSON.stringify(c, null, 2) + '\n');
  mkdirSync(dir);
  put('lib/owner.ts', 'export const COPY = (x: number) => x;\nCOPY(1);\n');
  put('lib/a.ts', "// COPY( in a comment does not count\nimport { COPY } from './owner';\nexport const a = COPY(1);\n");
  put('docs/ARCHITECTURE.md', '# Architecture\n');
  setJson({ questions: questions });
  assert.match(run('--init').out, /baseline written for: copy 1/);
  git('init', '-q', '-b', 'dev');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  return { top, dir, put, git, run, json, setJson, env };
}

test('the baseline from --init counts code only, and the check passes against the base', t => {
  const r = repo(t);
  assert.deepEqual(r.json().baseline, { copy: { 'lib/a.ts': 1 } });
  const ok = r.run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /check:owners ok \(compared with dev \([0-9a-f]{7}\)\)/);
});

test('a new copy above the baseline fails, naming the line and the owner', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /lib\/a\.ts:2 copy: export const b = COPY\(2\)/);
  assert.match(res.out, /Owner: lib\/owner\.ts/);
});

test('a baseline raised by hand fails against the merge-base, committed or not', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.baseline.copy['lib/a.ts'] = 2;
  r.setJson(c);
  assert.match(r.run().out, /allows 2 in lib\/a\.ts, dev \([0-9a-f]{7}\) allows 1\. A baseline is never raised/);
  r.git('commit', '-q', '-am', 'raise');
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /never raised/);
});

test('a file the base does not list cannot be added to the baseline', t => {
  const r = repo(t);
  r.put('lib/b.ts', 'export const b = COPY(2);\n');
  const c = r.json();
  c.baseline.copy['lib/b.ts'] = 1;
  r.setJson(c);
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /allows 1 in lib\/b\.ts, dev \([0-9a-f]{7}\) allows 0/);
});

test('--init refuses a question the base already has a baseline for', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  delete c.baseline.copy;
  r.setJson(c);
  const init = r.run('--init');
  assert.equal(init.code, 1);
  assert.match(init.out, /--init refused: copy already has a baseline on dev/);
  assert.equal(r.json().baseline.copy, undefined, 'nothing was written');
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /its baseline is missing here but dev \([0-9a-f]{7}\) has one\. Restore it: git checkout/);
});

test('below the baseline fails until --update; --no-stale only warns; --update only lowers', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = 1;\n');
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /below the baseline.*copy lib\/a\.ts 1 -> 0.*--update/s);
  const warn = r.run('--no-stale');
  assert.equal(warn.code, 0, warn.out);
  assert.match(warn.out, /Below the baseline: copy lib\/a\.ts 1 -> 0/);
  const up = r.run('--update');
  assert.equal(up.code, 0, up.out);
  assert.deepEqual(r.json().baseline, { copy: {} });
  assert.equal(r.run().code, 0);
});

test('a changed question needs docs/ARCHITECTURE.md to change in the same diff', t => {
  const r = repo(t);
  const c = r.json();
  c.questions.copy.owners.push('lib/a.ts');
  r.setJson(c);
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /copy: its owners, target, scan or patterns differ from dev .* but docs\/ARCHITECTURE\.md did not change/);
  r.put('docs/ARCHITECTURE.md', '# Architecture\n\nlib/a.ts owns it too.\n');
  const up = r.run('--update');
  assert.equal(up.code, 0, up.out);
  assert.deepEqual(r.json().baseline, { copy: {} });
});

test('a git mv keeps its count with --rename; the moved key is checked against the old one', t => {
  const r = repo(t);
  r.git('mv', 'lib/a.ts', 'lib/c.ts');
  assert.equal(r.run().code, 1, 'the new path is not in the baseline yet');
  assert.match(r.run('--rename', 'lib/a.ts', 'lib/c.ts').out, /lib\/a\.ts is now lib\/c\.ts in 1 question/);
  const ok = r.run();
  assert.equal(ok.code, 0, ok.out);
  r.put('lib/c.ts', readFileSync(join(r.dir, 'lib/c.ts'), 'utf8') + 'export const b = COPY(2);\n'); // still alike enough for git to see the move
  const c = r.json();
  c.baseline.copy['lib/c.ts'] = 2;
  r.setJson(c);
  assert.match(r.run().out, /allows 2 in lib\/c\.ts, dev \([0-9a-f]{7}\) allows 1 \(as lib\/a\.ts\)/);
});

test('outside git (the build folder) only the counts are checked', t => {
  const r = repo(t);
  const build = join(r.top, 'build');
  cpSync(r.dir, build, { recursive: true, filter: s => !s.includes('.git') });
  const env = { ...r.env, OWNERS_ROOT: build };
  const run = (...a) => { const x = spawnSync(process.execPath, [SCRIPT, ...a], { cwd: build, env, encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; };
  const ok = run('--no-stale');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /not compared/);
  writeFileSync(join(build, 'lib/a.ts'), 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  assert.equal(run('--no-stale').code, 1, 'a copy above the baseline still fails the build');
});

test('a question changed together with docs/ARCHITECTURE.md may be measured again with --init', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = AGAIN(2);\n');
  const c = r.json();
  c.questions.copy.patterns.push({ name: 'again', re: /\bAGAIN\(/.source });
  delete c.baseline.copy;
  r.setJson(c);
  assert.equal(r.run('--init').code, 1, 'refused while docs/ARCHITECTURE.md is unchanged');
  r.put('docs/ARCHITECTURE.md', '# Architecture\n\nAGAIN is a copy too.\n');
  assert.match(r.run('--init').out, /baseline written for: copy 2/);
  const ok = r.run();
  assert.equal(ok.code, 0, ok.out);
});

test('a question changed with docs/ARCHITECTURE.md still may not raise what the base counted', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.baseline.copy['lib/a.ts'] = 2;
  c.questions.copy.patterns.push({ name: 'never', re: 'ZZZ_NEVER' });
  r.setJson(c);
  r.put('docs/ARCHITECTURE.md', '# Architecture\n.\n');
  const res = r.run();
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /copy: lib\/a\.ts answers the question as dev \([0-9a-f]{7}\) asks it 2 time\(s\), and dev \([0-9a-f]{7}\) allows 1/);
  assert.match(r.run('--update').out, /never raised|does not raise/, '--update does not help either');
});

test('narrowing a question (its scan or patterns) with docs/ARCHITECTURE.md does not hide a new copy', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.questions.copy.scan = ['lib/none'];
  delete c.baseline.copy;
  r.setJson(c);
  r.put('docs/ARCHITECTURE.md', '# Architecture\n\nOnly lib/none.\n');
  assert.match(r.run('--init').out, /baseline written for: copy 0/);
  const res = r.run();
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /lib\/a\.ts answers the question as dev .* 2 time\(s\), and dev .* allows 1/);
});

test('a question goes away only when the base counts no answers to it', t => {
  const r = repo(t, { ...QUESTIONS, none: { question: 'Who never?', owners: [], target: [], scan: ['lib'], how: 'No.', patterns: [{ name: 'never', re: 'ZZZ_NEVER' }] } });
  assert.deepEqual(r.json().baseline.none, {});
  const c = r.json();
  c.questions.copy2 = c.questions.copy;
  delete c.questions.copy;
  delete c.baseline.copy;
  r.setJson(c);
  r.put('docs/ARCHITECTURE.md', '# Architecture\n\ncopy is now copy2.\n');
  assert.match(r.run('--init').out, /baseline written for: copy2 1/);
  const res = r.run();
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /copy: the question is gone, but dev \([0-9a-f]{7}\) counts 1 answer\(s\)/);
  r.git('checkout', '--', 'tests/owners.json');
  const d = r.json();
  delete d.questions.none;
  delete d.baseline.none;
  r.setJson(d);
  const ok = r.run();
  assert.equal(ok.code, 0, ok.out);
});

test('OWNERS_BASE adds a base and never replaces origin/dev and dev', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.baseline.copy['lib/a.ts'] = 2;
  r.setJson(c);
  r.git('commit', '-q', '-am', 'raise');
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: r.dir, env: { ...r.env, OWNERS_BASE: 'HEAD' }, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /allows 2 in lib\/a\.ts, dev \([0-9a-f]{7}\) allows 1/);
});

test('in git, a base that cannot be read fails: shallow clone, no merge-base, unknown OWNERS_BASE', t => {
  const r = repo(t);
  const at = (root, env = {}) => spawnSync(process.execPath, [SCRIPT], { cwd: root, env: { ...r.env, OWNERS_ROOT: root, ...env }, encoding: 'utf8' });
  const shallow = join(r.top, 'shallow');
  r.git('clone', '-q', '--depth', '1', pathToFileURL(r.dir).href, shallow);
  const s = at(shallow);
  assert.equal(s.status, 1, s.stdout);
  assert.match(s.stderr, /not compared: this is a shallow clone/);
  const u = at(r.dir, { OWNERS_BASE: 'no-such-ref' });
  assert.equal(u.status, 1, u.stdout);
  assert.match(u.stderr, /not compared: OWNERS_BASE no-such-ref has no merge-base/);
  r.git('checkout', '-q', '--orphan', 'lone');
  r.git('commit', '-q', '-m', 'lone');
  const n = at(r.dir);
  assert.equal(n.status, 1, n.stdout);
  assert.match(n.stderr, /not compared: neither origin\/dev nor dev has a merge-base/);
});

test('the walk skips worker/test only; another folder named test is scanned', t => {
  const r = repo(t, { copy: { ...QUESTIONS.copy, scan: ['lib', 'worker'] } });
  r.put('worker/test/x.test.mjs', 'COPY(1);\n');
  r.put('lib/test/b.ts', 'export const b = COPY(2);\n');
  const res = r.run();
  assert.equal(res.code, 1);
  assert.match(res.out, /lib\/test\/b\.ts: 1 answer\(s\)/);
  assert.doesNotMatch(res.out, /worker\/test/);
});

test('a GIT_DIR in the caller environment never reaches the temp repo', t => {
  const decoy = realpathSync(mkdtempSync(join(tmpdir(), 'wos-decoy-')));
  t.after(() => rmSync(decoy, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k];
  execFileSync('git', ['init', '-q', '-b', 'main', decoy], { env });
  const keep = process.env.GIT_DIR;
  process.env.GIT_DIR = join(decoy, '.git');
  try { repo(t); } finally { if (keep === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = keep; }
  const log = spawnSync('git', ['-C', decoy, 'rev-parse', '--verify', '-q', 'HEAD'], { env, encoding: 'utf8' });
  assert.notEqual(log.status, 0, 'the decoy repo has no commit');
  assert.equal(readFileSync(join(decoy, '.git/HEAD'), 'utf8').trim(), 'ref: refs/heads/main');
});

test('moving a file into owners or target, with any edit of docs/ARCHITECTURE.md, lets no raise through', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.questions.copy.target.push('lib/a.ts');
  delete c.baseline.copy['lib/a.ts'];
  r.setJson(c);
  r.put('docs/ARCHITECTURE.md', '# Architecture\n.\n');
  const asTarget = r.run();
  assert.equal(asTarget.code, 1, asTarget.out);
  assert.match(asTarget.out, /lib\/a\.ts is a target owner and exists now/);
  assert.match(asTarget.out, /copy: lib\/a\.ts is new in its owners or target, but no line this change adds to docs\/ARCHITECTURE\.md names it/);
  c.questions.copy.target.pop();
  c.questions.copy.owners.push('lib/a.ts');
  r.setJson(c);
  const asOwner = r.run();
  assert.equal(asOwner.code, 1, asOwner.out);
  assert.match(asOwner.out, /copy: lib\/a\.ts is new in its owners or target/);
  r.put('docs/ARCHITECTURE.md', '# Architecture\n\n`lib/a.ts` owns copy too.\n');
  const named = r.run();
  assert.equal(named.code, 0, 'a new owner named in the row is the visible way: ' + named.out);
});

test('OWNERS_ROOT and OWNERS_FILE count only with OWNERS_TEST=1, and the base is always tests/owners.json', t => {
  const r = repo(t);
  r.put('tests/owners-check.mjs', readFileSync(SCRIPT, 'utf8'));
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.baseline.copy['lib/a.ts'] = 2;
  r.put('tests/loose.json', JSON.stringify(c, null, 2) + '\n');
  const env = { ...r.env, OWNERS_FILE: join(r.dir, 'tests/loose.json') };
  delete env.OWNERS_TEST;
  delete env.OWNERS_ROOT;
  const own = spawnSync(process.execPath, [join(r.dir, 'tests/owners-check.mjs')], { cwd: r.dir, env, encoding: 'utf8' });
  assert.equal(own.status, 1, own.stdout);
  assert.match(own.stderr, /read only with OWNERS_TEST=1/);
  assert.match(own.stderr, /lib\/a\.ts: 2 answer\(s\) to "Who copies\?" outside its owner \(allowed 1\)/);
  const loose = spawnSync(process.execPath, [SCRIPT], { cwd: r.dir, env: { ...r.env, OWNERS_FILE: join(r.dir, 'tests/loose.json') }, encoding: 'utf8' });
  assert.equal(loose.status, 1, loose.stdout);
  assert.match(loose.stderr, /tests\/owners\.json allows 2 in lib\/a\.ts, dev \([0-9a-f]{7}\) allows 1/);
});

test('a base that has the script but no tests/owners.json fails', t => {
  const r = repo(t);
  r.put('tests/owners-check.mjs', readFileSync(SCRIPT, 'utf8'));
  r.git('add', 'tests/owners-check.mjs');
  r.git('rm', '-q', 'tests/owners.json');
  r.git('commit', '-q', '-m', 'drop the baseline');
  r.git('checkout', '-q', '-b', 'after');
  r.put('tests/owners.json', r.git('show', 'dev:tests/owners.json'));
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: r.dir, env: { ...r.env, OWNERS_BASE: 'work' }, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /not compared: work \([0-9a-f]{7}\) has tests\/owners-check\.mjs but no tests\/owners\.json/);
});

test('with no origin/dev, the upstream of dev is a base, and OWNERS_BASE adds the remote sha', t => {
  const r = repo(t);
  const clone = join(r.top, 'clone');
  r.git('clone', '-q', '-o', 'upstream', '-b', 'dev', r.dir, clone);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: clone, env: r.env, encoding: 'utf8' });
  writeFileSync(join(clone, 'lib/a.ts'), 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = JSON.parse(readFileSync(join(clone, 'tests/owners.json'), 'utf8'));
  c.baseline.copy['lib/a.ts'] = 2;
  writeFileSync(join(clone, 'tests/owners.json'), JSON.stringify(c, null, 2) + '\n');
  git('commit', '-q', '-am', 'raise on dev');
  const at = env => spawnSync(process.execPath, [SCRIPT], { cwd: clone, env: { ...r.env, OWNERS_ROOT: clone, ...env }, encoding: 'utf8' });
  const up = at();
  assert.equal(up.status, 1, up.stdout);
  assert.match(up.stderr, /allows 2 in lib\/a\.ts, dev@\{upstream\} \([0-9a-f]{7}\) allows 1/);
  git('branch', '--unset-upstream');
  const sha = git('rev-parse', 'upstream/dev').trim();
  const bySha = at({ OWNERS_BASE: sha });
  assert.equal(bySha.status, 1, bySha.stdout);
  assert.ok(bySha.stderr.includes(`allows 2 in lib/a.ts, ${sha} (${sha.slice(0, 7)}) allows 1`), bySha.stderr);
});

test('a change to the gate itself (this script, .githooks, the check scripts) prints a NOTE; OWNERS_TEST=1 is shown', t => {
  const r = repo(t);
  const pkg = scripts => r.put('package.json', JSON.stringify({ name: 'p', private: true, scripts }) + '\n');
  r.put('tests/owners-check.mjs', readFileSync(SCRIPT, 'utf8'));
  r.put('.githooks/pre-push', '#!/bin/sh\nexit 0\n');
  pkg({ check: 'node tests/owners-check.mjs', dev: 'next dev' });
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'the gate');
  r.git('branch', '-f', 'dev', 'HEAD');
  const same = r.run();
  assert.equal(same.code, 0, same.out);
  assert.doesNotMatch(same.out, /NOTE/);
  assert.match(same.out, /check:owners ok \(compared with dev \([0-9a-f]{7}\)\) \[test mode: OWNERS_TEST=1\]/);
  pkg({ check: 'node tests/owners-check.mjs', dev: 'next dev --port 3001' });
  assert.doesNotMatch(r.run().out, /NOTE/, 'other scripts are not the gate');
  pkg({ check: 'node tests/owners-check.mjs', dev: 'next dev', 'precheck:owners': 'node -e 0' });
  assert.match(r.run().out, /NOTE: the gate differs from dev \([0-9a-f]{7}\): the check scripts in package\.json\./, 'npm runs pre- and post-scripts with their script');
  pkg({ check: 'node -e 0', dev: 'next dev' });
  r.put('tests/owners-check.mjs', readFileSync(SCRIPT, 'utf8') + '// looser\n');
  r.put('.githooks/pre-push', '#!/bin/sh\nexit 0 # looser\n');
  const res = r.run();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /NOTE: the gate differs from dev \([0-9a-f]{7}\): \.githooks\/pre-push, tests\/owners-check\.mjs, the check scripts in package\.json\. The reviewer reads it: git diff [0-9a-f]{7} -- package\.json \.githooks tests\/owners-check\.mjs$/m);
});

test('a GIT_DIR and GIT_WORK_TREE in the caller environment do not switch off the base comparison', t => {
  const r = repo(t);
  r.put('lib/a.ts', 'export const a = COPY(1);\nexport const b = COPY(2);\n');
  const c = r.json();
  c.baseline.copy['lib/a.ts'] = 2;
  r.setJson(c);
  r.git('commit', '-q', '-am', 'raise');
  const decoy = join(r.top, 'decoy');
  r.git('init', '-q', decoy);
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: r.dir, env: { ...r.env, GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy }, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stderr, /allows 2 in lib\/a\.ts, dev \([0-9a-f]{7}\) allows 1/);
});

test('a folder named .next or node_modules below the root is scanned', t => {
  const r = repo(t);
  r.put('lib/data/.next/h.ts', 'export const h = COPY(3);\n');
  r.put('lib/node_modules/n.ts', 'export const n = COPY(4);\n');
  const res = r.run();
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /lib\/data\/\.next\/h\.ts: 1 answer\(s\)/);
  assert.match(res.out, /lib\/node_modules\/n\.ts: 1 answer\(s\)/);
});

test('the gate is the list in .githooks/gate-files; the NOTE names each listed file that changed and prints the list', t => {
  const r = repo(t);
  const files = ['.npmrc', 'tsconfig.check.json', 'scripts/check-links.mjs', 'tests/words-check.mjs'];
  r.put('.githooks/gate-files', '# the gate\npackage.json\n.npmrc\ntsconfig.json\ntsconfig.check.json\n.githooks\nscripts/check-links.mjs\ntests/*-check.mjs\n');
  for (const f of files) r.put(f, 'v1\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'the gate');
  r.git('branch', '-f', 'dev', 'HEAD');
  r.put('lib/other.ts', 'export const o = 1;\n');
  r.put('tests/other.test.mjs', 'v2\n');
  const same = r.run();
  assert.equal(same.code, 0, same.out);
  assert.doesNotMatch(same.out, /NOTE/, 'other code and tests are not the gate');
  for (const f of files) r.put(f, 'v2\n');
  const res = r.run();
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /NOTE: the gate differs from dev \([0-9a-f]{7}\): \.npmrc, scripts\/check-links\.mjs, tests\/words-check\.mjs, tsconfig\.check\.json\./);
  assert.ok(res.out.includes(" -- package.json .npmrc tsconfig.json tsconfig.check.json .githooks scripts/check-links.mjs 'tests/*-check.mjs'\n"), res.out);
});
