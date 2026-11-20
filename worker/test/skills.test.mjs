// The Work OS skills (/transfer, /declutter; worker/skills-install.mjs): installed and refreshed beside the hooks, only
// into folders marked as the worker's; a person's own folder of the same name is left alone unless they adopt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-skills-'));
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, 'claude', 'settings.json');
delete process.env.CLAUDE_SKILLS_DIR;
delete process.env.WORK_OS_KEY;
const s = await import('../skills-install.mjs');
const h = await import('../hooks-install.mjs');
const { bundleFrom, readWorkerFiles } = await import('../bundle/build.mjs');

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(tmp, 'claude', 'skills');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const marker = (name, t = target) => read(t, name, s.MARKER).trim();
const NAMES = ['declutter', 'transfer'];

test('the worker carries /transfer and /declutter, written for anyone (no Om, no machine paths)', () => {
  assert.deepEqual(s.skillSources().map((x) => x.name), NAMES);
  for (const x of s.skillSources()) {
    assert.match(x.text, new RegExp(`^---\\r?\\nname: ${x.name}\\r?\\n`));
    assert.doesNotMatch(x.text, /\bOm\b|VICTUS|[A-Z]:[\\/]|\/Users\//);
    assert.match(x.text, /your person/);
  }
  assert.equal(s.skillsTarget(), target, 'beside the settings file a test points at, never the real ~/.claude');
});

test('install puts both skills in with the marker; a rerun changes nothing; status says current', () => {
  fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH, '{}');
  const r = h.install();
  assert.deepEqual(r.skills.installed, NAMES);
  for (const x of s.skillSources()) {
    assert.equal(read(target, x.name, 'SKILL.md'), x.text);
    assert.equal(marker(x.name), x.version);
  }
  assert.deepEqual(h.install().skills, { installed: [], current: NAMES, own: [], removed: [], backups: [] });
  assert.deepEqual(h.status().skills.map((x) => x.state), ['current', 'current']);
  assert.deepEqual(fs.readdirSync(target).sort(), NAMES, 'no temp folder left');
});

test('a newer skill replaces the installed one; a marked skill no longer carried is removed', () => {
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'transfer'), { recursive: true });
  fs.writeFileSync(path.join(src, 'transfer', 'SKILL.md'), '---\nname: transfer\n---\nv2\n');
  const t = path.join(tmp, 't1');
  s.installSkills({ target: t, src: path.join(WORKER, 'skills') });
  fs.writeFileSync(path.join(t, 'transfer', 'notes.txt'), 'left by an old version');
  const r = s.installSkills({ target: t, src });
  assert.deepEqual(r.installed, ['transfer']);
  assert.deepEqual(r.removed, ['declutter'], 'the worker no longer carries it, and it was ours');
  assert.equal(read(t, 'transfer', 'SKILL.md'), '---\nname: transfer\n---\nv2\n');
  assert.equal(marker('transfer', t), s.skillVersion('---\nname: transfer\n---\nv2\n'));
  assert.equal(fs.existsSync(path.join(t, 'transfer', 'notes.txt')), false, 'the folder is replaced whole');
  assert.equal(s.skillVersion('a\r\nb\r\n'), s.skillVersion('a\nb\n'), 'line endings do not change the version');
});

test('the worker start refreshes stale skills only when its own hooks are installed', () => {
  fs.writeFileSync(path.join(target, 'declutter', s.MARKER), 'old000000000\n');
  assert.equal(h.status().skills.find((x) => x.name === 'declutter').state, 'stale');
  assert.match(s.describeSkills([{ name: 'declutter', state: 'stale' }])[0], /out of date/);
  assert.deepEqual(h.refreshSkills(), ['declutter']);
  assert.deepEqual(h.refreshSkills(), [], 'current: nothing to do');
  const saved = read(process.env.CLAUDE_SETTINGS_PATH);
  fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH, '{}');
  fs.writeFileSync(path.join(target, 'declutter', s.MARKER), 'old000000000\n');
  assert.deepEqual(h.refreshSkills(), [], 'no Work OS hooks here: the skills are not touched');
  fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH, saved);
  assert.deepEqual(h.refreshSkills(), ['declutter']);
});

test("a folder without the marker is the person's own: left alone, and status says so", () => {
  const own = path.join(target, 'transfer');
  fs.rmSync(own, { recursive: true });
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'my own transfer\n');
  const r = h.install();
  assert.deepEqual(r.skills.own, ['transfer']);
  assert.equal(read(own, 'SKILL.md'), 'my own transfer\n');
  assert.equal(fs.existsSync(path.join(own, s.MARKER)), false);
  assert.deepEqual(h.refreshSkills(), []);
  assert.ok(r.skillLines.some((l) => l.startsWith('transfer: your own skill, not replaced')), r.skillLines.join('\n'));
  const out = spawnSync(process.execPath, [path.join(WORKER, 'worker.mjs'), 'hooks', 'status'], { encoding: 'utf8', env: process.env });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^transfer: your own skill, not replaced/m);
  assert.match(out.stdout, /^declutter: installed \(current\)/m);
  assert.equal(read(own, 'SKILL.md'), 'my own transfer\n', 'status writes nothing');
  // A link at the skill's name is never followed or replaced, even when adopted.
  const linkTo = path.join(tmp, 'elsewhere');
  fs.mkdirSync(linkTo);
  const link = path.join(target, 'declutter');
  fs.rmSync(link, { recursive: true });
  fs.symlinkSync(linkTo, link, 'junction');
  assert.equal(s.skillState(target, 'declutter', 'x'), 'own');
  assert.deepEqual(s.installSkills({ target, adopt: ['declutter'] }).own, ['declutter', 'transfer']);
  assert.deepEqual(fs.readdirSync(linkTo), [], 'nothing written through the link');
  assert.deepEqual(s.removeSkills({ target }), [], 'remove leaves the link and the own folder');
  fs.rmSync(link, { recursive: true, force: true });
  h.install();
});

test('--adopt replaces one own folder after keeping it in the backup folder; an unknown name is refused', () => {
  const r = spawnSync(process.execPath, [path.join(WORKER, 'worker.mjs'), 'hooks', 'install', '--adopt', 'transfer'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /your own copy was moved to /);
  assert.match(r.stdout, /Work OS skills: \/declutter, \/transfer \(installed now: transfer\)/);
  assert.equal(marker('transfer'), s.skillSources().find((x) => x.name === 'transfer').version);
  const backups = fs.readdirSync(path.join(process.env.WORK_OS_WORKER_DIR, 'skills-backup'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^transfer-\d{4}-/);
  assert.equal(read(process.env.WORK_OS_WORKER_DIR, 'skills-backup', backups[0], 'SKILL.md'), 'my own transfer\n');
  assert.ok(!fs.readdirSync(target).some((n) => n.startsWith('transfer-')), 'the backup is not left where Claude Code reads skills');
  assert.throws(() => h.install({ adopt: ['nope'] }), /no Work OS skill named nope/);
  const bad = spawnSync(process.execPath, [path.join(WORKER, 'worker.mjs'), 'hooks', 'install', '--adopt'], { encoding: 'utf8', env: process.env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--adopt needs the skill name/);
});

test('remove (and uninstall) takes out only the marked folders', () => {
  const mine = path.join(target, 'my-skill');
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'SKILL.md'), 'mine\n');
  const r = h.remove();
  assert.equal(r.hooks, true);
  assert.deepEqual(r.skills.sort(), NAMES);
  assert.deepEqual(fs.readdirSync(target), ['my-skill']);
  assert.deepEqual(h.remove(), { hooks: false, skills: [] });
});

test('hooks repo writes the skills into the repo for cloud sessions, with the marker; an own folder there stays', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-skills-repo-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, '.claude', 'skills', 'transfer'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.claude', 'skills', 'transfer', 'SKILL.md'), 'the repo team transfer\n');
    const r = h.repo(repoDir, { server: 'https://work.example' });
    assert.deepEqual(r.skills.installed, ['declutter']);
    assert.deepEqual(r.skills.own, ['transfer']);
    const t = path.join(repoDir, '.claude', 'skills');
    assert.equal(marker('declutter', t), s.skillSources().find((x) => x.name === 'declutter').version);
    assert.equal(read(t, 'transfer', 'SKILL.md'), 'the repo team transfer\n');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-skills-link-'));
    fs.rmSync(t, { recursive: true });
    fs.symlinkSync(other, t, 'junction');
    assert.throws(() => h.repo(repoDir, { server: 'https://work.example' }), /link or not a folder/);
    assert.deepEqual(fs.readdirSync(other), []);
    fs.rmSync(t, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
  } finally { fs.rmSync(repoDir, { recursive: true, force: true }); }
});

test('the download carries the skills and the loader unpacks them; a skill gone from a release goes from the worker folder', () => {
  const { files, loader } = readWorkerFiles(WORKER);
  const b = bundleFrom(files, loader);
  assert.ok(b.files.includes('skills/transfer/SKILL.md') && b.files.includes('skills/declutter/SKILL.md'), b.files.join(','));
  assert.ok(!b.files.some((f) => /\.md$/.test(f) && !/^skills\//.test(f)), 'no other markdown');
  const d = fs.mkdtempSync(path.join(tmp, 'dl-'));
  const file = path.join(d, 'work-os-worker.mjs');
  fs.writeFileSync(file, b.body);
  assert.equal(spawnSync(process.execPath, [file, 'unpack'], { encoding: 'utf8' }).status, 0);
  assert.equal(read(d, 'worker', 'skills', 'transfer', 'SKILL.md'), files['skills/transfer/SKILL.md']);
  const fewer = { ...files };
  delete fewer['skills/declutter/SKILL.md'];
  fs.writeFileSync(file, bundleFrom(fewer, loader).body);
  assert.equal(spawnSync(process.execPath, [file, 'unpack'], { encoding: 'utf8' }).status, 0);
  assert.deepEqual(fs.readdirSync(path.join(d, 'worker', 'skills')), ['transfer']);
  assert.deepEqual(bundleFrom({ ...files, 'skills/../x/SKILL.md': 'x', 'skills/a/README.md': 'x' }, loader).files.filter((f) => f.startsWith('skills/')), ['skills/declutter/SKILL.md', 'skills/transfer/SKILL.md'], 'only skills/<name>/SKILL.md');
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
