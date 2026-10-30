import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { cloneUrl, safeName, gitArgs, resolveDestination, runClone, prepareClone, handleCloneJob, projectsDirOf, CloneError } from '../clone.mjs';
import { createCore } from '../core.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wos-c-')));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const SID = '8c1d2f3a-1b2c-4d5e-8f90-123456789abc';

test('cloneUrl: owner/name is GitHub; full https and ssh addresses are used as given (any host)', () => {
  assert.deepEqual(cloneUrl('delpat-tech/grant-leads-portal'), { url: 'https://github.com/delpat-tech/grant-leads-portal.git', name: 'grant-leads-portal', display: 'delpat-tech/grant-leads-portal' });
  assert.equal(cloneUrl('Owner/Repo.git').url, 'https://github.com/Owner/Repo.git');
  assert.equal(cloneUrl('https://gitlab.com/a/b.git').url, 'https://gitlab.com/a/b.git');
  assert.equal(cloneUrl('git@bitbucket.org:team/thing.git').url, 'git@bitbucket.org:team/thing.git');
  assert.equal(cloneUrl('git@bitbucket.org:team/thing.git').name, 'thing');
  assert.equal(cloneUrl('ssh://git@host.example:2222/grp/sub/proj.git').display, 'sub/proj');
});

test('cloneUrl refuses transports that run commands, local paths and option look-alikes', () => {
  const bads = ['ext::sh -c "touch /tmp/x"', 'ext::sh -c id%', 'fd::17/foo', 'file:///etc/passwd', 'file://localhost/etc', 'git://github.com/a/b', 'http://github.com/a/b', 'ftp://h/a/b',
    '/etc/passwd', '../x/y', './a/b', '~/a/b', 'C:\\Work\\repo', 'C:/Work/repo', '\\\\server\\share\\r', '--upload-pack=touch x', '-oProxyCommand=x',
    'ssh://-oProxyCommand=evil@host/a/b', 'https://-bad.com/a/b', 'foo::bar/baz', 'https://h/a/b c', '', '   ', 'owner', 'a/b/c', 'https://github.com/only', 'transport::https://github.com/a/b', 'https://github.com/../b'];
  for (const bad of bads) assert.throws(() => cloneUrl(bad), CloneError, `should refuse ${JSON.stringify(bad)}`);
  assert.throws(() => cloneUrl(null), CloneError);
  assert.throws(() => cloneUrl('a'.repeat(500)), CloneError);
});

test('safeName: plain characters only, no leading dot, no reserved Windows names', () => {
  assert.equal(safeName('my repo!'), 'my-repo-');
  assert.equal(safeName('..'), 'repo');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName('con'), 'con-repo');
  assert.equal(safeName('NUL.txt'), 'NUL.txt-repo');
  assert.equal(safeName('lpt1'), 'lpt1-repo');
  assert.equal(safeName('x'.repeat(200)).length, 80);
  assert.equal(safeName('..\\..\\evil'), 'evil');
});

test('gitArgs: the exact fixed safe form, url and folder after --', () => {
  assert.deepEqual(gitArgs('https://github.com/a/b.git', '/w/b'), ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=never', 'clone', '--', 'https://github.com/a/b.git', '/w/b']);
});

test('projectsDirOf: config value, else the first scan root', () => {
  assert.equal(projectsDirOf({ projectsDir: '/p', roots: ['/r'] }), '/p');
  assert.equal(projectsDirOf({ roots: ['/r', '/s'] }), '/r');
  assert.equal(projectsDirOf({ roots: [] }), null);
});

test('resolveDestination: free name, reuse of the same repo, -2 for something else, never a root, never outside', () => {
  const root = tmp();
  try {
    const roots = [root];
    const args = { projectsDir: root, name: 'app', display: 'o/app', roots };
    assert.deepEqual(resolveDestination({ ...args }), { dest: path.join(root, 'app'), reuse: false });
    fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
    assert.deepEqual(resolveDestination({ ...args, remoteOf: () => 'git@github.com:O/App.git' }), { dest: path.join(root, 'app'), reuse: true });
    assert.deepEqual(resolveDestination({ ...args, remoteOf: () => 'https://github.com/o/other' }), { dest: path.join(root, 'app-2'), reuse: false });
    fs.mkdirSync(path.join(root, 'app-2'));
    fs.writeFileSync(path.join(root, 'app-3'), 'a file');
    assert.deepEqual(resolveDestination({ ...args, remoteOf: () => '' }), { dest: path.join(root, 'app-4'), reuse: false });
    // a name that is not a plain component is refused by the inside check
    assert.throws(() => resolveDestination({ ...args, name: '..' }), CloneError);
    // the scan root's own path is never the destination
    const parent = path.dirname(root);
    assert.equal(resolveDestination({ projectsDir: parent, name: path.basename(root), display: 'o/x', roots: [root, parent] }).dest, path.join(parent, path.basename(root) + '-2'));
    // projects folder outside every root
    const other = tmp();
    try { assert.throws(() => resolveDestination({ ...args, projectsDir: other }), /not inside a folder the worker scans/); } finally { rm(other); }
    assert.throws(() => resolveDestination({ ...args, projectsDir: null }), /no projects folder/);
  } finally { rm(root); }
});

test('resolveDestination: a projects folder inside a root is created and used', () => {
  const root = tmp();
  try {
    const r = resolveDestination({ projectsDir: path.join(root, 'sub', 'dir'), name: 'x', display: 'o/x', roots: [root] });
    assert.equal(r.dest, path.join(root, 'sub', 'dir', 'x'));
  } finally { rm(root); }
});

function fakeSpawn({ code = 0, stderr = '', hang = false } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    c.pid = 1;
    c.kill = () => { c.killed = true; };
    calls.push({ cmd, args, opts, child: c });
    if (!hang) setImmediate(() => { if (stderr) c.stderr.emit('data', stderr); c.emit('close', code); });
    return c;
  };
  fn.calls = calls;
  return fn;
}

test('runClone: runs git without a shell, with prompts off, and succeeds on exit 0', async () => {
  const sp = fakeSpawn();
  const dest = path.join(os.tmpdir(), 'wos-nope-1');
  await runClone({ url: 'https://github.com/a/b.git', dest, display: 'a/b', spawnImpl: sp, env: { PATH: 'x' } });
  const c = sp.calls[0];
  assert.equal(c.cmd, 'git');
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(c.args, gitArgs('https://github.com/a/b.git', dest));
});

test('runClone: failures are said in plain words; a partial folder it made is removed', async () => {
  const dest = path.join(os.tmpdir(), 'wos-partial-' + process.pid);
  const sp = (cmd, args, o) => { fs.mkdirSync(dest, { recursive: true }); return fakeSpawn({ code: 128, stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/o/x.git/' not found" })(cmd, args, o); };
  try {
    await assert.rejects(runClone({ url: 'u', dest, display: 'o/x', spawnImpl: sp }), (e) => e.kind === 'access' && e.message === "Couldn't clone: no access to o/x; check that this PC is signed in to git");
    assert.equal(fs.existsSync(dest), false, 'partial folder removed');
    await assert.rejects(runClone({ url: 'u', dest, display: 'o/x', spawnImpl: fakeSpawn({ code: 1, stderr: 'fatal: something odd happened' }) }), /Couldn't clone o\/x: fatal: something odd happened/);
    const enoent = () => { const c = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); return c; };
    await assert.rejects(runClone({ url: 'u', dest, display: 'o/x', spawnImpl: enoent }), /git is not installed/);
  } finally { rm(dest); }
});

test('runClone: a clone that takes too long is killed and reported', async () => {
  const sp = fakeSpawn({ hang: true });
  await assert.rejects(runClone({ url: 'u', dest: path.join(os.tmpdir(), 'wos-nope-2'), display: 'o/x', timeoutMs: 30, spawnImpl: sp }), (e) => e.kind === 'timeout' && /took longer than/.test(e.message));
});

test('prepareClone: off switch, refusal, reuse (no git run) and a fresh clone', async () => {
  const root = tmp();
  try {
    const ran = [];
    const run = async (a) => { ran.push(a); fs.mkdirSync(a.dest); };
    await assert.rejects(prepareClone({ repo: 'o/x', cfg: { roots: [root], allowClone: false }, run }), (e) => e.kind === 'off' && /turned off/.test(e.message));
    await assert.rejects(prepareClone({ repo: 'ext::sh -c id', cfg: { roots: [root] }, run }), CloneError);
    assert.equal(ran.length, 0);
    const a = await prepareClone({ repo: 'o/x', cfg: { roots: [root] }, run });
    assert.equal(a.dir, path.join(root, 'x'));
    assert.equal(ran.length, 1);
    assert.equal(ran[0].url, 'https://github.com/o/x.git');
    fs.mkdirSync(path.join(root, 'x', '.git'), { recursive: true });
    const b = await prepareClone({ repo: 'o/x', cfg: { roots: [root] }, run, remoteOf: () => 'https://github.com/o/x.git' });
    assert.deepEqual([b.reused, ran.length], [true, 1], 'same repo already there: no clone');
    const c = await prepareClone({ repo: 'o/x', cfg: { roots: [root] }, run, remoteOf: () => 'https://github.com/o/else' });
    assert.equal(c.dir, path.join(root, 'x-2'));
  } finally { rm(root); }
});

function mkCoreForClone(root, extra = {}) {
  const state = { ids: {}, folders: {}, sessions: {}, markers: {}, doneJobs: [] };
  const posted = [];
  const launches = [];
  const cfg = { roots: [root], maxDepth: 4, allowPrompts: true, ...extra };
  const core = createCore({
    getConfig: () => cfg, state, save() {}, now: () => 1000,
    api: { postFolders: async () => {}, postStatus: async (b) => void posted.push(JSON.parse(JSON.stringify(b))), getJobs: async () => ({}) },
    launcher: async (a) => void launches.push(a), listProcesses: async () => [], killPid: async () => {},
  });
  return { core, state, posted, launches, cfg };
}

test('handleCloneJob: clones, reports the folder, writes the marker, starts; a re-offer starts nothing twice', async () => {
  const root = tmp();
  const home = tmp();
  const old = { u: process.env.USERPROFILE, h: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const m = mkCoreForClone(root);
    const job = { id: 'j1', kind: 'start', sessionId: SID, projectId: 'p1', projectName: 'Proj', prompt: 'hello', clone: { repo: 'o/x' } };
    const deps = (run) => ({ getConfig: () => m.cfg, state: m.state, save() {}, api: { postStatus: async (b) => void m.posted.push(b) }, launcher: async (a) => void m.launches.push(a), scanAndReport: m.core.scanAndReport, run });
    const r = await handleCloneJob(job, deps(async ({ dest }) => { fs.mkdirSync(path.join(dest, '.git'), { recursive: true }); }));
    assert.equal(r.ok, true, r.error);
    assert.match(r.folderId, /^f_/);
    assert.equal(m.launches.length, 1);
    assert.equal(m.launches[0].folder, path.join(root, 'x'));
    assert.equal(m.launches[0].prompt, 'hello');
    assert.equal(m.launches[0].projectName, 'Proj');
    assert.ok(m.state.markers[r.folderId], 'marker recorded');
    assert.ok(m.posted.some((b) => b.sessions?.[0]?.phase === 'starting'));
    const again = await handleCloneJob(job, deps(async () => { throw new Error('must not clone again'); }));
    assert.deepEqual(again, { id: 'j1', ok: true, folderId: r.folderId });
    assert.equal(m.launches.length, 1);
  } finally {
    if (old.u === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = old.u;
    if (old.h === undefined) delete process.env.HOME; else process.env.HOME = old.h;
    rm(root);
    rm(home);
  }
});

test('handleJob with a clone: allowClone false, refused address and bad job fail in plain words and start nothing', async () => {
  const root = tmp();
  try {
    const m = mkCoreForClone(root, { allowClone: false });
    const base = { id: 'j2', kind: 'start', sessionId: SID, projectId: 'p1', projectName: 'Proj' };
    let r = await m.core.handleJob({ ...base, clone: { repo: 'o/x' } });
    assert.deepEqual([r.ok, r.error], [false, "Couldn't clone: cloning is turned off on this PC"]);
    m.cfg.allowClone = true;
    r = await m.core.handleJob({ ...base, clone: { repo: 'ext::sh -c id' } });
    assert.equal(r.ok, false);
    assert.match(r.error, /^Couldn't clone:/);
    r = await m.core.handleJob({ ...base, sessionId: 'nope', clone: { repo: 'o/x' } });
    assert.equal(r.ok, false);
    r = await m.core.handleJob({ ...base, projectId: undefined, clone: { repo: 'o/x' } });
    assert.equal(r.ok, false);
    assert.equal(m.launches.length, 0);
    assert.equal(fs.readdirSync(root).length, 0, 'nothing was created');
  } finally { rm(root); }
});

test('status reports allowClone and projectsDir (default: the first scan root)', async () => {
  const root = tmp();
  try {
    const m = mkCoreForClone(root);
    await m.core.sendStatus();
    assert.deepEqual([m.posted[0].worker.allowClone, m.posted[0].worker.projectsDir], [true, root]);
    m.cfg.allowClone = false;
    m.cfg.projectsDir = path.join(root, 'p');
    await m.core.sendStatus();
    assert.deepEqual([m.posted[1].worker.allowClone, m.posted[1].worker.projectsDir], [false, path.join(root, 'p')]);
  } finally { rm(root); }
});
