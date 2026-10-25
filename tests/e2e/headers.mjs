// Security headers and link schemes (red-team R2-01). Every page carries a Content-Security-Policy with a fresh nonce
// (proxy.ts) and the static headers from next.config.ts; Next's inline scripts carry that nonce, and the app runs with no
// CSP violation on Today, a task, a note (BlockNote), Settings, Claude and the sign-in page. /_next/image is off.
// A task link must be http(s) or mailto: javascript:, data: and vbscript: are refused through MCP and through the task
// page (a server action). Seed profile: none.
import { B, rawDb, check, finish, launch, login, call } from './lib.mjs';

const get = (p, o = {}) => fetch(B + p, { redirect: 'manual', ...o }).then(async r => ({ status: r.status, h: r.headers, text: await r.text() }));
const nonceOf = csp => csp?.match(/'nonce-([^']+)'/)?.[1] ?? null;

// ---- 1. headers on a page (no session needed: the sign-in page) ----
let r = await get('/login');
const csp = r.h.get('content-security-policy');
const nonce = nonceOf(csp);
check('login: Content-Security-Policy with a nonce', r.status === 200 && !!nonce, csp ?? 'none');
check("login: CSP scripts only by nonce ('strict-dynamic', no 'unsafe-inline' for scripts)", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/.test(csp ?? ''), csp ?? '');
for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) check(`login: CSP ${d}`, (csp ?? '').includes(d));
check('login: X-Frame-Options DENY', r.h.get('x-frame-options') === 'DENY', r.h.get('x-frame-options'));
check('login: X-Content-Type-Options nosniff', r.h.get('x-content-type-options') === 'nosniff');
check('login: Referrer-Policy strict-origin-when-cross-origin', r.h.get('referrer-policy') === 'strict-origin-when-cross-origin', r.h.get('referrer-policy'));
check('login: Permissions-Policy turns off camera, microphone, geolocation', /camera=\(\).*microphone=\(\).*geolocation=\(\)/.test(r.h.get('permissions-policy') ?? ''), r.h.get('permissions-policy'));
const scripts = [...r.text.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]);
const bad = scripts.filter(a => !a.includes(`nonce="${nonce}"`));
check(`login: every <script> carries this request's nonce (${scripts.length})`, scripts.length > 0 && bad.length === 0, bad.slice(0, 2).join(' | '));
const r2 = await get('/login');
check('login: a new nonce on every request', nonceOf(r2.h.get('content-security-policy')) !== nonce);
r = await get('/login/reset');
check('reset page: Referrer-Policy stays no-referrer', r.h.get('referrer-policy') === 'no-referrer', r.h.get('referrer-policy'));
check('reset page: still framed by nobody', r.h.get('x-frame-options') === 'DENY');
r = await get('/today');
check('signed out: /today redirects to sign-in (proxy gate unchanged)', r.status === 307 && (r.h.get('location') ?? '').includes('/login'), `${r.status} ${r.h.get('location')}`);
r = await get('/api/live');
check('API: static headers too (nosniff)', r.h.get('x-content-type-options') === 'nosniff');

// ---- 2. image optimization is off ----
r = await get('/_next/image?url=%2Ficons%2F192&w=64&q=75');
check('/_next/image optimizes nothing (404)', r.status === 404, r.status);
r = await get('/icons/192');
check('app icons (assets/brand, built statically) still served', r.status === 200 && (r.h.get('content-type') ?? '').startsWith('image/png'), `${r.status} ${r.h.get('content-type')}`);

// ---- 3. link schemes through MCP ----
const BAD = ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///c:/windows/win.ini', 'javascript:1;alert(1)', 'data:1,x'];
for (const u of BAD) {
  const x = await call('add_task', { title: 'Bad link ' + u.slice(0, 12), links: [u] });
  check(`mcp add_task refuses ${JSON.stringify(u.slice(0, 24))}`, !!x.ERROR && /http, https and mailto/.test(x.ERROR), JSON.stringify(x).slice(0, 160));
}
check('mcp: nothing stored for the refused links', (await rawDb.collection('tasks').countDocuments({ title: /^Bad link / })) === 0);
const good = await call('add_task', { title: 'Good links', links: ['example.com/a', 'https://example.com/b', 'http://example.com/c', 'mailto:someone@example.com', 'localhost:3000/x'] });
const gt = await call('get_task', { task: good.created?.ref });
check('mcp: http(s), mailto and bare hosts kept (bare gets https://)', JSON.stringify(gt.links?.map(l => l.url)) === JSON.stringify(['https://example.com/a', 'https://example.com/b', 'http://example.com/c', 'mailto:someone@example.com', 'https://localhost:3000/x']), JSON.stringify(gt.links ?? gt).slice(0, 300));
let x = await call('update_task', { task: good.created.ref, links: ['https://example.com/ok', 'javascript:alert(1)'] });
check('mcp update_task refuses a javascript: link', !!x.ERROR, JSON.stringify(x).slice(0, 160));
x = await call('apply_changes', { ops: [{ op: 'create_task', title: 'Bad via batch', links: ['javascript:alert(1)'] }] });
check('mcp apply_changes (create_task) refuses a javascript: link', JSON.stringify(x).includes('http, https and mailto') && (await rawDb.collection('tasks').countDocuments({ title: 'Bad via batch' })) === 0, JSON.stringify(x).slice(0, 200));
check('mcp: links unchanged after the refusals', (await rawDb.collection('tasks').findOne({ ref: good.created.ref }))?.links?.length === 5);

// ---- 4. pages: no CSP violation, and the task page (a server action) refuses a javascript: link ----
const note = await call('write_note', { task: good.created.ref, title: 'CSP note', body: '# CSP note\n\nSome **text** and a [link](https://example.com).' });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const violations = [];
p.on('console', m => { if (/Content Security Policy|Refused to (execute|load|apply|connect)/i.test(m.text())) violations.push(m.text().slice(0, 200)); });
p.on('pageerror', e => violations.push('pageerror: ' + String(e).slice(0, 200)));
await login(p);
const pages = ['/today', `/tasks/${good.created.ref}`, '/settings', '/claude', '/tasks', ...(note?.created?.id ? [`/notes/${note.created.id}`] : [])];
for (const path of pages) {
  const before = violations.length;
  const resp = await p.goto(B + path);
  await p.waitForLoadState('networkidle').catch(() => {});
  check(`${path}: CSP header present`, !!resp && !!nonceOf(resp.headers()['content-security-policy']));
  check(`${path}: no CSP violation or page error`, violations.length === before, violations.slice(before).join(' || '));
}
if (pages.some(q => q.startsWith('/notes/'))) check('note page: the editor rendered', (await p.locator('.bn-editor, [contenteditable=true]').count()) > 0);
else check('note page: write_note returned a note id', false, JSON.stringify(note).slice(0, 200));

await p.goto(B + `/tasks/${good.created.ref}`);
const input = p.locator('input[placeholder="Paste a URL…"]');
await input.fill('javascript:alert(document.domain)');
await input.press('Enter');
const toast = p.locator('[data-sonner-toast]');
await toast.first().waitFor({ timeout: 8000 }).catch(() => {});
const toasts = (await toast.allInnerTexts()).join(' | ');
check('task page: adding a javascript: link shows the refusal', /http, https and mailto|web address/i.test(toasts), toasts);
const after = await rawDb.collection('tasks').findOne({ ref: good.created.ref });
check('task page: the javascript: link was not stored', after.links.length === 5 && !after.links.some(l => /^javascript:/i.test(l.url)), JSON.stringify(after.links));
await input.fill('example.org/page');
await input.press('Enter');
let ok = false;
for (let i = 0; i < 40 && !ok; i++) { ok = ((await rawDb.collection('tasks').findOne({ ref: good.created.ref }))?.links ?? []).some(l => l.url === 'https://example.org/page'); if (!ok) await p.waitForTimeout(200); }
check('task page: a plain link is still added (https:// added)', ok);
check('task page: the new link shows', await p.locator('a[href="https://example.org/page"]:visible').first().waitFor({ timeout: 8000 }).then(() => true, () => false));
check('pages: no CSP violation in the whole run', violations.length === 0, violations.join(' || '));
// The CSP itself stops a javascript: URL, whatever renders it (a note's markdown link is drawn by BlockNote, not React).
await p.goto(B + `/notes/${note.created.id}`);
await p.locator('.bn-editor').first().waitFor({ timeout: 15000 }).catch(() => {});
const raw = await p.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(h => /^\s*javascript:/i.test(h) && !h.includes('React has blocked')));
console.log('note page: raw javascript: hrefs drawn by the editor:', JSON.stringify(raw));
const before = violations.length;
await p.evaluate(() => { const a = document.createElement('a'); a.href = 'javascript:window.__pwned=1'; document.body.appendChild(a); a.click(); a.remove(); });
await p.waitForTimeout(500);
check('CSP: a javascript: link does not run when clicked', (await p.evaluate(() => window.__pwned)) === undefined);
check('CSP: and the browser reports the block', violations.length > before, 'no violation logged');
await browser.close();
await finish();
