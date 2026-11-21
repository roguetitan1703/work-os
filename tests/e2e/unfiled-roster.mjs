// Identity step 5: a Claude Code session whose folder no project owns is still on the roster ("No project"). POST /api/agent/start with
// the protocol 3 header answers 200 { unfiled, quiet?, token } (an older hook still gets the 404); the token opens only /api/agent/event and
// /api/agent/wait (state, release and a start with a folder of a project refuse it); the row has no project and is private to its person
// (a teammate's roster and list_sessions never show it); filing the folder ends the no-project row and token; one Claude Code session is
// one row. Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, MCP, ME, SP, check, finish, launch, login, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { must, mcpH } from './flow-lib.mjs';

const call = async (url, cred, body = {}, hook = '3') => {
  const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...(hook ? { 'x-work-os-hook': hook } : {}), ...(cred ? { authorization: `Bearer ${cred}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
};

try {
  const TESS = await makeUser({ email: 'tess-unfiled@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first roster read: member names are cached for a minute
  const tessKey = await mkKey({ userId: TESS.userId });
  const pc = await mkDevice('unfiled-pc');
  await rawDb.collection('devices').updateOne({ _id: pc.id }, { $set: { ownerId: ME.userId, orgId: ME.orgId, name: 'Scratch-PC' } });
  const body = (ccSession, extra = {}) => ({ path: 'C:/scratch/orchestrator', branch: 'main', ccSession, source: 'startup', tool: 'desktop', title: 'Made up orchestrator', model: 'model-z', ...extra });
  const CC = randomUUID();

  // the start
  const old = await call('/api/agent/start', pc.key, body(randomUUID()), '2');
  check('an older hook still gets the 404 for a folder no project owns', old.status === 404 && old.json?.unfiled === true, `${old.status} ${old.text.slice(0, 120)}`);
  const none = await rawDb.collection('presence').countDocuments({ projectId: null });
  check('…and no row is made for it', none === 0, String(none));
  const r1 = await call('/api/agent/start', pc.key, body(CC));
  check('protocol 3: the answer is 200 { unfiled, token } with no brief', r1.status === 200 && r1.json?.unfiled === true && /^wst_/.test(r1.json?.token ?? '') && !('brief' in (r1.json ?? {})), r1.text.slice(0, 160));
  const tok = r1.json?.token;
  const sid = (await rawDb.collection('agentSessions').findOne({ ccSession: CC }))?._id;
  const row = sid ? await rawDb.collection('presence').findOne({ session: sid }) : null;
  check('the token row has no project and keeps the Claude Code session id', !!sid && (await rawDb.collection('agentSessions').findOne({ _id: sid }))?.projectId === null);
  check('the presence row has no project, is private to its person, and carries its name, tool, model and machine', !!row && row.projectId === null && row.visibility === 'private' && row.ownerId === ME.userId && row.label === 'Made up orchestrator' && row.tool === 'desktop' && row.model === 'model-z' && row.machineName === 'Scratch-PC', JSON.stringify(row));
  const q = await call('/api/agent/start', pc.key, body(randomUUID(), { path: 'C:/scratch/orchestrator-2', title: undefined }));
  const qrow = await rawDb.collection('presence').findOne({ ccSession: { $ne: CC }, projectId: null });
  check('a session with no name is called "<folder> · Claude Code"', q.status === 200 && qrow?.label === 'orchestrator-2 · Claude Code' && qrow?.labelSource === 'fallback', JSON.stringify([q.status, qrow?.label]));
  const again = await call('/api/agent/start', pc.key, body(CC));
  check('the same Claude Code session starting again is still one row and one session record (tokens are keys: the first one stays)', again.status === 200 && (await rawDb.collection('presence').countDocuments({ ccSession: CC })) === 1 && (await rawDb.collection('agentIdentities').countDocuments({ ccSessions: CC })) === 1 && (await rawDb.collection('agentSessions').countDocuments({ ccSession: CC })) === 2);
  const tok2 = again.json?.token;
  check('…and the first token still opens the same session', (await call('/api/agent/event', tok, { event: 'prompt' })).status === 200);
  const sid2 = (await rawDb.collection('agentIdentities').findOne({ ccSessions: CC }))?._id;

  // the token's reach
  const ev = await call('/api/agent/event', tok2, { event: 'prompt' });
  check('the token takes an event', ev.status === 200 && ev.json?.state === 'working', ev.text.slice(0, 120));
  const ev2 = await call('/api/agent/event', tok2, { event: 'prompt', deliver: true });
  check('…with deliver it answers the state and no delivery (nothing to deliver outside a project)', ev2.status === 200 && !ev2.json?.deliver, ev2.text.slice(0, 120));
  const idn = await call('/api/agent/event', tok2, { event: 'stop', identity: { title: 'Renamed orchestrator' } });
  const row2 = await rawDb.collection('presence').findOne({ session: sid2 });
  check('a rename reaches the row', idn.status === 200 && row2?.label === 'Renamed orchestrator', `${idn.status} ${row2?.label}`);
  await call('/api/agent/event', tok2, { event: 'prompt' });
  const w = await call('/api/agent/wait', tok2, {});
  check('the token takes a wait (a working session is told it is busy)', w.status === 200 && w.json?.busy === true, w.text.slice(0, 120));
  const st = await call('/api/agent/state', tok2, {});
  check('state refuses it', st.status === 403, `${st.status} ${st.text.slice(0, 100)}`);
  const rel = await call('/api/agent/release', tok2, { what: 'push' });
  check('release (production) refuses it', rel.status === 403, `${rel.status} ${rel.text.slice(0, 100)}`);
  const st2 = await call('/api/agent/start', tok2, body(CC, { title: undefined })); // the hook sends the session's current name, not the old one
  check('a start with the token and no project answers unfiled again (no brief, no new token)', st2.status === 200 && st2.json?.unfiled === true && !('brief' in st2.json) && !('token' in st2.json), st2.text.slice(0, 120));
  const wrong = await call('/api/agent/start', 'wst_' + 'x'.repeat(43), body(CC));
  check('a token that is not one is refused', wrong.status === 401, `${wrong.status}`);

  // the roster
  const mine = await must(MCP, 'list_sessions', { project: undefined });
  const row3 = mine.sessions.find(x => x.session === sid2);
  check('list_sessions shows it to its person under No project, with its name, tool and model', !!row3 && row3.project === 'No project' && row3.name === 'Renamed orchestrator' && row3.tool === 'desktop' && row3.model === 'model-z', JSON.stringify(row3));
  const theirs = await must(tessKey, 'list_sessions', {});
  check('a teammate does not see it (not in list_sessions)', !theirs.sessions.some(x => x.name === 'Renamed orchestrator' || x.project === 'No project'), JSON.stringify(theirs.sessions).slice(0, 200));
  const rosterRows = await must(MCP, 'list_sessions', { include_off: true });
  check('the person keeps seeing it with the off rows too', rosterRows.sessions.some(x => x.session === sid2));

  // filing the folder
  const P = 'Filed Project';
  const pid = (await must(MCP, 'add_project', { name: P, code: [{ remote: 'acme/filed-project' }] })).project.id;
  await rawDb.collection('workerFolders').insertOne({ _id: `${pc.id}:fold1`, deviceId: pc.id, folderId: 'fold1', name: 'C:/scratch/orchestrator', git: false, remote: null, projectId: pid, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: ME.orgId, ownerId: ME.userId });
  const filed = await call('/api/agent/start', tok2, { ...body(CC), folders: ['fold1'] });
  check('the same session with its folder filed: the no-project token files it (same session id, no 403)', filed.status === 200 && filed.json?.brief?.session === sid2 && filed.json?.brief?.project?.name === P, `${filed.status} ${filed.text.slice(0, 100)}`);
  const f2 = await call('/api/agent/start', pc.key, { ...body(CC), folders: ['fold1'] });
  check('the folder is filed: a brief and a new token for the same session on the project', f2.status === 200 && f2.json?.brief?.project?.name === P && f2.json?.brief?.session === sid2 && /^wst_/.test(f2.json?.token ?? ''), f2.text.slice(0, 160));
  check('…the no-project row has ended (no open row with no project)', (await rawDb.collection('presence').countDocuments({ ccSession: CC, projectId: null, endedAt: { $exists: false } })) === 0);
  check('…and the session has one open row, on the project', (await rawDb.collection('presence').countDocuments({ ccSession: CC, endedAt: { $exists: false } })) === 1 && (await rawDb.collection('presence').findOne({ ccSession: CC, endedAt: { $exists: false } }))?.projectId === pid);
  check('…the old no-project token is the same session key: its events go to the project row', (await call('/api/agent/event', tok2, { event: 'prompt' })).status === 200 && !!(await rawDb.collection('presence').findOne({ ccSession: CC, projectId: pid }))?.activity);

  // a session of its own person only: another key for the same user sees it, a person of another kind cannot address it by project
  const agent = await mkKey({ agent: 'claude-code', name: 'unfiled agent' });
  const r = await mcpH(agent, 'list_sessions', {});
  check('another key of the same person sees their no-project sessions (the roster is the person\'s)', !r.isError && JSON.parse(r.text).sessions.some(x => x.project === 'No project'), r.text.slice(0, 160));

  // Claude › Workers: the no-project session sits under its own "No project" heading beside the project's sessions (390 and 1280 px, light and dark).
  const browser = await launch();
  try {
    for (const vp of [390, 1280]) {
      for (const scheme of ['light', 'dark']) {
        const phone = vp === 390;
        const T = l => `[${vp} ${scheme}] ${l}`;
        const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } : { viewport: { width: 1280, height: 800 }, colorScheme: scheme });
        const p = await ctx.newPage();
        await login(p, { phone, next: '/claude?tab=workers' });
        await p.waitForSelector('[data-section="workers"]');
        // One list: the no-project session is a row like the others, its project said as "No project" (no link).
        const box = p.locator('[data-workers-list] [data-worker]', { has: p.locator('[data-session-project="none"]') }).first();
        await box.waitFor({ timeout: 8000 });
        const txt = await box.innerText();
        check(T('Sessions: the no-project session is in the one list, named, reading "No project", with no project link'), /No project/.test(txt) && /orchestrator-2/.test(txt) && (await box.locator('a[href^="/projects/"]').count()) === 0, txt.slice(0, 200));
        check(T("Sessions: the project's session names its project"), (await p.locator('[data-workers-list]').innerText()).includes('Filed Project') && !txt.includes('Filed Project'), '');
        check(T('Workers: no horizontal scroll'), await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        await p.screenshot({ path: `${SP}/unfiled-${vp}-${scheme}-workers.png`, fullPage: true });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  check('unfiled-roster (error)', false, e?.stack || String(e));
}
await finish();
