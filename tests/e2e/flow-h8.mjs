// Flow H8 (plan note 63bf2014de): the three blocks. The server half of block 1 and 2: a release Need (ask with release: true),
// what production means per project (default from the code remotes, set in the app only), the brief's production field for the
// hook, and the grant route POST /api/agent/release (wst_ token only). The hook half is worker/test/hook-h8.test.mjs.
// Seed profile: none.
import { randomUUID } from 'node:crypto';
import { B, ME, MCP, check, finish, launch, login, makeUser, mkDevice, mkKey, rawDb } from './lib.mjs';
import { mcpH, mkOAuth, must } from './flow-lib.mjs';

const call = async (url, cred, body = {}, { headers = {}, raw, method = 'POST' } = {}) => {
  const r = await fetch(B + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}), ...headers }, body: method === 'GET' ? undefined : (raw ?? JSON.stringify(body)) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json, headers: r.headers };
};
const folder = (dev, who, fid, remote, projectId) => ({ _id: `${dev.id}:${fid}`, deviceId: dev.id, folderId: fid, name: `C:/code/${fid}`, git: true, remote, projectId, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
async function deviceOf(who, name) {
  const dev = await mkDevice(name);
  await rawDb.collection('devices').updateOne({ _id: dev.id }, { $set: { ownerId: who.userId, orgId: who.orgId, name } });
  return dev;
}
const HOOK = { 'X-Work-OS-Hook': '1' };

try {
  const T = await makeUser({ email: 'tess-h8@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached
  const kOm = await mkKey({ agent: 'claude-code', name: 'H8 Om Code' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  const ONE = (await must(MCP, 'add_project', { name: 'H8 One', code: [{ remote: 'acme/h8-one' }, { remote: 'acme/h8-site' }] })).project.id;
  const TESS = (await must(kT, 'add_project', { name: 'H8 Tess', visibility: 'org', code: [{ remote: 'acme/h8-tess' }] })).project.id;
  await must(MCP, 'save_state', { project: 'H8 One', ops: [{ op: 'add_next', text: 'H8 line' }] });
  const one = () => rawDb.collection('projects').findOne({ _id: ONE });
  const needDoc = ref => rawDb.collection('needs').findOne({ orgId: ME.orgId, ref });

  // ---- a) the release Need: fixed, app-only, to the owner ----
  const a1 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Release H8 One to production' });
  const n1 = a1.json?.need;
  const d1 = n1 ? await needDoc(n1.ref) : null;
  check('a: ask {release: true, kind approve} needs no "to": it goes to the project owner', !a1.isError && d1?.to === ME.userId && d1?.release === true, a1.text.slice(0, 300));
  check('a: the options are the three the server fixes (yes, day, no), the first is "Yes, release"', JSON.stringify(d1?.options?.map(o => o.id)) === '["yes","day","no"]' && d1.options[0].label === 'Yes, release' && d1.options[1].label === 'Yes, for 24 hours' && d1.options[2].label === 'No', JSON.stringify(d1?.options));
  check('a: it is app-only whatever the words say', d1?.appOnly === true);
  const a2 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Release again', options: [{ label: 'Sure' }, { label: 'Nope' }] });
  const d2 = a2.json?.need ? await needDoc(a2.json.need.ref) : null;
  check('a: options an agent passes are ignored: the server fixes them', !a2.isError && JSON.stringify(d2?.options?.map(o => o.id)) === '["yes","day","no"]', a2.text.slice(0, 300));
  const a3 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'decide', release: true, ask: 'Release?', options: [{ label: 'A' }, { label: 'B' }] });
  check('a: kind decide with release is refused', a3.isError && /approve/.test(a3.text), a3.text.slice(0, 200));
  const aT = await mcpH(kT, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Tess wants to release H8 One' });
  const dT = aT.json?.need ? await needDoc(aT.json.need.ref) : null;
  check("a: a teammate's agent asks too, and it still goes to the owner (Om), not to the asker", !aT.isError && dT?.to === ME.userId && dT?.from?.actor?.userId === T.userId, aT.text.slice(0, 300));
  const aTme = await mcpH(kT, 'ask', { project: 'H8 One', to: 'me', kind: 'approve', release: true, ask: 'Release, asking myself' });
  check('a: "me" on someone else\'s project is refused (the AKAR shape): a release goes to the owner', aTme.isError && /owner/.test(aTme.text), aTme.text.slice(0, 200));
  const aOwn = await mcpH(kOm, 'ask', { project: 'H8 One', to: 'Tess', kind: 'approve', release: true, ask: 'Release, to Tess' });
  check('a: naming another person than the owner is refused', aOwn.isError && /owner/.test(aOwn.text), aOwn.text.slice(0, 200));
  const aPlain = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', ask: 'No to given' });
  check('a: without release, "to" is still required', aPlain.isError && /to is required/.test(aPlain.text), aPlain.text.slice(0, 200));
  const aNo = await mcpH(kOm, 'ask', { project: 'H8 One', to: 'me', kind: 'approve', ask: 'An ordinary approve' });
  const dNo = aNo.json?.need ? await needDoc(aNo.json.need.ref) : null;
  check('a: an ordinary approve Need has no release mark and keeps Yes / No', !dNo?.release && JSON.stringify(dNo?.options?.map(o => o.id)) === '["yes","no"]', JSON.stringify(dNo));

  // ---- b) production per project: default, the brief for the hook, no MCP way to change it ----
  const pc = await deviceOf(ME, 'h8-pc');
  await rawDb.collection('workerFolders').insertOne(folder(pc, ME, 'f1', 'acme/h8-one', ONE));
  const body0 = { remote: 'https://github.com/acme/h8-one.git', branch: 'main', path: 'C:/code/h8-one', label: 'H8 · builder', ccSession: randomUUID(), source: 'startup' };
  const st = await call('/api/agent/start', pc.key, body0);
  const prod = st.json?.brief?.production;
  check("b: the hook's start brief carries production: the code remotes, main and master, no CLI targets (the default)", st.status === 200 && JSON.stringify(prod) === JSON.stringify({ remotes: ['acme/h8-one', 'acme/h8-site'], branches: ['main', 'master'], targets: [] }), JSON.stringify(prod) + st.text.slice(0, 200));
  const sw = await mcpH(kOm, 'start_work', { project: 'H8 One' });
  check('b: start_work without the hook header has no production field (no tokens spent)', !sw.isError && !('production' in (sw.json ?? {})), sw.text.slice(0, 200));
  const swh = await mcpH(kOm, 'start_work', { project: 'H8 One' }, HOOK);
  check('b: start_work with the hook header carries it', !swh.isError && JSON.stringify(swh.json?.production?.remotes) === '["acme/h8-one","acme/h8-site"]', swh.text.slice(0, 200));
  const up = await mcpH(kOm, 'update_project', { project: 'H8 One', production: { off: true, remotes: [], branches: [], targets: [] }, description: 'h8 touched' });
  const ac = await mcpH(kOm, 'apply_changes', { changes: [{ op: 'update_project', project: 'H8 One', production: { off: true, remotes: [], branches: [], targets: [] } }] });
  check('b: update_project and apply_changes cannot set production (nothing is stored)', !(await one()).production && !(await one()).productionBy, JSON.stringify([up.text.slice(0, 120), ac.text.slice(0, 120)]));
  // ---- c) the grant route: credentials, body, scope ----
  const sess = st.json;
  const REL = '/api/agent/release';
  const rel = (cred, body = { what: 'push', name: 'main' }, o = {}) => call(REL, cred, body, o);
  const oauth = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  const bad = [['no credential', null], ['a device key (wkr_)', pc.key], ['a Work OS key (wos_)', kOm], ['the chat key', MCP], ['an OAuth token', oauth], ['a made-up session token', 'wst_' + 'x'.repeat(43)]];
  for (const [label, cred] of bad) {
    const r = await rel(cred);
    check(`c: ${label} is refused with 401`, r.status === 401, `${r.status} ${r.text.slice(0, 100)}`);
  }
  const xk = await rel(null, { what: 'push' }, { headers: { 'x-api-key': kOm } });
  check('c: X-API-Key is not a credential here', xk.status === 401, String(xk.status));
  const xt = await call(REL, null, { what: 'push' }, { headers: { 'x-api-key': sess.token } });
  check('c: the session token as X-API-Key is not a credential either', xt.status === 401, String(xt.status));
  const jar = await call(REL, null, { what: 'push' }, { headers: { cookie: 'workos.session_token=abc' } });
  check('c: a cookie is not a credential', jar.status === 401, String(jar.status));
  const un = await rel(null);
  check('c: 401 carries no-store and the Bearer challenge', un.headers.get('cache-control') === 'no-store' && un.headers.get('www-authenticate') === 'Bearer');
  check('c: GET is not a method of this route', (await call(REL, sess.token, {}, { method: 'GET' })).status === 405);
  const b400 = [['no body', ''], ['not JSON', 'push'], ['an empty object', '{}'], ['an unknown what', '{"what":"deploy"}'], ['an extra field', '{"what":"push","command":"git push"}'], ['a name over 100 characters', JSON.stringify({ what: 'push', name: 'x'.repeat(101) })], ['a name that is not text', '{"what":"push","name":5}']];
  for (const [label, raw] of b400) {
    const r = await call(REL, sess.token, null, { raw });
    check(`c: ${label} is 400`, r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
  }
  check('c: over 1 KB is 413', (await call(REL, sess.token, null, { raw: JSON.stringify({ what: 'push', name: 'y'.repeat(1100) }) })).status === 413);
  const none = await rel(sess.token);
  check('c: a release Need open and none answered: allowed false, open = its number, owner = first name only', none.status === 200 && none.json?.allowed === false && typeof none.json?.open === 'number' && none.json?.owner === 'E2E' && !('until' in none.json), none.text);
  check('c: the answer is no-store and holds nothing else (no ids, no project, no Need text)', none.headers.get('cache-control') === 'no-store' && Object.keys(none.json).sort().join() === 'allowed,open,owner', none.text);
  const TWO = (await must(MCP, 'add_project', { name: 'H8 Two', code: [{ remote: 'acme/h8-two' }] })).project.id;
  await rawDb.collection('workerFolders').insertOne(folder(pc, ME, 'f2', 'acme/h8-two', TWO));
  const st2 = await call('/api/agent/start', pc.key, { remote: 'https://github.com/acme/h8-two.git', branch: 'main', path: 'C:/code/h8-two', label: 'H8 two', ccSession: randomUUID(), source: 'startup' });
  const none2 = await rel(st2.json.token);
  check('c: a project with no release Need at all: allowed false and no "open"', none2.status === 200 && none2.json?.allowed === false && !('open' in none2.json), none2.text);

  // ---- d) answers open and close the window; only the owner's tap counts ----
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await login(page, { phone: false, next: '/needs' });
  const answerUI = async (ref, option) => {
    await page.goto(`${B}/needs`);
    const btn = page.locator(`[data-need="${ref}"] [data-need-option="${option}"]`);
    await btn.waitFor({ timeout: 20000 });
    await btn.click();
    await page.waitForFunction(r => !document.querySelector(`[data-need="${r}"] [data-need-option]`), ref, { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
  };
  await answerUI(dT.ref, 'no');
  const afterNo = await rel(sess.token);
  check('d: "No" opens nothing: still allowed false (the other release Needs are open)', afterNo.json?.allowed === false && typeof afterNo.json?.open === 'number', afterNo.text);
  const dNoDoc = await needDoc(dT.ref);
  check('d: "No" sets no window', dNoDoc.status === 'answered' && dNoDoc.answer.option === 'no' && !dNoDoc.releaseUntil, JSON.stringify(dNoDoc.answer));
  await answerUI(d1.ref, 'yes');
  const yes = await rel(sess.token, { what: 'push', name: 'main' });
  const hrs = ms => ms / 3_600_000;
  check('d: "Yes, release" opens production for about 1 hour: allowed true, until, the Need number', yes.status === 200 && yes.json?.allowed === true && yes.json?.need === d1.ref && Math.abs(hrs(Date.parse(yes.json.until) - Date.now()) - 1) < 0.05, yes.text);
  const openLine = await page.locator(`[data-need="${d1.ref}"] [data-need-release]`).first().innerText().catch(() => '');
  check('d: the answered Need says "Release open until HH:MM" in its closed line', /Release open until (\w{3} )?\d\d:\d\d/.test(openLine), openLine);
  await page.locator(`[data-need="${d1.ref}"]`).first().screenshot({ path: `${process.env.E2E_SHOTS || 'D:/Work/Delpat/builds/e2e-h8/shots'}/h8-needs-answered-open-desk-light.png` }).catch(() => {});
  const feed = await rawDb.collection('activity').find({ orgId: ME.orgId, type: 'production', projectId: ONE }).sort({ at: -1 }).toArray();
  check('d: an allowed check writes one feed row on the project: what and name, as the agent, no command', feed.length === 1 && feed[0].note === `Production push (main) under Need #${d1.ref}` && feed[0].actor?.kind === 'agent', JSON.stringify(feed.map(f => f.note)));
  await rel(sess.token, { what: 'cli', name: 'vercel' });
  await rel(sess.token, { what: 'tag', name: 'v1' });
  const notes = (await rawDb.collection('activity').find({ orgId: ME.orgId, type: 'production', projectId: ONE }).sort({ at: 1 }).toArray()).map(f => f.note);
  check('d: tag and command read as "Production tag (v1)" and "Production command (vercel)"', notes.includes(`Production tag (v1) under Need #${d1.ref}`) && notes.includes(`Production command (vercel) under Need #${d1.ref}`), JSON.stringify(notes));
  check('d: a refusal writes nothing on the server (the other project has no row)', (await rawDb.collection('activity').countDocuments({ type: 'production', projectId: TWO })) === 0);
  await answerUI(d2.ref, 'day');
  const day = await rel(sess.token);
  check('d: "Yes, for 24 hours" opens 24 hours on this project; the longest open window answers', day.json?.allowed === true && day.json?.need === d2.ref && Math.abs(hrs(Date.parse(day.json.until) - Date.now()) - 24) < 0.05, day.text);
  const other2 = await rel(st2.json.token);
  check("d: the grant on H8 One does not open H8 Two (a session's token is its own project's)", other2.json?.allowed === false, other2.text);
  await rawDb.collection('needs').updateMany({ _id: { $in: [d1._id, d2._id] } }, { $set: { releaseUntil: new Date(Date.now() - 1000) } });
  const expired = await rel(sess.token);
  check('d: an expired window is no grant (and none is open any more, so no "open" either)', expired.json?.allowed === false && !('open' in expired.json), expired.text);
  await rawDb.collection('needs').insertOne({ ...d1, _id: randomUUID(), ref: 9000, to: T.userId, status: 'answered', releaseUntil: new Date(Date.now() + 3_600_000), answer: { option: 'yes', by: T.userId, via: 'app', at: new Date() } });
  const notOwner = await rel(sess.token);
  check("d: an answered release Need addressed to someone other than the project's owner opens nothing", notOwner.json?.allowed === false, notOwner.text);
  await rawDb.collection('needs').insertOne({ ...d1, _id: randomUUID(), ref: 9001, projectId: TESS, to: T.userId, status: 'answered', releaseUntil: new Date(Date.now() + 3_600_000), answer: { option: 'yes', by: T.userId, via: 'app', at: new Date() } });
  const tessGrant = await rel(sess.token);
  check("d: a teammate's grant on their own project does not open Om's project", tessGrant.json?.allowed === false, tessGrant.text);
  await rawDb.collection('needs').deleteMany({ ref: { $in: [9000, 9001] } });
  const a9 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Release, typed answer' });
  const d9 = await needDoc(a9.json.need.ref);
  await page.goto(`${B}/needs`);
  const box = page.locator(`[data-need="${d9.ref}"] [data-need-text]`);
  await box.waitFor({ timeout: 20000 });
  await box.fill('yes, go ahead');
  await page.locator(`[data-need="${d9.ref}"] [data-need-send]`).click();
  await new Promise(r => setTimeout(r, 1200));
  const typed = await needDoc(d9.ref);
  const afterTyped = await rel(sess.token);
  check('d: a typed answer to a release Need ("other") opens no window', typed.status === 'answered' && typed.answer.option === 'other' && !typed.releaseUntil && afterTyped.json?.allowed === false, JSON.stringify([typed.answer, afterTyped.json]));
  await ctx.close();
  await browser.close();
  const viewer = await mcpH(kT, 'needs', { project: 'H8 One', status: 'answered' });
  const seenByT = (viewer.json?.needs ?? []).find(n => n.ref === d1.ref);
  check('d: a teammate reading the answered release Need sees no window and no choice (an app-only answer is hidden)', !!seenByT && !viewer.text.includes('releaseUntil') && seenByT.answer?.option === '', viewer.text.slice(0, 300));

  // ---- e) unlinked folder, rate ----
  await rawDb.collection('workerFolders').updateOne({ _id: `${pc.id}:f1` }, { $set: { missing: true } });
  const gone = await rel(sess.token);
  check('e: a folder unlinked since the start: 404, no grant answered', gone.status === 404, `${gone.status} ${gone.text}`);
  await rawDb.collection('workerFolders').updateOne({ _id: `${pc.id}:f1` }, { $set: { missing: false } });
  const sess3 = (await call('/api/agent/start', pc.key, { ...body0, ccSession: randomUUID() })).json;
  let last = null;
  let firstBad = 0;
  for (let i = 1; i <= 61; i++) {
    last = await rel(sess3.token, { what: 'push', name: 'dev' });
    if (last.status === 429 && !firstBad) firstBad = i;
  }
  check('e: 60 checks an hour per session token, the 61st is 429 with Retry-After', firstBad === 61 && last.status === 429 && last.headers.get('retry-after') === '600', `${firstBad} ${last.status}`);
  // ---- f) the Production row, the "open until" line, looked at by eye ----
  const SHOTS = process.env.E2E_SHOTS || 'D:/Work/Delpat/builds/e2e-h8/shots';
  const browser2 = await launch();
  const open10 = await mcpH(kOm, 'ask', { project: 'H8 One', kind: 'approve', release: true, ask: 'Release H8 One to production (tag v2 and the site)' });
  const d10 = await needDoc(open10.json.need.ref);
  const variants = [['phone', 'light'], ['phone', 'dark'], ['desk', 'light'], ['desk', 'dark']];
  for (const [kind, scheme] of variants) {
    const phone = kind === 'phone';
    const c = await browser2.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } : { viewport: { width: 1280, height: 900 }, colorScheme: scheme });
    const p = await c.newPage();
    await login(p, { phone, next: '/needs' });
    // the Needs page: an open release Need beside an ordinary approve Need, and an answered one with its window
    await p.locator(`[data-need="${d10.ref}"]`).waitFor({ timeout: 20000 });
    const relLine = await p.locator(`[data-need="${d1.ref}"] [data-need-release]`).first().innerText().catch(() => '');
    check(`f: ${kind} ${scheme}: the answered release Need says its window ended (the test expired it)`, /Release ended/.test(relLine), relLine);
    const openCard = p.locator(`[data-need="${d10.ref}"]`);
    check(`f: ${kind} ${scheme}: the open release Need shows its three options like any approve Need`, (await openCard.locator('[data-need-option]').allInnerTexts()).map(t => t.split('\n')[0]).join('|') === 'Yes, release|Yes, for 24 hours|No', '');
    await openCard.scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/h8-needs-${kind}-${scheme}.png`, fullPage: false });
    const pageX = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(`f: ${kind} ${scheme}: no horizontal scroll on /needs`, pageX);
    // the project page: Production under Repository
    await p.goto(`${B}/projects/${ONE}?tab=info`);
    const row = p.locator('[data-part="production"]');
    await row.waitFor({ timeout: 20000 });
    const sum = await row.locator('[data-production-summary]').innerText();
    check(`f: ${kind} ${scheme}: the row shows the default: branches, repositories, "Default"`, /^main or master on acme\/h8-one, acme\/h8-site$/.test(sum) && /Default/.test(await row.innerText()), sum);
    const btnBox = await row.locator('[data-production-change]').boundingBox();
    check(`f: ${kind} ${scheme}: one Change button on the right, tap-sized on the phone`, !!btnBox && (!phone || btnBox.height >= 43.5) && btnBox.x > (phone ? 250 : 300), JSON.stringify(btnBox));
    await row.scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${SHOTS}/h8-project-${kind}-${scheme}.png`, fullPage: false });
    if (scheme === 'light') {
      // the sheet: change, save, switch off, back to the default (each is read back from the database and the hook's brief)
      await row.locator('[data-production-change]').click();
      const sheet = p.locator('[data-production-sheet]');
      await sheet.waitFor({ timeout: 10000 });
      await p.screenshot({ path: `${SHOTS}/h8-sheet-${kind}-${scheme}.png` });
      await sheet.getByLabel('Branches').fill('release');
      await sheet.getByLabel('Command targets').fill('prodref123');
      await sheet.locator('[data-production-save]').click();
      await p.locator('[data-production-sheet]').waitFor({ state: 'detached', timeout: 15000 });
      const set = (await rawDb.collection('projects').findOne({ _id: ONE })).production;
      check(`f: ${kind}: Save stores what was typed (remotes kept, branch release, one target) and who set it`, JSON.stringify(set) === JSON.stringify({ remotes: ['acme/h8-one', 'acme/h8-site'], branches: ['release'], targets: ['prodref123'] }) && (await one()).productionBy === ME.userId, JSON.stringify(set));
      check(`f: ${kind}: the row now reads the set value, without "Default"`, /^release on acme\/h8-one, acme\/h8-site, commands on prodref123$/.test(await row.locator('[data-production-summary]').innerText()) && /Set by you/.test(await row.innerText()));
      const brief = await mcpH(kOm, 'start_work', { project: 'H8 One' }, HOOK);
      check(`f: ${kind}: the hook's brief follows at once`, JSON.stringify(brief.json?.production) === JSON.stringify({ remotes: ['acme/h8-one', 'acme/h8-site'], branches: ['release'], targets: ['prodref123'] }), JSON.stringify(brief.json?.production));
      const f1 = await rawDb.collection('activity').find({ type: 'production', projectId: ONE, note: /^Production now:/ }).toArray();
      check(`f: ${kind}: the change is in the project feed, as the person`, f1.length >= 1 && f1[f1.length - 1].actor?.kind === 'user', JSON.stringify(f1.map(f => f.note)));
      await row.locator('[data-production-change]').click();
      await sheet.waitFor({ timeout: 10000 });
      await sheet.locator('[data-production-off]').click();
      await sheet.locator('[data-production-save]').click();
      await sheet.waitFor({ state: 'detached', timeout: 15000 });
      check(`f: ${kind}: "No production here" is stored as off and reads "none"`, (await one()).production?.off === true && (await row.locator('[data-production-summary]').innerText()) === 'none');
      const brief2 = await mcpH(kOm, 'start_work', { project: 'H8 One' }, HOOK);
      check(`f: ${kind}: off gives the hook no production at all (null)`, brief2.json && 'production' in brief2.json && brief2.json.production === null, JSON.stringify(brief2.json?.production));
      await row.locator('[data-production-change]').click();
      await sheet.waitFor({ timeout: 10000 });
      await sheet.locator('[data-production-default]').click();
      await sheet.waitFor({ state: 'detached', timeout: 15000 });
      check(`f: ${kind}: Use the default unsets it, and the default is back`, (await one()).production === undefined && /^main or master on acme\/h8-one, acme\/h8-site$/.test(await row.locator('[data-production-summary]').innerText()));
      const bad = await mcpH(kOm, 'get_project', { project: 'H8 One' });
      check(`f: ${kind}: no MCP read shows the production field (it stays in the app and the hook brief)`, !bad.isError && !bad.text.includes('productionBy'), bad.text.slice(0, 120));
    }
    await c.close();
  }
  await browser2.close();
  void TESS;
} catch (e) {
  check('flow-h8 ran to the end', false, String(e?.stack ?? e));
}
await finish();
