// H8 hook side: the production blocks (worker/hook-release.mjs, hook-pre-tool.mjs) and block 3, the WORK-STATE.md copy, as a
// test of record. Part 1: the parser table against temp git repos (every case expects a match or null). Part 2: the installed
// copy against a stub server for /api/agent/release and /api/agent/state. No network beyond 127.0.0.1; nothing is pushed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-hook-h8-'));
process.env.WORK_OS_HOOK_DIR = path.join(tmp, 'markers');
process.env.WORK_OS_WORKER_DIR = path.join(tmp, 'cfg');
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
delete process.env.WORK_OS_KEY;
delete process.env.WORK_OS_URL;
const { prodAction, splitCommands, releaseDeny } = await import('../hook-release.mjs');
const { FILES } = await import('../hooks-install.mjs');
const fwd = (p) => p.split(path.sep).join('/');

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' });
function mkRepo(name, branch = 'master') {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  sh(d, 'init', '-q', '-b', 'master');
  sh(d, 'remote', 'add', 'origin', 'https://github.com/acme/prod.git');
  sh(d, 'remote', 'add', 'delpat', 'https://github.com/acme/mirror.git');
  fs.writeFileSync(path.join(d, 'a.txt'), '1');
  sh(d, 'add', '.');
  sh(d, 'commit', '-qm', 'init');
  sh(d, 'tag', 'v1');
  if (branch !== 'master') sh(d, 'checkout', '-q', '-b', branch);
  sh(d, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  sh(d, 'config', `branch.${branch}.remote`, 'origin');
  sh(d, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
  return d;
}
const onMaster = mkRepo('on-master');
const onDev = mkRepo('on-dev', 'dev');
const elsewhere = path.join(tmp, 'elsewhere');
fs.mkdirSync(elsewhere);
const linked = mkRepo('linked');
fs.mkdirSync(path.join(linked, 'supabase', '.temp'), { recursive: true });
fs.writeFileSync(path.join(linked, 'supabase', '.temp', 'project-ref'), 'prodref123\n');
const PROD = { remotes: ['acme/prod'], branches: ['main', 'master'], targets: ['prodref123'] };

const act = (command, cwd = onMaster, prod = PROD) => prodAction({ command, cwd }, prod);
const shape = (a) => (a ? `${a.what}:${a.name}` : null);

test('splitCommands: operators outside quotes, quotes removed, call operator dropped, variables marked', () => {
  const w = (c) => splitCommands(c).map((x) => x.map(String));
  assert.deepEqual(w('git status && git push origin master; echo done | cat'), [['git', 'status'], ['git', 'push', 'origin', 'master'], ['echo', 'done'], ['cat']]);
  assert.deepEqual(w('git commit -m "a && b; c" && git push'), [['git', 'commit', '-m', 'a && b; c'], ['git', 'push']]);
  assert.deepEqual(w("echo 'x;y'\ngit push"), [['echo', 'x;y'], ['git', 'push']]);
  assert.deepEqual(w('& git push origin master'), [['git', 'push', 'origin', 'master']]);
  assert.deepEqual(w('git push origin master 2>&1'), [['git', 'push', 'origin', 'master']], 'a redirect is not an argument');
  assert.deepEqual(w('git push 2>&1 | tail -3'), [['git', 'push'], ['tail', '-3']]);
  assert.deepEqual(w('git push > out.txt 2> err.txt < in.txt'), [['git', 'push']]);
  assert.deepEqual(w('git push >>log &>/dev/null'), [['git', 'push']]);
  assert.deepEqual(w('(cd x && git push origin master)'), [['cd', 'x'], ['git', 'push', 'origin', 'master']]);
  assert.deepEqual(w('{ git push origin master; }'), [['git', 'push', 'origin', 'master']]);
  assert.deepEqual(w('git push origin HEAD@{push}'), [['git', 'push', 'origin', 'HEAD@{push}']], 'braces inside a word stay');
  assert.equal(splitCommands('git push $R master')[0][2].dyn, true);
  assert.equal(splitCommands('git push "$R" master')[0][2].dyn, true);
  assert.equal(splitCommands('git push origin master')[0][2].dyn, false);
});

const GIT = [
  ['git push', 'push:master'],
  ['git push origin master', 'push:master'],
  ['git push origin dev', null],
  ['git push origin HEAD', 'push:master'],
  ['git push origin HEAD:master', 'push:master'],
  ['git push origin +dev:master', 'push:master'],
  ['git push origin :master', 'push:master'],
  ['git push origin refs/heads/master', 'push:master'],
  ['git push origin dev:refs/heads/master', 'push:master'],
  ['git push origin main', 'push:main'],
  ['git push -u origin master', 'push:master'],
  ['git push --force-with-lease origin master', 'push:master'],
  ['git push -f origin master', 'push:master'],
  ['git push -o ci.skip origin dev', null],
  ['git push origin dev master', 'push:master'],
  ['git push --tags origin', 'tag:tags'],
  ['git push origin --follow-tags', 'push:master'], // the refspec (here the current branch, master) decides
  ['git push origin master --follow-tags', 'push:master'],
  ['git push origin dev --follow-tags', null],
  ['git push 2>&1 | tail -3', 'push:master'],
  ['git push origin master 2>&1', 'push:master'],
  ['(cd . && git push origin master)', 'push:master'],
  ['{ git push origin master; }', 'push:master'],
  ['(git push origin dev)', null],
  ['git push --all origin', 'push:all'],
  ['git push --mirror origin', 'push:mirror'],
  ['git push origin v1', 'tag:v1'],
  ['git push origin refs/tags/v2', 'tag:v2'],
  ['git push origin v9', null],
  ['git push --dry-run origin master', null],
  ['git push -n origin master', null],
  ['git push delpat master', null],
  ['git push --tags delpat', null],
  ['git push https://github.com/acme/prod.git master', 'push:master'],
  ['git push git@github.com:acme/prod.git master', 'push:master'],
  ['git push https://github.com/acme/other.git master', null],
  ['git push $R master', null],
  ['git push origin $B', null],
  ['git push "$R" master', null],
  ['bash -c "git push origin master"', null],
  ['echo git push origin master', null],
  ['git status && git push origin master', 'push:master'],
  ['git add . | git commit -m x', null],
  ['cd . ; git push origin master', 'push:master'],
  ['& git push origin master', 'push:master'],
  ['GIT_TRACE=1 git push origin master', 'push:master'],
  ['sudo git push origin master', 'push:master'],
  ['git commit -m "git push origin master"', null],
  ['git log origin/master', null],
  ['git tag v3', null],
  ['git push origin master --dry-run', null],
];
for (const [cmd, want] of GIT) {
  test(`git: ${cmd} -> ${want ?? 'passes'}`, () => assert.equal(shape(act(cmd)), want));
}

test('git: no refspec on another branch passes; -C names the repo; a push from outside a repo passes', () => {
  assert.equal(shape(act('git push', onDev)), null, 'dev is not production');
  assert.equal(shape(act('git push origin', onDev)), null);
  assert.equal(shape(act(`git -C "${fwd(onMaster)}" push origin master`, elsewhere)), 'push:master');
  assert.equal(shape(act(`git -C ${fwd(onDev)} push origin master`, onMaster)), 'push:master', 'the refspec still names master');
  assert.equal(shape(act(`git -C ${fwd(onDev)} push`, onMaster)), null, '-C moves to the dev repo');
  assert.equal(shape(act('git push origin master', elsewhere)), null, 'no repo here: the remote name resolves to nothing');
  assert.equal(shape(act(`cd ${fwd(onMaster)} && git push`, elsewhere)), 'push:master', 'cd in the same command line');
});

test('git: a branch list with a prefix pattern, other remotes listed, nothing listed', () => {
  assert.equal(shape(act('git push origin release/1.0', onMaster, { ...PROD, branches: ['release/*'] })), 'push:release/1.0');
  assert.equal(shape(act('git push origin master', onMaster, { ...PROD, branches: ['release/*'] })), null);
  assert.equal(shape(act('git push delpat master', onMaster, { ...PROD, remotes: ['acme/prod', 'acme/mirror'] })), 'push:master', 'the mirror counts when it is listed');
  assert.equal(shape(act('git push origin master', onMaster, { remotes: [], branches: ['master'], targets: [] })), null);
  assert.equal(shape(act('git push origin master', onMaster, null)), null);
  assert.equal(shape(act('git push origin refs/heads/*:refs/heads/*')), 'push:all branches');
});

const GH = [
  ['gh release create v1 -R acme/prod', 'release:release create'],
  ['gh release create v1 --repo acme/prod', 'release:release create'],
  ['gh release create v1 --repo=acme/prod', 'release:release create'],
  ['gh release upload v1 a.zip -R https://github.com/acme/prod', 'release:release upload'],
  ['gh release create v1 -R acme/other', null],
  ['gh release create v1', 'release:release create'],
  ['gh release delete v1 -y', 'release:release delete'],
  ['gh release edit v1', 'release:release edit'],
  ['gh release list', null],
  ['gh release view v1', null],
  ['gh pr merge 4', null],
  ['gh release create v1 -R $REPO', null],
];
for (const [cmd, want] of GH) test(`gh: ${cmd} -> ${want ?? 'passes'}`, () => assert.equal(shape(act(cmd)), want));
test('gh release from a folder whose remotes are not production passes', () => assert.equal(shape(act('gh release create v1', elsewhere)), null));

const CLI = [
  ['vercel --prod', 'cli:vercel'],
  ['vercel deploy --prod', 'cli:vercel'],
  ['vercel deploy --prod --yes', 'cli:vercel'],
  ['vercel --target production', 'cli:vercel'],
  ['vercel deploy --target=production', 'cli:vercel'],
  ['vercel deploy --target preview', null],
  ['vercel build --prod', null], // a local build
  ['vercel pull --yes --environment production', null],
  ['vercel env add X production', 'cli:vercel'],
  ['vercel env add X production --force', 'cli:vercel'],
  ['vercel env rm X production -y', 'cli:vercel'],
  ['vercel env update X production', 'cli:vercel'],
  ['vercel env add X preview', null],
  ['vercel env add X preview feature-branch', null],
  ['vercel env add X', null],
  ['vercel env pull', null],
  ['vercel env ls', null],
  ['vercel deploy', null],
  ['vercel promote dpl_123', 'cli:vercel'],
  ['vercel rollback', 'cli:vercel'],
  ['vercel dev', null],
  ['npx vercel --prod', 'cli:vercel'],
  ['npx -y vercel@latest --prod', 'cli:vercel'],
  ['pnpm dlx vercel --prod', 'cli:vercel'],
  ['bunx vercel --prod', 'cli:vercel'],
  ['VERCEL_ORG_ID=x vercel --prod', 'cli:vercel'],
  ['vercel --prod --token $VERCEL_TOKEN', null],
  ['netlify deploy --prod', 'cli:netlify'],
  ['netlify deploy', null],
  ['netlify status', null],
  ['supabase db push --project-ref prodref123', 'cli:supabase'],
  ['supabase db push --project-ref=prodref123', 'cli:supabase'],
  ['supabase db push --project-ref otherref', null],
  ['supabase secrets set A=b --project-ref prodref123', 'cli:supabase'],
  ['supabase db reset', null],
  ['supabase status', null],
  ['supabase start', null],
];
for (const [cmd, want] of CLI) test(`cli: ${cmd} -> ${want ?? 'passes'}`, () => assert.equal(shape(act(cmd, onMaster)), want));

test('supabase: the linked project ref file, --linked, --local, --db-url, and no targets listed', () => {
  assert.equal(shape(act('supabase db push', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase db reset --linked', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase db reset', linked)), null, 'db reset without --linked is the local database');
  assert.equal(shape(act('supabase secrets set A=b', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase secrets unset A', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase migration up', linked)), null, 'migration up is the local database by default');
  assert.equal(shape(act('supabase migration up --linked', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase db push --dry-run', linked)), null, 'a dry run writes nothing');
  assert.equal(shape(act('supabase migration repair 1 --status applied', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase functions deploy hello', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase functions delete hello', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase config push', linked)), 'cli:supabase');
  assert.equal(shape(act('supabase functions serve', linked)), null);
  assert.equal(shape(act('supabase db push --local', linked)), null);
  assert.equal(shape(act('supabase db push --db-url postgres://x', linked)), null);
  assert.equal(shape(act('supabase db push', onMaster)), null, 'no project ref known here');
  assert.equal(shape(act('supabase db push', linked, { ...PROD, targets: [] })), null, 'no targets listed');
  assert.equal(shape(act('supabase db push --project-ref prodref123', onMaster, { ...PROD, targets: [] })), null);
  assert.equal(shape(act(`supabase db push --workdir ${fwd(linked)}`, onMaster)), 'cli:supabase');
});

test('git push --follow-tags on a feature branch is not production', () => {
  assert.equal(shape(act('git push --follow-tags', onDev)), null);
  assert.equal(shape(act('git push origin --follow-tags', onDev)), null);
  assert.equal(shape(act('git push --follow-tags origin master', onDev)), 'push:master');
});

test('a command without git, gh, vercel, netlify or supabase makes no git call at all', () => {
  assert.equal(prodAction({ command: 'npm run build && ls -la', cwd: '/nonexistent' }, PROD), null);
  assert.equal(prodAction({ command: '', cwd: onMaster }, PROD), null);
  assert.equal(prodAction({ command: 5, cwd: onMaster }, PROD), null);
});

test('releaseDeny: names what to do, under 600 characters, in the Words', () => {
  const a = { what: 'push', name: 'master', label: 'push (master to acme/prod)' };
  const texts = [releaseDeny(a, { allowed: false, owner: 'Om' }, 'Work OS'), releaseDeny(a, { allowed: false, open: 41 }, 'Work OS'), releaseDeny(a, 'no-token', 'Work OS'), releaseDeny(a, 'unconfirmed', 'Work OS'), releaseDeny(a, { allowed: false, owner: 'x'.repeat(500) }, 'p'.repeat(500))]
    .map((o) => o.hookSpecificOutput);
  for (const o of texts) {
    assert.equal(o.permissionDecision, 'deny');
    assert.ok(o.permissionDecisionReason.length <= 600, String(o.permissionDecisionReason.length));
    assert.doesNotMatch(o.permissionDecisionReason, /plugin|approval marker|\buser\b/i);
    assert.match(o.permissionDecisionReason, /release Need/);
  }
  assert.match(texts[0].permissionDecisionReason, /ask \{project: "Work OS", kind: "approve", release: true, ask: "Release master"\}/);
  assert.match(texts[0].permissionDecisionReason, /Production push \(master to acme\/prod\)/);
  assert.match(texts[1].permissionDecisionReason, /Need #41, which is open: wait for its answer/);
  assert.match(texts[2].permissionDecisionReason, /no Work OS session token/);
});

// ---- the installed copy against a stub server ----
const WKR = 'wkr_' + 'D'.repeat(43);
const TOKEN = 'wst_' + 't'.repeat(43);
const seen = [];
let stateMode = 'ok'; // ok | http500 | http400 (what /api/agent/state answers)
let mode = 'allowed'; // allowed | refused | open | http500 | http401 | hang | garbled
let stateLine = '- ship it';
let ctxWarnAnswer; // the brief's contextWarn: undefined = the field is absent
const md = (v, line) => `Copy of the Work OS state, version ${v}. Edit it in Work OS (https://x/projects/p1); this file is its copy.\n\n# Work state: Demo\n\n## Now\n${line}\n`;
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, hook: req.headers['x-work-os-hook'], body });
    const json = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/agent/start') {
      const brief = { project: { id: 'p1', name: 'Demo' }, session: 's-1', orders: 'none', state: { now: { text: 'x' } }, stateVersion: 2, production: PROD, ...(ctxWarnAnswer !== undefined ? { contextWarn: ctxWarnAnswer } : {}) };
      return json(200, { brief, token: TOKEN, expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (req.url === '/api/agent/release') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
      if (mode === 'hang') return;
      if (mode === 'http500') return json(500, { error: 'x' });
      if (mode === 'http401') return json(401, { error: 'unauthorized' });
      if (mode === 'garbled') return json(200, { fine: true });
      if (mode === 'open') return json(200, { allowed: false, open: 41, owner: 'Om' });
      if (mode === 'refused') return json(200, { allowed: false, owner: 'Om' });
      return json(200, { allowed: true, until: new Date(Date.now() + 3600e3).toISOString(), need: 41 });
    }
    if (req.url === '/api/agent/state') {
      if (stateMode === 'http500') return json(500, { error: 'x' });
      if (stateMode === 'http400') return json(400, { error: 'No Now, Next or Later line holds that text.' });
      if (body.edit) stateLine = body.edit.new ? `- ${body.edit.new.replace(/^- /, '')}` : '- (empty)';
      return json(200, { project: 'p1', version: 12, markdown: md(12, stateLine), ...(body.edit ? { applied: { version: 12, closedTasks: [], sentForReview: [] } } : {}) });
    }
    json(404, {});
  });
});
server.keepAliveTimeout = 1;
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const home = path.join(tmp, 'w');
fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
for (const f of FILES) fs.copyFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), path.join(home, 'hooks', f));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ baseUrl: URL_ }));
const dev = await import(pathToFileURL(path.join(home, 'hooks', 'hook.mjs')).href);
const preMod = await import(pathToFileURL(path.join(home, 'hooks', 'hook-pre-tool.mjs')).href);
const libMod = await import(pathToFileURL(path.join(home, 'hooks', 'hook-lib.mjs')).href);
dev.deps.deviceKey = (dir) => (dir === home ? WKR : null);

const transcript = path.join(tmp, 't.jsonl');
fs.writeFileSync(transcript, '{"type":"user"}\n');
const startSid = (sid, cwd = onMaster) => dev.main('session-start', JSON.stringify({ session_id: sid, cwd, transcript_path: transcript }));
const pre = async (sid, command, { cwd = onMaster, tool = 'Bash', permission_mode = 'default' } = {}) => {
  const out = await dev.main('pre-tool', JSON.stringify({ session_id: sid, cwd, tool_name: tool, tool_input: { command }, permission_mode }));
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const releases = () => seen.filter((s) => s.url === '/api/agent/release');
const readMarkerFile = (sid) => JSON.parse(fs.readFileSync(path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`), 'utf8'));

test('session start keeps the brief production in the marker; a brief without it keeps none', async () => {
  assert.ok(await startSid('p1'));
  assert.deepEqual(readMarkerFile('p1').production, PROD);
  assert.ok(readMarkerFile('p1').project === 'Demo');
});

test('session start keeps the brief contextWarn as ctxWarn; an answer without it keeps the old value, null clears it (context warning)', async () => {
  ctxWarnAnswer = 150;
  assert.ok(await startSid('cw1'));
  assert.equal(readMarkerFile('cw1').ctxWarn, 150);
  { const mf = path.join(process.env.WORK_OS_HOOK_DIR, 'cw1.json'); const m = JSON.parse(fs.readFileSync(mf, 'utf8')); fs.writeFileSync(mf, JSON.stringify({ ...m, ctxSteps: { main: 1, abc: 0 } })); }
  ctxWarnAnswer = undefined;
  assert.ok(await dev.main('session-start', JSON.stringify({ session_id: 'cw1', cwd: onMaster, transcript_path: transcript, source: 'compact' })));
  assert.equal(readMarkerFile('cw1').ctxWarn, 150, 'an answer without the field keeps it');
  assert.deepEqual(readMarkerFile('cw1').ctxSteps, { abc: 0 }, 'a compaction drops the main agent step: it is warned again');
  ctxWarnAnswer = null;
  assert.ok(await dev.main('session-start', JSON.stringify({ session_id: 'cw1', cwd: onMaster, transcript_path: transcript, source: 'compact' })));
  assert.equal('ctxWarn' in readMarkerFile('cw1'), false, 'null (the setting turned off) clears it');
  ctxWarnAnswer = undefined;
  assert.ok(await startSid('cw2'));
  assert.equal('ctxWarn' in readMarkerFile('cw2'), false);
});

test('an allowed check lets the command through and sends only what and name', async () => {
  seen.length = 0; mode = 'allowed';
  const out = await pre('p1', 'git push origin master');
  assert.equal(out, null);
  assert.equal(releases().length, 1);
  assert.deepEqual(releases()[0].body, { what: 'push', name: 'master' }, 'no command, no cwd, no remote address');
  assert.equal(releases()[0].auth, `Bearer ${TOKEN}`);
  assert.equal(releases()[0].hook, '4');
});

test('a refusal names the ask call; a waiting Need is named; both under 600 characters', async () => {
  seen.length = 0; mode = 'refused';
  const out = await pre('p1', 'git push origin master');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Production push \(master to acme\/prod\) needs an answered release Need\. Call ask \{project: "Demo", kind: "approve", release: true/);
  assert.ok(out.permissionDecisionReason.length < 600);
  mode = 'open';
  const o2 = await pre('p1', 'git push origin master');
  assert.match(o2.permissionDecisionReason, /release Need #41, which is open/);
});

test('PowerShell is checked the same way, and a chain asks once', async () => {
  seen.length = 0; mode = 'refused';
  const out = await pre('p1', 'git status; git push origin master; git tag v9', { tool: 'PowerShell' });
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(releases().length, 1);
});

test('commands that are not production never reach the server', async () => {
  seen.length = 0; mode = 'refused';
  for (const c of ['git push origin dev', 'git push delpat master', 'git tag v1', 'git push --dry-run origin master', 'git status', 'ls', 'npm test', 'vercel env add X preview', 'vercel env pull', 'git push $R master', 'bash -c "git push origin master"', 'gh release list']) {
    assert.equal(await pre('p1', c), null, c);
  }
  assert.equal(releases().length, 0);
});

test('fails closed on an exact match: server error, 401, a garbled answer, unreachable', async () => {
  for (const m of ['http500', 'http401', 'garbled']) {
    mode = m;
    const out = await pre('p1', 'git push origin master');
    assert.equal(out.permissionDecision, 'deny', m);
    assert.match(out.permissionDecisionReason, /could not confirm a release Need/, m);
  }
  const down = path.join(tmp, 'w2');
  fs.cpSync(home, down, { recursive: true });
  fs.writeFileSync(path.join(down, 'config.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9' }));
  const d2 = await import(pathToFileURL(path.join(down, 'hooks', 'hook.mjs')).href);
  const out = await d2.main('pre-tool', JSON.stringify({ session_id: 'p1', cwd: onMaster, tool_name: 'Bash', tool_input: { command: 'git push origin master' } }));
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
});

test('a session with no token (the key path, cloud) is refused on a production match and untouched otherwise', async () => {
  fs.writeFileSync(path.join(process.env.WORK_OS_HOOK_DIR, 'nt.json'), JSON.stringify({ status: 'x', offset: 0, stopped: false, project: 'Demo', production: PROD }));
  seen.length = 0;
  const out = await pre('nt', 'git push origin master');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /no Work OS session token/);
  assert.equal(await pre('nt', 'git push origin dev'), null);
  assert.equal(seen.length, 0);
});

test('no marker, or a marker without production: nothing is checked, nothing is sent', async () => {
  fs.writeFileSync(path.join(process.env.WORK_OS_HOOK_DIR, 'np.json'), JSON.stringify({ status: 'x', offset: 0, stopped: false, project: 'Demo' }));
  seen.length = 0; mode = 'refused';
  assert.equal(await pre('np', 'git push origin master'), null);
  assert.equal(await pre('nosuchsession', 'git push origin master'), null);
  assert.equal(releases().length, 0);
});

test('out of time: timeoutAnswer refuses once a production action was found and the server had not answered', async () => {
  mode = 'hang'; seen.length = 0;
  libMod.run.prod = null;
  const input = { session_id: 'p1', cwd: onMaster, tool_name: 'Bash', tool_input: { command: 'git push origin master' } };
  assert.equal(preMod.timeoutAnswer(JSON.stringify(input)), null, 'nothing found yet');
  const pending = dev.main('pre-tool', JSON.stringify(input));
  await new Promise((r) => setTimeout(r, 400));
  const late = preMod.timeoutAnswer(JSON.stringify(input));
  assert.equal(JSON.parse(JSON.stringify(late)).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(late.hookSpecificOutput.permissionDecisionReason, /could not confirm a release Need/);
  const out = await pending; // the 3 s call ends in a refusal too
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  libMod.run.prod = null;
  assert.equal(preMod.timeoutAnswer(JSON.stringify({ ...input, tool_input: { command: 'ls' } })), null);
  mode = 'allowed';
});

// ---- block 3, the WORK-STATE.md copy, as a test of record ----
test('block 3: Edit of one line is forwarded, Write is refused, shell writes are refused, other files are untouched', async () => {
  mode = 'allowed'; seen.length = 0;
  const copy = path.join(onMaster, 'WORK-STATE.md');
  fs.writeFileSync(copy, md(9, '- ship it'));
  assert.ok(await startSid('b3'));
  const run = (tool_name, tool_input, permission_mode = 'acceptEdits') => dev.main('pre-tool', JSON.stringify({ session_id: 'b3', cwd: onMaster, tool_name, tool_input, permission_mode }));
  const edit = JSON.parse(await run('Edit', { file_path: copy, old_string: 'ship it', new_string: 'shipped' })).hookSpecificOutput;
  assert.equal(edit.permissionDecision, 'deny');
  assert.match(edit.permissionDecisionReason, /Applied to Work OS State v12/);
  const posted = seen.filter((s) => s.url === '/api/agent/state');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { edit: { old: '- ship it', new: '- shipped' } });
  assert.match(fs.readFileSync(copy, 'utf8'), /- shipped/);
  seen.length = 0;
  for (const [tool, input] of [['Write', { file_path: copy, content: 'x' }], ['MultiEdit', { file_path: copy, edits: [] }], ['NotebookEdit', { notebook_path: copy }], ['Bash', { command: 'echo x > WORK-STATE.md' }], ['Bash', { command: 'sed -i s/a/b/ WORK-STATE.md' }], ['PowerShell', { command: 'Set-Content WORK-STATE.md x' }]]) {
    const o = JSON.parse(await run(tool, input)).hookSpecificOutput;
    assert.equal(o.permissionDecision, 'deny', tool);
    assert.match(o.permissionDecisionReason, /save_state/, tool);
  }
  // H12: a refusal that never reached the server is counted (one event with copy: 'refused', nothing else); only the one-line Edit is forwarded.
  assert.equal(seen.filter((x) => x.url === '/api/agent/state').length, 0, 'only the one-line Edit is forwarded');
  assert.ok(seen.every((x) => x.url === '/api/agent/event' && x.body.copy === 'refused' && x.body.event === 'tool'), 'the refusals post a count and nothing else');
  assert.equal(await run('Write', { file_path: path.join(onMaster, 'other.txt'), content: 'x' }), '');
  assert.equal(await run('Bash', { command: 'cat WORK-STATE.md' }), '');
  // out of time on a write of the copy: the plain refusal, as before
  assert.equal(JSON.parse(JSON.stringify(preMod.timeoutAnswer(JSON.stringify({ session_id: 'b3', tool_name: 'Write', tool_input: { file_path: copy } })))).hookSpecificOutput.permissionDecision, 'deny');
});

// H12: a refused write is counted by the hook only when the server never judged it: a 5xx or no answer is counted here, a 200 or a 400 is the server's own count.
test('block 3 counts: a 5xx on the forwarded Edit posts one count event; a 400 or a 200 posts none (the server counted it)', async () => {
  const copy = path.join(onMaster, 'WORK-STATE.md');
  fs.writeFileSync(copy, md(9, '- ship it'));
  assert.ok(await startSid('b3c'));
  const edit = () => dev.main('pre-tool', JSON.stringify({ session_id: 'b3c', cwd: onMaster, tool_name: 'Edit', tool_input: { file_path: copy, old_string: 'ship it', new_string: 'shipped' }, permission_mode: 'acceptEdits' }));
  const counts = () => seen.filter((x) => x.url === '/api/agent/event' && x.body.copy === 'refused');
  for (const [m, want] of [['http500', 1], ['http400', 0], ['ok', 0]]) {
    stateMode = m; mode = 'allowed'; seen.length = 0;
    fs.writeFileSync(copy, md(9, '- ship it'));
    const out = JSON.parse(await edit()).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny', m);
    assert.equal(seen.filter((x) => x.url === '/api/agent/state').length, 1, m);
    assert.equal(counts().length, want, m);
  }
  stateMode = 'ok';
});

// ---- 19 Nov (Om): an attended session needs no release Need ----
// Attended = the person typed a prompt in this main session within 30 minutes (marker.promptAt), not a subagent's call, not a dispatched run.
const setMarker = (sid, patch) => { const f = path.join(process.env.WORK_OS_HOOK_DIR, `${sid}.json`); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch })); };
const preRaw = async (sid, command, extra = {}) => {
  const out = await dev.main('pre-tool', JSON.stringify({ session_id: sid, cwd: onMaster, tool_name: 'Bash', tool_input: { command }, ...extra }));
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const MIN = 60_000;

test('attended (prompt 29 minutes ago): the push passes with a note to record the words as a Decision; the server is not asked', async () => {
  assert.ok(await startSid('at1'));
  setMarker('at1', { promptAt: Date.now() - 29 * MIN });
  seen.length = 0; mode = 'refused';
  const out = await preRaw('at1', 'git push origin master');
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /Production push \(master to acme\/prod\) passes without a release Need because the person is in this session/);
  assert.match(out.additionalContext, /their yes in chat/);
  assert.match(out.additionalContext, /save_state \{project: "Demo", add_decision\}/);
  assert.equal(releases().length, 0);
  assert.equal(await preRaw('at1', 'git push origin dev'), null, 'not production: untouched');
});

test('unattended (prompt 31 minutes ago, or no prompt recorded): refused as before, the release Need still decides', async () => {
  assert.ok(await startSid('at2'));
  setMarker('at2', { promptAt: Date.now() - 31 * MIN });
  seen.length = 0; mode = 'refused';
  const out = await preRaw('at2', 'git push origin master');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /needs an answered release Need/);
  assert.equal(releases().length, 1);
  setMarker('at2', { promptAt: undefined });
  assert.equal((await preRaw('at2', 'git push origin master')).permissionDecision, 'deny', 'no prompt recorded');
});

test('a granted release Need still opens production everywhere: unattended, a subagent, dispatched', async () => {
  mode = 'allowed';
  setMarker('at2', { promptAt: Date.now() - 31 * MIN });
  seen.length = 0;
  assert.equal(await preRaw('at2', 'git push origin master'), null);
  setMarker('at1', { promptAt: Date.now() - 1 * MIN });
  assert.equal(await preRaw('at1', 'git push origin master', { agent_id: 'sub-1' }), null, 'a subagent goes through the Need path and it is granted');
  process.env.WORK_OS_DISPATCHED = '301';
  try { assert.equal(await preRaw('at1', 'git push origin master'), null); } finally { delete process.env.WORK_OS_DISPATCHED; }
  assert.equal(releases().length, 3);
});

test('a subagent call is never attended, even right after the person typed', async () => {
  setMarker('at1', { promptAt: Date.now() - 1 * MIN });
  seen.length = 0; mode = 'refused';
  const out = await preRaw('at1', 'git push origin master', { agent_id: 'sub-1' });
  assert.equal(out.permissionDecision, 'deny');
  assert.equal(releases().length, 1);
});

test('a dispatched run is never attended: the environment variable, or the dispatched mark in the marker', async () => {
  setMarker('at1', { promptAt: Date.now() - 1 * MIN });
  seen.length = 0; mode = 'refused';
  process.env.WORK_OS_DISPATCHED = '301';
  try { assert.equal((await preRaw('at1', 'git push origin master')).permissionDecision, 'deny'); } finally { delete process.env.WORK_OS_DISPATCHED; }
  setMarker('at1', { dispatched: 301 });
  assert.equal((await preRaw('at1', 'git push origin master')).permissionDecision, 'deny');
  assert.equal(releases().length, 2);
  setMarker('at1', { dispatched: undefined });
  assert.equal((await preRaw('at1', 'git push origin master')).permissionDecision, undefined, 'attended again without the mark');
});

test('a production command (not only a push) is covered the same way', async () => {
  setMarker('at1', { promptAt: Date.now() - 1 * MIN });
  mode = 'refused'; seen.length = 0;
  const o = await preRaw('at1', 'vercel deploy --prod');
  assert.equal(o.permissionDecision, undefined);
  assert.match(o.additionalContext, /Production command \(vercel on production\) passes/);
  assert.equal(releases().length, 0);
});

test('the prompt hook records the person\'s prompt time; a subagent prompt records nothing; a compaction keeps it', async () => {
  assert.ok(await startSid('at3'));
  assert.equal(readMarkerFile('at3').promptAt, undefined);
  const up = (extra = {}) => dev.main('user-prompt', JSON.stringify({ session_id: 'at3', cwd: onMaster, prompt: 'hi', ...extra }));
  await up({ agent_id: 'sub-1' });
  assert.equal(readMarkerFile('at3').promptAt, undefined, 'a subagent is not the person');
  const t0 = Date.now();
  await up();
  const at = readMarkerFile('at3').promptAt;
  assert.ok(at >= t0 && at <= Date.now());
  assert.ok(await startSid('at3'));
  assert.equal(readMarkerFile('at3').promptAt, at, 'session start again (compaction) keeps it');
  seen.length = 0; mode = 'refused';
  assert.equal((await preRaw('at3', 'git push origin master')).additionalContext?.includes('passes without a release Need'), true);
});

// An automated prompt (agent report, notification, another session, a scheduled task) is not the person: it never sets promptAt.
// Only a wrapper at the START of the prompt counts as automated; a typed prompt that quotes one mid-text is still typed.
test('promptAt: every automated wrapper leaves it unchanged; a typed prompt sets it, also when it quotes a wrapper mid-text; a wake prompt and an empty one do not', async () => {
  assert.ok(await startSid('at4'));
  const up = (prompt) => dev.main('user-prompt', JSON.stringify({ session_id: 'at4', cwd: onMaster, prompt }));
  const at = () => readMarkerFile('at4').promptAt;
  const wrappers = ['<task-notification>\n<task-id>x</task-id>', '[SYSTEM NOTIFICATION - NOT USER INPUT] hi', '<cross-session-message from="a">x</cross-session-message>', 'Another Claude session sent a message: x', '<agent-message from="b">x', '[Subagent hand-back] done', '<side-sessions-event>x', '<ci-monitor-event>x', '<scheduled-task name="n">x', '  \n<task-notification>x', '', undefined];
  for (const w of wrappers) { await up(w); assert.equal(at(), undefined, String(w).slice(0, 30)); }
  const t0 = Date.now();
  await up('push it to master please');
  const first = at();
  assert.ok(first >= t0);
  const old = first - 40 * MIN;
  setMarker('at4', { promptAt: old });
  for (const w of wrappers) { await up(w); assert.equal(at(), old, 'unchanged: ' + String(w).slice(0, 30)); }
  await up('what does <task-notification> mean in the log?');
  assert.ok(at() > old, 'a prompt that quotes a wrapper mid-text is typed');
  setMarker('at4', { promptAt: old, wokeAt: Date.now() });
  await up('a message that woke the idle wait');
  assert.equal(at(), old, 'the wake prompt is not typed');
});
