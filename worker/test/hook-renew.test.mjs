// Session identity, piece C (hook): the sign-in sends `proc` and x-work-os-hook: 5; a token that ran out (or was refused) is renewed
// with `renew: true` for a session that had one; a failed renew is cut by a backoff kept in the marker (so separate hook processes
// do not repeat it); an old server (400) gets a plain start from the prompt hook only; `elsewhere` stops the WORK-STATE.md copy and the
// Stop check outside the project's folders; the answers' expiresAt keeps the kept token alive. The installed copy beside a throwaway
// worker config, a stub of /api/agent/* answering per the contract (note db5bf91389, A10).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-renew-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
process.env.CLAUDE_PID = String(process.pid); // stands for the claude process: any live process will do
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
const { FILES } = await import('../hooks-install.mjs');

const WKR = 'wkr_' + 'R'.repeat(43);
const tok = (c) => 'wst_' + c.repeat(43);
const SID = '11111111-1111-4111-8111-111111111111';
const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: 'none', state: { now: { text: 'x' } }, stateVersion: 2 };
const seen = [];
// What the stub answers: renew = the status of a renew call (200 gives a new token), event401 = tokens the event route refuses, startExtra = fields on a start answer.
// The stub is strict like master's start route: a body key it does not know is a 400 (`old: true` is today's production server, which knows neither `proc` nor `renew`).
const MASTER_KEYS = ['remote', 'subdir', 'branch', 'path', 'folders', 'machine', 'label', 'model', 'account', 'title', 'aiTitle', 'tool', 'ccSession', 'source', 'head', 'dirty', 'worktrees'];
const cfg = { old: false, renew: 200, event401: new Set(), startExtra: {}, next: 'a' };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, hook: req.headers['x-work-os-hook'], body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/agent/start') {
      const allowed = cfg.old ? MASTER_KEYS : [...MASTER_KEYS, 'proc', 'renew'];
      if (Object.keys(body).some((k) => !allowed.includes(k))) return json(400, { error: 'unrecognized key' });
      if (body.renew) {
        if (cfg.renew === 200) return json(200, { token: tok(cfg.next), expiresAt: iso(3600e3), session: 's-1' });
        return json(cfg.renew, { error: 'no' });
      }
      return json(200, { brief, token: tok(cfg.next), expiresAt: iso(3600e3), ...cfg.startExtra });
    }
    if (req.url === '/api/agent/event') {
      if (cfg.event401.has(req.headers.authorization.slice(7))) return json(401, { error: 'expired' });
      return json(200, { state: 'working', expiresAt: iso(24 * 3600e3) });
    }
    json(404, {});
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}` }));
const dev = await import(pathToFileURL(path.join(home, 'hooks', 'hook.mjs')).href);
const lib = await import(pathToFileURL(path.join(home, 'hooks', 'hook-lib.mjs')).href);
const copyMod = await import(pathToFileURL(path.join(home, 'hooks', 'hook-copy.mjs')).href);
dev.deps.deviceKey = (dir) => (dir === home ? WKR : null);

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
const proj = path.join(tmp, 'projs', 'app');
const other = path.join(tmp, 'projs', 'other');
for (const d of [proj, other]) { fs.mkdirSync(d, { recursive: true }); sh(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), '1'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'init'); }
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ folders: { fldProj01: proj, fldOther1: other } }));
const transcript = path.join(tmp, 't.jsonl');
fs.writeFileSync(transcript, '{"type":"user"}\n');
const markerFile = (sid) => path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`);
const marker = (sid) => JSON.parse(fs.readFileSync(markerFile(sid), 'utf8'));
const tokenFile = (sid) => path.join(home, 'hooks', 'sessions', `${sid}.json`);
const kept = (sid) => JSON.parse(fs.readFileSync(tokenFile(sid), 'utf8'));
const expire = (sid) => fs.writeFileSync(tokenFile(sid), JSON.stringify({ token: kept(sid).token, until: Date.now() - 1000 }));
const start = (sid, cwd, extra = {}) => dev.main('session-start', JSON.stringify({ session_id: sid, cwd, transcript_path: transcript, source: 'startup', ...extra }));
const prompt = (sid, cwd) => dev.main('user-prompt', JSON.stringify({ session_id: sid, cwd, transcript_path: transcript }));
const calls = (url) => seen.filter((s) => s.url === url);
const renews = () => seen.filter((s) => s.url === '/api/agent/start' && s.body.renew);
const reset = () => { fs.rmSync(path.join(home, 'hooks', 'sessions'), { recursive: true, force: true }); seen.length = 0; Object.assign(cfg, { old: false, renew: 200, startExtra: {}, next: 'a' }); cfg.event401.clear(); };

test('the sign-in sends proc (the claude pid) and x-work-os-hook: 5', async () => {
  reset();
  await start(SID, proj);
  const s = calls('/api/agent/start')[0];
  assert.equal(s.auth, `Bearer ${WKR}`);
  assert.equal(s.hook, '5');
  assert.equal(s.body.proc.pid, process.pid);
  assert.equal(s.body.ccSession, SID);
  assert.equal(lib.readProc(SID).pid, process.pid);
  assert.equal(marker(SID).hadToken, true);
  assert.equal(kept(SID).token, tok('a'));
});

test('a /clear start sends the start time too (the server links the new session by pid and start time)', async () => {
  reset();
  const sid = '22222222-2222-4222-8222-222222222222';
  await start(sid, proj, { source: 'clear' });
  const s = calls('/api/agent/start')[0];
  if (process.platform === 'win32' || process.platform === 'darwin') assert.match(s.body.proc.procStart, /^\d+$/);
  assert.equal(s.body.source, 'clear');
});

test('a token that ran out: the prompt renews it (device key, ccSession, proc, renew: true) and the event goes with the new token', async () => {
  reset();
  await start(SID, proj);
  seen.length = 0;
  expire(SID);
  cfg.next = 'b';
  await prompt(SID, proj);
  assert.equal(renews().length, 1, 'one renew');
  const r = renews()[0];
  assert.equal(r.auth, `Bearer ${WKR}`);
  assert.equal(r.body.renew, true);
  assert.equal(r.body.ccSession, SID);
  assert.equal(r.body.proc.pid, process.pid);
  assert.equal(r.hook, '5');
  assert.deepEqual(Object.keys(r.body).sort(), ['ccSession', 'proc', 'renew'], 'nothing else: the server ignores folders on a renew');
  const ev = calls('/api/agent/event');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].auth, `Bearer ${tok('b')}`);
  assert.equal(kept(SID).token, tok('b'));
  assert.ok(kept(SID).until > Date.now() + 3600e3 * 20, 'the event answer moved the end of the token (C2)');
  assert.equal(marker(SID).renewFailAt, undefined);
});

test('a token the server refuses (401): one renew, the same event posted again with the new token', async () => {
  reset();
  await start(SID, proj);
  seen.length = 0;
  cfg.event401.add(tok('a'));
  cfg.next = 'c';
  await prompt(SID, proj);
  assert.equal(renews().length, 1);
  const ev = calls('/api/agent/event');
  assert.deepEqual(ev.map((e) => e.auth), [`Bearer ${tok('a')}`, `Bearer ${tok('c')}`]);
});

test('an event answer moves the kept token\'s end (C2); the file is rewritten', async () => {
  reset();
  await start(SID, proj);
  fs.writeFileSync(tokenFile(SID), JSON.stringify({ token: tok('a'), until: Date.now() + 60_000 }));
  await prompt(SID, proj);
  assert.ok(kept(SID).until > Date.now() + 3600e3 * 20);
});

test('a failed renew sets a backoff in the marker; later hooks (other processes) do not renew again until it passes, and it doubles', async () => {
  reset();
  await start(SID, proj);
  expire(SID);
  seen.length = 0;
  cfg.renew = 500;
  await prompt(SID, proj);
  assert.equal(renews().length, 1);
  assert.equal(marker(SID).renewBackoff, 60_000);
  assert.equal(typeof marker(SID).renewFailAt, 'number');
  // a hook run in another process only has the marker file: a prompt, a tool event and a stop within the minute make no renew
  await prompt(SID, proj);
  await lib.postEvent(SID, 'tool');
  await lib.postEvent(SID, 'stop');
  assert.equal(renews().length, 1, 'cut by the backoff');
  assert.equal(calls('/api/agent/event').length, 0, 'no token, no event');
  // the minute passes: one more try, a longer backoff
  const m = marker(SID); m.renewFailAt -= 61_000; fs.writeFileSync(markerFile(SID), JSON.stringify(m));
  await prompt(SID, proj);
  assert.equal(renews().length, 2);
  assert.equal(marker(SID).renewBackoff, 120_000);
  // the backoff stops at 30 minutes
  const m2 = marker(SID); m2.renewBackoff = 1_500_000; m2.renewFailAt -= 1_600_000; fs.writeFileSync(markerFile(SID), JSON.stringify(m2));
  await prompt(SID, proj);
  assert.equal(marker(SID).renewBackoff, 1_800_000);
});

test('a renew that works clears the backoff', async () => {
  reset();
  await start(SID, proj);
  expire(SID);
  cfg.renew = 500;
  await prompt(SID, proj);
  const m = marker(SID); m.renewFailAt -= 61_000; fs.writeFileSync(markerFile(SID), JSON.stringify(m));
  cfg.renew = 200; cfg.next = 'd';
  await prompt(SID, proj);
  assert.equal(marker(SID).renewFailAt, undefined);
  assert.equal(marker(SID).renewBackoff, undefined);
  assert.equal(kept(SID).token, tok('d'));
});

test('404 (no record): no more renews in this session', async () => {
  reset();
  await start(SID, proj);
  expire(SID);
  seen.length = 0;
  cfg.renew = 404;
  await prompt(SID, proj);
  assert.equal(renews().length, 1);
  assert.equal(marker(SID).renewDead, true);
  await prompt(SID, proj);
  await lib.postEvent(SID, 'tool');
  assert.equal(renews().length, 1);
});

test('a session that never had a token never renews', async () => {
  reset();
  const sid = '33333333-3333-4333-8333-333333333333';
  fs.mkdirSync(process.env.WORK_OS_HOOK_DIR, { recursive: true });
  fs.writeFileSync(markerFile(sid), JSON.stringify({ project: 'Demo', stopped: false }));
  await prompt(sid, proj);
  assert.equal(seen.length, 0);
});

test('400 (an old server): the prompt hook makes a plain start (no renew), a tool event does not', async () => {
  reset();
  await start(SID, proj);
  expire(SID);
  seen.length = 0;
  cfg.renew = 400; cfg.next = 'e';
  // a tool call never starts again
  await lib.postEvent(SID, 'tool');
  assert.equal(seen.filter((s) => !s.body.renew && s.url === '/api/agent/start').length, 0, 'no plain start from a tool call');
  assert.equal(marker(SID).renewBad, true);
  assert.equal(calls('/api/agent/event').length, 0);
  // the prompt falls back to a plain start with the folder, then posts its event
  seen.length = 0;
  await prompt(SID, proj);
  const starts = calls('/api/agent/start');
  assert.equal(starts.length, 1, 'no second renew: the old server is remembered');
  assert.equal(starts[0].body.renew, undefined);
  assert.deepEqual(starts[0].body.folders, ['fldProj01']);
  assert.equal(starts[0].body.ccSession, SID);
  assert.equal(calls('/api/agent/event')[0].auth, `Bearer ${tok('e')}`);
  assert.equal(kept(SID).token, tok('e'));
  assert.equal(marker(SID).renewFailAt, undefined);
});

test('elsewhere: the marker keeps it and the project\'s folders; no WORK-STATE.md copy outside them, one inside', async () => {
  reset();
  cfg.startExtra = { elsewhere: true, projectFolders: ['fldProj01'] };
  await start(SID, other);
  const m = marker(SID);
  assert.equal(m.elsewhere, true);
  assert.deepEqual(m.projectFolders, ['fldProj01']);
  const md = 'Copy of the Work OS state, version 5.\n\n# Work state: Demo\n\nNow: x\n';
  assert.equal(copyMod.writeCopy(SID, other, md, { commit: false }), null, 'the unlinked folder gets no copy');
  assert.equal(fs.existsSync(path.join(other, 'WORK-STATE.md')), false);
  const w = copyMod.writeCopy(SID, proj, md, { commit: false });
  assert.equal(w?.version, 5, 'the project\'s own folder gets it');
  assert.equal(fs.existsSync(path.join(proj, 'WORK-STATE.md')), true);
  // a start that is not elsewhere clears it
  cfg.startExtra = {};
  await start(SID, proj, { source: 'resume' });
  assert.equal(marker(SID).elsewhere, undefined);
  assert.equal(copyMod.writeCopy(SID, other, md.replace('version 5', 'version 6'), { commit: false })?.version, 6);
  fs.rmSync(path.join(other, 'WORK-STATE.md'), { force: true });
  fs.rmSync(path.join(proj, 'WORK-STATE.md'), { force: true });
});

test('elsewhere: the Stop check is skipped outside the project\'s folders and runs inside them', async () => {
  reset();
  cfg.startExtra = { elsewhere: true, projectFolders: ['fldProj01'] };
  await start(SID, other);
  fs.writeFileSync(path.join(other, 'changed.txt'), 'x');
  fs.writeFileSync(path.join(proj, 'changed.txt'), 'x');
  const stop = (cwd) => dev.main('stop', JSON.stringify({ session_id: SID, cwd, transcript_path: transcript, hook_event_name: 'Stop' }));
  assert.equal(await stop(other), '', 'no Stop check in the folder that is not the project\'s');
  assert.equal(marker(SID).stopped, false, 'the marker is untouched');
  const inside = await stop(proj);
  assert.match(String(inside), /block/, 'in the project\'s folder the check runs as before');
  fs.rmSync(path.join(other, 'changed.txt'), { force: true });
  fs.rmSync(path.join(proj, 'changed.txt'), { force: true });
});

test('a sign-in without the worker copy sends nothing (not installed beside a worker)', async () => {
  assert.equal(typeof lib.signIn, 'function');
  assert.equal(await lib.renewToken('44444444-4444-4444-8444-444444444444'), null);
});

// ── Review fixes: an old server, the /clear link, no folders known, the renew gap ──────────────────────────────────────────

test('an old server (strict start schema, no proc): start, brief, token and events all work; the hook remembers and stops sending proc and renew', async () => {
  reset();
  cfg.old = true;
  const out = await start(SID, proj);
  assert.match(JSON.stringify(out), /Work OS brief for project Demo/, 'the brief is shown');
  const starts = calls('/api/agent/start');
  assert.equal(starts.length, 2, 'one 400, one retry');
  assert.ok(starts[0].body.proc, 'the first try carried proc');
  assert.equal(starts[1].body.proc, undefined);
  assert.equal(starts[1].body.renew, undefined);
  assert.equal(starts[1].body.ccSession, SID);
  assert.deepEqual(starts[1].body.folders, ['fldProj01']);
  assert.equal(kept(SID).token, tok('a'));
  assert.equal(marker(SID).oldServer, true);
  assert.equal(marker(SID).hadToken, true);
  seen.length = 0;
  await prompt(SID, proj);
  assert.equal(calls('/api/agent/event').length, 1, 'events reach the old server');
  assert.equal(calls('/api/agent/event')[0].auth, `Bearer ${tok('a')}`);
  // the token runs out: no renew (the old server would refuse it); a plain start from the prompt hook, with no proc
  expire(SID);
  seen.length = 0;
  cfg.next = 'b';
  await prompt(SID, proj);
  assert.equal(renews().length, 0);
  const again = calls('/api/agent/start');
  assert.equal(again.length, 1, 'no 400 round trip: the marker says the server is old');
  assert.equal(again[0].body.proc, undefined);
  assert.equal(calls('/api/agent/event')[0].auth, `Bearer ${tok('b')}`);
  // a tool call with the token expired again makes no start and no renew
  expire(SID);
  seen.length = 0;
  await lib.postEvent(SID, 'tool');
  assert.equal(calls('/api/agent/start').length, 0);
  // the next session start tries the new fields again; a server that has been updated takes them
  cfg.old = false;
  seen.length = 0;
  await start(SID, proj, { source: 'resume' });
  assert.ok(calls('/api/agent/start')[0].body.proc, 'a new session start sends proc again');
  assert.equal(marker(SID).oldServer, undefined);
});

test('an old server with a kept token: the refresh start is retried plain', async () => {
  reset();
  await start(SID, proj); // a new server: a token and a marker
  cfg.old = true;
  seen.length = 0;
  const out = await start(SID, proj, { source: 'compact' });
  assert.match(JSON.stringify(out), /Work OS brief/);
  assert.equal(marker(SID).oldServer, true);
});

test('/clear after a startup links to the same session: both starts carry the same pid and start time', async () => {
  reset();
  const sid2 = '55555555-5555-4555-8555-555555555555';
  await start(SID, proj);
  await start(sid2, proj, { source: 'clear' });
  const [a, b] = calls('/api/agent/start').filter((s) => !s.body.renew);
  assert.equal(a.body.ccSession, SID);
  assert.equal(b.body.ccSession, sid2);
  assert.equal(a.body.proc.pid, b.body.proc.pid);
  if (process.platform === 'win32' || process.platform === 'darwin') assert.match(a.body.proc.procStart, /^\d+$/, 'the first start already sends the full pair');
  assert.equal(a.body.proc.procStart, b.body.proc.procStart);
});

test('no CLAUDE_PID and a stale .proc file: the full lookup runs and replaces the dead process\'s pair before the sign-in', async () => {
  reset();
  // A copy of node named claude is the session's process; it runs the hook as its child, with CLAUDE_PID unset.
  const fake = path.join(tmp, process.platform === 'win32' ? 'claude.exe' : 'claude');
  fs.copyFileSync(process.execPath, fake);
  const hookJs = pathToFileURL(path.join(home, 'hooks', 'hook-session-start.mjs')).href;
  const child = path.join(tmp, 'child.mjs');
  fs.writeFileSync(child, `const ss = await import(${JSON.stringify(hookJs)}); await ss.sessionStart({ session_id: ${JSON.stringify(SID)}, cwd: ${JSON.stringify(proj)}, transcript_path: ${JSON.stringify(transcript)}, source: 'startup' });`);
  const parent = path.join(tmp, 'parent.mjs');
  fs.writeFileSync(parent, `import { spawnSync } from 'node:child_process'; spawnSync(process.argv[0].replace(/[^\\/]*$/, '') + '' || process.execPath, []); `);
  const runner = path.join(tmp, 'runner.mjs');
  fs.writeFileSync(runner, `import { spawnSync } from 'node:child_process'; const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(child)}], { stdio: 'inherit', env: process.env }); process.exit(r.status ?? 1);`);
  fs.mkdirSync(path.join(home, 'hooks', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hooks', 'sessions', `${SID}.proc`), JSON.stringify({ pid: 999999, procStart: '1' }));
  const env = { ...process.env };
  delete env.CLAUDE_PID;
  const code = await new Promise((res) => spawn(fake, [runner], { env, stdio: 'ignore' }).on('exit', res));
  assert.equal(code, 0);
  // (the child has no device key here, so no sign-in; the .proc file is what the sign-in or renew would send)
  const kept = lib.readProc(SID);
  assert.ok(kept, 'a pair is kept');
  assert.notEqual(kept.pid, 999999, 'a dead pair is replaced');
});

test('keepProc finds no claude process: the stale .proc file is deleted, so the start body carries no stale pair', async () => {
  reset();
  const pf = path.join(home, 'hooks', 'sessions', `${SID}.proc`);
  fs.mkdirSync(path.dirname(pf), { recursive: true });
  fs.writeFileSync(pf, JSON.stringify({ pid: 999999, procStart: '1' }));
  assert.equal(lib.keepProc(SID, () => null), null);
  assert.equal(fs.existsSync(pf), false, 'the stale file is gone');
  assert.equal(lib.readProc(SID), null);
  await start(SID, proj);
  assert.equal(calls('/api/agent/start')[0].body.proc?.pid === 999999, false);
});

test('no time for the start time before the sign-in: the pair goes with a renew right after the start', async () => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  reset();
  const was = lib.run.deadline;
  lib.run.deadline = Date.now() + 3500; // under the 4 s the start time needs before the sign-in is allowed, over what the follow-up needs
  const ss = await import(pathToFileURL(path.join(home, 'hooks', 'hook-session-start.mjs')).href);
  try { await ss.sessionStart({ session_id: SID, cwd: proj, transcript_path: transcript, source: 'startup' }); } finally { lib.run.deadline = was; }
  const sent = calls('/api/agent/start');
  assert.equal(sent[0].body.proc.procStart, undefined, 'the sign-in went with the pid alone');
  assert.ok(lib.readProc(SID).procStart, 'the start time was taken afterwards');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.renew, true);
  assert.equal(sent[1].body.proc.procStart, lib.readProc(SID).procStart, 'the renew carries the full pair');
});

test('elsewhere, state.json readable, cwd outside every folder: the copy and the Stop check are skipped; inside the project folder they are not', async () => {
  reset();
  const m = { elsewhere: true, projectFolders: ['fldProj01'] };
  const outside = path.join(tmp, 'nowhere-repo');
  fs.mkdirSync(outside, { recursive: true });
  sh(outside, 'init', '-q', '-b', 'main');
  assert.equal(lib.elsewhereHere(m, outside), true, 'outside all folders: skip');
  assert.equal(lib.elsewhereHere(m, proj), false, 'inside P: no skip');
  assert.equal(lib.elsewhereHere(m, other), true, 'another known folder: skip');
});

test('elsewhere with no folder known (state.json unreadable): never skip, so the copy and the Stop check run in the project\'s own repo', async () => {
  reset();
  const st = path.join(home, 'state.json');
  const saved = fs.readFileSync(st, 'utf8');
  try {
    fs.rmSync(st);
    assert.equal(lib.elsewhereHere({ elsewhere: true, projectFolders: ['fldProj01'] }, proj), false);
    fs.writeFileSync(st, '{ not json');
    assert.equal(lib.elsewhereHere({ elsewhere: true, projectFolders: ['fldProj01'] }, proj), false);
  } finally { fs.writeFileSync(st, saved); }
  assert.equal(lib.elsewhereHere({ elsewhere: true, projectFolders: ['fldProj01'] }, other), true, 'known folders still skip');
});

test('renews are at least 5 minutes apart: a server that renews with 200 but refuses events with 401 does not renew on every call', async () => {
  reset();
  await start(SID, proj);
  expire(SID);
  seen.length = 0;
  cfg.next = 'b';
  cfg.event401.add(tok('b'));
  await prompt(SID, proj);
  assert.equal(renews().length, 1);
  assert.equal(typeof marker(SID).renewedAt, 'number');
  await lib.postEvent(SID, 'stop');
  await lib.postEvent(SID, 'notify', { kind: 'idle_prompt' });
  assert.equal(renews().length, 1, 'the 401 does not start another renew within 5 minutes');
  const m = marker(SID); m.renewedAt -= 5 * 60_000 + 1000; fs.writeFileSync(markerFile(SID), JSON.stringify(m));
  await lib.postEvent(SID, 'stop');
  assert.equal(renews().length, 2, 'after the gap it may renew again');
});
