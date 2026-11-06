// "Open in Claude Code" / "Open in Claude Desktop" on a task, and Settings › AI tools (docs/connect.md).
// The worker is played over the real worker API (device key); nothing is launched: the job the worker would get is asserted.
// If the Claude Code CLI is installed, the Claude Code snippet is also run for real against this server (isolated config dir).
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, db, mcp, call, api, sha, B, ME, mkWos, launch, finish, login, overflow, okO } from './lib.mjs';

const browser = await launch();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn().catch(() => false); if (v) return v; await sleep(150); } return false; };

for (const c of ['workerFolders', 'workerJobs', 'workerSessions', 'devices', 'projects']) await db.collection(c).deleteMany({});
const key = 'wkr_' + randomBytes(32).toString('base64url');
const dev = randomUUID();
await db.collection('devices').insertOne({ _id: dev, name: 'Om-PC', ownerId: ME.userId, orgId: ME.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
const status = body => api(key, 'POST', '/api/worker/status', { worker: { version: '0.2.0', os: 'win32', allowPrompts: true }, ...body });
await status({});
const pid = (await mcp('add_project', { name: 'Alpha' })).project.id;
const pidNo = (await mcp('add_project', { name: 'Unlinked' })).project.id;
await db.collection('workerFolders').insertOne({ _id: `${dev}:f_alpha1`, deviceId: dev, folderId: 'f_alpha1', name: 'alpha', git: false, projectId: pid, linkedAt: new Date(), seenAt: new Date(), missing: false });
const TITLE = 'Secret plan title ' + randomBytes(4).toString('hex');
const t1 = (await call('add_task', { title: TITLE, project: 'Alpha' })).created.ref;
const t2 = (await call('add_task', { title: 'Task in an unlinked project', project: 'Unlinked' })).created.ref;
const worker = async () => (await api(key, 'GET', '/api/worker/jobs')).body.jobs;
const jobs = f => db.collection('workerJobs').find({ deviceId: dev, ...f }).toArray();

async function suite(vp) {
  const phone = vp === 390;
  const T = s => `[${vp}] ${s}`;
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message.slice(0, 80)));
  const click = l => (phone ? l.tap() : l.click());
  await login(p, { phone, next: '/settings?section=ai-tools' });

  // ── Settings › AI tools ──
  await p.waitForSelector('[data-ai-tools]');
  const addr = await p.locator('[data-ai-address]').getAttribute('data-ai-address');
  const MCP_URL = B + '/api/mcp';
  check(T('AI tools shows this server\'s MCP address'), addr === MCP_URL, addr);
  const ids = await p.locator('[data-ai-tool]').evaluateAll(els => els.map(e => e.getAttribute('data-ai-tool')));
  check(T('four tools: Claude Code, Cursor, Antigravity, ChatGPT'), ids.join() === 'claude-code,cursor,antigravity,chatgpt', ids.join());
  const flag = async id => p.locator(`[data-ai-tool="${id}"] [data-ai-tested]`).getAttribute('data-ai-tested');
  check(T('only Claude Code is marked tested; the others say "not tested yet"'), (await flag('claude-code')) === 'yes' && (await flag('cursor')) === 'no' && (await flag('antigravity')) === 'no' && (await flag('chatgpt')) === 'no');
  for (const id of ids) {
    const txt = await p.locator(`[data-ai-tool="${id}"]`).innerText();
    check(T(`${id}: snippet carries this server's URL`), txt.includes(MCP_URL), id);
  }
  const cursorTxt = await p.locator('[data-ai-tool="cursor"] pre').first().innerText();
  const agTxt = await p.locator('[data-ai-tool="antigravity"] pre').first().innerText();
  check(T('Cursor uses "url", Antigravity uses "serverUrl" (as each one documents)'), JSON.parse(cursorTxt).mcpServers['work-os'].url === MCP_URL && JSON.parse(agTxt).mcpServers['work-os'].serverUrl === MCP_URL, cursorTxt + agTxt);
  check(T('ChatGPT says plainly it may not be available'), /may not let you add this/.test(await p.locator('[data-ai-tool="chatgpt"] [data-ai-warning]').innerText()));
  if (!phone) {
    await p.locator('[data-ai-tool="claude-code"] button[title="Copy"]').first().click();
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    check(T('copy button copies the Claude Code command'), clip === `claude mcp add --scope user --transport http work-os ${MCP_URL}`, clip);
  }
  const ov = await overflow(p);
  check(T('no sideways scroll'), okO(ov), JSON.stringify(ov));
  if (phone) {
    await p.goto(B + '/settings');
    await p.waitForSelector('[data-settings-rows]');
    check(T('phone list has an AI tools row'), /AI tools/.test(await p.locator('[data-settings-rows]').innerText()));
  }

  // ── Open in Claude Code / Claude Desktop ──
  const openMenu = async which => {
    await p.goto(`${B}/tasks/${which}`);
    if (phone) { await click(p.locator('button[aria-label="More actions"]')); await p.waitForTimeout(200); }
  };
  const press = async mode => {
    if (phone) await click(p.getByRole('button', { name: mode === 'desktop' ? /Open in Claude Desktop/ : /Open in Claude Code/ }).first());
    else await click(p.locator(mode === 'desktop' ? '[data-cd-open-menu]' : '[data-cc-open-menu]'));
  };
  await db.collection('workerJobs').deleteMany({});
  await openMenu(t1);
  await press('terminal');
  await p.waitForSelector('[data-cc-sheet="terminal"] [data-cc-open]');
  const sheetTxt = await p.locator('[data-cc-sheet]').innerText();
  check(T('sheet names the folder and the PC'), /alpha/.test(sheetTxt) && /Om-PC/.test(sheetTxt), sheetTxt);
  await click(p.locator('[data-cc-open]'));
  const j = await wait(async () => (await jobs({ kind: 'start' }))[0]);
  check(T('Open in Claude Code queues one start job in the linked folder'), !!j && j.folderId === 'f_alpha1' && j.projectId === pid && (await jobs({})).length === 1, JSON.stringify(j));
  check(T('its prompt names the task ref and get_task, never the title'), !!j && j.prompt.includes(`#${t1}`) && j.prompt.includes(`get_task ${t1}`) && !j.prompt.includes(TITLE), j?.prompt);
  const got = (await worker()).find(x => x.kind === 'start');
  check(T('the worker receives folderId, session id and prompt (no path)'), got?.folderId === 'f_alpha1' && /^[0-9a-f-]{36}$/.test(got.sessionId) && got.prompt === j.prompt && !/[A-Za-z]:[\\/]/.test(JSON.stringify(got)), JSON.stringify(got));
  const sess = await db.collection('workerSessions').findOne({ _id: got.sessionId });
  check(T('a session row exists and the task is not marked for Claude'), !!sess && !(await db.collection('tasks').findOne({ ref: t1 })).claude, JSON.stringify(sess));
  await status({ jobs: [{ id: got.id, ok: true }] });

  await db.collection('workerJobs').deleteMany({});
  await openMenu(t1);
  await press('desktop');
  await p.waitForSelector('[data-cc-sheet="desktop"] [data-cc-open]');
  check(T('Desktop sheet is honest: you confirm the folder and press Enter'), /confirm the folder/.test(await p.locator('[data-cc-sheet]').innerText()));
  await click(p.locator('[data-cc-open]'));
  const d = await wait(async () => (await jobs({ kind: 'desktop' }))[0]);
  check(T('Open in Claude Desktop queues one desktop job: folder + prompt, no session'), !!d && d.folderId === 'f_alpha1' && !d.sessionId && d.prompt.includes(`get_task ${t1}`) && !d.prompt.includes(TITLE), JSON.stringify(d));
  const gd = (await worker()).find(x => x.kind === 'desktop');
  check(T('the worker receives kind desktop with folderId and prompt'), gd?.folderId === 'f_alpha1' && !!gd.prompt && !('sessionId' in gd), JSON.stringify(gd));
  await status({ jobs: [{ id: gd.id, ok: true }] });

  // a project with no linked folder: the same words Open in VS Code gives
  await db.collection('workerJobs').deleteMany({});
  await openMenu(t2);
  await press('terminal');
  const blocked = await p.locator('[data-cc-blocked]').waitFor().then(() => p.locator('[data-cc-blocked]').innerText());
  check(T('no linked folder: "Link this folder to a project first"'), /Link this folder to a project first/.test(blocked) && (await p.locator('[data-cc-open]').count()) === 0, blocked);

  // a computer that does not pass first messages on: refused, nothing queued
  await db.collection('devices').updateOne({ _id: dev }, { $set: { 'worker.allowPrompts': false } });
  await openMenu(t1);
  await press('terminal');
  await p.waitForSelector('[data-cc-open]');
  await click(p.locator('[data-cc-open]'));
  const toast = await wait(async () => (await p.locator('[data-sonner-toast]').allInnerTexts()).some(t => /allowPrompts/.test(t)), 8000);
  check(T('allowPrompts off: refused with the reason, nothing queued'), !!toast && (await jobs({})).length === 0);
  await db.collection('devices').updateOne({ _id: dev }, { $set: { 'worker.allowPrompts': true } });
  check(T('no page errors'), errs.length === 0, errs.join('|'));
  await ctx.close();
}
await suite(390);
await suite(1280);

// ── the Claude Code snippet, for real (optional: needs the CLI) ──
try {
  const ver = execFileSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 20000 }).trim();
  const cfg = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'wos-cc-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  try {
    const k = await mkWos();
    const run = (args) => execFileSync('claude', args, { encoding: 'utf8', env, cwd: cfg, shell: process.platform === 'win32', timeout: 90000 });
    // exactly the page's key variant (with the key in place of YOUR_KEY)
    run(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'work-os', B + '/api/mcp', '--header', `"Authorization: Bearer ${k}"`]);
    const list = run(['mcp', 'list']);
    check(`claude mcp add + list (CLI ${ver}) shows work-os connected`, /work-os/.test(list) && /Connected/i.test(list) && !/Failed|Needs authentication/i.test(list), list.replace(/wos_\S+/g, 'wos_<redacted>').slice(0, 300));
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
} catch (e) { console.log('SKIP claude CLI check:', String(e.message).slice(0, 120)); }

await finish();
