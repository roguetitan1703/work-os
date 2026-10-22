// Sign-in by user (docs/auth.md): password and wrong password, two-factor (app code and backup code), password reset
// by email (read from MAIL_CAPTURE_DIR) revoking old sessions, invitations (Settings › Members, accept as a new user,
// used and forged links), another organization's invitations out of reach, API keys recorded as their user, a revoked
// key refused, Better Auth endpoints outside the allowlist 404, and every page and API route refusing a request with
// no session or key. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { B, EMAIL, PW, ME, db, admin, makeUser, check, finish, launch, login, fillLogin } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIL = process.env.MAIL_CAPTURE_DIR;
const idIn = id => ({ $in: [new ObjectId(id), String(id)] });
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- tiny cookie jar over fetch ----
function jar(init = {}) {
  const c = { ...init };
  return {
    c,
    header: (only = null) => Object.entries(c).filter(([k]) => !only || only.includes(k)).map(([k, v]) => `${k}=${v}`).join('; '),
    take(res) {
      for (const sc of res.headers.getSetCookie()) {
        const [nv] = sc.split(';');
        const i = nv.indexOf('=');
        const k = nv.slice(0, i).trim();
        const v = nv.slice(i + 1).trim();
        if (!v || /max-age=0/i.test(sc)) delete c[k];
        else c[k] = v;
      }
    },
  };
}
async function authApi(j, p, body, { only = null, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const headers = { origin: B, ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const ch = j?.header(only);
  if (ch) headers.cookie = ch;
  const r = await fetch(B + '/api/auth' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  j?.take(r);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, loc: r.headers.get('location') };
}
async function signIn(email, password) {
  const j = jar();
  const r = await authApi(j, '/sign-in/email', { email, password });
  return { j, ...r };
}
const sessionOf = async (j, onlyToken = false) => (await authApi(j, '/get-session', undefined, { only: onlyToken ? ['workos.session_token'] : null })).json;

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, at = Date.now()) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', base32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// ---- captured mail ----
async function mailTo(to, re, { since = 0, tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const files = fs.existsSync(MAIL) ? fs.readdirSync(MAIL).filter(f => f.endsWith('.json')) : [];
    const hits = files
      .map(f => JSON.parse(fs.readFileSync(path.join(MAIL, f), 'utf8')))
      .filter(m => m.to === to && re.test(m.subject + '\n' + m.text) && Date.parse(m.at) >= since)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (hits.length) return hits[0];
    await wait(250);
  }
  return null;
}

const browser = await launch();
try {
  // ======== 1. sign-in, wrong password ========
  {
    const r = await signIn(EMAIL, 'wrong-password-123');
    check('sign-in api: wrong password -> 401', r.status === 401, `${r.status} ${r.text.slice(0, 80)}`);
    const ok = await signIn(EMAIL, PW);
    check('sign-in api: right password -> 200 + session cookie', ok.status === 200 && !!ok.j.c['workos.session_token'], ok.status);
    const s = await sessionOf(ok.j);
    check('get-session: the owner', s?.user?.email === EMAIL && String(s?.session?.activeOrganizationId) === ME.orgId, JSON.stringify(s)?.slice(0, 120));

    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(B + '/login?next=/today');
    await fillLogin(p, { password: 'wrong-password-123' });
    await p.click('button[type=submit]');
    await p.waitForSelector('[role=alert]', { timeout: 10000 }).catch(() => {});
    check('login page: wrong password -> message, stays on /login', (await p.locator('[role=alert]').textContent().catch(() => ''))?.includes('Wrong email or password') && new URL(p.url()).pathname === '/login');
    check('login page: no password in the URL', !p.url().includes('wrong-password'));
    await fillLogin(p);
    await p.click('button[type=submit]');
    await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 }).catch(() => {});
    check('login page: right password -> /today', new URL(p.url()).pathname === '/today', p.url());
    await ctx.close();
  }

  // ======== 2. two-factor ========
  {
    const email = 'e2e-2fa@example.test';
    await makeUser({ email, name: 'Two Factor', orgName: '2FA Org' });
    const { j } = await signIn(email, PW);
    const en = await authApi(j, '/two-factor/enable', { password: PW });
    const uri = en.json?.totpURI ?? '';
    const secret = new URL(uri.replace(/^otpauth:/, 'http:')).searchParams.get('secret') ?? '';
    const backup = en.json?.backupCodes ?? [];
    check('2fa: enable returns a TOTP URI and 10 backup codes', !!secret && backup.length === 10, `${en.status} ${en.text.slice(0, 80)}`);
    const v = await authApi(j, '/two-factor/verify-totp', { code: totp(secret) });
    check('2fa: first code turns it on', v.status === 200 && (await db.collection('user').findOne({ email }))?.twoFactorEnabled === true, `${v.status} ${v.text.slice(0, 80)}`);

    const s1 = await signIn(email, PW);
    check('2fa: password alone -> twoFactorRedirect, no session', s1.json?.twoFactorRedirect === true && !s1.j.c['workos.session_token'], JSON.stringify(s1.json));
    const bad = await authApi(s1.j, '/two-factor/verify-totp', { code: totp(secret, Date.now() - 600000) });
    check('2fa: wrong code -> refused', bad.status >= 400 && !s1.j.c['workos.session_token'], bad.status);
    const s2 = await signIn(email, PW);
    const bc = await authApi(s2.j, '/two-factor/verify-backup-code', { code: backup[0] });
    check('2fa: backup code -> session', bc.status === 200 && (await sessionOf(s2.j))?.user?.email === email, `${bc.status} ${bc.text.slice(0, 80)}`);
    const s3 = await signIn(email, PW);
    const bc2 = await authApi(s3.j, '/two-factor/verify-backup-code', { code: backup[0] });
    check('2fa: the same backup code twice -> refused', bc2.status >= 400, bc2.status);

    // In the browser: password, then the code step.
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(B + '/login?next=/today');
    await fillLogin(p, { email });
    await p.click('button[type=submit]');
    const codeStep = await p.waitForSelector('input[name=code]', { timeout: 10000 }).then(() => true, () => false);
    check('2fa login page: asks for the code', codeStep);
    await p.waitForSelector('form button[type=submit]:not([disabled])');
    await p.fill('input[name=code]', totp(secret, Date.now() + 30000));
    await p.click('button[type=submit]');
    await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 }).catch(() => {});
    check('2fa login page: right code -> /today', new URL(p.url()).pathname === '/today', p.url());
    await ctx.close();
  }

  // ======== 3. password reset by email ========
  {
    const email = 'e2e-reset@example.test';
    const NEWPW = 'brand-new-password-456';
    await makeUser({ email, name: 'Reset Me', orgName: 'Reset Org' });
    const old = await signIn(email, PW);
    check('reset: an old session exists', (await sessionOf(old.j, true))?.user?.email === email);

    const since = Date.now() - 1000;
    const rq = await authApi(null, '/request-password-reset', { email, redirectTo: '/login/reset' });
    check('reset: request -> 200', rq.status === 200, `${rq.status} ${rq.text.slice(0, 80)}`);
    const unknown = await authApi(null, '/request-password-reset', { email: 'nobody@example.test', redirectTo: '/login/reset' });
    check('reset: unknown address answers the same (no account probing)', unknown.status === 200, unknown.status);
    const m = await mailTo(email, /reset/i, { since });
    const link = m?.text.match(/https?:\/\/\S+\/reset-password\/[A-Za-z0-9_-]+\S*/)?.[0] ?? '';
    check('reset: the email went to the user, with a link to this app', !!link && link.startsWith(B), m ? m.text.slice(0, 120) : 'no mail');
    check('reset: nothing mailed to an unknown address', !(await mailTo('nobody@example.test', /./, { since, tries: 4 })));
    const token = link.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
    const vs = await db.collection('verification').find().toArray();
    check('reset: token stored hashed (not the token itself)', !!token && vs.length > 0 && !JSON.stringify(vs).includes(token));

    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(link);
    await p.waitForURL(u => u.pathname === '/login/reset', { timeout: 15000 }).catch(() => {});
    check('reset: the link opens /login/reset', new URL(p.url()).pathname === '/login/reset', p.url());
    await p.waitForSelector('form button[type=submit]:not([disabled])', { timeout: 15000 }).catch(() => {});
    await p.fill('input[aria-label="New password"]', NEWPW);
    await p.fill('input[aria-label="New password again"]', NEWPW);
    await p.click('button[type=submit]');
    await p.waitForURL(u => u.pathname === '/login' && u.searchParams.get('reset') === 'done', { timeout: 15000 }).catch(() => {});
    check('reset: new password set -> /login?reset=done', p.url().includes('reset=done'), p.url());
    await ctx.close();

    check('reset: the old session is revoked', (await sessionOf(old.j, true)) === null);
    check('reset: old password refused', (await signIn(email, PW)).status === 401);
    check('reset: new password works', (await signIn(email, NEWPW)).status === 200);
    const again = await authApi(null, '/reset-password', { newPassword: 'another-password-789', token });
    check('reset: the link works once', again.status >= 400, again.status);
    check('reset: "password changed" mail sent', !!(await mailTo(email, /changed/i, { since })));
  }

  // ======== 4. invitations ========
  let invitee = null;
  let inviteeCookies = '';
  let pendingId = '';
  {
    const email = 'e2e-invitee@example.test';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await login(p, { next: '/settings?section=members' });
    await p.waitForSelector('[data-members]', { timeout: 15000 });
    check('members: the owner is listed', (await p.locator(`[data-member="${EMAIL}"]`).count()) === 1);
    const since = Date.now() - 1000;
    await p.fill('input[aria-label="Email to invite"]', email);
    await p.selectOption('select[aria-label="Role"]', 'member');
    await p.click('form button:has-text("Invite")');
    await p.waitForSelector('[data-invite-link] code', { timeout: 15000 }).catch(() => {});
    const link = ((await p.locator('[data-invite-link] code').textContent().catch(() => '')) ?? '').trim();
    check('invite: link shown', link.startsWith(B + '/accept-invitation/') && link.includes('?t='), link);
    const m = await mailTo(email, /accept-invitation/, { since });
    check('invite: mailed to the address with the same link', !!m && m.text.includes(link));
    const inv = await db.collection('invitation').findOne({ email });
    const t = new URL(link).searchParams.get('t') ?? '';
    check('invite: only the hash of the secret is stored', !!inv?.tokenHash && !JSON.stringify(inv).includes(t));

    // A second, pending invitation for the cross-organization checks.
    await p.fill('input[aria-label="Email to invite"]', 'e2e-pending@example.test');
    await p.selectOption('select[aria-label="Role"]', 'admin');
    await p.click('form button:has-text("Invite")');
    await p.waitForSelector('[data-invitation="e2e-pending@example.test"]', { timeout: 15000 }).catch(() => {});
    pendingId = String((await db.collection('invitation').findOne({ email: 'e2e-pending@example.test' }))?._id ?? '');
    check('invite: second invitation pending', !!pendingId);
    await ctx.close();

    const forged = link.replace(/\?t=.*$/, '?t=' + 'x'.repeat(t.length));
    const c2 = await browser.newContext();
    const q = await c2.newPage();
    await q.goto(forged);
    check('accept: a wrong secret -> invalid', (await q.getAttribute('[data-invite]', 'data-invite', { timeout: 10000 }).catch(() => null)) === 'invalid');
    await q.goto(link.replace(/\?t=.*$/, ''));
    check('accept: no secret -> invalid', (await q.getAttribute('[data-invite]', 'data-invite', { timeout: 10000 }).catch(() => null)) === 'invalid');
    await q.goto(link);
    check('accept: the real link -> new account form', (await q.getAttribute('[data-invite]', 'data-invite', { timeout: 10000 }).catch(() => null)) === 'new');
    await q.fill('input[name=name]', 'Invited Person');
    await q.fill('input[name=password]', PW);
    await q.fill('input[name=again]', PW);
    await q.click('button:has-text("Join")');
    await q.waitForURL(u => u.pathname === '/today', { timeout: 20000 }).catch(() => {});
    check('accept: joined, signed in, on /today', new URL(q.url()).pathname === '/today', q.url());
    const u = await db.collection('user').findOne({ email });
    invitee = u ? String(u._id) : null;
    const mem = u && (await db.collection('member').findOne({ userId: idIn(invitee), organizationId: idIn(ME.orgId) }));
    check('accept: member of the organization with the invited role', mem?.role === 'member', JSON.stringify(mem));
    check('accept: invitation marked accepted', (await db.collection('invitation').findOne({ email }))?.status === 'accepted');

    await q.goto(B + '/settings?section=members');
    await q.waitForSelector('[data-members]', { timeout: 15000 }).catch(() => {});
    check('members: a member sees the list but no invite form', (await q.locator(`[data-member="${email}"]`).count()) === 1 && (await q.locator('input[aria-label="Email to invite"]').count()) === 0);
    inviteeCookies = (await c2.cookies()).filter(c => c.name.startsWith('workos.')).map(c => `${c.name}=${c.value}`).join('; ');
    await q.goto(link);
    check('accept: the link works once', (await q.getAttribute('[data-invite]', 'data-invite', { timeout: 10000 }).catch(() => null)) === 'invalid');
    await c2.close();
  }

  // ======== 5. another organization's invitations ========
  {
    const email = 'e2e-outsider@example.test';
    await makeUser({ email, name: 'Outsider', orgName: 'Other Org' });
    const { j } = await signIn(email, PW);
    const li = await authApi(j, `/organization/list-invitations?organizationId=${ME.orgId}`);
    check('other org: list-invitations of org A refused', li.status >= 400 || (Array.isArray(li.json) && li.json.length === 0), `${li.status} ${li.text.slice(0, 80)}`);
    const fo = await authApi(j, `/organization/get-full-organization?organizationId=${ME.orgId}`);
    check('other org: get-full-organization of org A refused', fo.status >= 400 || fo.json === null, `${fo.status} ${fo.text.slice(0, 80)}`);
    const ci = await authApi(j, '/organization/cancel-invitation', { invitationId: pendingId });
    check('other org: cancel-invitation of org A refused', ci.status >= 400, `${ci.status} ${ci.text.slice(0, 80)}`);
    const gi = await authApi(j, `/organization/get-invitation?id=${pendingId}`);
    check('other org: get-invitation is not served (404)', gi.status === 404, gi.status);
    const sa = await authApi(j, '/organization/set-active', { organizationId: ME.orgId });
    check('other org: set-active into org A refused', sa.status >= 400, `${sa.status} ${sa.text.slice(0, 80)}`);
    check('other org: the invitation is still pending', (await db.collection('invitation').findOne({ _id: new ObjectId(pendingId) }))?.status === 'pending');

    const mj = jar(Object.fromEntries(inviteeCookies.split('; ').filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])));
    const mc = await authApi(mj, '/organization/cancel-invitation', { invitationId: pendingId });
    check('member: cancel-invitation refused (owners and admins only)', mc.status >= 400, `${mc.status} ${mc.text.slice(0, 80)}`);
    check('member: the invitation is still pending', (await db.collection('invitation').findOne({ _id: new ObjectId(pendingId) }))?.status === 'pending');
  }

  // ======== 6. Better Auth endpoints outside the allowlist ========
  for (const [method, p, body] of [
    ['POST', '/sign-up/email', { email: 'x@example.test', password: 'whatever-12345', name: 'X' }],
    ['POST', '/api-key/create', { name: 'x' }],
    ['GET', '/api-key/list'],
    ['POST', '/organization/create', { name: 'X', slug: 'x' }],
    ['POST', '/organization/invite-member', { email: 'x@example.test', role: 'owner' }],
    ['POST', '/organization/accept-invitation', { invitationId: pendingId }],
    ['POST', '/organization/update-member-role', { memberId: 'x', role: 'owner' }],
    ['POST', '/update-user', { name: 'X' }],
    ['POST', '/delete-user', {}],
  ]) {
    const r = await authApi(null, p, body, { method });
    check(`auth endpoint ${method} ${p} -> 404`, r.status === 404, r.status);
  }
  check('sign-up: no user made', !(await db.collection('user').findOne({ email: 'x@example.test' })));

  // ======== 7. API keys carry their user ========
  {
    const a = await admin();
    const mcpWith = (key, name, args, extra = {}) =>
      fetch(B + '/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...extra },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }).then(async r => ({ status: r.status, text: await r.text() }));

    const chat = await a.createKey({ userId: invitee, orgId: ME.orgId, agent: 'claude', name: 'invitee chat' });
    let r = await mcpWith(chat.key, 'add_task', { title: 'auth-e2e by invitee chat' });
    const act1 = await db.collection('activity').findOne({ taskTitle: 'auth-e2e by invitee chat' });
    check('key: Claude chat key of user X -> history says X', r.status === 200 && act1?.actorUserId === invitee && act1?.actor === 'claude', `${r.status} ${JSON.stringify(act1)?.slice(0, 160)}`);

    const code = await a.createKey({ userId: invitee, orgId: ME.orgId, agent: 'claude-code', name: 'invitee code' });
    r = await mcpWith(code.key, 'add_task', { title: 'auth-e2e by invitee code' }, { 'x-work-os-session': 'auth-e2e', 'x-work-os-repo': 'work-os' });
    const act2 = await db.collection('activity').findOne({ taskTitle: 'auth-e2e by invitee code' });
    check('key: Claude Code key of user X -> history says X (claude-code)', r.status === 200 && act2?.actorUserId === invitee && act2?.actor === 'claude-code', `${r.status} ${JSON.stringify(act2)?.slice(0, 160)}`);
    const own = await db.collection('activity').findOne({ actor: 'claude', actorUserId: ME.userId });
    check('key: owner key entries are not recorded as X', !own || own.actorUserId !== invitee);

    await db.collection('apikey').deleteOne({ _id: idIn(chat.id) });
    r = await mcpWith(chat.key, 'list_projects', {});
    check('key: revoked Claude chat key -> 401 on /api/mcp', r.status === 401, r.status);
    const h = await fetch(B + '/api/admin/health', { headers: { authorization: `Bearer ${chat.key}` } });
    check('key: revoked key -> 401 on /api/admin/health', h.status === 401, h.status);
    await db.collection('apikey').updateOne({ _id: idIn(code.id) }, { $set: { enabled: false } });
    r = await mcpWith(code.key, 'list_projects', {}, { 'x-work-os-session': 'auth-e2e' });
    check('key: disabled Claude Code key -> 401', r.status === 401, r.status);
    const fake = 'wos_' + 'A'.repeat(48);
    r = await mcpWith(fake, 'list_projects', {});
    check('key: made-up key -> 401', r.status === 401, r.status);
  }

  // ======== 8. every page and API route without a session or key ========
  {
    const routes = [];
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name === 'page.tsx' || e.name === 'route.ts') routes.push(f);
      }
    };
    walk(path.join(ROOT, 'app'));
    const toUrl = f =>
      '/' +
      path
        .relative(path.join(ROOT, 'app'), path.dirname(f))
        .split(path.sep)
        .filter(s => s && !/^\(.*\)$/.test(s))
        .map(s => (/^\[\[\.\.\..*\]\]$/.test(s) ? '' : /^\[\.\.\..*\]$/.test(s) ? 'x/y' : /^\[.*\]$/.test(s) ? 'abc123' : s))
        .filter(Boolean)
        .join('/');
    const PUBLIC = new Set(['/login', '/login/reset', '/accept-invitation/abc123']);
    let pages = 0;
    let apis = 0;
    for (const f of routes) {
      const u = toUrl(f);
      if (u.startsWith('/api/auth')) continue; // Better Auth's own endpoints: allowlist checked above
      if (f.endsWith('page.tsx')) {
        const r = await fetch(B + u, { redirect: 'manual' });
        if (PUBLIC.has(u)) check(`page ${u}: public -> 200`, r.status === 200, r.status);
        else {
          pages++;
          const loc = r.headers.get('location') ?? '';
          check(`page ${u}: no session -> redirect to /login`, r.status >= 300 && r.status < 400 && loc.includes('/login'), `${r.status} ${loc}`);
          const forged = await fetch(B + u, { redirect: 'manual', headers: { cookie: 'workos.session_token=forged.value' } });
          check(`page ${u}: forged cookie -> redirect to /login`, forged.status >= 300 && forged.status < 400 && (forged.headers.get('location') ?? '').includes('/login'), forged.status);
        }
        continue;
      }
      const src = fs.readFileSync(f, 'utf8');
      const methods = new Set([...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b|\bas\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1] || m[2] || m[3]));
      for (const method of methods) {
        apis++;
        const r = await fetch(B + u, { method, redirect: 'manual', headers: method === 'GET' ? {} : { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
        check(`api ${method} ${u}: no key -> 401`, r.status === 401, r.status);
      }
    }
    check(`route sweep covered the app (${pages} pages, ${apis} API handlers)`, pages >= 10 && apis >= 10);
  }
} catch (e) {
  check('auth suite (error)', false, e?.stack || String(e));
} finally {
  await browser.close();
}
await finish();
