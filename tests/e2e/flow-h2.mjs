// H2 (hooks on any PC with one command), docs/HANDOVER.md "Claude Code hooks". Covers: the worker's `hooks` status is
// kept when valid and dropped when not (version 12 hex or null, events 0-8, stale bool, signIn worker|key|null) and shows
// in the Computers row as "hooks on / out of date / no hooks" at 390 and 1280; matchingFolders and linkMatchingFolders (a
// single match is linked, a remote shared by two projects is skipped and listed, an archived project never matches, an
// already-linked folder is untouched, another person's computer is "not found"); the Link them line in a computer's
// Folders panel; and an installed hook copy (a temp worker folder, a temp settings file, no DPAPI) run with the command from
// settings.json: the brief for a linked folder, nothing for an unlinked one. Seed profile: none. Needs `next build` output
// (server actions are called through the build's manifest). WRITTEN, NOT RUN in the session that made it (light work only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { B, EMAIL, MCP, ME, PW, SP, api, check, finish, launch, login, makeUser, mkDevice, okO, overflow, rawDb } from './lib.mjs';
import { must } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
function actionOf(name) {
  for (const [id, e] of Object.entries(MANIFEST)) {
    const ws = e.exportedName ? [e] : Object.values(e.workers);
    if (!ws.some(w => w.exportedName === name && /launcher-actions\.ts$/.test(w.filename))) continue;
    const pages = Object.keys(e.workers);
    const page = pages.find(x => x.startsWith('app/(app)/claude')) ?? pages.find(x => !x.includes('[')) ?? pages[0];
    return { id, url: '/' + page.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(x => !/^\(.*\)$/.test(x)).join('/') };
  }
  return null;
}
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
async function act(cookie, name, ...args) {
  const a = actionOf(name);
  if (!a) return { ok: false, text: `${name} not in the build` };
  const r = await fetch(B + a.url, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  const text = await r.text();
  return { ok: /"ok":true/.test(text), text, linked: Number((/"linked":(\d+)/.exec(text) ?? [])[1] ?? NaN) };
}
const folder = (dev, fid, remote, projectId = null, extra = {}) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: fid, git: true, remote, branch: 'main', projectId, linkedAt: projectId ? new Date() : null, seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId, ...extra });
const status = (dev, hooks) => api(dev.key, 'POST', '/api/worker/status', { worker: { version: '0.4.0', os: 'win32', allowPrompts: true, ...(hooks === undefined ? {} : { hooks }) }, jobs: [], sessions: [] });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-h2-'));

try {
  const cookie = await signIn(EMAIL);
  // ── the hooks status ──
  const pc = await mkDevice('h2-pc');
  const good = { version: '1a2b3c4d5e6f', events: 4, stale: false, signIn: 'worker' };
  check('status with hooks: accepted', (await status(pc, good)).status === 200);
  const stored = async () => (await rawDb.collection('devices').findOne({ _id: pc.id }))?.worker?.hooks;
  check('a valid hooks value is kept', JSON.stringify(await stored()) === JSON.stringify(good), JSON.stringify(await stored()));
  for (const [label, bad] of [['version not hex', { ...good, version: 'xyz' }], ['events 9', { ...good, events: 9 }], ['events 2.5', { ...good, events: 2.5 }], ['stale a string', { ...good, stale: 'no' }], ['signIn other', { ...good, signIn: 'cloud' }], ['an array', [good]]]) {
    await status(pc, good); // start from a valid one so "dropped" is visible
    await status(pc, bad);
    check(`a bad hooks value is dropped (${label})`, (await stored()) === undefined, JSON.stringify(await stored()));
  }
  await status(pc, { version: null, events: 0, stale: false, signIn: null });
  check('no hooks installed: version null is kept', (await stored())?.version === null && (await stored())?.events === 0);

  // ── Link matching folders ──
  const one = (await must(MCP, 'add_project', { name: 'H2 One', code: [{ remote: 'acme/h2-one' }] })).project.id;
  const sharedA = (await must(MCP, 'add_project', { name: 'H2 Shared A', code: [{ remote: 'acme/h2-shared' }] })).project.id;
  await must(MCP, 'add_project', { name: 'H2 Shared B', code: [{ remote: 'acme/h2-shared' }] });
  const arch = (await must(MCP, 'add_project', { name: 'H2 Old', code: [{ remote: 'acme/h2-old' }] })).project.id;
  await rawDb.collection('projects').updateOne({ _id: arch }, { $set: { status: 'archived' } });
  const linkedElsewhere = (await must(MCP, 'add_project', { name: 'H2 Taken', code: [{ remote: 'acme/h2-taken' }] })).project.id;
  await rawDb.collection('workerFolders').insertMany([
    folder(pc, 'h2-one', 'acme/h2-one'),
    folder(pc, 'h2-one-wt', 'acme/h2-one'), // a worktree of the same repo: linked too
    folder(pc, 'h2-shared', 'acme/h2-shared'),
    folder(pc, 'h2-old', 'acme/h2-old'),
    folder(pc, 'h2-taken', 'acme/h2-taken', linkedElsewhere),
    folder(pc, 'h2-norepo', ''),
    folder(pc, 'h2-gone', 'acme/h2-one', null, { missing: true }),
  ]);
  const m = await act(cookie, 'matchingFoldersAction', pc.id);
  check('matchingFolders lists the two folders of one project', m.ok && /h2-one"/.test(m.text) && /h2-one-wt/.test(m.text), m.text.slice(0, 300));
  check('the ambiguous folder is listed apart, with both projects', /ambiguous/.test(m.text) && /H2 Shared A/.test(m.text) && /H2 Shared B/.test(m.text));
  check('an archived project, a missing folder and a linked folder never match', !/h2-old|h2-gone|h2-taken/.test(m.text.split('ambiguous')[0]));
  await makeUser({ email: 'h2-x@example.test', name: 'Xia', orgName: 'H2 X Org' });
  const xCookie = await signIn('h2-x@example.test');
  const other = await act(xCookie, 'matchingFoldersAction', pc.id);
  check("another person's computer is not found", !other.ok && /not found/i.test(other.text), other.text.slice(0, 200));
  const lk = await act(cookie, 'linkMatchingFoldersAction', pc.id);
  check('Link them links the two folders and reports one skipped', lk.ok && lk.linked === 2 && /matches several projects/.test(lk.text), lk.text.slice(0, 300));
  const rows = Object.fromEntries((await rawDb.collection('workerFolders').find({ deviceId: pc.id }).toArray()).map(f => [f.folderId, f.projectId]));
  check('both folders of the repo are linked to its project', rows['h2-one'] === one && rows['h2-one-wt'] === one, JSON.stringify(rows));
  check('the ambiguous, archived, missing and no-remote folders stay unlinked, the linked one untouched', rows['h2-shared'] === null && rows['h2-old'] === null && rows['h2-gone'] === null && rows['h2-norepo'] === null && rows['h2-taken'] === linkedElsewhere);
  check('a second Link them links nothing', (await act(cookie, 'linkMatchingFoldersAction', pc.id)).linked === 0);

  // ── an installed copy run with the command from settings.json ──
  const worker = path.join(tmp, 'work-os-worker');
  const settings = path.join(tmp, 'claude', 'settings.json');
  const env = { ...process.env, WORK_OS_WORKER_DIR: worker, CLAUDE_SETTINGS_PATH: settings, WORK_OS_HOOK_DIR: path.join(tmp, 'markers') };
  delete env.WORK_OS_KEY; delete env.WORK_OS_URL;
  fs.mkdirSync(worker, { recursive: true });
  fs.writeFileSync(path.join(worker, 'config.json'), JSON.stringify({ baseUrl: B }));
  const inst = pathToFileURL(path.join(ROOT, 'worker', 'hooks-install.mjs')).href;
  const i = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(inst)}); m.install({ force: true });`], { env, encoding: 'utf8' });
  check('hooks install into a temp worker folder and temp settings', i.status === 0, i.stderr);
  const cmd = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.SessionStart[0].hooks[0].command;
  const hookFile = /^node "(.+)" session-start$/.exec(cmd)?.[1];
  check('the settings command points into the temp worker folder', !!hookFile && hookFile.replace(/\\/g, '/').includes('/work-os-worker/hooks/hook.mjs'), cmd);
  const mkRepo = (name, remote) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    for (const a of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', remote]]) spawnSync('git', a, { cwd: dir });
    return dir;
  };
  const devKey = pc.key;
  const run = cwd => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const hook = await import(${JSON.stringify(pathToFileURL(hookFile).href)});
    hook.deps.deviceKey = () => ${JSON.stringify(devKey)};
    process.stdout.write(await hook.main('session-start', JSON.stringify({ session_id: 'h2s', cwd: ${JSON.stringify(cwd)}, transcript_path: '' })));
  `], { env, encoding: 'utf8', timeout: 30000 });
  const linkedRepo = run(mkRepo('linked', 'https://github.com/acme/h2-one.git'));
  check('a linked folder gets the brief for its project', /Work OS brief for project H2 One/.test(linkedRepo.stdout), linkedRepo.stdout.slice(0, 200) + linkedRepo.stderr);
  const unlinkedRepo = run(mkRepo('unlinked', 'https://github.com/acme/h2-shared.git'));
  check('an unlinked folder gets nothing', unlinkedRepo.stdout.trim() === '', unlinkedRepo.stdout.slice(0, 200));

  // ── the Computers row and the Link them line, by eye ──
  await status(pc, good);
  await rawDb.collection('workerFolders').insertOne(folder(pc, 'h2-new', 'acme/h2-one')); // one more match
  const stalePc = await mkDevice('h2-stale');
  await status(stalePc, { version: '1a2b3c4d5e6f', events: 4, stale: true, signIn: 'key' });
  const bare = await mkDevice('h2-bare');
  await status(bare, { version: null, events: 0, stale: false, signIn: null });
  const b = await launch();
  try {
    for (const vp of [390, 1280]) {
      const ctx = await b.newContext({ viewport: { width: vp, height: 844 }, ...(vp === 390 ? { isMobile: true, hasTouch: true } : {}) });
      const p = await ctx.newPage();
      await login(p, { phone: vp === 390, next: '/claude?tab=setup' });
      await p.waitForSelector('[data-device="h2-pc"]');
      const t = n => p.locator(`[data-device="${n}"]`).innerText();
      check(`[${vp}] the row says hooks on`, /hooks on/.test(await t('h2-pc')), await t('h2-pc'));
      check(`[${vp}] hooks out of date`, /hooks out of date/.test(await t('h2-stale')), await t('h2-stale'));
      check(`[${vp}] no hooks`, /no hooks/.test(await t('h2-bare')), await t('h2-bare'));
      await p.locator('[data-device="h2-pc"] button[aria-label="Folders on h2-pc"]').click();
      await p.waitForSelector('[data-match-folders]');
      await p.screenshot({ path: `${SP}/h2-setup-${vp}.png` });
      check(`[${vp}] the Link them line names the count`, /1 folder here matches/.test(await p.locator('[data-match-folders]').innerText()));
      check(`[${vp}] the Folders panel has no horizontal overflow`, okO(await overflow(p)));
      await p.locator('[data-match-folders] button', { hasText: 'Link them' }).click();
      await p.waitForSelector('[data-match-folders]', { state: 'detached', timeout: 8000 });
      check(`[${vp}] after Link them the line is gone`, true);
      await rawDb.collection('workerFolders').updateOne({ _id: `${pc.id}:h2-new` }, { $set: { projectId: null, linkedAt: null } });
      await ctx.close();
    }
  } finally { await b.close(); }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
await finish();
