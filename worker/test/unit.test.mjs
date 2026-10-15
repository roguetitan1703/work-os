import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeRemote } from '../remote.mjs';
import { shQuote, macScript, asEscape } from '../quote.mjs';
import { validateJob } from '../validate.mjs';
import { writeMarker, removeMarker, addExclude, excludePath, MARKER } from '../markers.mjs';
import { windowsWtArgs, claudeArgs, resolveClaude, matchesSession } from '../launch.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wos-w-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const SID = '8c1d2f3a-1b2c-4d5e-8f90-123456789abc';

test('normalizeRemote', () => {
  assert.equal(normalizeRemote('https://user:tok3n@GitHub.com/Owner/Name.git'), 'github.com/owner/name');
  assert.equal(normalizeRemote('https://ghp_abc@github.com/o/n'), 'github.com/o/n');
  assert.equal(normalizeRemote('git@github.com:Owner/Repo.git'), 'github.com/owner/repo');
  assert.equal(normalizeRemote('ssh://git@host.com:2222/Own/Rep.git'), 'host.com/own/rep');
  assert.equal(normalizeRemote('HTTPS://GITHUB.COM/A/B.GIT'), 'github.com/a/b');
  assert.equal(normalizeRemote('https://github.com/a/b/'), 'github.com/a/b');
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('nonsense'), null);
  assert.ok(!normalizeRemote('https://u:secret@github.com/a/b.git').includes('secret'));
});

test('shQuote and macScript', () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote('a b'), `'a b'`);
  assert.equal(shQuote('$HOME `id` $(x)'), `'$HOME \`id\` $(x)'`);
  assert.equal(shQuote(''), `''`);
  const s = macScript("/Users/o/my 'proj'", '/usr/local/bin/claude', ['--session-id', SID, 'say "hi"; rm -rf ~']);
  assert.equal(s, `cd '/Users/o/my '\\''proj'\\''' && '/usr/local/bin/claude' '--session-id' '${SID}' 'say "hi"; rm -rf ~'`);
  assert.equal(asEscape('a"b\\c'), 'a\\"b\\\\c');
});

test('windows launch args', () => {
  const a = windowsWtArgs('C:\\p', 'PMS', 'C:\\bin\\claude.exe', claudeArgs({ kind: 'start', sessionId: SID, projectName: 'PMS', prompt: 'a; b' }));
  assert.deepEqual(a.slice(0, 7), ['-w', 'new', '-d', 'C:\\p', '--title', 'PMS', 'C:\\bin\\claude.exe']);
  assert.ok(a.includes('a\\; b'));
  assert.ok(!a.some((x) => /dangerously|bare/.test(x)));
  assert.equal(claudeArgs({ kind: 'resume', sessionId: SID })[0], '--resume');
  assert.deepEqual(claudeArgs({ kind: 'resume', sessionId: SID }).slice(2, 4), ['--permission-mode', 'manual']);
  assert.ok(claudeArgs({ kind: 'start', sessionId: SID, prompt: '--bare' }).at(-1).startsWith(' '));
});

test('job validation', () => {
  const d = tmp();
  try {
    const root = path.join(d, 'root');
    const outside = path.join(d, 'outside');
    fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
    fs.mkdirSync(outside);
    const folders = {
      ok: path.join(root, 'proj'),
      dots: path.join(root, 'proj', '..', '..', 'outside'),
      out: outside,
    };
    let link = false;
    try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); folders.link = path.join(root, 'link'); link = true; } catch {}
    const ctx = { folders, roots: [root] };
    const base = { id: 'j', kind: 'start', folderId: 'ok', sessionId: SID };
    assert.equal(validateJob(base, ctx).ok, true);
    assert.equal(validateJob({ ...base, kind: 'rm' }, ctx).error, 'unknown job kind');
    assert.equal(validateJob({ ...base, sessionId: 'nope' }, ctx).error, 'bad session id');
    assert.equal(validateJob({ ...base, folderId: 'zzz' }, ctx).error, 'unknown folder');
    assert.equal(validateJob({ ...base, folderId: 'constructor' }, ctx).error, 'unknown folder');
    assert.equal(validateJob({ ...base, folderId: 'dots' }, ctx).error, 'folder outside allowed roots');
    assert.equal(validateJob({ ...base, folderId: 'out' }, ctx).error, 'folder outside allowed roots');
    if (link) assert.equal(validateJob({ ...base, folderId: 'link' }, ctx).error, 'folder outside allowed roots');
    assert.equal(validateJob({ ...base, prompt: 'x'.repeat(4001) }, ctx).error, 'prompt too long');
    assert.equal(validateJob({ ...base, prompt: 'x'.repeat(4000) }, ctx).ok, true);
    assert.equal(validateJob({ id: 'j', kind: 'stop', sessionId: SID }, ctx).ok, true);
  } finally { rm(d); }
});

test('markers: write, remove only own, exclude idempotent', () => {
  const d = tmp();
  try {
    execFileSync('git', ['init', '-q', d]);
    const info = { projectId: 'pms', projectName: 'PMS', folderId: 'f_abc123' };
    assert.equal(writeMarker(d, info), 'written');
    const m = JSON.parse(fs.readFileSync(path.join(d, MARKER), 'utf8'));
    assert.deepEqual(m, { v: 1, project: 'pms', projectName: 'PMS', folderId: 'f_abc123', writtenBy: 'work-os-worker' });
    assert.equal(writeMarker(d, info), 'same');
    const ex = fs.readFileSync(excludePath(d), 'utf8');
    assert.equal(ex.split('\n').filter((l) => l === MARKER).length, 1);
    assert.equal(addExclude(d), false);
    assert.equal(addExclude(d), false);
    assert.equal(fs.readFileSync(excludePath(d), 'utf8').split('\n').filter((l) => l === MARKER).length, 1);
    assert.equal(fs.existsSync(path.join(d, '.gitignore')), false);
    assert.equal(removeMarker(d), true);
    assert.equal(fs.existsSync(path.join(d, MARKER)), false);
    // foreign marker is left alone
    fs.writeFileSync(path.join(d, MARKER), JSON.stringify({ v: 1, writtenBy: 'someone' }));
    assert.equal(writeMarker(d, info), 'foreign');
    assert.equal(removeMarker(d), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, MARKER), 'utf8')).writtenBy, 'someone');
    fs.writeFileSync(path.join(d, MARKER), 'not json');
    assert.equal(removeMarker(d), false);
  } finally { rm(d); }
});

test('resolveClaude avoids roots; matchesSession is exact', () => {
  const d = tmp();
  try {
    const root = path.join(d, 'root'); const bin = path.join(d, 'bin');
    fs.mkdirSync(root); fs.mkdirSync(bin);
    const inRoot = path.join(root, 'claude.exe'); const good = path.join(bin, 'claude.exe');
    fs.writeFileSync(inRoot, ''); fs.writeFileSync(good, '');
    assert.equal(resolveClaude([root], () => [inRoot, 'claude', good]), good);
    assert.equal(resolveClaude([root], () => [inRoot]), null);
    assert.ok(matchesSession('claude --session-id ' + SID, SID));
    assert.ok(matchesSession('claude --resume ' + SID + ' --name x', SID));
    assert.ok(!matchesSession('vim notes-' + SID + '.txt', SID));
  } finally { rm(d); }
});

test('marker symlink is refused', () => {
  const d = tmp();
  try {
    const target = path.join(d, 'target.txt'); fs.writeFileSync(target, 'keep');
    const dir = path.join(d, 'f'); fs.mkdirSync(dir);
    try { fs.symlinkSync(target, path.join(dir, MARKER), 'file'); } catch { return; } // no symlink privilege
    assert.equal(writeMarker(dir, { projectId: 'p', projectName: 'P', folderId: 'f_abc123' }), 'foreign');
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    assert.equal(removeMarker(dir), false);
    assert.ok(fs.existsSync(target));
  } finally { rm(d); }
});
