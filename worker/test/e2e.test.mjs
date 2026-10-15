import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startFakeServer, TEST_TOKEN } from './fake-server.mjs';
import { makeApi } from '../api.mjs';
import { createCore } from '../core.mjs';
import { MARKER, excludePath } from '../markers.mjs';

process.env.WORK_OS_CLAUDE_JSON = path.join(os.tmpdir(), 'wos-test-claude-' + process.pid + '.json');
const SID = '11111111-2222-4333-8444-555555555555';

test('end to end against fake server', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wos-e2e-')));
  const server = await startFakeServer();
  try {
    const root = path.join(tmp, 'root');
    const repo = path.join(root, 'myrepo');
    const plain = path.join(root, 'plainapp');
    const nested = path.join(plain, 'vendor', 'inner');
    for (const d of [repo, plain, nested]) fs.mkdirSync(d, { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'package.json'), '{}');
    fs.writeFileSync(path.join(plain, 'package.json'), '{}');
    fs.mkdirSync(path.join(plain, 'sub'));
    fs.writeFileSync(path.join(plain, 'sub', 'package.json'), '{}'); // must not count
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://omuser:s3cr3tTOKEN@GitHub.com/Om/MyRepo.git']);
    execFileSync('git', ['init', '-q', nested]);

    const state = { ids: {}, folders: {}, sessions: {}, markers: {}, lastPoll: null, lastScan: null };
    const config = { baseUrl: server.url, roots: [root], maxDepth: 6 };
    const launches = [];
    const procs = [];
    const core = createCore({
      getConfig: () => config, state, save: () => {},
      api: makeApi(() => config, () => TEST_TOKEN),
      launcher: async (a) => { launches.push(a); procs.push({ pid: 4242, cmd: `claude --session-id ${a.sessionId}` }); },
      listProcesses: async () => procs,
      killPid: async () => {},
    });

    await core.scanAndReport();
    const sent = JSON.stringify(server.folders);
    assert.ok(!sent.includes('s3cr3tTOKEN') && !sent.includes('omuser'), 'no credentials');
    assert.ok(!sent.includes(tmp) && !sent.includes(os.tmpdir()), 'no absolute paths');
    assert.ok(!/[A-Za-z]:\\|\\\\/.test(sent), 'no windows paths');
    const byName = Object.fromEntries(server.folders.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(byName).sort(), ['root/myrepo'.replace('root/', ''), 'plainapp', 'plainapp/vendor/inner'].sort());
    assert.equal(byName.myrepo.remote, 'github.com/om/myrepo');
    assert.equal(byName.myrepo.branch, 'main');
    assert.equal(byName.myrepo.git, true);
    assert.equal(byName.plainapp.git, false);
    assert.equal(byName.plainapp.remote, undefined);
    assert.ok(byName['plainapp/vendor/inner'].git);
    assert.ok(server.folders.every((f) => /^f_[A-Za-z0-9_-]{12}$/.test(f.id)));

    // stable ids on rescan
    const idBefore = byName.myrepo.id;
    await core.scanAndReport();
    assert.equal(server.folders.find((f) => f.name === 'myrepo').id, idBefore);

    // link -> marker + exclude
    server.links = [{ folderId: idBefore, projectId: 'pms', projectName: 'PMS' }];
    await core.pollOnce();
    const mfile = path.join(repo, MARKER);
    assert.equal(JSON.parse(fs.readFileSync(mfile, 'utf8')).folderId, idBefore);
    assert.match(fs.readFileSync(excludePath(repo), 'utf8'), /^\.workos\.json$/m);
    assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
    // marker id is reused after a state wipe
    state.ids = {};
    await core.scanAndReport();
    assert.equal(server.folders.find((f) => f.name === 'myrepo').id, idBefore);

    // unlink -> marker removed
    server.links = [];
    await core.pollOnce();
    assert.equal(fs.existsSync(mfile), false);

    // start job with stubbed launcher
    server.links = [{ folderId: idBefore, projectId: 'pms', projectName: 'PMS' }];
    server.jobs = [
      { id: 'j_1', kind: 'start', folderId: idBefore, projectId: 'pms', projectName: 'PMS', sessionId: SID, prompt: 'hello' },
      { id: 'j_bad', kind: 'start', folderId: 'f_unknown00', sessionId: SID },
    ];
    server.statuses.length = 0;
    await core.pollOnce();
    assert.equal(launches.length, 1);
    assert.equal(launches[0].folder, repo);
    assert.equal(launches[0].prompt, 'hello');
    assert.ok(fs.existsSync(mfile), 'marker present before start');
    const results = server.statuses.flatMap((s) => s.jobs);
    assert.deepEqual(results.find((r) => r.id === 'j_1'), { id: 'j_1', ok: true });
    assert.equal(results.find((r) => r.id === 'j_bad').ok, false);
    const last = server.statuses.at(-1);
    assert.deepEqual(last.sessions, [{ sessionId: SID, folderId: idBefore, state: 'running' }]);
    assert.equal(last.worker.version, '0.1.0');

    // stop job
    const killed = [];
    const core2 = core; // same core; stop uses injected killPid via closure
    server.jobs = [{ id: 'j_3', kind: 'stop', sessionId: SID }];
    server.statuses.length = 0;
    await core2.pollOnce();
    const stopRes = server.statuses.flatMap((s) => s.jobs).find((r) => r.id === 'j_3');
    assert.equal(stopRes.ok, true);
    assert.equal(server.statuses.at(-1).sessions[0].state, 'stopped');
    void killed;

    // unlinked scanned folder may not be launched
    const plainId = server.folders.find((f) => f.name === 'plainapp').id;
    const SID2 = '99999999-2222-4333-8444-555555555555';
    server.jobs = [{ id: 'j_unl', kind: 'start', folderId: plainId, sessionId: SID2 }];
    server.statuses.length = 0;
    const n = launches.length;
    await core.pollOnce();
    assert.equal(launches.length, n);
    assert.equal(server.statuses.flatMap((s) => s.jobs).find((r) => r.id === 'j_unl').error, 'folder not linked to a project');

    // stop of an untracked session is refused
    server.jobs = [{ id: 'j_unk', kind: 'stop', sessionId: SID2 }];
    server.statuses.length = 0;
    await core.pollOnce();
    assert.equal(server.statuses.flatMap((s) => s.jobs).find((r) => r.id === 'j_unk').error, 'unknown session');

    // re-offered job is not launched twice
    server.jobs = [{ id: 'j_1', kind: 'start', folderId: idBefore, projectId: 'pms', projectName: 'PMS', sessionId: SID, prompt: 'hello' }];
    server.statuses.length = 0;
    await core.pollOnce();
    assert.equal(launches.length, n);
    assert.equal(server.statuses.flatMap((s) => s.jobs).find((r) => r.id === 'j_1').ok, true);

    // allowPrompts: false drops the prompt
    config.allowPrompts = false;
    server.jobs = [{ id: 'j_np', kind: 'start', folderId: idBefore, projectId: 'pms', projectName: 'PMS', sessionId: SID2, prompt: 'secret ask' }];
    await core.pollOnce();
    assert.equal(launches.at(-1).prompt, undefined);
  } finally {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fake server rejects bad key', async () => {
  const server = await startFakeServer();
  try {
    const cfg = { baseUrl: server.url };
    await assert.rejects(makeApi(() => cfg, () => 'wkr_' + 'B'.repeat(43)).getJobs(), /401/);
  } finally { await server.close(); }
});
