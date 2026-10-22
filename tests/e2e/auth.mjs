// Sign-in by user (docs/auth.md): password and wrong password, two-factor (app code and backup code), password reset
// by email (read from MAIL_CAPTURE_DIR) revoking old sessions, invitations (Settings › Members, accept as a new user,
// used and forged links), another organization's invitations out of reach, API keys recorded as their user, a revoked
// key refused, Better Auth endpoints outside the allowlist 404, and every page and API route refusing a request with
// no session or key. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { B, EMAIL, PW, ME, db, rawDb, admin, makeUser, mkDevice, mkKey, mcpAs, call, api, sha, check, finish, launch, login, fillLogin } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIL = process.env.MAIL_CAPTURE_DIR;
const idIn = id => ({ $in: [new ObjectId(id), String(id)] });
const wait = ms => new Promise(r => setTimeout(r, ms));
const INVITEE = 'e2e-invitee@example.test';

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
    await p.waitForSelector('form [role=alert]', { timeout: 10000 }).catch(() => {});
    check('login page: wrong password -> message, stays on /login', (await p.locator('form [role=alert]').textContent().catch(() => ''))?.includes('Wrong email or password') && new URL(p.url()).pathname === '/login');
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
    check('key: Claude chat key of user X -> history says X', r.status === 200 && act1?.actor?.kind === 'agent' && act1.actor.agent === 'claude' && act1.actor.userId === invitee, `${r.status} ${JSON.stringify(act1)?.slice(0, 160)}`);

    const code = await a.createKey({ userId: invitee, orgId: ME.orgId, agent: 'claude-code', name: 'invitee code' });
    r = await mcpWith(code.key, 'add_task', { title: 'auth-e2e by invitee code' }, { 'x-work-os-session': 'auth-e2e', 'x-work-os-repo': 'work-os' });
    const act2 = await db.collection('activity').findOne({ taskTitle: 'auth-e2e by invitee code' });
    check('key: Claude Code key of user X -> history says X (claude-code)', r.status === 200 && act2?.actor?.kind === 'agent' && act2.actor.agent === 'claude-code' && act2.actor.userId === invitee, `${r.status} ${JSON.stringify(act2)?.slice(0, 160)}`);
    const own = await db.collection('activity').findOne({ 'actor.kind': 'agent', 'actor.agent': 'claude', 'actor.userId': ME.userId });
    check('key: owner key entries are not recorded as X', !own || own.actor.userId !== invitee);

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

  // ======== 7b. computers belong to their user ========
  {
    const ownerDevs = [];
    for (let i = 1; i <= 10; i++) ownerDevs.push(await mkDevice(`owner-pc-${i}`));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await login(p, { email: INVITEE, next: '/claude?tab=setup' });
    await p.waitForSelector('input[aria-label="Name for the new computer"]', { timeout: 15000 });
    await p.waitForTimeout(500);
    check('devices: a member does not see the owner\'s computers', (await p.locator('[data-device^="owner-pc-"]').count()) === 0);
    await p.fill('input[aria-label="Name for the new computer"]', 'owner-pc-1');
    await p.locator('button:has-text("Add")').last().click();
    const made = await p.locator('code.bg-muted', { hasText: /^wkr_/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    const mine = await db.collection('devices').findOne({ name: 'owner-pc-1', ownerId: invitee, revokedAt: null });
    check('devices: the owner\'s 10 computers and names do not count against the member', made && !!mine && mine.orgId === ME.orgId);
    await p.locator('button:has-text("I saved it")').click().catch(() => {});

    // A forged revoke: the member's own Revoke, with the owner's device id swapped into the action's arguments.
    const target = ownerDevs[1].id;
    await db.collection('workerJobs').insertOne({ _id: 'auth-e2e-job', deviceId: target, kind: 'stop', doneAt: null, createdAt: new Date() });
    await p.route('**/claude**', async route => {
      const r = route.request();
      if (r.method() === 'POST' && r.headers()['next-action'] && (r.postData() ?? '').includes(mine._id)) return route.continue({ postData: r.postData().split(mine._id).join(target) });
      return route.continue();
    });
    await p.locator(`button[aria-label="Revoke owner-pc-1"]`).click();
    await p.locator('button[data-confirm]').click();
    await p.waitForTimeout(1500);
    await p.unroute('**/claude**');
    check('devices: a member cannot revoke the owner\'s computer', (await db.collection('devices').findOne({ _id: target }))?.revokedAt === null);
    check("devices: ...and the owner's pending job stays", (await db.collection('workerJobs').findOne({ _id: 'auth-e2e-job' }))?.doneAt === null);

    // ======== 7c. new credentials need a fresh sign-in ========
    // The refused revoke leaves its confirm dialog open: start from a fresh page.
    await p.reload();
    await p.waitForSelector('input[aria-label="Name for the new computer"]', { timeout: 15000 });
    const old = new Date(Date.now() - 20 * 60_000);
    await db.collection('session').updateMany({ userId: idIn(invitee) }, { $set: { createdAt: old }, $unset: { reauthAt: '' } });
    await p.fill('input[aria-label="Name for the new computer"]', 'stale-pc');
    await p.locator('button:has-text("Add")').last().click();
    const dlg = p.locator('[data-reauth]');
    check('fresh: adding a computer 20 min after sign-in asks for the password', await dlg.waitFor({ timeout: 10000 }).then(() => true, () => false));
    await dlg.locator('input[name=password]').fill('wrong-password-000');
    await dlg.locator('button[type=submit]').click();
    check('fresh: wrong password -> message, nothing made', (await dlg.locator('[role=alert]').textContent({ timeout: 8000 }).catch(() => ''))?.includes('Wrong password') && !(await db.collection('devices').findOne({ name: 'stale-pc' })));
    await dlg.locator('input[name=password]').fill(PW);
    await dlg.locator('button[type=submit]').click();
    const made2 = await p.locator('code.bg-muted', { hasText: /^wkr_/ }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    check('fresh: right password -> the computer is made', made2 && !!(await db.collection('devices').findOne({ name: 'stale-pc', ownerId: invitee })));

    const cj = jar(Object.fromEntries((await ctx.cookies()).filter(c => c.name === 'workos.session_token').map(c => [c.name, c.value])));
    await db.collection('session').updateMany({ userId: idIn(invitee) }, { $set: { createdAt: old }, $unset: { reauthAt: '' } });
    const pk = await authApi(cj, '/passkey/generate-register-options');
    check('fresh: passkey registration with a stale session -> 403', pk.status === 403 && pk.json?.code === 'FRESH_SESSION_REQUIRED', `${pk.status} ${pk.text.slice(0, 80)}`);
    await db.collection('session').updateMany({ userId: idIn(invitee) }, { $set: { reauthAt: new Date() } });
    const pk2 = await authApi(cj, '/passkey/generate-register-options');
    check('fresh: ...and allowed right after the password', pk2.status === 200, `${pk2.status} ${pk2.text.slice(0, 80)}`);
    await ctx.close();
  }

  // ======== 7e. computers, folders and sessions are private to their owner ========
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
    const pid = (await call('add_project', { name: 'Auth Private Launcher' })).project.id;
    // A server action called the way the browser does (Next-Action header), on a page that registers it.
    const act = async (cookie, name, ...args) => {
      const [id, e] = Object.entries(manifest).find(([, e]) => Object.values(e.workers).some(w => w.exportedName === name && /(launcher|dispatcher)-actions\.ts$/.test(w.filename)));
      const pages = Object.keys(e.workers);
      const page = pages.find(x => !x.includes('[')) ?? pages[0];
      const url = '/' + page.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(x => !/^\(.*\)$/.test(x)).map(x => (/^\[.*\]$/.test(x) ? pid : x)).join('/');
      const r = await fetch(B + url, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
      return { status: r.status, text: await r.text() };
    };
    const refused = (r, msg) => r.text.includes('"ok":false') && r.text.includes(msg);

    const own = await mkDevice('owner-private-pc');
    await db.collection('devices').updateOne({ _id: own.id }, { $set: { worker: { version: '0.1.0', os: 'win32', allowPrompts: true }, lastSeenAt: new Date() } });
    const fA = own.id + ':fA', fB = own.id + ':fB';
    const folder = (dev, fid, name, projectId) => ({ _id: dev + ':' + fid, deviceId: dev, folderId: fid, name, git: false, projectId, linkedAt: projectId ? new Date() : null, seenAt: new Date(), missing: false });
    await db.collection('workerFolders').insertMany([folder(own.id, 'fA', 'owner-secret-folder', pid), folder(own.id, 'fB', 'owner-unlinked-folder', null)]);
    const live = randomUUID(), done = randomUUID();
    await db.collection('workerSessions').insertMany([
      { _id: live, deviceId: own.id, folderId: 'fA', projectId: pid, state: 'running', startedAt: new Date(), updatedAt: new Date() },
      { _id: done, deviceId: own.id, folderId: 'fA', projectId: pid, state: 'stopped', startedAt: new Date(), updatedAt: new Date() },
    ]);
    const jobs = () => db.collection('workerJobs').countDocuments({ deviceId: own.id });
    const jobs0 = await jobs();

    const member = (await signIn(INVITEE, PW)).j.header();
    const html = async u => (await fetch(B + u, { headers: { cookie: member } })).text();
    const projectPage = await html('/projects/' + pid);
    check("private: the project page shows a member none of the owner's folders, computers or sessions", !projectPage.includes('owner-secret-folder') && !projectPage.includes('owner-private-pc') && !projectPage.includes(live));
    const claudePage = await html('/claude');
    check("private: the Claude page shows a member none of the owner's sessions or computers", !claudePage.includes('owner-private-pc') && !claudePage.includes(live));

    let r = await act(member, 'startSessionAction', pid, fA, '');
    check("private: start on the owner's folder -> not found", refused(r, 'Folder not found'), r.status + ' ' + r.text.slice(0, 160));
    r = await act(member, 'linkAndStartAction', pid, fB, '');
    check("private: link-and-start the owner's folder -> not found", refused(r, 'Folder not found') && (await db.collection('workerFolders').findOne({ _id: fB }))?.projectId === null, r.text.slice(0, 160));
    r = await act(member, 'linkFolderAction', pid, fB);
    check("private: link the owner's folder -> not found", refused(r, 'Folder not found'), r.text.slice(0, 160));
    r = await act(member, 'unlinkFolderAction', pid, fA);
    check("private: unlink the owner's folder -> not found, still linked", refused(r, 'Folder not found') && (await db.collection('workerFolders').findOne({ _id: fA }))?.projectId === pid, r.text.slice(0, 160));
    r = await act(member, 'searchFoldersAction', own.id, '');
    check("private: search folders on the owner's computer -> not found", refused(r, 'Device not found'), r.text.slice(0, 160));
    r = await act(member, 'stopSessionAction', pid, live);
    check("private: stop the owner's session -> not found", refused(r, 'Session not found'), r.text.slice(0, 160));
    r = await act(member, 'resumeSessionAction', pid, done);
    check("private: resume the owner's session -> not found", refused(r, 'Session not found'), r.text.slice(0, 160));
    r = await act(member, 'removeSessionAction', pid, done);
    check("private: remove the owner's session -> not found", refused(r, 'Session not found') && !(await db.collection('workerSessions').findOne({ _id: done }))?.hidden, r.text.slice(0, 160));
    r = await act(member, 'unhideSessionAction', pid, done);
    check("private: unhide the owner's session -> not found", refused(r, 'Session not found'), r.text.slice(0, 160));
    check("private: none of that queued a job on the owner's computer", (await jobs()) === jobs0);
    r = await act(member, 'startOptionsAction', pid);
    check("private: the Start picker lists none of the owner's folders or computers", r.text.includes('"ok":true') && !r.text.includes('owner-secret-folder') && !r.text.includes('owner-private-pc'), r.text.slice(0, 160));
    r = await act(member, 'startProjectsAction');
    check("private: the Start project list counts none of the owner's folders", r.text.includes('"ok":true') && !/"name":"Auth Private Launcher"[^}]*"folders":[1-9]/.test(r.text), r.text.slice(0, 160));

    // Dispatcher: a task given to Claude by the member runs only on the member's computer.
    const tref = (await call('add_task', { title: 'auth private dispatch', project: 'Auth Private Launcher' })).created.ref;
    r = await act(member, 'markOptionsAction', String(tref));
    check("private: Give to Claude offers a member none of the owner's folders", r.text.includes('"ok":true') && !r.text.includes('owner-secret-folder'), r.text.slice(0, 160));
    r = await act(member, 'giveToClaudeAction', String(tref));
    check("private: Give to Claude with only the owner's folder -> refused", refused(r, 'Link a folder'), r.text.slice(0, 160));
    const mkey = 'wkr_' + randomBytes(32).toString('base64url');
    const mdev = randomUUID();
    await db.collection('devices').insertOne({ _id: mdev, name: 'member-pc', ownerId: invitee, orgId: ME.orgId, hash: sha(mkey), prefix: mkey.slice(0, 8), createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, worker: { version: '0.1.0', os: 'win32', allowPrompts: true } });
    await db.collection('workerFolders').insertOne({ ...folder(mdev, 'fM', 'member-folder', pid), ownerId: invitee, orgId: ME.orgId });
    r = await act(member, 'giveToClaudeAction', String(tref));
    const marked = await db.collection('tasks').findOne({ ref: tref });
    check('private: Give to Claude records who gave it', r.text.includes('"ok":true') && marked?.claude?.markedByUserId === invitee, r.text.slice(0, 160));
    // Each person's dispatcher reads a note of their own first.
    await db.collection('notes').insertOne({ _id: 'n-auth-member', title: 'Member rules', blocks: [], body: 'x', parentId: null, taskId: null, projectId: null, archived: false, createdBy: { kind: 'user', userId: invitee }, createdAt: new Date(), updatedBy: { kind: 'user', userId: invitee }, updatedAt: new Date(), deletedAt: null, ownerId: invitee, visibility: 'private' });
    r = await act(member, 'dispatcherSettingsAction', { boilerplateNoteId: 'n-auth' });
    check("boilerplate: a member cannot pick the owner's (shared) note", refused(r, 'your own notes'), r.text.slice(0, 160));
    await db.collection('settings').updateOne({ _id: `dispatcher:${invitee}` }, { $set: { enabled: true, maxConcurrent: 3, boilerplateNoteId: 'n-auth' } }, { upsert: true });
    r = await act(member, 'markOptionsAction', String(tref));
    check("boilerplate: a setting pointing at someone else's note counts as off", r.text.includes('"dispatcherOn":false'), r.text.slice(0, 200));
    for (const [u, n] of [[ME.userId, 'n-auth'], [invitee, 'n-auth-member']]) await db.collection('settings').updateOne({ _id: `dispatcher:${u}` }, { $set: { enabled: true, maxConcurrent: 3, boilerplateNoteId: n } }, { upsert: true });
    await api(own.key, 'GET', '/api/worker/jobs');
    check("private: the owner's computer does not claim the member's task", (await db.collection('tasks').findOne({ ref: tref }))?.claude?.state === 'queued');
    await api(mkey, 'GET', '/api/worker/jobs');
    const claimed = await db.collection('tasks').findOne({ ref: tref });
    check("private: the member's computer claims it", claimed?.claude?.state === 'running' && claimed?.claude?.deviceId === mdev, JSON.stringify(claimed?.claude));
    const owner = (await signIn(EMAIL, PW)).j.header();
    r = await act(owner, 'takeBackFromClaudeAction', String(tref), true);
    check("private: the owner cannot take back (stop) the member's Claude task", refused(r, 'Task not found') && (await db.collection('tasks').findOne({ ref: tref }))?.claude?.state === 'running', r.text.slice(0, 160));

    // Someone else changes what Claude reads: the run is taken back, its session stopped, the giver told; the edit stays.
    const run = await db.collection('tasks').findOne({ ref: tref });
    check("take back: the claim made the session on the member's computer", !!(await db.collection('workerSessions').findOne({ _id: run.claude.sessionId, deviceId: mdev })));
    const stops = () => db.collection('workerJobs').countDocuments({ deviceId: mdev, kind: 'stop' });
    const stops0 = await stops();
    await call('update_task', { task: tref, title: 'auth private dispatch, edited by the owner' });
    const back = await db.collection('tasks').findOne({ ref: tref });
    check("take back: the owner's title edit ends the member's Claude run", back?.claude?.state === 'stopped' && /changed by/.test(back.claude.note ?? '') && back.title === 'auth private dispatch, edited by the owner', JSON.stringify(back?.claude));
    check("take back: ...and stops the session on the member's computer", (await stops()) === stops0 + 1);
    const told = async () => (await rawDb.collection('notifications').find({ userId: invitee, kind: 'claude_stopped' }).toArray()).filter(n => n.title.startsWith(`#${tref} changed by `) && n.title.endsWith(', taken back from Claude'));
    check('take back: the member gets one notice', (await told()).length === 1, JSON.stringify((await told()).map(n => n.title)));
    const mkeyChat = await mkKey({ agent: 'claude', userId: invitee, orgId: ME.orgId, name: 'auth member chat' });
    r = await act(member, 'giveToClaudeAction', String(tref));
    check('take back: the member can give it to Claude again', r.text.includes('"ok":true'), r.text.slice(0, 160));
    const own1 = await mcpAs(mkeyChat, 'add_comment', { task: tref, note: 'member note to their own Claude' });
    check("take back: the giver's own (Claude's) comment leaves it queued", !own1.isError && (await db.collection('tasks').findOne({ ref: tref }))?.claude?.state === 'queued', own1.text.slice(0, 160));
    await call('add_comment', { task: tref, note: 'owner comment' });
    check("take back: someone else's comment takes a queued task back", (await db.collection('tasks').findOne({ ref: tref }))?.claude?.state === 'stopped');
    check('take back: ...with a second notice', (await told()).length === 2);
    r = await act(member, 'giveToClaudeAction', String(tref));
    await call('update_task', { task: tref, priority: 'P1' });
    check('take back: a priority change is not task text (stays queued)', (await db.collection('tasks').findOne({ ref: tref }))?.claude?.state === 'queued');
    await call('update_checklist', { task: tref, add: ['owner step'] });
    check('take back: new checklist text takes it back', (await db.collection('tasks').findOne({ ref: tref }))?.claude?.state === 'stopped');
    for (const u of [ME.userId, invitee]) await db.collection('settings').updateOne({ _id: `dispatcher:${u}` }, { $set: { enabled: false } });
  }

  // ======== 7d. per-account limit on failed sign-in steps ========
  {
    const email = 'e2e-lock@example.test';
    await makeUser({ email, name: 'Lock Me', orgName: 'Lock Org' });
    for (let i = 0; i < 10; i++) await signIn(email, 'wrong-password-' + i);
    const locked = await signIn(email, PW);
    check('limit: 10 wrong passwords lock the account, even for the right one (429)', locked.status === 429, locked.status);
    check('limit: another account is not affected', (await signIn(EMAIL, PW)).status === 200);
    check('limit: stored as a hash, not the address', !(await db.collection('authLimits').findOne({ key: { $regex: 'e2e-lock' } })));

    const tfa = 'e2e-2fa@example.test';
    for (let i = 0; i < 10; i++) {
      const s = await signIn(tfa, PW);
      await authApi(s.j, '/two-factor/verify-totp', { code: '000000' });
    }
    const s = await signIn(tfa, PW);
    const v = await authApi(s.j, '/two-factor/verify-totp', { code: '123456' });
    check('limit: 10 wrong codes lock the code step for that account (429)', v.status === 429, `${v.status} ${v.text.slice(0, 80)}`);
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
