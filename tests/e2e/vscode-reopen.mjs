// "Open in VS Code" on a session row, the "N sessions were open before your PC restarted" prompt, and readable failure
// reasons (Claude page and the project's Sessions). The worker is played over the real worker API (device key). Seed profile: none.
import { randomUUID, randomBytes } from 'node:crypto';
import { check, db, mcp, api, sha, B, ME, launch, finish, fillLogin } from './lib.mjs';

const browser = await launch();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => false); if (v) return v; await sleep(150); } return false; };

async function suite(vp) {
  const phone = vp === 390;
  const T = s => `[${vp}] ${s}`;
  for (const c of ['workerFolders', 'workerJobs', 'workerSessions', 'devices', 'projects']) await db.collection(c).deleteMany({});
  const key = 'wkr_' + randomBytes(32).toString('base64url');
  const dev = randomUUID();
  await db.collection('devices').insertOne({ _id: dev, name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
  const pid = (await mcp('add_project', { name: 'Alpha' })).project.id;
  await db.collection('workerFolders').insertOne({ _id: `${dev}:f_alpha1`, deviceId: dev, folderId: 'f_alpha1', name: 'alpha', git: false, projectId: pid, linkedAt: new Date(), seenAt: new Date(), missing: false });
  const sV = randomUUID(), sC = randomUUID(), sF = randomUUID();
  const item = (sessionId, title, origin) => ({ sessionId, folder: 'alpha', title, lastActiveAt: Date.now() - 5000, subagentsActive: 0, startedByWorkOs: false, running: true, origin });
  const status = body => api(key, 'POST', '/api/worker/status', { worker: { version: '0.2.0', os: 'win32' }, ...body });
  const worker = async () => (await api(key, 'GET', '/api/worker/jobs')).body.jobs;
  await status({ claudeSessions: [item(sV, 'Fix the login page', 'vscode'), item(sC, 'Terminal chat', 'cli')], reopen: [] });
  await db.collection('workerSessions').insertOne({ _id: sF, deviceId: dev, folderId: 'f_alpha1', projectId: pid, state: 'failed', error: 'claude not found on PATH outside the allowed roots', startedAt: new Date(), updatedAt: new Date() });

  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message.slice(0, 80)));
  p.on('console', m => m.type() === 'error' && !/Failed to load resource/i.test(m.text()) && errs.push(m.text().slice(0, 200)));
  const click = l => (phone ? l.tap() : l.click());
  const toast = async re => !!(await wait(async () => (await p.locator('[data-sonner-toast]').allInnerTexts()).some(t => re.test(t)), 12000));
  const jobs = f => db.collection('workerJobs').find({ deviceId: dev, ...f }).toArray();

  await p.goto(B + '/login?next=/claude');
  await fillLogin(p);
  await click(p.locator('button[type=submit]'));
  await p.waitForURL(u => u.pathname === '/claude', { timeout: 20000 });
  await p.waitForSelector('[data-section="sessions"]');

  // ── Open in VS Code ──
  const vrow = p.locator(`[data-session-row="${dev}:${sV}"]`);
  const crow = p.locator(`[data-session-row="${dev}:${sC}"]`);
  check(T('VS Code session is badged, terminal session is not'), (await vrow.locator('[data-origin-badge]').count()) === 1 && (await crow.locator('[data-origin-badge]').count()) === 0);
  check(T('Open in VS Code on a VS Code session and on a terminal one'), (await vrow.locator('[data-open-vscode]').count()) === 1 && (await crow.locator('[data-open-vscode]').count()) === 1);
  if (phone) { const bb = await vrow.locator('[data-open-vscode]').boundingBox(); check(T('Open in VS Code target >= 44px'), bb && bb.height >= 43.5, JSON.stringify(bb)); }
  await click(vrow.locator('[data-open-vscode]'));
  const job = await wait(async () => (await jobs({ kind: 'vscode' }))[0]);
  check(T('Open in VS Code queues one vscode job with only the session id'), !!job && job.sessionId === sV && !job.folderId && !job.prompt && (await jobs({ kind: 'vscode' })).length === 1, JSON.stringify(job));
  const got = (await worker()).find(j => j.kind === 'vscode');
  check(T('the worker receives it with just kind and session id'), got?.sessionId === sV && !('folderId' in got) && !('prompt' in got), JSON.stringify(got));
  await status({ jobs: [{ id: got.id, ok: false, error: 'folder not linked to a project' }] });
  check(T('a failed open says it in plain words'), await toast(/Link this folder to a project first/));
  check(T('and does not touch any session'), (await db.collection('workerSessions').findOne({ _id: sF })).state === 'failed' && (await db.collection('workerSessions').countDocuments({})) === 1);
  await click(crow.locator('[data-open-vscode]'));
  const j2 = await wait(async () => (await jobs({ kind: 'vscode', sessionId: sC }))[0]);
  const g2 = (await worker()).find(j => j.kind === 'vscode');
  await status({ jobs: [{ id: g2.id, ok: true }] });
  check(T('a successful open toasts Opened in VS Code'), !!j2 && (await toast(/Opened in VS Code/)));

  // ── a failed session shows why, in plain words ──
  await p.goto(B + '/claude?tab=now');
  await p.waitForSelector('[data-section="sessions"]');
  const frow = p.locator(`[data-session-row="${dev}:${sF}"]`);
  await frow.waitFor();
  const ftxt = await frow.innerText();
  check(T('failed row shows the reason in plain words'), /Claude Code isn't installed on this PC/.test(ftxt) && !/outside the allowed roots/.test(ftxt), ftxt);
  if (!phone) {
    const er = frow.locator('[data-col="state"] [data-session-error]');
    check(T('desktop: reason sits next to the state, full text in a tooltip'), (await er.count()) === 1 && /isn't installed/.test((await er.getAttribute('title')) ?? ''));
  }

  // ── Reopen after a restart ──
  const r1 = randomUUID(), r2 = randomUUID();
  await status({ claudeSessions: [], reopen: [{ sessionId: r1, origin: 'vscode', title: 'Fix the login page', folder: 'alpha' }, { sessionId: r2, origin: 'cli', title: 'Terminal chat', folder: 'alpha' }] });
  await p.goto(B + '/claude?tab=now');
  const bn = p.locator(`[data-reopen-banner="${dev}"]`);
  await bn.waitFor();
  const bt = await bn.innerText();
  check(T('banner: "2 sessions were open before Om-PC restarted", each with where it reopens'), /2 sessions were open before Om-PC restarted/.test(bt) && /Fix the login page.*in VS Code/.test(bt) && /Terminal chat.*in a terminal/.test(bt), bt);
  check(T('nothing is reopened until the tap'), (await jobs({ kind: 'reopen' })).length === 0 && (await worker()).filter(j => j.kind === 'reopen').length === 0);
  if (phone) { const bb = await bn.locator('[data-reopen-all]').boundingBox(); check(T('Reopen all target >= 44px'), bb && bb.height >= 43.5, JSON.stringify(bb)); }
  await p.goto(B + `/projects/${pid}?tab=claude`);
  check(T('project Sessions shows the same prompt for its computer'), !!(await p.locator(`[data-reopen-banner="${dev}"]`).waitFor({ timeout: 8000 }).then(() => true, () => false)));
  await p.goto(B + '/claude?tab=now');
  await bn.waitFor();
  await click(bn.locator('[data-reopen-all]'));
  const rj = await wait(async () => (await jobs({ kind: 'reopen' }))[0]);
  check(T('Reopen all queues one reopen job with no session ids'), !!rj && !rj.sessionId && !rj.folderId && (await jobs({ kind: 'reopen' })).length === 1, JSON.stringify(rj));
  check(T('the banner goes away at once'), await bn.waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false));
  const gr = (await worker()).find(j => j.kind === 'reopen');
  await status({ reopen: [], jobs: [{ id: gr.id, ok: false, error: 'Opened 1 of 2: folder not linked to a project' }] });
  check(T('the worker result is shown in plain words (some were not opened)'), await toast(/Opened 1 of 2: Link this folder to a project first/));
  check(T('server holds no pending list after the worker reports none'), !(await db.collection('devices').findOne({ _id: dev })).reopen);

  // Dismiss
  await status({ reopen: [{ sessionId: r1, origin: 'vscode', title: 'Fix the login page', folder: 'alpha' }] });
  await p.goto(B + '/claude?tab=now');
  await bn.waitFor();
  check(T('banner: one session says "1 session was open"'), /1 session was open before Om-PC restarted/.test(await bn.innerText()));
  await click(bn.locator('[data-reopen-dismiss]'));
  const dj = await wait(async () => (await jobs({ kind: 'dismiss' }))[0]);
  check(T('Dismiss queues a dismiss job and opens nothing'), !!dj && (await jobs({ kind: 'reopen' })).length === 1 && (await jobs({ kind: 'vscode' })).length === 2);
  check(T('banner gone after Dismiss'), await bn.waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false));
  check(T('server cleared the list'), !(await db.collection('devices').findOne({ _id: dev })).reopen);
  const noScroll = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(T('no horizontal scroll'), noScroll);
  check(T('no console/page errors'), errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await suite(1280);
await suite(390);
await browser.close();
await finish();
