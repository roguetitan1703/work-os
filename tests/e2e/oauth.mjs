// OAuth sign-in for MCP clients (docs/auth.md "Connecting Claude with OAuth"): the MCP authorization flow end to end with a
// scripted client, as claude.ai and Claude Code run it. Discovery (401 + WWW-Authenticate, protected-resource and
// authorization-server metadata), dynamic client registration (and what it refuses), authorization code + PKCE (S256 only)
// through the real sign-in and consent pages in a browser, token exchange, tools/list and scoped tool calls with the token,
// refresh with rotation, reuse detection, revocation (endpoint and Settings), removed members, other organizations, the
// claude / claude-code split, deny, tampered requests and routes that must not be served.
// Seed profile: none (this suite makes its own people and data).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { B, EMAIL, ME, MCP, PW, SP, check, finish, launch, makeUser, mkKey, okO, overflow, rawDb } from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64u = b => Buffer.from(b).toString('base64url');
const MCP_URL = `${B}/api/mcp`;
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
let rid = 0;

// ---- the scripted client ----
const post = (path, body, json = true) =>
  fetch(B + path, { method: 'POST', headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' }, body: json ? JSON.stringify(body) : new URLSearchParams(body).toString() }).then(async r => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const register = body => post('/api/auth/oauth2/register', body);
const pkce = () => {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
};
const authUrl = (c, { redirect, challenge, state = b64u(randomBytes(8)), scope = 'workos offline_access', resource = MCP_URL, method = 'S256', extra = {} }) => {
  const q = new URLSearchParams({ response_type: 'code', client_id: c.client_id, redirect_uri: redirect, scope, state, resource, ...(challenge ? { code_challenge: challenge, code_challenge_method: method } : {}), ...extra });
  return { url: `${B}/api/auth/oauth2/authorize?${q}`, state };
};
const exchange = (c, { code, redirect, verifier, resource = MCP_URL }) =>
  post('/api/auth/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: c.client_id, code_verifier: verifier, ...(resource ? { resource } : {}) }, false);
const refresh = (c, rt) => post('/api/auth/oauth2/token', { grant_type: 'refresh_token', refresh_token: rt, client_id: c.client_id, resource: MCP_URL }, false);
const mcp = (token, method = 'tools/list', params = {}) =>
  fetch(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) }).then(async r => {
    const t = await r.text();
    const line = t.split('\n').find(l => l.startsWith('data:'));
    let b = null;
    try { b = JSON.parse(line ? line.slice(5) : t); } catch { /* not json */ }
    const text = b?.result?.content?.[0]?.text ?? '';
    let json = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, headers: r.headers, b, text, json, isError: !!b?.result?.isError || !!b?.error };
  });
const tool = (token, name, args = {}) => mcp(token, 'tools/call', { name, arguments: args });
const status = token => mcp(token).then(r => r.status);

/**
 * The browser half: opens the authorization request in this context (signing in first when it has no session), answers the
 * consent screen, and returns the address the app was sent to. Redirects to the app's own addresses are caught, not followed.
 */
async function approve(ctx, url, { allow = true, callback, email = EMAIL } = {}) {
  const page = await ctx.newPage();
  // The browser cannot reach any other site (launch() below): the app's own address is only noted when the browser asks for it.
  let landed = null;
  page.on('request', r => { if (r.url().startsWith(callback)) landed ??= r.url(); });
  const path = () => { try { return new URL(page.url()).pathname; } catch { return ''; } };
  const until = async (ok, what) => {
    for (let i = 0; i < 100 && !landed && !ok(); i++) await sleep(200);
    if (!landed && !ok()) throw new Error(`approve: stuck waiting for ${what} at ${page.url()} :: ${(await page.locator('body').innerText().catch(() => '')).slice(0, 300)}`);
  };
  await page.goto(url).catch(() => {});
  await until(() => path().startsWith('/login') || path().startsWith('/oauth/consent') || /\/api\/auth\/error/.test(path()), 'login or consent');
  let sawLogin = false;
  if (!landed && path().startsWith('/login')) {
    sawLogin = true;
    await page.waitForSelector('form button[type=submit]:not([disabled])', { timeout: 20000 });
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', PW);
    await page.click('button[type=submit]');
    await until(() => path().startsWith('/oauth/consent') || /\/api\/auth\/error/.test(path()), 'consent after sign-in');
  }
  let consent = null;
  if (!landed && path().startsWith('/oauth/consent')) {
    await page.waitForSelector('[data-oauth-consent]', { timeout: 15000 });
    consent = {
      text: await page.locator('[data-oauth-consent]').innerText(),
      allowDisabledAtLoad: await page.locator('[data-consent=allow]').isDisabled(),
      client: (await page.locator('[data-consent-client]').count()) ? await page.locator('[data-consent-client]').innerText() : null,
      org: (await page.locator('[data-consent-org]').count()) ? await page.locator('[data-consent-org]').innerText() : null,
      host: (await page.locator('[data-consent-host]').count()) ? await page.locator('[data-consent-host]').innerText() : null,
      url: page.url(),
    };
    if (consent.client) {
      await page.click(allow ? '[data-consent=allow]' : '[data-consent=deny]');
      await until(() => false, 'the redirect to the app');
    }
  }
  const final = landed ?? page.url();
  await page.close();
  const u = new URL(final);
  return { sawLogin, consent, final, code: u.searchParams.get('code'), state: u.searchParams.get('state'), iss: u.searchParams.get('iss'), error: u.searchParams.get('error'), errorPath: u.pathname };
}

/** Register, authorize in the browser and exchange: a connected app. */
async function connect(ctx, { name = 'Claude', redirects = [CLAUDE_CB], redirect = redirects[0], callback = redirect.split('?')[0].replace(/:\d+/, ''), email = EMAIL, extraReg = {} } = {}) {
  const reg = await register({ client_name: name, redirect_uris: redirects, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extraReg });
  const c = reg.body;
  if (!c?.client_id) return { reg };
  const p = pkce();
  const a = authUrl(c, { redirect, challenge: p.challenge });
  const r = await approve(ctx, a.url, { callback, email });
  if (!r.code) return { reg, c, r, a };
  const t = await exchange(c, { code: r.code, redirect, verifier: p.verifier });
  return { reg, c, r, a, p, t, access: t.body?.access_token, refreshTok: t.body?.refresh_token };
}

/** An authorization request as a browser navigation sends it (a redirect, not a JSON body): the address it redirects to, or null. */
const navigate = async (url, cookie = '') => {
  const r = await fetch(url, { redirect: 'manual', headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html', ...(cookie ? { cookie } : {}) } });
  const j = r.status === 200 ? await r.json().catch(() => null) : null;
  return { status: r.status, location: r.headers.get('location') ?? j?.url ?? null };
};
const hostOnly = u => new URL(u).host;
// Every address outside this computer is unreachable (the redirects to claude.ai and the like are noted, never followed).
const browser = await launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
try {
  const A = ME;
  const kA = MCP;
  // Data: the owner's organization and another one's, so isolation can be seen.
  const must = async (key, name, args) => {
    const r = await tool(key, name, args);
    if (r.isError) throw new Error(`${name}: ${r.text}`);
    return r.json;
  };
  const aTask = (await must(kA, 'add_task', { title: 'OAuth Alpha task' })).created;
  const Cy = await makeUser({ email: 'cy@example.test', name: 'Cy', orgName: 'Cy Org' });
  const kCy = await mkKey({ agent: 'claude', userId: Cy.userId, orgId: Cy.orgId, name: 'cy chat' });
  const cyTask = (await must(kCy, 'add_task', { title: 'Cy secret task' })).created;
  const Rex = await makeUser({ email: 'rex@example.test', name: 'Rex', orgId: A.orgId, role: 'member' });

  // ======== 1. discovery ========
  const un = await mcp(null);
  const wa = un.headers.get('www-authenticate') ?? '';
  check('discovery: /api/mcp without a token answers 401', un.status === 401, String(un.status));
  check('discovery: the 401 names the protected-resource metadata (Bearer resource_metadata=…)', /^Bearer .*resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource[^"]*"/.test(wa), wa);
  const bad = await mcp('wosat_' + 'x'.repeat(40));
  check('discovery: an unknown token is 401 with invalid_token', bad.status === 401 && /invalid_token/.test(bad.headers.get('www-authenticate') ?? ''), bad.headers.get('www-authenticate') ?? '');
  check('discovery: GET /api/mcp without a token is 401 with the same header', await fetch(MCP_URL).then(r => r.status === 401 && /resource_metadata=/.test(r.headers.get('www-authenticate') ?? '')));
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wa)?.[1] ?? '';
  const prm = await fetch(prmUrl).then(r => r.json()).catch(() => null);
  const prmRoot = await fetch(`${B}/.well-known/oauth-protected-resource`).then(r => r.json()).catch(() => null);
  check('discovery: protected resource metadata: resource is exactly the MCP address', prm?.resource === MCP_URL && prmRoot?.resource === MCP_URL, JSON.stringify(prm));
  check('discovery: it lists one authorization server (the issuer) and scope workos', Array.isArray(prm?.authorization_servers) && prm.authorization_servers.length === 1 && prm.authorization_servers[0] === `${B}/api/auth` && prm.scopes_supported?.includes('workos'), JSON.stringify(prm));
  check('discovery: other well-known paths are 404', (await fetch(`${B}/.well-known/oauth-protected-resource/api/other`)).status === 404);
  const asm = await fetch(`${prm?.authorization_servers?.[0] ? new URL(prm.authorization_servers[0]).origin : B}/.well-known/oauth-authorization-server/api/auth`).then(r => r.json()).catch(() => null);
  const asmRoot = await fetch(`${B}/.well-known/oauth-authorization-server`).then(r => r.json()).catch(() => null);
  check('discovery: authorization server metadata at the RFC path form and at the root', asm?.issuer === `${B}/api/auth` && asmRoot?.issuer === asm?.issuer, JSON.stringify(asm).slice(0, 200));
  check('discovery: endpoints are the ones this site serves', asm?.authorization_endpoint === `${B}/api/auth/oauth2/authorize` && asm?.token_endpoint === `${B}/api/auth/oauth2/token` && asm?.registration_endpoint === `${B}/api/auth/oauth2/register` && asm?.revocation_endpoint === `${B}/api/auth/oauth2/revoke`, JSON.stringify(asm).slice(0, 300));
  check('discovery: S256 only, public clients, code and refresh grants', JSON.stringify(asm?.code_challenge_methods_supported) === '["S256"]' && asm?.token_endpoint_auth_methods_supported?.includes('none') && asm?.grant_types_supported?.includes('authorization_code') && asm?.grant_types_supported?.includes('refresh_token') && !asm?.grant_types_supported?.includes('client_credentials'), JSON.stringify(asm).slice(0, 400));
  check('discovery: offline_access is listed (Claude adds it to get a refresh token)', asm?.scopes_supported?.includes('offline_access') && asm?.scopes_supported?.includes('workos'), JSON.stringify(asm?.scopes_supported));
  check('discovery: no introspection or userinfo endpoint is advertised', !asm?.introspection_endpoint && !asm?.userinfo_endpoint, JSON.stringify(asm).slice(0, 400));

  // ======== 2. dynamic client registration ========
  const good = await register({ client_name: 'Claude', redirect_uris: [CLAUDE_CB], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  check('register: a hosted-Claude client registers (201, client_id, no secret)', (good.status === 201 || good.status === 200) && !!good.body?.client_id && !good.body?.client_secret, JSON.stringify(good.body)?.slice(0, 300));
  const noUris = await register({ client_name: 'x' });
  const httpEvil = await register({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] });
  const jsUri = await register({ client_name: 'x', redirect_uris: ['javascript:alert(1)'] });
  const custom = await register({ client_name: 'x', redirect_uris: ['myapp://callback'] });
  const frag = await register({ client_name: 'x', redirect_uris: ['https://example.com/cb#frag'] });
  const cred = await register({ client_name: 'x', redirect_uris: ['https://user:pw@example.com/cb'] });
  check('register: no redirect addresses, http to another host, javascript:, a custom scheme, a fragment, credentials are all refused', [noUris, httpEvil, jsUri, custom, frag, cred].every(r => r.status === 400), [noUris, httpEvil, jsUri, custom, frag, cred].map(r => r.status).join(','));
  const sneaky = await register({ client_name: 'Sneaky', redirect_uris: ['https://example.com/cb'], token_endpoint_auth_method: 'client_secret_post', backchannel_logout_uri: 'http://127.0.0.1:1/logout', jwks_uri: 'http://127.0.0.1:1/jwks', logo_uri: 'http://127.0.0.1:1/logo.png', software_statement: 'a.b.c', skip_consent: true });
  const sneakyRow = sneaky.body?.client_id ? await rawDb.collection('oauthClient').findOne({ clientId: sneaky.body.client_id }) : null;
  check('register: it is always a public client; server-fetching fields are dropped', (sneaky.status === 201 || sneaky.status === 200) && !sneaky.body?.client_secret && !sneakyRow?.backchannelLogoutUri && !sneakyRow?.jwksUri && !sneakyRow?.logo && !sneakyRow?.softwareStatement && !sneakyRow?.skipConsent && (sneakyRow?.tokenEndpointAuthMethod ?? 'none') === 'none', JSON.stringify([sneaky.status, sneaky.body, sneakyRow && Object.keys(sneakyRow)]).slice(0, 400));
  const huge = await register({ client_name: 'x', redirect_uris: ['https://example.com/cb'], contacts: ['a'.repeat(9000)] });
  check('register: an oversized request is refused', huge.status === 400, String(huge.status));
  check('register: a client with a loopback address (Claude Code) registers', (await register({ client_name: 'Claude Code', redirect_uris: ['http://localhost:3118/callback'] })).body?.client_id !== undefined);
  check('register: only POST (GET is 404)', (await fetch(`${B}/api/auth/oauth2/register`)).status === 404);

  // ======== 3. the flow, in a real browser, as the owner ========
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const flow = await connect(ctxA, { name: 'Claude' });
  check('flow: signed out, the request goes to the sign-in page first', flow.r?.sawLogin === true);
  check('flow: the consent screen names the app, the person, the organization and where it goes', !!flow.r?.consent && flow.r.consent.client === 'Claude' && flow.r.consent.org === 'E2E Org' && /E2E Owner/.test(flow.r.consent.text) && flow.r.consent.host === 'claude.ai', JSON.stringify(flow.r?.consent)?.slice(0, 400));
  check('flow: the screen says the name is not verified', /Not verified/.test(flow.r?.consent?.text ?? ''));
  check('flow: Allow sends the browser to the registered address with a code, the same state and the issuer', !!flow.r?.code && flow.r.state === flow.a?.state && flow.r.iss === `${B}/api/auth`, flow.r?.final);
  check('flow: token exchange with PKCE gives an access token, a refresh token, Bearer, 1 hour', flow.t?.status === 200 && flow.access?.startsWith('wosat_') && flow.refreshTok?.startsWith('wosrt_') && String(flow.t.body.token_type).toLowerCase() === 'bearer' && flow.t.body.expires_in <= 3600 && flow.t.body.expires_in > 3000, JSON.stringify(flow.t?.body)?.slice(0, 300));
  const rawAccess = flow.access?.slice('wosat_'.length) ?? '';
  const rawRefresh = flow.refreshTok?.slice('wosrt_'.length) ?? '';
  const atRows = await rawDb.collection('oauthAccessToken').find({}).toArray();
  const rtRows = await rawDb.collection('oauthRefreshToken').find({}).toArray();
  check('tokens: stored hashed, never in clear', rawAccess.length > 20 && atRows.length > 0 && !atRows.some(r => r.token === rawAccess) && !rtRows.some(r => r.token === rawRefresh) && JSON.stringify(atRows).indexOf(rawAccess) < 0 && JSON.stringify(rtRows).indexOf(rawRefresh) < 0);
  const atRow = atRows.find(r => r.clientId === flow.c.client_id);
  check('tokens: bound to the person and the organization, the MCP address and the workos scope', !!atRow && String(atRow.userId) === A.userId && String(atRow.referenceId) === A.orgId && atRow.resources?.includes(MCP_URL) && atRow.scopes?.includes('workos'), JSON.stringify(atRow));
  check('tokens: the browser session is not needed (no Work OS cookie goes to the app)', !/workos\.session/.test(JSON.stringify(flow.t?.body ?? {})));

  // ---- the token on /api/mcp ----
  const list = await mcp(flow.access);
  const names = (list.b?.result?.tools ?? []).map(t => t.name);
  check('mcp: tools/list with the OAuth token works and lists the tools', list.status === 200 && names.includes('add_task') && names.includes('list_tasks'), `${list.status} ${names.length}`);
  const mine = await tool(flow.access, 'list_tasks', {});
  check('mcp: a scoped tool shows the owner\'s data and not another organization\'s', mine.status === 200 && /OAuth Alpha task/.test(mine.text) && !/Cy secret task/.test(mine.text), mine.text.slice(0, 200));
  const cyGet = await tool(flow.access, 'get_task', { task: cyTask.ref });
  check('mcp: another organization\'s task is not reachable by its reference', cyGet.isError || !/Cy secret task/.test(cyGet.text), cyGet.text.slice(0, 150));
  const made = await tool(flow.access, 'add_task', { title: 'Made over OAuth' });
  const madeDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, title: 'Made over OAuth' });
  const actor = madeDoc?.createdBy;
  check('mcp: what the token writes is recorded as Claude under the person (same as a chat key)', !made.isError && actor?.kind === 'agent' && actor?.agent === 'claude' && String(actor?.userId) === A.userId, JSON.stringify(actor));
  const viaKey = await tool(kA, 'add_task', { title: 'Made over a key' });
  const keyActor = (await rawDb.collection('tasks').findOne({ orgId: A.orgId, title: 'Made over a key' }))?.createdBy;
  check('mcp: identical to the chat key\'s record', !viaKey.isError && JSON.stringify({ ...actor, at: 0 }) === JSON.stringify({ ...keyActor, at: 0 }), JSON.stringify([actor, keyActor]));
  const usage = await rawDb.collection('policyEvents').countDocuments({ keyId: { $regex: '^oauth_' } });
  check('mcp: a chat-agent token has no Claude Code call limits recorded', usage === 0, String(usage));
  check('mcp: the old key still works next to it', (await status(kA)) === 200);

  // ---- PKCE, redirect and request checks ----
  const p2 = pkce();
  const bare = await register({ client_name: 'Claude', redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: 'none' });
  const noPkce = await navigate(authUrl(bare.body, { redirect: CLAUDE_CB }).url);
  check('pkce: an authorization request without a code challenge is refused (error to the app, no code)', /error=/.test(noPkce.location ?? '') && !/code=/.test(noPkce.location ?? ''), `${noPkce.status} ${noPkce.location}`);
  const plain = await navigate(authUrl(bare.body, { redirect: CLAUDE_CB, challenge: p2.verifier, method: 'plain' }).url);
  check('pkce: the plain method is refused (S256 only)', /error=/.test(plain.location ?? '') && !/code=/.test(plain.location ?? ''), `${plain.status} ${plain.location}`);
  const wrongRedirect = await navigate(authUrl(bare.body, { redirect: 'https://claude.ai/api/mcp/auth_callback/../evil', challenge: p2.challenge }).url);
  const wrongLoc = wrongRedirect.location ?? '';
  check('redirect: an address that is not exactly the registered one is never redirected to (no open redirect)', !wrongLoc.startsWith('https://claude.ai') && !/evil/.test(wrongLoc), `${wrongRedirect.status} ${wrongLoc}`);
  const otherHost = await navigate(authUrl(bare.body, { redirect: 'https://evil.example/cb', challenge: p2.challenge }).url);
  check('redirect: another host is not redirected to', !(otherHost.location ?? '').startsWith('https://evil.example'), `${otherHost.status} ${otherHost.location}`);
  const badRes = await navigate(authUrl(bare.body, { redirect: CLAUDE_CB, challenge: p2.challenge, resource: 'https://evil.example/mcp' }).url);
  check('resource: a token for another resource is refused', /error=/.test(badRes.location ?? '') && !/code=/.test(badRes.location ?? ''), `${badRes.status} ${badRes.location}`);
  const badScope = await navigate(authUrl(bare.body, { redirect: CLAUDE_CB, challenge: p2.challenge, scope: 'workos admin' }).url);
  check('scope: an unknown scope is refused', /error=/.test(badScope.location ?? '') && !/code=/.test(badScope.location ?? ''), `${badScope.status} ${badScope.location}`);

  // a code with the wrong verifier, and a replayed code
  const p3 = pkce();
  const a3 = authUrl(bare.body, { redirect: CLAUDE_CB, challenge: p3.challenge });
  const r3 = await approve(ctxA, a3.url, { callback: 'https://claude.ai/api/mcp/auth_callback' });
  check('consent: a second app needs its own consent (screen shown, never skipped)', !!r3.consent?.client && !!r3.code, JSON.stringify(r3.consent)?.slice(0, 200));
  const wrongV = await exchange(bare.body, { code: r3.code, redirect: CLAUDE_CB, verifier: pkce().verifier });
  check('pkce: a wrong code verifier is refused (invalid_grant)', wrongV.status === 400 && wrongV.body?.error === 'invalid_grant', JSON.stringify(wrongV.body));
  const retry = await exchange(bare.body, { code: r3.code, redirect: CLAUDE_CB, verifier: p3.verifier });
  check('pkce: the code was used up by the failed try (single use)', retry.status === 400, JSON.stringify(retry.body));
  // replay of a good code
  const a4 = authUrl(bare.body, { redirect: CLAUDE_CB, challenge: p3.challenge });
  const r4 = await approve(ctxA, a4.url, { callback: 'https://claude.ai/api/mcp/auth_callback' });
  check('consent: an approved app is not asked again for the same organization', r4.consent === null && !!r4.code, JSON.stringify(r4.consent)?.slice(0, 120));
  const t4 = await exchange(bare.body, { code: r4.code, redirect: CLAUDE_CB, verifier: p3.verifier });
  const t4b = await exchange(bare.body, { code: r4.code, redirect: CLAUDE_CB, verifier: p3.verifier });
  check('code: used twice is refused', t4.status === 200 && t4b.status === 400, `${t4.status} ${t4b.status}`);
  check('code: a replay revokes what the first use issued', (await status(t4.body?.access_token)) === 401);
  const wrongRedirectTok = await (async () => {
    const r = await approve(ctxA, authUrl(bare.body, { redirect: CLAUDE_CB, challenge: p3.challenge }).url, { callback: 'https://claude.ai/api/mcp/auth_callback' });
    return exchange(bare.body, { code: r.code, redirect: 'https://claude.ai/api/mcp/other', verifier: p3.verifier });
  })();
  check('token: a different redirect address at the token step is refused', wrongRedirectTok.status === 400, JSON.stringify(wrongRedirectTok.body));
  const junk = await post('/api/auth/oauth2/token', { grant_type: 'authorization_code', code: 'nope', redirect_uri: CLAUDE_CB, client_id: bare.body.client_id, code_verifier: p3.verifier }, false);
  check('token: junk code is invalid_grant', junk.status === 400 && junk.body?.error === 'invalid_grant', JSON.stringify(junk.body));
  const cc = await post('/api/auth/oauth2/token', { grant_type: 'client_credentials', client_id: bare.body.client_id }, false);
  check('token: client_credentials is not offered', cc.status >= 400, JSON.stringify(cc.body));
  const jsonTok = await post('/api/auth/oauth2/token', { grant_type: 'refresh_token', refresh_token: 'x', client_id: bare.body.client_id }, true);
  check('token: the token endpoint answers JSON errors, never an HTML page', jsonTok.status >= 400 && !!jsonTok.body, String(jsonTok.status));

  // ======== 4. refresh, rotation, reuse detection ========
  const sibling = await connect(ctxA, { name: 'Claude' });
  const rt1 = flow.refreshTok;
  const ref1 = await refresh(flow.c, rt1);
  check('refresh: a refresh token gives a new access token and a new refresh token', ref1.status === 200 && ref1.body?.access_token?.startsWith('wosat_') && ref1.body?.refresh_token?.startsWith('wosrt_') && ref1.body.refresh_token !== rt1 && ref1.body.access_token !== flow.access, JSON.stringify(ref1.body)?.slice(0, 200));
  check('refresh: the new access token works on /api/mcp', (await status(ref1.body?.access_token)) === 200);
  const ref2 = await refresh(flow.c, ref1.body.refresh_token);
  check('refresh: rotates again', ref2.status === 200 && ref2.body?.refresh_token !== ref1.body?.refresh_token, String(ref2.status));
  const reuse = await refresh(flow.c, rt1);
  check('reuse: an old (rotated) refresh token is refused as invalid_grant', reuse.status === 400 && reuse.body?.error === 'invalid_grant', JSON.stringify(reuse.body));
  const afterReuse = await refresh(flow.c, ref2.body.refresh_token);
  check('reuse: that revoked the whole family: the newest refresh token is dead too', afterReuse.status === 400, String(afterReuse.status));
  check('reuse: and the access tokens of the family stop', (await status(ref2.body.access_token)) === 401 && (await status(ref1.body.access_token)) === 401);
  check('reuse: another app\'s tokens (same person) are not touched', (await status(sibling.access)) === 200);

  // ======== 5. revocation: the endpoint ========
  const flow2 = await connect(ctxA, { name: 'Claude' });
  check('revoke: a fresh connection works', !!flow2.access && (await status(flow2.access)) === 200);
  const rev = await post('/api/auth/oauth2/revoke', { token: flow2.access, token_type_hint: 'access_token', client_id: flow2.c.client_id }, false);
  check('revoke: the revocation endpoint accepts the token', rev.status === 200, `${rev.status} ${JSON.stringify(rev.body)}`);
  check('revoke: the access token stops at once', (await status(flow2.access)) === 401);
  const revR = await post('/api/auth/oauth2/revoke', { token: flow2.refreshTok, token_type_hint: 'refresh_token', client_id: flow2.c.client_id }, false);
  const afterRevoke = await refresh(flow2.c, flow2.refreshTok);
  check('revoke: a revoked refresh token cannot be used', (revR.status === 200 || revR.status === 400) && afterRevoke.status === 400, `${revR.status} ${afterRevoke.status}`);

  // ======== 6. Settings: list, last used, revoke ========
  const flow3 = await connect(ctxA, { name: 'Claude' });
  const flow3b = await connect(ctxA, { name: 'Claude Desktop (test)', redirects: ['https://claude.ai/api/mcp/auth_callback'] });
  await tool(flow3.access, 'list_tasks', {});
  const ps = await ctxA.newPage();
  await ps.goto(B + '/claude?tab=setup');
  await ps.waitForSelector('[data-authorized-apps]', { timeout: 20000 });
  const appsText = await ps.locator('[data-authorized-apps]').innerText();
  check('Set up: lists authorized apps with name, when connected and last used', /Claude/.test(appsText) && /Claude Desktop \(test\)/.test(appsText) && /used/i.test(appsText), appsText.slice(0, 300));
  check('settings: Connect Claude is the main path (the URL to add, no key needed)', (await ps.locator('[data-connect-claude]').innerText()).includes(MCP_URL), await ps.locator('[data-connect-claude]').innerText().catch(() => ''));
  const advanced = ps.locator('[data-advanced-keys]');
  check('settings: access keys are under Advanced', (await advanced.count()) === 1 && /Access keys/i.test(await advanced.first().textContent()));
  await ps.screenshot({ path: SP + '/oauth-settings-desktop.png', fullPage: true });
  await ps.setViewportSize({ width: 390, height: 800 });
  check('settings: phone: no sideways scroll', okO(await overflow(ps)), JSON.stringify(await overflow(ps)));
  await ps.screenshot({ path: SP + '/oauth-settings-phone.png', fullPage: true });
  await ps.setViewportSize({ width: 1280, height: 900 });
  await ps.click(`button[aria-label="Revoke Claude Desktop (test)"]`);
  await ps.click('[data-confirm]');
  await sleep(1200);
  const stillThere = await ps.locator('[data-authorized-apps]').innerText();
  check('settings: Revoke removes the app from the list', !/Claude Desktop \(test\)/.test(stillThere), stillThere.slice(0, 200));
  check('settings: and its token stops at once', (await status(flow3b.access)) === 401);
  check('settings: other apps are untouched', (await status(flow3.access)) === 200);
  await ps.close();

  // ======== 7. Claude Code: loopback, any port, stricter rules ========
  const ctxCode = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const regCode = await register({ client_name: 'Claude Code (work-os)', redirect_uris: ['http://localhost:3118/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  const pc = pkce();
  const redirectOtherPort = 'http://localhost:54321/callback';
  const aCode = authUrl(regCode.body, { redirect: redirectOtherPort, challenge: pc.challenge });
  const rc = await approve(ctxCode, aCode.url, { callback: 'http://localhost:54321/callback' });
  check('code: a loopback client may use another port than it registered (RFC 8252)', !!rc.code && rc.final.startsWith('http://localhost:54321/callback'), rc.final);
  check('code: the consent screen warns that it is a program on this computer and shows the stricter limits', /on this computer/.test(rc.consent?.text ?? '') && /stricter Claude Code limits/.test(rc.consent?.text ?? ''), rc.consent?.text?.slice(0, 300));
  const tc = await exchange(regCode.body, { code: rc.code, redirect: redirectOtherPort, verifier: pc.verifier });
  check('code: token exchange works', tc.status === 200 && !!tc.body?.access_token, JSON.stringify(tc.body)?.slice(0, 200));
  const codeAdd = await tool(tc.body?.access_token, 'add_task', { title: 'Made by Claude Code over OAuth' });
  const codeDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, title: 'Made by Claude Code over OAuth' });
  check('code: acts as Claude Code (stricter rules), under the person', !codeAdd.isError && codeDoc?.createdBy?.agent === 'claude-code' && String(codeDoc?.createdBy?.userId) === A.userId, JSON.stringify(codeDoc?.createdBy));
  check('code: the Claude Code call limits are counted for it', (await rawDb.collection('policyEvents').countDocuments({ keyId: { $regex: '^oauth_' } })) > 0);
  const impostor = await connect(ctxCode, { name: 'Claude', redirects: ['https://evil.example/cb'], callback: 'https://evil.example/cb' });
  check('code: an app that only calls itself "Claude" (another address) is treated as Claude Code, not chat', !!impostor.access && (await tool(impostor.access, 'add_task', { title: 'Impostor task' })).isError === false && (await rawDb.collection('tasks').findOne({ title: 'Impostor task' }))?.createdBy?.agent === 'claude-code');
  check('code: the consent screen warns when an app calls itself Claude but is not Claude\'s connector', /not Claude's own connector/.test(impostor.r?.consent?.text ?? ''), impostor.r?.consent?.text?.slice(0, 400));
  check('code: but not for the real hosted connector or Claude Code itself', !/not Claude's own connector/.test(flow.r?.consent?.text ?? '') && !/not Claude's own connector/.test(rc.consent?.text ?? ''));
  check('consent: the screen says how long access lasts (30 days, until revoked) for every app', [flow.r, rc, impostor.r].every(r => /keeps access for 30 days/.test(r?.consent?.text ?? '')), flow.r?.consent?.text?.slice(0, 300));
  check('consent: a client registered minutes ago says so', /registered \d+ minutes? ago/.test(impostor.r?.consent?.text ?? '') && /registered \d+ minutes? ago/.test(rc.consent?.text ?? ''), impostor.r?.consent?.text?.slice(0, 300));
  check('consent: Allow starts disabled for every app except Claude\'s hosted connector', impostor.r?.consent?.allowDisabledAtLoad === true && rc.consent?.allowDisabledAtLoad === true && flow.r?.consent?.allowDisabledAtLoad === false, JSON.stringify([impostor.r?.consent?.allowDisabledAtLoad, rc.consent?.allowDisabledAtLoad, flow.r?.consent?.allowDisabledAtLoad]));
  const delpatLook = await connect(ctxCode, { name: 'Delpat Work OS Helper', redirects: ['https://evil.example/cb2'], callback: 'https://evil.example/cb2' });
  check('consent: a name like Delpat or Work OS gets the lookalike warning too', /not Claude's own connector/.test(delpatLook.r?.consent?.text ?? ''), delpatLook.r?.consent?.text?.slice(0, 300));
  const mixed = await connect(ctxCode, { name: 'Claude', redirects: [CLAUDE_CB, 'https://evil.example/cb'], callback: 'https://claude.ai/api/mcp/auth_callback' });
  check('code: a client with Claude\'s address plus another one is also Claude Code', !!mixed.access && (await tool(mixed.access, 'add_task', { title: 'Mixed task' })).isError === false && (await rawDb.collection('tasks').findOne({ title: 'Mixed task' }))?.createdBy?.agent === 'claude-code');

  // ======== 8. deny, tampering, framing ========
  const regD = await register({ client_name: 'Denied App', redirect_uris: [CLAUDE_CB] });
  const pd = pkce();
  const ad = authUrl(regD.body, { redirect: CLAUDE_CB, challenge: pd.challenge });
  const rd = await approve(ctxA, ad.url, { allow: false, callback: 'https://claude.ai/api/mcp/auth_callback' });
  check('deny: Deny sends access_denied and the same state, no code', rd.error === 'access_denied' && rd.state === ad.state && !rd.code, rd.final);
  const denied = await rawDb.collection('oauthConsent').countDocuments({ clientId: regD.body.client_id });
  check('deny: nothing is stored as approved', denied === 0);
  // tampered consent address
  const regT = await register({ client_name: 'Tamper App', redirect_uris: [CLAUDE_CB] });
  const pt = pkce();
  const at = authUrl(regT.body, { redirect: CLAUDE_CB, challenge: pt.challenge });
  const pg = await ctxA.newPage();
  await pg.route(u => u.href.startsWith('https://claude.ai/'), r => r.fulfill({ status: 200, body: 'ok' }));
  const authResp = await navigate(at.url, (await ctxA.cookies()).map(c => `${c.name}=${c.value}`).join('; '));
  const consentLoc = authResp.location ?? '';
  check('consent: the authorize endpoint sends a signed-in person to the consent page', consentLoc.includes('/oauth/consent?') && /sig=/.test(consentLoc), consentLoc);
  const cu = new URL(consentLoc, B);
  const orig = await pg.goto(cu.href);
  check('consent: the page cannot be framed (CSP frame-ancestors none, X-Frame-Options)', /frame-ancestors 'none'/.test(orig.headers()['content-security-policy'] ?? '') && /deny/i.test(orig.headers()['x-frame-options'] ?? ''), JSON.stringify(orig.headers()).slice(0, 300));
  const t1 = new URL(cu.href); t1.searchParams.set('client_id', good.body.client_id);
  await pg.goto(t1.href);
  check('consent: a changed request (another app) shows nothing to approve', (await pg.locator('[data-consent=allow]').count()) === 0 && /can.t be used/.test(await pg.locator('body').innerText()));
  const t2 = new URL(cu.href); t2.searchParams.set('redirect_uri', 'https://evil.example/cb');
  await pg.goto(t2.href);
  check('consent: a changed redirect address shows nothing to approve', (await pg.locator('[data-consent=allow]').count()) === 0);
  const t3 = new URL(cu.href); t3.searchParams.delete('sig');
  await pg.goto(t3.href);
  check('consent: a request without its signature shows nothing to approve', (await pg.locator('[data-consent=allow]').count()) === 0);
  // posting a forged consent straight to the API
  const forged = await fetch(`${B}/api/auth/oauth2/consent`, { method: 'POST', headers: { 'content-type': 'application/json', origin: B, cookie: (await ctxA.cookies()).map(c => `${c.name}=${c.value}`).join('; ') }, body: JSON.stringify({ accept: true, oauth_query: t1.search.slice(1) }) });
  check('consent: a forged or altered consent post is refused', forged.status >= 400, String(forged.status));
  const anon = await fetch(`${B}/api/auth/oauth2/consent`, { method: 'POST', headers: { 'content-type': 'application/json', origin: B }, body: JSON.stringify({ accept: true, oauth_query: cu.search.slice(1) }) });
  check('consent: without a session it is refused', anon.status >= 400 && anon.status < 500, String(anon.status));
  const evilOrigin = await fetch(`${B}/api/auth/oauth2/consent`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: (await ctxA.cookies()).map(c => `${c.name}=${c.value}`).join('; ') }, body: JSON.stringify({ accept: true, oauth_query: cu.search.slice(1) }) });
  check('consent: a post from another site (with the cookies) is refused (CSRF)', evilOrigin.status === 403 || evilOrigin.status === 401, String(evilOrigin.status));
  await pg.setViewportSize({ width: 390, height: 800 });
  await pg.goto(cu.href);
  await pg.waitForSelector('[data-consent=allow]');
  check('consent: phone: no sideways scroll, big buttons', okO(await overflow(pg)) && (await pg.locator('[data-consent=allow]').boundingBox()).height >= 44, JSON.stringify(await overflow(pg)));
  await pg.screenshot({ path: SP + '/oauth-consent-phone.png', fullPage: true });
  await pg.setViewportSize({ width: 1280, height: 900 });
  await pg.screenshot({ path: SP + '/oauth-consent-desktop.png', fullPage: true });
  await pg.close();
  check('consent: nothing was approved by the tampering', (await rawDb.collection('oauthConsent').countDocuments({ clientId: regT.body.client_id })) === 0);

  // ======== 9. routes that must not be served ========
  const blocked = [
    ['POST', '/api/auth/oauth2/introspect'], ['GET', '/api/auth/oauth2/userinfo'], ['POST', '/api/auth/oauth2/create-client'], ['GET', '/api/auth/oauth2/get-clients'],
    ['GET', '/api/auth/oauth2/get-client?client_id=x'], ['POST', '/api/auth/oauth2/update-client'], ['POST', '/api/auth/oauth2/delete-client'], ['POST', '/api/auth/admin/oauth2/create-client'],
    ['GET', '/api/auth/oauth2/get-consents'], ['POST', '/api/auth/oauth2/delete-consent'], ['POST', '/api/auth/oauth2/continue'], ['GET', '/api/auth/oauth2/end-session'],
    ['GET', '/api/auth/admin/oauth2/resources'], ['GET', '/api/auth/jwks'],
  ];
  const results = await Promise.all(blocked.map(([m, p]) => fetch(B + p, { method: m, headers: m === 'POST' ? { 'content-type': 'application/json' } : {}, body: m === 'POST' ? '{}' : undefined }).then(r => [m + ' ' + p, r.status])));
  check('routes: introspection, userinfo, client and consent management, resources and end-session are 404', results.every(([, s]) => s === 404), JSON.stringify(results.filter(([, s]) => s !== 404)));

  // ======== 10. a removed member's token dies; the person's other organization is separate ========
  const ctxR = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fr = await connect(ctxR, { name: 'Claude', email: 'rex@example.test' });
  check('member: Rex connects Claude as himself (consent names his organization)', !!fr.access && fr.r?.consent?.org === 'E2E Org' && /Rex/.test(fr.r?.consent?.text ?? ''), JSON.stringify(fr.r?.consent)?.slice(0, 200));
  check('member: his token works and is his own', (await status(fr.access)) === 200);
  const rexRow = await rawDb.collection('oauthAccessToken').findOne({ clientId: fr.c.client_id });
  check('member: bound to him and to the organization', String(rexRow?.userId) === Rex.userId && String(rexRow?.referenceId) === A.orgId);
  const pa = await ctxA.newPage();
  await pa.goto(B + '/settings?section=members');
  await pa.waitForSelector('button[aria-label="Remove rex@example.test"]', { timeout: 15000 });
  await pa.click('button[aria-label="Remove rex@example.test"]');
  await pa.click('[data-remove-confirm="rex@example.test"] button:has-text("Remove")');
  for (let i = 0; i < 40 && (await status(fr.access)) !== 401; i++) await sleep(300);
  check('member: removing him ends the token at once', (await status(fr.access)) === 401);
  check('member: his refresh token is dead too', (await refresh(fr.c, fr.refreshTok)).status === 400);
  check('member: his approvals and tokens are deleted', (await rawDb.collection('oauthConsent').countDocuments({ clientId: fr.c.client_id })) === 0 && (await rawDb.collection('oauthAccessToken').countDocuments({ clientId: fr.c.client_id })) === 0 && (await rawDb.collection('oauthRefreshToken').countDocuments({ clientId: fr.c.client_id })) === 0);
  check('member: the owner\'s own app is not affected', (await status(flow3.access)) === 200);
  await pa.close();

  // another organization
  const ctxCy = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fc = await connect(ctxCy, { name: 'Claude', email: 'cy@example.test' });
  check('org: Cy connects and the consent names Cy\'s organization', !!fc.access && fc.r?.consent?.org === 'Cy Org', JSON.stringify(fc.r?.consent)?.slice(0, 160));
  const cyList = await tool(fc.access, 'list_tasks', {});
  check('org: Cy\'s token sees Cy\'s tasks and none of the first organization\'s', /Cy secret task/.test(cyList.text) && !/OAuth Alpha task|Made over OAuth/.test(cyList.text), cyList.text.slice(0, 200));
  const cyReach = await tool(fc.access, 'get_task', { task: aTask.ref });
  check('org: and cannot fetch the first organization\'s task by reference', cyReach.isError || !/OAuth Alpha task/.test(cyReach.text), cyReach.text.slice(0, 150));
  const fcRow = await rawDb.collection('oauthAccessToken').findOne({ clientId: fc.c.client_id });
  check('org: Cy\'s token is bound to Cy\'s organization', String(fcRow?.referenceId) === Cy.orgId);

  const tt = await fetch(B + '/api/timetable/today', { headers: { authorization: 'Bearer ' + flow3.access } });
  const hh = await fetch(B + '/api/admin/health', { headers: { authorization: 'Bearer ' + flow3.access } });
  check('scope: an OAuth token opens /api/mcp only (not the other API routes, not admin)', tt.status === 401 && hh.status === 401, `${tt.status} ${hh.status}`);
  const cookieless = await fetch(B + '/settings', { headers: { authorization: 'Bearer ' + flow3.access }, redirect: 'manual' });
  check('scope: and not the pages', cookieless.status >= 300 && cookieless.status < 400, String(cookieless.status));

  // ======== 11. registration scope, budgets, prune ========
  const wk = await register({ client_name: 'Scoped', redirect_uris: ['https://example.com/scoped'], scope: 'workos' });
  const wkRow = await rawDb.collection('oauthClient').findOne({ clientId: wk.body?.client_id });
  check('register: scope "workos" registers (201) and the stored scopes are only ours (the plugin stores its allowed set for every dynamic client)', (wk.status === 201 || wk.status === 200) && (wkRow?.scopes ?? []).every(x => ['workos', 'offline_access'].includes(x)) && (wkRow?.scopes ?? []).includes('workos'), JSON.stringify(wkRow?.scopes));
  const wk2 = await register({ client_name: 'Scoped2', redirect_uris: ['https://example.com/scoped2'], scope: 'workos  evil	admin offline_access' });
  const wk2Row = await rawDb.collection('oauthClient').findOne({ clientId: wk2.body?.client_id });
  check('register: unknown scopes are dropped (any spacing splits) and never stored', (wk2.status === 201 || wk2.status === 200) && (wk2Row?.scopes ?? []).every(x => ['workos', 'offline_access'].includes(x)) && !/evil|admin/.test(JSON.stringify(wk2.body)), JSON.stringify([wk2.body?.scope, wk2Row?.scopes]));
  const wk3 = await register({ client_name: 'Scoped3', redirect_uris: ['https://example.com/scoped3'], scope: 'evil admin' });
  check('register: only unknown scopes falls back to ours, not to theirs', !/evil|admin/.test(JSON.stringify(wk3.body)), JSON.stringify(wk3.body)?.slice(0, 200));
  const evs = await rawDb.collection('policyEvents').find({ keyId: { $regex: '^oauth_' } }).toArray();
  const budgetKeys = [...new Set(evs.map(e => e.keyId))];
  check('budgets: OAuth callers are counted per person (oauth_<userId>), not per app', budgetKeys.length > 0 && budgetKeys.every(k => /^oauth_[0-9a-f]{24}$/.test(k)) && budgetKeys.includes('oauth_' + A.userId), JSON.stringify(budgetKeys));

  const stale = await register({ client_name: 'Stale', redirect_uris: ['https://example.com/stale'] });
  const days3 = new Date(Date.now() - 3 * 86_400_000);
  await rawDb.collection('oauthClient').updateOne({ clientId: stale.body.client_id }, { $set: { createdAt: days3 } });
  await rawDb.collection('oauthClient').updateOne({ clientId: flow3.c.client_id }, { $set: { createdAt: days3 } });
  await register({ client_name: 'Trigger', redirect_uris: ['https://example.com/trigger'] });
  for (let i = 0; i < 30 && (await rawDb.collection('oauthClient').countDocuments({ clientId: stale.body.client_id })) > 0; i++) await sleep(300);
  check('prune: an unapproved client older than 48 hours is deleted (with its resource link)', (await rawDb.collection('oauthClient').countDocuments({ clientId: stale.body.client_id })) === 0 && (await rawDb.collection('oauthClientResource').countDocuments({ clientId: stale.body.client_id })) === 0);
  check('prune: an approved client of the same age stays', (await rawDb.collection('oauthClient').countDocuments({ clientId: flow3.c.client_id })) === 1);

  // ======== 12. a password change, turning two-step sign-in off or a reset ends every approved app ========
  const MAILDIR = process.env.MAIL_CAPTURE_DIR;
  const signedIn = async (email, password) => {
    const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
    return { status: r.status, cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
  };
  const authPost = (p, body, cookie) => fetch(B + '/api/auth' + p, { method: 'POST', headers: { origin: B, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }));
  const gone = async (f, label) => {
    check(label + ': the app\'s access token is dead', (await status(f.access)) === 401);
    check(label + ': and its refresh token', (await refresh(f.c, f.refreshTok)).status === 400);
    check(label + ': approvals and tokens are deleted', (await rawDb.collection('oauthConsent').countDocuments({ clientId: f.c.client_id })) === 0 && (await rawDb.collection('oauthAccessToken').countDocuments({ clientId: f.c.client_id })) === 0 && (await rawDb.collection('oauthRefreshToken').countDocuments({ clientId: f.c.client_id })) === 0);
  };
  const NEWPW = 'brand-new-password-456';
  for (const who of ['chg', 'tfa', 'rst']) await makeUser({ email: who + '@example.test', name: who.toUpperCase(), orgName: who + ' Org' });

  const chg = await connect(await browser.newContext(), { email: 'chg@example.test' });
  check('password change: the person connects an app', (await status(chg.access)) === 200);
  const chgIn = await signedIn('chg@example.test', PW);
  const chgDone = await authPost('/change-password', { currentPassword: PW, newPassword: NEWPW, revokeOtherSessions: true }, chgIn.cookie);
  check('password change: succeeds', chgDone.status === 200, chgDone.status + ' ' + chgDone.text.slice(0, 120));
  await gone(chg, 'password change');

  const tfa = await connect(await browser.newContext(), { email: 'tfa@example.test' });
  check('two-step off: the person connects an app', (await status(tfa.access)) === 200);
  const tfaIn = await signedIn('tfa@example.test', PW);
  const tfaOn = await authPost('/two-factor/enable', { password: PW }, tfaIn.cookie);
  check('two-step off: two-step sign-in set up', tfaOn.status === 200, tfaOn.status + ' ' + tfaOn.text.slice(0, 120));
  check('two-step off: turning it on does not touch the app', (await status(tfa.access)) === 200);
  const tfaOff = await authPost('/two-factor/disable', { password: PW }, tfaIn.cookie);
  check('two-step off: turning it off succeeds', tfaOff.status === 200, tfaOff.status + ' ' + tfaOff.text.slice(0, 120));
  await gone(tfa, 'two-step off');

  const rst = await connect(await browser.newContext(), { email: 'rst@example.test' });
  check('reset: the person connects an app', (await status(rst.access)) === 200);
  const since = Date.now() - 1000;
  await authPost('/request-password-reset', { email: 'rst@example.test', redirectTo: '/login/reset' });
  let token = '';
  for (let i = 0; i < 40 && !token; i++) {
    const files = fs.existsSync(MAILDIR) ? fs.readdirSync(MAILDIR).filter(f => f.endsWith('.json')) : [];
    for (const f of files) {
      const m = JSON.parse(fs.readFileSync(path.join(MAILDIR, f), 'utf8'));
      if (m.to === 'rst@example.test' && Date.parse(m.at) >= since) token = m.text.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1] ?? token;
    }
    if (!token) await sleep(250);
  }
  const rstDone = await authPost('/reset-password', { newPassword: NEWPW, token });
  check('reset: succeeds', !!token && rstDone.status === 200, rstDone.status + ' ' + rstDone.text.slice(0, 120));
  await gone(rst, 'reset');

  // ======== 13. the old key ========
  const old = await rawDb.collection('oauthClient').find({ clientId: { $in: [sneaky.body.client_id] } }).toArray();
  check('keys: the old key forms still work (chat key and Claude Code key)', (await status(kA)) === 200 && (await status(await mkKey({ agent: 'claude-code' }))) === 200);
  check('keys: a wos_ key is not treated as an OAuth token and the reverse', (await status('wos_' + 'a'.repeat(48))) === 401);
  check('housekeeping: registered clients are kept for the unused-client window', old.length === 1);
  await ctxA.close(); await ctxCode.close(); await ctxR.close(); await ctxCy.close();
} catch (e) {
  check('suite ran without an unexpected error', false, e?.stack || String(e));
} finally {
  await browser.close().catch(() => {});
}
await finish();
