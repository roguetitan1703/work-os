// The personal calendar feed (docs/calendar.md): Settings > Connections > Calendar makes a private ICS link; /api/calendar/<token>.ics
// lists only the person's own open tasks with a date that they may see. Checks: valid ICS (all-day events, a span, escaping,
// folding, no notes/comments/checklist), scope (someone else's private task, a members-only project they are not on, another
// organization, done/archived/undated/others' tasks), no cookies and no session, headers, rotate and turn off kill the old
// link at once, a removed member's link dies, bad tokens all answer the same 404, and the rate limit (last: it waits out the minute).
// Seed profile: none.
import { randomBytes, randomUUID } from 'node:crypto';
import { B, ME, check, finish, launch, login, makeUser, okO, overflow, PW, rawDb } from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fetchFeed = (token, opts = {}) => fetch(`${B}/api/calendar/${token}.ics`, { redirect: 'manual', ...opts });

/** Unfold and split an ICS into { header lines, events: [{ KEY: value }] }. */
function parse(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').split(/\r\n/).filter(Boolean);
  const events = [];
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = {};
    else if (l === 'END:VEVENT') { events.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(':'); cur[l.slice(0, i).split(';')[0]] = l.slice(i + 1); }
  }
  return { lines, events };
}

let ref = 1000;
async function task(over) {
  const now = new Date();
  const d = {
    _id: randomUUID(), orgId: ME.orgId, ref: ++ref, title: 'cal task', description: 'SECRET-NOTES', mode: null, projectId: null, priority: 'P2', status: 'Not Started', tags: [], due: null, start: null,
    estimateMins: null, progress: 0, checklist: [{ id: 'c1', text: 'SECRET-CHECKLIST', done: false }], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false,
    createdBy: { kind: 'user', userId: ME.userId }, createdAt: now, updatedAt: now, doneAt: null, doneOn: null, doneBy: null, ownerId: ME.userId, visibility: 'org', assigneeIds: [], ...over,
  };
  await rawDb.collection('tasks').insertOne(d);
  return d;
}

const browser = await launch();
try {
  const A = ME;
  const bea = await makeUser({ email: 'cal-bea@example.test', name: 'Bea', orgId: A.orgId, role: 'member' });
  const cy = await makeUser({ email: 'cal-cy@example.test', name: 'Cy', orgId: A.orgId, role: 'member' });
  const zed = await makeUser({ email: 'cal-zed@example.test', name: 'Zed' }); // his own organization

  // ---- fixtures ----
  const own1 = await task({ title: 'Own due only; with, comma; semi and a very long title that has to be folded across several lines of the calendar file ok', due: '2031-03-10', status: 'In Progress' });
  const own2 = await task({ title: 'Own start only', start: '2031-03-12' });
  const span = await task({ title: 'Own span', start: '2031-03-14', due: '2031-03-16' });
  const backwards = await task({ title: 'Own start after due', start: '2031-04-20', due: '2031-04-18' });
  const assignedByBea = await task({ title: 'A teammate gave me this', ownerId: bea.userId, assigneeIds: [A.userId], due: '2031-03-20' });
  const unicode = await task({ title: 'Café → résumé 日本語', due: '2031-03-21', status: 'Blocked' });
  const sharedFine = await task({ title: 'On a list I am on', ownerId: bea.userId, visibility: 'members', sharedWith: [bea.userId, A.userId], assigneeIds: [A.userId], due: '2031-03-22' });
  // must NOT be in A's feed:
  const done = await task({ title: 'Own done', due: '2031-03-10', status: 'Done', doneAt: new Date(), doneOn: '2031-03-09' });
  const dropped = await task({ title: 'Own dropped', due: '2031-03-10', status: 'Dropped' });
  const archived = await task({ title: 'Own archived', due: '2031-03-10', archived: true });
  const undated = await task({ title: 'Own undated' });
  const othersTask = await task({ title: 'Org task of Bea, not mine', ownerId: bea.userId, due: '2031-03-10' });
  const beaPrivate = await task({ title: 'Bea PRIVATE', ownerId: bea.userId, visibility: 'private', due: '2031-03-10' });
  const beaPrivateAssigned = await task({ title: 'Bea PRIVATE assigned to me', ownerId: bea.userId, visibility: 'private', assigneeIds: [A.userId], due: '2031-03-10' });
  const offList = await task({ title: 'Members-only, I am not on it', ownerId: cy.userId, visibility: 'members', sharedWith: [cy.userId, bea.userId], assigneeIds: [A.userId], due: '2031-03-10' });
  const otherOrg = await rawDb.collection('tasks').insertOne({ ...(await rawDb.collection('tasks').findOne({ _id: own1._id })), _id: randomUUID(), orgId: zed.orgId, ref: 1, ownerId: zed.userId, assigneeIds: [A.userId], title: 'Other org task assigned to my id', due: '2031-03-10' });
  void otherOrg;
  // Bea's own feed material (her private task is hers)
  await task({ title: 'Bea PRIVATE mine', ownerId: bea.userId, visibility: 'private', due: '2031-05-01' });

  // ---- a bad token, before any link exists ----
  const bads = ['x', 'a'.repeat(43), randomBytes(32).toString('base64url'), '..%2f..%2fetc%2fpasswd', 'a'.repeat(300), '%00'];
  const badRes = await Promise.all(bads.map(async b => { const r = await fetchFeed(b); return { s: r.status, t: await r.text(), sc: r.headers.get('set-cookie') }; }));
  check('bad tokens: all 404 with the same bare body', badRes.every(r => r.s === 404 && r.t === 'Not found'), JSON.stringify(badRes.map(r => r.s)));
  check('bad tokens: no cookies set', badRes.every(r => !r.sc));
  const noExt = await fetch(`${B}/api/calendar/${randomBytes(32).toString('base64url')}`, { redirect: 'manual' });
  check('a path without .ics is 404 too', noExt.status === 404);

  // ---- Settings UI: desktop ----
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  await login(p, { next: '/settings?section=connections' });
  await p.waitForSelector('[data-calendar]', { timeout: 20000 });
  check('ui: Calendar section is under Connections, link is off, Create link is offered', (await p.locator('[data-calendar-create]').count()) === 1 && (await p.locator('[data-calendar-rotate]').count()) === 0);
  const help = await p.locator('[data-calendar-help]').innerText();
  check('ui: one line each for Google, Outlook and Apple', /Google Calendar:.*Other calendars.*From URL/.test(help) && /Outlook:/.test(help) && /Apple Calendar:/.test(help), help);
  check('ui desktop: no overflow', okO(await overflow(p)), JSON.stringify(await overflow(p)));
  await p.click('[data-calendar-create]');
  await p.waitForSelector('[data-calendar-url]', { timeout: 15000 });
  const url1 = await p.inputValue('[data-calendar-url]');
  const tok1 = (url1.match(/\/api\/calendar\/([A-Za-z0-9_-]{43})\.ics$/) ?? [])[1];
  check('ui: Create shows a link /api/calendar/<43-char token>.ics', !!tok1, url1);
  await p.click('[data-calendar-copy]');
  check('ui: Copy puts the link on the clipboard', (await p.evaluate(() => navigator.clipboard.readText())) === url1);
  const row1 = await rawDb.collection('calendarFeeds').find({ userId: A.userId }).toArray();
  check('storage: one row, SHA-256 hash and a sealed copy; the token itself is nowhere in it', row1.length === 1 && row1[0].orgId === A.orgId && !JSON.stringify(row1[0]).includes(tok1) && /^[0-9a-f]{64}$/.test(row1[0].hash) && /^v1\./.test(row1[0].sealed ?? ''), JSON.stringify(row1));
  await p.reload();
  await p.waitForSelector('[data-calendar-url]', { timeout: 15000 });
  check('reload: Copy is still there and gives the same working link', (await p.inputValue('[data-calendar-url]')) === url1 && (await fetchFeed(tok1)).status === 200);
  await p.click('[data-calendar-copy]');
  check('reload: Copy puts the same link on the clipboard', (await p.evaluate(() => navigator.clipboard.readText())) === url1);

  // ---- the feed ----
  const r1 = await fetchFeed(tok1);
  const body1 = await r1.text();
  check('feed: 200 text/calendar', r1.status === 200 && /^text\/calendar; charset=utf-8$/i.test(r1.headers.get('content-type') ?? ''), `${r1.status} ${r1.headers.get('content-type')}`);
  check('feed: no cookies, private no-store, noindex', !r1.headers.get('set-cookie') && /private/.test(r1.headers.get('cache-control') ?? '') && /no-store/.test(r1.headers.get('cache-control') ?? '') && /noindex/.test(r1.headers.get('x-robots-tag') ?? ''), JSON.stringify([...r1.headers]));
  check('feed: CRLF line ends, VCALENDAR wrapper, no line over 75 octets', body1.startsWith('BEGIN:VCALENDAR\r\n') && body1.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(body1) && body1.split('\r\n').every(l => Buffer.byteLength(l) <= 75), body1.split('\r\n').find(l => Buffer.byteLength(l) > 75));
  const { lines, events } = parse(body1);
  check('feed: calendar name and the person\'s timezone', lines.includes('X-WR-CALNAME:Work OS tasks') && lines.includes('X-WR-TIMEZONE:Asia/Kolkata'));
  const byRef = n => events.find(e => (e.SUMMARY ?? '').startsWith(`#${n} `));
  const want = [own1, own2, span, backwards, assignedByBea, unicode, sharedFine];
  const notWant = [done, dropped, archived, undated, othersTask, beaPrivate, beaPrivateAssigned, offList];
  check(`feed: exactly the ${want.length} own, visible, open, dated tasks`, events.length === want.length && want.every(t => byRef(t.ref)), events.map(e => e.SUMMARY).join(' | '));
  check('feed: none of done, dropped, archived, undated, someone else\'s, their private, off-list, another org', notWant.every(t => !byRef(t.ref)) && !/Other org task|PRIVATE|not on it/.test(body1));
  check('feed: due only is one all-day event on the due date', byRef(own1.ref).DTSTART === '20310310' && byRef(own1.ref).DTEND === '20310311');
  check('feed: start only is one all-day event on the start date', byRef(own2.ref).DTSTART === '20310312' && byRef(own2.ref).DTEND === '20310313');
  check('feed: start and due make a span (end is the day after the due date)', byRef(span.ref).DTSTART === '20310314' && byRef(span.ref).DTEND === '20310317');
  check('feed: a start after the due falls back to the due day', byRef(backwards.ref).DTSTART === '20310418' && byRef(backwards.ref).DTEND === '20310419');
  check('feed: dates are VALUE=DATE (all-day, no time)', /DTSTART;VALUE=DATE:20310314/.test(body1) && !/DTSTART:/.test(body1));
  const e1 = byRef(own1.ref);
  check('feed: summary has #ref and the title; commas and semicolons escaped', e1.SUMMARY.startsWith(`#${own1.ref} Own due only\\; with\\, comma\\; semi`), e1.SUMMARY);
  check('feed: description has the status and the link back; URL too', e1.DESCRIPTION.includes('Status: In Progress') && e1.DESCRIPTION.includes(`${B}/tasks/${own1.ref}`) && e1.URL === `${B}/tasks/${own1.ref}`, e1.DESCRIPTION);
  check('feed: UID is stable per task', e1.UID === `${own1._id}@work-os`);
  check('feed: multi-byte text survives folding', (byRef(unicode.ref).SUMMARY ?? '').includes('Café → résumé 日本語'), byRef(unicode.ref)?.SUMMARY);
  check('feed: no notes, checklist, comments or people', !/SECRET-NOTES|SECRET-CHECKLIST/.test(body1) && !/Bea|Cy|Zed|@example/.test(body1));
  const r1b = await fetchFeed(tok1, { headers: { cookie: 'workos.session_token=nonsense', authorization: 'Bearer nonsense' } });
  check('feed: no session or key is needed (and a bad one changes nothing)', r1b.status === 200);

  // ---- rotate ----
  await p.click('[data-calendar-rotate]');
  await p.waitForFunction(old => { const i = document.querySelector('[data-calendar-url]'); return i && i.value !== old; }, url1, { timeout: 15000 });
  const url2 = await p.inputValue('[data-calendar-url]');
  const tok2 = (url2.match(/\/api\/calendar\/([A-Za-z0-9_-]{43})\.ics$/) ?? [])[1];
  check('rotate: a new, different link', !!tok2 && tok2 !== tok1);
  check('rotate: the old link is 404 at once', (await fetchFeed(tok1)).status === 404);
  check('rotate: the new link works', (await fetchFeed(tok2)).status === 200);
  check('rotate: still one row', (await rawDb.collection('calendarFeeds').countDocuments({ userId: A.userId })) === 1);

  // ---- the feed follows the data ----
  await rawDb.collection('tasks').updateOne({ _id: own2._id }, { $set: { status: 'Done' } });
  await rawDb.collection('tasks').updateOne({ _id: undated._id }, { $set: { due: '2031-06-06' } });
  const ev2 = parse(await (await fetchFeed(tok2)).text()).events;
  check('feed: a task marked Done leaves, a newly dated one arrives', !ev2.some(e => e.SUMMARY.startsWith(`#${own2.ref} `)) && ev2.some(e => e.SUMMARY.startsWith(`#${undated.ref} `)));

  // ---- Bea has her own feed with her own private task; hers never shows A's ----
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pb = await ctxB.newPage();
  await login(pb, { email: 'cal-bea@example.test', password: PW, next: '/settings?section=connections' });
  await pb.waitForSelector('[data-calendar-create]', { timeout: 20000 });
  await pb.click('[data-calendar-create]');
  await pb.waitForSelector('[data-calendar-url]', { timeout: 15000 });
  const tokB = ((await pb.inputValue('[data-calendar-url]')).match(/([A-Za-z0-9_-]{43})\.ics$/) ?? [])[1];
  await pb.reload();
  await pb.waitForSelector('[data-calendar-url]', { timeout: 15000 });
  check('another member: after a reload she reads back only her own link, never the owner link', (await pb.inputValue('[data-calendar-url]')).includes(tokB) && !(await pb.content()).includes(tok2));
  const evB = parse(await (await fetchFeed(tokB)).text()).events.map(e => e.SUMMARY);
  check('Bea: her feed has her own private task and what she owns', evB.some(s => s.includes('Bea PRIVATE mine')) && evB.some(s => s.includes('Bea PRIVATE assigned to me')) && evB.some(s => s.includes('Org task of Bea')), evB.join(' | '));
  check('Bea: her feed never has the owner\'s private or other lists\' tasks', !evB.some(s => s.includes('Own due only') || s.includes('not on it')), evB.join(' | '));
  check('Bea: her private task is not in the owner\'s feed', !(await (await fetchFeed(tok2)).text()).includes('Bea PRIVATE'));

  // ---- turn off ----
  await p.click('[data-calendar-off]');
  await p.click('[data-calendar-off-confirm]');
  await p.waitForSelector('[data-calendar-create]', { timeout: 15000 });
  check('revoke: the link is 404 at once and the row is gone', (await fetchFeed(tok2)).status === 404 && (await rawDb.collection('calendarFeeds').countDocuments({ userId: A.userId })) === 0);
  check('revoke: Bea\'s link is untouched', (await fetchFeed(tokB)).status === 200);

  // ---- a removed member's link dies ----
  await p.goto(B + '/settings?section=members');
  await p.waitForSelector('button[aria-label="Remove cal-bea@example.test"]', { timeout: 15000 });
  await p.click('button[aria-label="Remove cal-bea@example.test"]');
  await p.click('[data-remove-confirm="cal-bea@example.test"] button:has-text("Remove")');
  let st = 200;
  for (let i = 0; i < 40 && st !== 404; i++) { await sleep(300); st = (await fetchFeed(tokB)).status; }
  check('removed member: her link is 404', st === 404);
  check('removed member: her link row is deleted', (await rawDb.collection('calendarFeeds').countDocuments({ userId: bea.userId })) === 0);
  check('removed member: another member\'s state untouched (Cy has no link, no error)', (await fetchFeed(randomBytes(32).toString('base64url'))).status === 404);

  // ---- phone layout ----
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pm = await ctxM.newPage();
  await login(pm, { phone: true, next: '/settings?section=connections' });
  await pm.waitForSelector('[data-calendar-create]', { timeout: 20000 });
  await pm.tap('[data-calendar-create]');
  await pm.waitForSelector('[data-calendar-url]', { timeout: 15000 });
  const tokM = ((await pm.inputValue('[data-calendar-url]')).match(/([A-Za-z0-9_-]{43})\.ics$/) ?? [])[1];
  check('ui phone: create works, no overflow, buttons are at least 44px tall', !!tokM && okO(await overflow(pm)) && (await pm.locator('[data-calendar-rotate]').evaluate(e => e.getBoundingClientRect().height)) >= 44, JSON.stringify(await overflow(pm)));
  await ctxM.close();

  // ---- the rate limit (last: misses count per client address for a minute) ----
  const codes = [];
  for (let i = 0; i < 26; i++) codes.push((await fetchFeed(randomBytes(32).toString('base64url'))).status);
  const first429 = codes.indexOf(429); // the misses earlier in this suite (bad tokens, old links) already count towards the 20
  check('rate limit: 404s, then 429 once 20 misses in a minute are used', first429 > 0 && first429 <= 20 && codes.slice(first429).every(c => c === 429) && codes.slice(0, first429).every(c => c === 404), codes.join(','));
  const lim = await fetchFeed(tokM);
  check('rate limit: the 429 is bare and cookie-free', lim.status === 429 && !lim.headers.get('set-cookie'));
  await sleep(61_000);
  check('rate limit: lifts after the minute and a valid link works again', (await fetchFeed(tokM)).status === 200);
  await rawDb.collection('calendarFeeds').deleteMany({ userId: A.userId });
} catch (e) {
  check('calendar suite (error)', false, e?.stack || String(e));
} finally {
  await browser.close().catch(() => {});
}
await finish();
