// The pre-push hook (.githooks/pre-push): which pushes run npm run check, what reaches the check, and what stops a push.
// Each test makes a bare remote, a clone and a stand-in `check` script that prints the GIT_* and OWNERS_* variables it
// sees. core.hooksPath is the absolute path of the main checkout's .githooks, as AGENTS.md says to install it.
// Run: node --test tests/pre-push.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-push');
const COPY = 'WORK-STATE.md';
// The stand-in check: what it saw and the owners check's ok line (none with CHECK_NO_OK), then fail when CHECK_FAIL is set.
const CHECK = [
  "if (!process.env.CHECK_NO_OK) console.log('check:owners ok (stand-in)');",
  "const seen = Object.keys(process.env).filter(k => /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_PREFIX|OWNERS_)/.test(k)).sort().map(k => k + '=' + process.env[k]);",
  "console.log('CHECK-SAW ' + JSON.stringify(seen));",
  'process.exit(process.env.CHECK_FAIL ? 1 : 0);',
].join('\n');

// The list the hook prints: the gate-files this file's tests copy next to the hook, as a regex.
const LIST = "package\\.json \\.npmrc tsconfig\\.json tsconfig\\.check\\.json \\.githooks scripts/check-links\\.mjs 'tests/\\*-check\\.mjs' node_modules$";

function setup(t) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'wos-prepush-')));
  t.after(() => rmSync(top, { recursive: true, force: true }));
  // Run from inside a hook, this test must not inherit that hook's GIT_DIR (tests/owners-check.test.mjs does the same).
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GIT|OWNERS)_/i.test(k)) delete env[k];
  env.GIT_CEILING_DIRECTORIES = top;
  const main = join(top, 'main');
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd, env, encoding: 'utf8' }).trim();
  git(top, 'init', '-q', '--bare', '-b', 'dev', 'remote.git');
  git(top, 'init', '-q', '-b', 'dev', 'main');
  mkdirSync(join(main, '.githooks'));
  copyFileSync(HOOK, join(main, '.githooks/pre-push'));
  copyFileSync(join(dirname(HOOK), 'gate-files'), join(main, '.githooks/gate-files'));
  chmodSync(join(main, '.githooks/pre-push'), 0o755);
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { check: 'node check.cjs' } }) + '\n');
  writeFileSync(join(main, 'check.cjs'), CHECK + '\n');
  writeFileSync(join(main, COPY), 'v1\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'base');
  git(main, 'remote', 'add', 'origin', join(top, 'remote.git'));
  git(main, 'config', 'core.hooksPath', `${main.split(sep).join('/')}/.githooks`);
  const push = (cwd, extra, ...a) => {
    const r = spawnSync('git', ['push', '-q', ...a], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const commit = (cwd, f, text) => { writeFileSync(join(cwd, f), text); git(cwd, 'add', f); git(cwd, 'commit', '-q', '-m', f); return git(cwd, 'rev-parse', 'HEAD'); };
  const remote = ref => spawnSync('git', ['--git-dir', join(top, 'remote.git'), 'rev-parse', '-q', '--verify', ref], { env, encoding: 'utf8' }).stdout.trim();
  return { top, main, git, push, commit, remote };
}

test('only dev and master run the check, once per commit', t => {
  const r = setup(t);
  const feature = r.push(r.main, {}, 'origin', 'HEAD:refs/heads/feature');
  assert.equal(feature.code, 0, feature.out);
  assert.doesNotMatch(feature.out, /pre-push:/);
  const dev = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(dev.code, 0, dev.out);
  assert.match(dev.out, /pre-push: npm run check for [0-9a-f]{40}/);
  assert.match(dev.out, /CHECK-SAW \[\]/, 'a new remote branch passes no base');
  const master = r.push(r.main, {}, 'origin', 'dev:master');
  assert.equal(master.code, 0, master.out);
  assert.doesNotMatch(master.out, /npm run check for/, 'the commit that passed is not checked again');
});

test('the sha the remote has is the base, and OWNERS_* from the caller never reach the check', t => {
  const r = setup(t);
  assert.equal(r.push(r.main, {}, 'origin', 'dev').code, 0);
  const before = r.remote('dev');
  r.commit(r.main, 'a.txt', 'a\n');
  const res = r.push(r.main, { OWNERS_BASE: 'HEAD', OWNERS_FILE: 'loose.json', OWNERS_ROOT: r.top, OWNERS_TEST: '1' }, 'origin', 'dev');
  assert.equal(res.code, 0, res.out);
  assert.ok(res.out.includes(`CHECK-SAW ["OWNERS_BASE=${before}"]`), res.out);
  assert.doesNotMatch(res.out, /NOTE/, 'a.txt is not the gate');
});

test('a failed check stops the push', t => {
  const r = setup(t);
  const res = r.push(r.main, { CHECK_FAIL: '1' }, 'origin', 'dev');
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /pre-push: npm run check failed; nothing was pushed/);
  assert.equal(r.remote('dev'), '', 'the remote has no dev');
});

test('a linked worktree whose commit has no .githooks still runs the hook, and GIT_DIR does not reach the check', t => {
  const r = setup(t);
  r.git(r.main, 'checkout', '-q', '-b', 'old');
  r.git(r.main, 'rm', '-r', '-q', '.githooks');
  r.git(r.main, 'commit', '-q', '-m', 'no hooks here');
  r.git(r.main, 'checkout', '-q', 'dev');
  const wt = join(r.top, 'wt');
  r.git(r.main, 'worktree', 'add', '-q', wt, 'old');
  const failed = r.push(wt, { CHECK_FAIL: '1' }, 'origin', 'HEAD:dev');
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /nothing was pushed/);
  const res = r.push(wt, {}, 'origin', 'HEAD:dev');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /pre-push: npm run check for [0-9a-f]{40}/);
  assert.match(res.out, /CHECK-SAW \[\]/, 'no GIT_DIR, GIT_PREFIX or OWNERS_* reached it');
});

test('changes or untracked files stop the push, except the State copy', t => {
  const r = setup(t);
  writeFileSync(join(r.main, COPY), 'v2\n');
  const copyOnly = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(copyOnly.code, 0, copyOnly.out);
  r.git(r.main, 'checkout', '--', COPY);
  r.commit(r.main, 'b.txt', 'b\n');
  writeFileSync(join(r.main, 'stray.txt'), 'x\n');
  const stray = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(stray.code, 1, stray.out);
  assert.match(stray.out, /is not HEAD here with a clean tree/);
  rmSync(join(r.main, 'stray.txt'));
  r.commit(r.main, 'c.txt', 'c\n');
  const older = r.push(r.main, {}, 'origin', 'HEAD~1:dev');
  assert.equal(older.code, 1, older.out);
  assert.match(older.out, /is not HEAD here/);
});

test('a check that passes without a "check:owners ok" line stops the push', t => {
  const r = setup(t);
  const res = r.push(r.main, { CHECK_NO_OK: '1' }, 'origin', 'dev');
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /printed no "check:owners ok" line, so the owners check did not run; nothing was pushed/);
  assert.equal(r.remote('dev'), '', 'the remote has no dev');
});

test('a push that changes a gate file names it, from the remote copy of the list', t => {
  const r = setup(t);
  assert.equal(r.push(r.main, {}, 'origin', 'dev').code, 0);
  const before = r.remote('dev');
  r.git(r.main, 'checkout', '-q', '-b', 'loose');
  r.commit(r.main, 'package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node check.cjs', 'check:owners': 'node -e 0' } }) + '\n');
  r.commit(r.main, '.githooks/gate-files', '.githooks\n');
  const wt = join(r.top, 'wt');
  r.git(r.main, 'checkout', '-q', 'dev');
  r.git(r.main, 'worktree', 'add', '-q', wt, 'loose');
  const res = r.push(wt, {}, 'origin', 'HEAD:dev');
  assert.equal(res.code, 0, res.out);
  const short = before.slice(0, 7);
  assert.match(res.out, new RegExp(`pre-push: NOTE: the gate differs from the remote's ${short}: \\.githooks/gate-files, package\\.json\\. The reviewer reads it: git diff ${short} [0-9a-f]{7} -- ${LIST}`, 'm'));
});

test('a remote sha this clone does not have stops the push before the check', t => {
  const r = setup(t);
  assert.equal(r.push(r.main, {}, 'origin', 'dev').code, 0);
  const other = join(r.top, 'other');
  r.git(r.top, 'clone', '-q', join(r.top, 'remote.git'), other);
  r.commit(other, 'o.txt', 'o\n');
  r.git(other, 'push', '-q', '--no-verify', 'origin', 'dev');
  r.commit(r.main, 'm.txt', 'm\n');
  const res = r.push(r.main, {}, 'origin', '+dev');
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /which this clone does not have/);
  assert.doesNotMatch(res.out, /npm run check for/);
});

test('a branch merged in the main checkout that shortens the list is still named, from the remote copy', t => {
  const r = setup(t);
  assert.equal(r.push(r.main, {}, 'origin', 'dev').code, 0);
  const before = r.remote('dev');
  r.git(r.main, 'checkout', '-q', '-b', 'feature');
  r.commit(r.main, '.githooks/gate-files', 'tsconfig.json\n');
  r.commit(r.main, 'package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node check.cjs', 'check:owners': 'echo check:owners ok' } }) + '\n');
  r.git(r.main, 'checkout', '-q', 'dev');
  r.git(r.main, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  const res = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(res.code, 0, res.out, 'a NOTE never stops a push; the reviewer reads it');
  const short = before.slice(0, 7);
  assert.match(res.out, new RegExp(`pre-push: NOTE: the gate differs from the remote's ${short}: \\.githooks/gate-files, package\\.json\\. The reviewer reads it: git diff ${short} [0-9a-f]{7} -- ${LIST}`, 'm'));
});

test('a remote list with no final newline still keeps .githooks and its last file', t => {
  const r = setup(t);
  r.commit(r.main, '.githooks/gate-files', 'package.json\ntsconfig.json');
  assert.equal(r.push(r.main, {}, 'origin', 'dev').code, 0);
  r.commit(r.main, 'tsconfig.json', '{}\n');
  const res = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /pre-push: NOTE: the gate differs from the remote's [0-9a-f]{7}: tsconfig\.json\. The reviewer reads it: git diff [0-9a-f]{7} [0-9a-f]{7} -- package\.json tsconfig\.json \.githooks node_modules$/m);
});

test('a remote with no gate list yet still names .githooks, package.json and node_modules', t => {
  const r = setup(t);
  r.git(r.main, 'rm', '-q', '.githooks/gate-files');
  r.git(r.main, 'commit', '-q', '-m', 'no list');
  assert.equal(r.push(r.main, {}, 'origin', 'dev').code, 0);
  r.commit(r.main, 'package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node check.cjs', x: '1' } }) + '\n');
  const res = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /pre-push: NOTE: the gate differs from the remote's [0-9a-f]{7}: package\.json\. The reviewer reads it: git diff [0-9a-f]{7} [0-9a-f]{7} -- \.githooks package\.json node_modules$/m);
});

test('a commit that tracks a file under node_modules stops the push before the check', t => {
  const r = setup(t);
  mkdirSync(join(r.main, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(r.main, 'node_modules/.bin/npm.cmd'), '@echo check:owners ok\r\n');
  r.git(r.main, 'add', '-f', 'node_modules/.bin/npm.cmd');
  r.git(r.main, 'commit', '-q', '-m', 'tracked node_modules');
  const res = r.push(r.main, {}, 'origin', 'dev');
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /tracks files under node_modules, and npm runs node_modules\/.bin before anything else; nothing was pushed/);
  assert.doesNotMatch(res.out, /npm run check for/);
  assert.equal(r.remote('dev'), '', 'the remote has no dev');
});
