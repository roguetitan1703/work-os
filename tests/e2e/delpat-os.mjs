// Delpat OS import (docs/auth.md "Linking Delpat OS"): Work OS is an OAuth client of a stub Delpat OS (metadata,
// authorize, token with refresh, MCP tools/list, list_projects, get_project; run here on the discord stub's port, server
// mode delpat). Covers: link and unlink; state and PKCE enforced; import fills the fields (client missing and null);
// the duplicate guard; one member's link never used for another (also across organizations and against a copied
// row); refresh when the access token ran out (and a refused refresh token); tokens sealed in the database; member
// removal and password reset dropping links. delpat-os-off covers the feature hidden. Seed profile: none.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { B, ME, PW, check, finish, launch, login, makeUser, rawDb } from './lib.mjs';

const PORT = Number(process.env.E2E_DISCORD_PORT);
const ISSUER = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = 'cli_e2e_client';
const CLIENT_SECRET = 'e2e-delpat-client-secret-0123456789';
const REDIRECT = `${B}/api/delpat-os/callback`;
const MAIL = process.env.MAIL_CAPTURE_DIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('base64url');
/** Seals like lib/delpat-os.ts (key from BETTER_AUTH_SECRET): lets a test play "another process rotated the token". */
const seal = (plain, aad) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(hkdfSync('sha256', process.env.BETTER_AUTH_SECRET, 'work-os', 'delpat-os-tokens-v1', 32)), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
};

// ---- stub Delpat OS ----
const PROJECTS = {
  owner: [
    { id: 'dp1', title: 'Akar Billing', client: 'Acme Corp', status: 'on_track', focus: 'Ship v2 of the invoice app', myRole: 'lead', updatedAt: '2026-10-20T00:00:00Z', phases: [{ name: 'Design', status: 'completed', startDate: '2026-01-01', endDate: '2026-02-01' }, { name: 'Build', status: 'active', startDate: '2026-02-02', endDate: null }] },
    { id: 'dp2', title: 'Old Site', status: 'completed', focus: 'Done and dusted', myRole: 'member', updatedAt: '2026-09-01T00:00:00Z', phases: [] }, // no client key at all (not deployed yet)
    { id: 'dp3', title: 'Retired Tool', client: null, status: 'archived', focus: '', myRole: 'member', updatedAt: '2026-08-01T00:00:00Z', phases: [] },
    { id: 'dp4', title: 'Rework Portal', client: 'Beta Ltd', status: 'revision', focus: 'Second pass', myRole: 'lead', updatedAt: '2026-07-01T00:00:00Z', phases: [] },
    { id: 'dp6', title: 'Owner Only Secret', client: 'Hush', status: 'on_track', focus: '', myRole: 'lead', updatedAt: '2026-06-01T00:00:00Z', phases: [] },
  ],
  bea: [
    { id: 'dp1', title: 'Akar Billing', client: 'Acme Corp', status: 'on_track', focus: 'Ship v2 of the invoice app', myRole: 'member', updatedAt: '2026-10-20T00:00:00Z', phases: [] },
    { id: 'dp4', title: 'Rework Portal', client: 'Beta Ltd', status: 'revision', focus: 'Second pass', myRole: 'member', updatedAt: '2026-07-01T00:00:00Z', phases: [] },
    { id: 'dp5', title: 'Bea Only Project', client: null, status: 'on_track', focus: 'Bea work', myRole: 'lead', updatedAt: '2026-05-01T00:00:00Z', phases: [] },
  ],
  cy: [{ id: 'dp7', title: 'Cy Project', client: 'Cy Co', status: 'on_track', focus: '', myRole: 'lead', updatedAt: '2026-05-01T00:00:00Z', phases: [] }],
};
const stub = { next: 'owner', hold: false, held: null, codes: new Map(), access: new Map(), refresh: new Map(), issued: [], authorize: [], tokenCalls: [], mcp: [], n: 0, down: false, refreshDelay: 0, refreshFailNext: false, revoked: [], revokeFail: false, big: false };
const send = (s, code, body) => { s.statusCode = code; s.setHeader('content-type', 'application/json'); s.end(JSON.stringify(body)); };
function issue(subject) {
  const access = `dat_${++stub.n}_${randomBytes(12).toString('hex')}`;
  const refresh = `drt_${stub.n}_${randomBytes(12).toString('hex')}`;
  stub.access.set(access, { subject, exp: Date.now() + 3600e3 });
  stub.refresh.set(refresh, { subject, valid: true });
  stub.issued.push(access, refresh);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'mcp' };
}
const server = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => (b += d));
  q.on('end', () => {
    const url = new URL(q.url, ISSUER);
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return send(s, 200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, mcp_endpoint: `${ISSUER}/mcp`, revocation_endpoint: `${ISSUER}/revoke`, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'], scopes_supported: ['mcp'] });
    }
    if (url.pathname === '/authorize') {
      const p = Object.fromEntries(url.searchParams);
      stub.authorize.push(p);
      const bad = p.client_id !== CLIENT_ID || p.redirect_uri !== REDIRECT || p.response_type !== 'code' || p.scope !== 'mcp' || p.code_challenge_method !== 'S256' || !p.code_challenge || !p.state;
      if (bad) return send(s, 400, { error: 'invalid_request' });
      const code = `code_${randomBytes(10).toString('hex')}`;
      stub.codes.set(code, { subject: stub.next, challenge: p.code_challenge, used: false });
      stub.held = { code, state: p.state, params: p };
      if (stub.hold) return send(s, 200, { held: true });
      s.statusCode = 302;
      s.setHeader('location', `${REDIRECT}?code=${code}&state=${encodeURIComponent(p.state)}`);
      return s.end();
    }
    if (url.pathname === '/token' && q.method === 'POST') {
      const f = new URLSearchParams(b);
      const rec = { grant: f.get('grant_type'), ok: false, basic: !!q.headers.authorization };
      stub.tokenCalls.push(rec);
      if (f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== CLIENT_SECRET) return send(s, 401, { error: 'invalid_client' });
      if (rec.grant === 'authorization_code') {
        const c = stub.codes.get(f.get('code'));
        if (!c || c.used || f.get('redirect_uri') !== REDIRECT || !f.get('code_verifier') || sha(f.get('code_verifier')) !== c.challenge) return send(s, 400, { error: 'invalid_grant' });
        c.used = true;
        rec.ok = true;
        return send(s, 200, issue(c.subject));
      }
      if (rec.grant === 'refresh_token') {
        const go = () => {
          const r = stub.refresh.get(f.get('refresh_token'));
          if (stub.refreshFailNext) { stub.refreshFailNext = false; return send(s, 400, { error: 'invalid_grant' }); }
          if (!r || !r.valid) return send(s, 400, { error: 'invalid_grant' });
          r.valid = false; // rotation
          rec.ok = true;
          return send(s, 200, issue(r.subject));
        };
        return stub.refreshDelay ? setTimeout(go, stub.refreshDelay) : go();
      }
      return send(s, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/revoke' && q.method === 'POST') {
      const f = new URLSearchParams(b);
      stub.revoked.push({ token: f.get('token'), hint: f.get('token_type_hint'), secret: f.get('client_secret') === CLIENT_SECRET });
      return stub.revokeFail ? send(s, 500, {}) : send(s, 200, {});
    }
    if (url.pathname === '/mcp' && q.method === 'POST') {
      const tok = (q.headers.authorization ?? '').replace(/^Bearer /, '');
      const a = stub.access.get(tok);
      if (stub.down) return send(s, 503, {});
      if (stub.big) return send(s, 200, { pad: 'x'.repeat(2_000_000) });
      if (!a || a.exp < Date.now()) return send(s, 401, { error: 'invalid_token' });
      const m = JSON.parse(b);
      stub.mcp.push({ method: m.method, tool: m.params?.name, subject: a.subject, token: tok });
      const reply = result => send(s, 200, { jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'tools/list') return reply({ tools: [{ name: 'list_projects', inputSchema: { type: 'object' } }, { name: 'get_project', inputSchema: { type: 'object' } }, { name: 'list_meetings', inputSchema: { type: 'object' } }] });
      if (m.method === 'tools/call') {
        const mine = PROJECTS[a.subject] ?? [];
        const text = o => reply({ content: [{ type: 'text', text: JSON.stringify(o) }] });
        if (m.params.name === 'list_projects') return text(mine.map(({ phases, ...r }) => r));
        if (m.params.name === 'get_project') {
          const p = mine.find(x => x.id === m.params.arguments?.id);
          return p ? text(p) : reply({ isError: true, content: [{ type: 'text', text: 'not found' }] });
        }
      }
      return send(s, 200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
    }
    send(s, 404, {});
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

// ---- helpers ----
async function signInCookie(email) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
const linkRow = (orgId, userId) => rawDb.collection('delpatOsLinks').findOne({ _id: `${orgId}:${userId}` });
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); } return v; };
const tokenOk = () => stub.tokenCalls.filter(t => t.ok).length;
const mcpCount = () => stub.mcp.length;

async function openSettings(p) {
  await p.goto(B + '/settings?section=connections');
  await p.waitForSelector('[data-connection="delpat-os"] [data-status]', { timeout: 20000 });
}
async function startLink(p, subject, hold) {
  stub.next = subject;
  stub.hold = hold;
  stub.held = null;
  await openSettings(p);
  await p.click('[data-delpat-link]');
  if (hold) await until(() => stub.held);
  else await p.waitForURL(u => u.searchParams.get('delpat') === 'linked', { timeout: 20000 });
}
async function picker(p) {
  await p.goto(B + '/projects');
  await p.getByRole('button', { name: 'New project' }).first().click();
  await p.waitForSelector('[data-mode=delpat]', { timeout: 15000 });
  await p.click('[data-mode=delpat]');
}
async function importVia(p, id, { priv = false } = {}) {
  await picker(p);
  await p.waitForSelector(`[data-delpat-project="${id}"]`, { timeout: 15000 });
  if (priv) await p.click('[data-sharing=private]');
  await p.click(`[data-delpat-project="${id}"] [data-delpat-import]`);
  await p.waitForURL(u => /^\/projects\/.+/.test(u.pathname), { timeout: 15000 });
}
const projectOf = (orgId, delpatOsId) => rawDb.collection('projects').findOne({ orgId, delpatOsId });

const browser = await launch();
try {
  const A = ME;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await login(p);
  const Bea = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: A.orgId, role: 'member' });
  const Cy = await makeUser({ email: 'cy@example.test', name: 'Cy', orgName: 'Other Org' });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pb = await ctxB.newPage();
  await login(pb, { email: 'bea@example.test' });
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pc = await ctxC.newPage();
  await login(pc, { email: 'cy@example.test' });

  // ======== 1. not linked ========
  await openSettings(p);
  check('unlinked: Settings says not linked and offers Link', /Not linked/.test(await p.locator('[data-connection="delpat-os"] [data-status]').innerText()) && (await p.locator('[data-delpat-link]').count()) === 1);
  await picker(p);
  check('unlinked: From Delpat OS asks to link first', (await p.locator('[data-delpat-unlinked]').count()) === 1);
  check('unlinked: no Delpat OS call was made', mcpCount() === 0 && stub.tokenCalls.length === 0);

  // ======== 2. state and PKCE ========
  await startLink(p, 'owner', true);
  const h1 = stub.held;
  const ap = h1.params;
  check('authorize: sent with client id, exact redirect address, scope mcp, code response', ap.client_id === CLIENT_ID && ap.redirect_uri === REDIRECT && ap.scope === 'mcp' && ap.response_type === 'code', JSON.stringify(ap));
  check('authorize: PKCE S256 challenge and a long random state', ap.code_challenge_method === 'S256' && ap.code_challenge.length >= 43 && ap.state.length >= 40);
  const get = (cookie, st, code) => fetch(`${B}/api/delpat-os/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(st)}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const ownerCookie = (await ctx.cookies()).filter(c => c.name.startsWith('workos.')).map(c => `${c.name}=${c.value}`).join('; ');
  const beaCookie = await signInCookie('bea@example.test');
  const before = stub.tokenCalls.length;
  let r = await get(ownerCookie, 'x'.repeat(43), h1.code);
  check('state: a wrong state is refused (redirect with error, no code in it)', r.status === 303 && /delpat=error/.test(r.headers.get('location')) && !r.headers.get('location').includes(h1.code), `${r.status} ${r.headers.get('location')}`);
  check('state: the token endpoint was not called for it', stub.tokenCalls.length === before);
  check('state: no link was made', !(await linkRow(A.orgId, A.userId)));
  r = await get(beaCookie, ap.state, h1.code);
  check("state: another member presenting the owner's state is refused", r.status === 303 && /delpat=error/.test(r.headers.get('location')) && stub.tokenCalls.length === before && !(await linkRow(A.orgId, Bea.userId)) && !(await linkRow(A.orgId, A.userId)), r.headers.get('location'));
  r = await get(ownerCookie, ap.state, h1.code);
  check('state: single use (the owner\'s own state is spent too once presented)', /delpat=error/.test(r.headers.get('location')) && stub.tokenCalls.length === before);
  r = await get(null, ap.state, h1.code);
  check('state: signed out, the callback never links', [303, 307, 302, 401, 403].includes(r.status) && !(await linkRow(A.orgId, A.userId)), String(r.status));
  // expired state
  await startLink(p, 'owner', true);
  const h2 = stub.held;
  await rawDb.collection('delpatOsAuth').updateMany({ userId: A.userId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  r = await get(ownerCookie, h2.state, h2.code);
  check('state: an expired state is refused', /delpat=error/.test(r.headers.get('location')) && stub.tokenCalls.length === before);
  // The pending state is stored hashed with a sealed verifier.
  await startLink(p, 'owner', true);
  const h3 = stub.held;
  const pend = await rawDb.collection('delpatOsAuth').find({ userId: A.userId }).toArray();
  check('state: stored hashed; the verifier is sealed (neither state nor verifier in the database)', pend.length === 1 && !JSON.stringify(pend).includes(h3.state) && pend[0].verifier.startsWith('v1.'));
  // refused at Delpat OS (the person pressed Deny) comes back with error=
  r = await fetch(`${B}/api/delpat-os/callback?error=access_denied&state=${encodeURIComponent(h3.state)}`, { headers: { cookie: ownerCookie }, redirect: 'manual' });
  check('denied: an error answer links nothing', /delpat=error/.test(r.headers.get('location')) && !(await linkRow(A.orgId, A.userId)));

  // ======== 3. link ========
  await startLink(p, 'owner', false);
  check('link: through Delpat OS and back, Settings says linked', /^s*Linked/.test(await p.locator('[data-connection="delpat-os"] [data-status]').innerText()) && (await p.locator('[data-delpat-notice]').innerText()).includes('linked'));
  check('link: exactly one authorization-code exchange, with the verifier (the stub checked S256) and client_secret_post', tokenOk() === 1 && stub.tokenCalls.every(t => !t.basic));
  const row = await linkRow(A.orgId, A.userId);
  check('link: stored for this person in this organization', !!row && row.userId === A.userId && row.orgId === A.orgId);
  const dump = JSON.stringify(await Promise.all((await rawDb.listCollections({}, { nameOnly: true }).toArray()).map(async c => [c.name, await rawDb.collection(c.name).find({}).toArray()])));
  check('sealed: no token or client secret appears in any collection in plain text', !stub.issued.some(t => dump.includes(t)) && !dump.includes(CLIENT_SECRET));
  check('sealed: refresh and access are AES-GCM envelopes', row.refresh.startsWith('v1.') && row.access.startsWith('v1.') && row.refresh.split('.').length === 4);
  check('link: the address has no code or token left in it', !p.url().includes('code=') && !p.url().includes('dat_'));

  // ======== 4. import ========
  await picker(p);
  await p.waitForSelector('[data-delpat-project]', { timeout: 15000 });
  check("picker: lists the person's projects with client, status and role", (await p.locator('[data-delpat-project]').count()) === 5 && /Acme Corp/.test(await p.locator('[data-delpat-project="dp1"]').innerText()) && /lead/.test(await p.locator('[data-delpat-project="dp1"]').innerText()));
  await p.fill('input[placeholder="Search your Delpat OS projects"]', 'akar');
  check('picker: search narrows the list', (await p.locator('[data-delpat-project]').count()) === 1);
  const callsBefore = stub.mcp.length;
  await importVia(p, 'dp1');
  const p1 = await projectOf(A.orgId, 'dp1');
  check('import: name, client, status filled; shared by default', p1?.name === 'Akar Billing' && p1.client === 'Acme Corp' && p1.status === 'active' && p1.visibility === 'org' && p1.ownerId === A.userId, JSON.stringify(p1));
  check('import: description holds the focus and the phases', /Ship v2 of the invoice app/.test(p1.description) && /Phases:/.test(p1.description) && /- Design \(completed, 2026-01-01 to 2026-02-01\)/.test(p1.description) && /- Build \(active, 2026-02-02 to \?\)/.test(p1.description), p1.description);
  check('import: opened the new project', new URL(p.url()).pathname === `/projects/${p1._id}`, p.url());
  await importVia(p, 'dp2');
  const p2 = await projectOf(A.orgId, 'dp2');
  check('import: a project with no client key at all gets an empty client; completed -> done', p2?.client === '' && p2.status === 'done', JSON.stringify(p2));
  await importVia(p, 'dp3');
  const p3 = await projectOf(A.orgId, 'dp3');
  check('import: client null -> empty; archived -> archived; empty focus -> empty description', p3?.client === '' && p3.status === 'archived' && p3.description === '', JSON.stringify(p3));
  await importVia(p, 'dp4', { priv: true });
  const p4 = await projectOf(A.orgId, 'dp4');
  check('import: revision -> active; the Private choice is honoured', p4?.status === 'active' && p4.visibility === 'private', JSON.stringify(p4));
  const mine = stub.mcp.slice(callsBefore);
  const lists = mine.filter(m => m.method === 'tools/list').length;
  const calls = mine.filter(m => m.method === 'tools/call').length;
  check('mcp: tools/list is fetched fresh before every call', lists === calls && calls >= 8, `${lists} lists, ${calls} calls`);
  check('mcp: every call carried a token issued to the owner', mine.every(m => m.subject === 'owner'));

  // ======== 5. duplicate guard ========
  await picker(p);
  await p.waitForSelector('[data-delpat-project="dp1"]', { timeout: 15000 });
  check('duplicate: an imported project shows "Already in Work OS" and no Import', (await p.locator('[data-delpat-project="dp1"] [data-delpat-already]').count()) === 1 && (await p.locator('[data-delpat-project="dp1"] [data-delpat-import]').count()) === 0 && (await p.locator('[data-delpat-project="dp6"] [data-delpat-import]').count()) === 1);
  check('duplicate: its link goes to the Work OS project', (await p.locator('[data-delpat-project="dp1"] [data-delpat-already]').getAttribute('href')) === `/projects/${p1._id}`);
  await startLink(pb, 'bea', false);
  await picker(pb);
  await pb.waitForSelector('[data-delpat-project="dp1"]', { timeout: 15000 });
  check('duplicate: a teammate sees the shared import as already there', (await pb.locator('[data-delpat-project="dp1"] [data-delpat-already]').count()) === 1);
  check('duplicate: a project the owner holds privately shows as importable to her (she cannot see it)', (await pb.locator('[data-delpat-project="dp4"] [data-delpat-import]').count()) === 1);
  await pb.click('[data-delpat-project="dp4"] [data-delpat-import]');
  await pb.waitForURL(u => /^\/projects\/.+/.test(u.pathname), { timeout: 15000 });
  const d4 = await rawDb.collection('projects').find({ orgId: A.orgId, delpatOsId: 'dp4' }).toArray();
  check("squatting: the owner's private import does not block a teammate's own (a shared one)", d4.length === 2 && d4.some(x => x.ownerId === Bea.userId && x.visibility === 'org') && d4.some(x => x.ownerId === A.userId && x.visibility === 'private'), JSON.stringify(d4.map(x => [x.ownerId, x.visibility])));
  check('duplicate: one per Delpat OS id among shared projects, one per owner among private ones', (await rawDb.collection('projects').aggregate([{ $match: { delpatOsId: { $type: 'string' } } }, { $group: { _id: { o: '$orgId', d: '$delpatOsId', v: '$visibility', w: { $cond: [{ $eq: ['$visibility', 'private'] }, '$ownerId', null] } }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray()).length === 0);
  const dupIdx = (await rawDb.collection('projects').indexes()).filter(i => /delpat_os/.test(i.name));
  check('duplicate: the indexes are split like the name ones (shared per organization, private per owner)', dupIdx.length === 2 && dupIdx.every(i => i.unique && i.partialFilterExpression?.visibility), JSON.stringify(dupIdx.map(i => i.name)));
  await picker(pb);
  await pb.waitForSelector('[data-delpat-project="dp5"]', { timeout: 15000 });
  await pb.click('[data-delpat-project="dp5"] [data-delpat-import]');
  await pb.waitForURL(u => /^\/projects\/.+/.test(u.pathname), { timeout: 15000 });
  const p5 = await projectOf(A.orgId, 'dp5');
  check('import: a teammate imports her own project as herself', p5?.ownerId === Bea.userId && p5.client === '' && p5.visibility === 'org');

  // ======== 6. one person's link is never used for another ========
  await picker(pb);
  await pb.waitForSelector('[data-delpat-project]', { timeout: 15000 });
  const ids = await pb.locator('[data-delpat-project]').evaluateAll(els => els.map(e => e.getAttribute('data-delpat-project')));
  check("isolation: Bea's list holds Bea's projects only (no owner-only project)", ids.sort().join() === 'dp1,dp4,dp5', ids.join());
  check('isolation: tokens were only ever used for the person they were issued to', stub.mcp.every(m => stub.access.get(m.token)?.subject === m.subject) && stub.mcp.filter(m => m.subject === 'bea').length > 0);
  const beaRow = await linkRow(A.orgId, Bea.userId);
  check('isolation: links are keyed by organization and person', !!beaRow && beaRow._id === `${A.orgId}:${Bea.userId}` && (await rawDb.collection('delpatOsLinks').countDocuments()) === 2);
  const m0 = mcpCount();
  await picker(pc);
  check('isolation: someone in another organization with no link sees the link prompt, and nothing was called', (await pc.locator('[data-delpat-unlinked]').count()) === 1 && mcpCount() === m0);
  // A copy of Bea's stored link under Cy's key: sealed to Bea and her organization, so it opens for nobody else.
  await rawDb.collection('delpatOsLinks').insertOne({ ...beaRow, _id: `${Cy.orgId}:${Cy.userId}`, orgId: Cy.orgId, userId: Cy.userId });
  await pc.goto(B + '/projects'); // new page load: the dialog asks again
  await pc.getByRole('button', { name: 'New project' }).first().click();
  await pc.click('[data-mode=delpat]');
  await pc.waitForSelector('[data-delpat-error], [data-delpat-project]', { timeout: 15000 });
  check('isolation: a copied row does not open (no Delpat OS call, the bad row is removed)', (await pc.locator('[data-delpat-project]').count()) === 0 && mcpCount() === m0 && !(await linkRow(Cy.orgId, Cy.userId)));

  // ======== 7. refresh ========
  const t0 = tokenOk();
  const refreshBefore = (await linkRow(A.orgId, A.userId)).refresh;
  await rawDb.collection('delpatOsLinks').updateOne({ _id: `${A.orgId}:${A.userId}` }, { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } });
  await picker(p);
  await p.waitForSelector('[data-delpat-project]', { timeout: 15000 });
  const rr = stub.tokenCalls.slice(-1)[0];
  check('refresh: an expired access token is renewed with the refresh token, and the list still works', tokenOk() === t0 + 1 && rr.grant === 'refresh_token' && rr.ok);
  const rowAfter = await linkRow(A.orgId, A.userId);
  check('refresh: the rotated refresh token is stored (sealed)', rowAfter.refresh !== refreshBefore && rowAfter.refresh.startsWith('v1.') && !stub.issued.some(t => JSON.stringify(rowAfter).includes(t)));
  const t1 = tokenOk();
  await picker(p);
  await p.waitForSelector('[data-delpat-project]', { timeout: 15000 });
  check('refresh: a still-valid access token is reused (no extra token call)', tokenOk() === t1);
  // Two calls at expiry: one refresh only, the link stays, both lists work.
  const pTwo = await ctx.newPage();
  const tc = tokenOk();
  await rawDb.collection('delpatOsLinks').updateOne({ _id: `${A.orgId}:${A.userId}` }, { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } });
  stub.refreshDelay = 700;
  await Promise.all([picker(p), picker(pTwo)]);
  await Promise.all([p.waitForSelector('[data-delpat-project]', { timeout: 15000 }), pTwo.waitForSelector('[data-delpat-project]', { timeout: 15000 })]);
  stub.refreshDelay = 0;
  await pTwo.close();
  check('refresh race: two concurrent calls at expiry make one refresh, both succeed, the link stays', tokenOk() === tc + 1 && !!(await linkRow(A.orgId, A.userId)) && stub.tokenCalls.filter(t => t.grant === 'refresh_token' && !t.ok).length === 0);
  // Another process rotated the token while ours was in flight and ours was refused: the link must survive.
  const lidA = `${A.orgId}:${A.userId}`;
  await rawDb.collection('delpatOsLinks').updateOne({ _id: lidA }, { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } });
  stub.refreshDelay = 900;
  stub.refreshFailNext = true;
  const n0 = stub.tokenCalls.length;
  const inflight = picker(p);
  await until(() => stub.tokenCalls.length > n0, 10000);
  const other = (() => { const acc = `dat_other_${randomBytes(6).toString('hex')}`, ref = `drt_other_${randomBytes(6).toString('hex')}`; stub.access.set(acc, { subject: 'owner', exp: Date.now() + 3600e3 }); stub.refresh.set(ref, { subject: 'owner', valid: true }); return { acc, ref }; })();
  await rawDb.collection('delpatOsLinks').updateOne({ _id: lidA }, { $set: { refresh: seal(other.ref, `refresh:${lidA}`), access: seal(other.acc, `access:${lidA}`), accessExpiresAt: new Date(Date.now() + 3600e3), updatedAt: new Date() } });
  await inflight;
  await p.waitForSelector('[data-delpat-project], [data-delpat-error]', { timeout: 15000 });
  stub.refreshDelay = 0;
  check('refresh race: a refusal of a token someone else already rotated does not drop the link, and the new token is used', !!(await linkRow(A.orgId, A.userId)) && (await p.locator('[data-delpat-project]').count()) > 0 && stub.mcp.slice(-1)[0].token === other.acc);
  // A huge answer from Delpat OS is refused (body capped at 1 MB) and keeps the link.
  stub.big = true;
  await picker(p);
  await p.waitForSelector('[data-delpat-error]', { timeout: 15000 });
  stub.big = false;
  check('body cap: a 2 MB answer is refused with a plain error and the link stays', /too much|could not/i.test(await p.locator('[data-delpat-error]').innerText()) && !!(await linkRow(A.orgId, A.userId)));
  // Delpat OS no longer accepts the refresh token (revoked there).
  for (const v of stub.refresh.values()) v.valid = false;
  await rawDb.collection('delpatOsLinks').updateOne({ _id: `${A.orgId}:${A.userId}` }, { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } });
  await picker(p);
  await p.waitForSelector('[data-delpat-error]', { timeout: 15000 });
  check('refresh: a refused refresh token says to link again and drops the link', /Link it again/.test(await p.locator('[data-delpat-error]').innerText()) && !(await linkRow(A.orgId, A.userId)));
  await openSettings(p);
  check('refresh: Settings then shows Not linked', /Not linked/.test(await p.locator('[data-connection="delpat-os"] [data-status]').innerText()));
  // Delpat OS down: the link stays.
  await startLink(p, 'owner', false);
  stub.down = true;
  await rawDb.collection('delpatOsLinks').updateOne({ _id: `${A.orgId}:${A.userId}` }, { $set: { accessExpiresAt: new Date(Date.now() - 60_000) } });
  await picker(p);
  await p.waitForSelector('[data-delpat-error]', { timeout: 15000 });
  stub.down = false;
  check('down: an unreachable Delpat OS gives a plain error and keeps the link', !!(await linkRow(A.orgId, A.userId)));

  // ======== 8. unlink ========
  await openSettings(p);
  const ownerRefresh = [...stub.refresh].filter(([, r]) => r.subject === 'owner' && r.valid).pop()?.[0];
  stub.revokeFail = true; // a failing revocation endpoint must not stop the unlink
  await p.click('[data-delpat-unlink]');
  await until(async () => !(await linkRow(A.orgId, A.userId)));
  await until(() => stub.revoked.some(r => r.token === ownerRefresh), 8000);
  stub.revokeFail = false;
  check('unlink: the refresh token is also revoked upstream (best effort; a failing endpoint did not block the unlink)', !!ownerRefresh && stub.revoked.some(r => r.token === ownerRefresh && r.hint === 'refresh_token' && r.secret));
  check('unlink: the stored tokens are deleted', !(await linkRow(A.orgId, A.userId)));
  await p.waitForSelector('[data-delpat-link]', { timeout: 10000 });
  const m1 = mcpCount();
  await picker(p);
  check('unlink: From Delpat OS asks to link again and calls nothing', (await p.locator('[data-delpat-unlinked]').count()) === 1 && mcpCount() === m1);

  // ======== 9. removal and password reset drop links ========
  await startLink(pc, 'cy', false);
  const cyRefresh = [...stub.refresh].filter(([, r]) => r.subject === 'cy' && r.valid).pop()?.[0];
  check('cy: linked in her own organization', !!(await linkRow(Cy.orgId, Cy.userId)));
  const since = Date.now() - 1000;
  const rq = await fetch(B + '/api/auth/request-password-reset', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'cy@example.test', redirectTo: '/login/reset' }) });
  let token = '';
  for (let i = 0; i < 40 && !token; i++) {
    const files = fs.existsSync(MAIL) ? fs.readdirSync(MAIL).filter(f => f.endsWith('.json')) : [];
    for (const f of files) {
      const m = JSON.parse(fs.readFileSync(path.join(MAIL, f), 'utf8'));
      if (m.to === 'cy@example.test' && Date.parse(m.at) >= since) token = m.text.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1] ?? token;
    }
    if (!token) await sleep(250);
  }
  check('reset: asked and mailed', rq.status === 200 && !!token);
  const rs = await fetch(B + '/api/auth/reset-password', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ newPassword: 'brand-new-password-456', token }) });
  check('reset: the password was reset', rs.status === 200, String(rs.status));
  check('reset: her Delpat OS link is gone', !!(await until(async () => !(await linkRow(Cy.orgId, Cy.userId)), 8000)));
  check('reset: and revoked upstream', !!(await until(() => stub.revoked.some(r => r.token === cyRefresh), 8000)));

  check("removal: Bea's link exists before", !!(await linkRow(A.orgId, Bea.userId)));
  const beaRefresh = [...stub.refresh].filter(([, r]) => r.subject === 'bea').pop()?.[0];
  await p.goto(B + '/settings?section=members');
  await p.waitForSelector('button[aria-label="Remove bea@example.test"]', { timeout: 15000 });
  await p.click('button[aria-label="Remove bea@example.test"]');
  await p.click('[data-remove-confirm="bea@example.test"] button:has-text("Remove")');
  check('removal: removing the member deletes her link', !!(await until(async () => !(await linkRow(A.orgId, Bea.userId)), 15000)));
  check('removal: and revokes it upstream', !!(await until(() => stub.revoked.some(r => r.token === beaRefresh), 8000)));
  check("removal: the owner's imported projects were not touched", !!(await projectOf(A.orgId, 'dp1')));
} catch (e) {
  check('suite error', false, e?.stack || String(e));
}
await browser.close();
server.close();
await finish();
