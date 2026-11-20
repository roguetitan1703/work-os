// UI tour: a capture suite for a design reviewer. Few checks, many screenshots.
// Seeds a realistic week (5 projects, ~30 tasks, a teammate, 4 Needs, 4 Claude sessions, 3 notes, What's new on), then
// photographs every screen at 390x844 (phone) and 1280x800, light and dark, and walks 10 everyday jobs, shot by shot.
// Output (next to E2E_SHOTS): shots/*.png, index.md, findings.md (functional problems), jobs.md.
// Not run by default: name it (tests/e2e/run.sh ui-tour). Seed profile: none; server mode: whatsnew.
import fs from 'node:fs';
import path from 'node:path';
import { ME, B, SP, EMAIL, check, finish, launch, login, overflow, okO, rawDb, call, makeUser } from './lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const OUT = path.dirname(SP);
const findings = [];
const searchLog = [];
const controls = [
  'Review Need: buttons Accept, Send back (disabled until a reason is typed in the note box) and, when the hand-in left things, Accept and file what is left (components/needs.tsx, data-need-option).',
  'Give to Claude, phone: task page, ... (More actions) at the top right, then Give to Claude, then a sheet with a Give to Claude button. Desktop: a Give to Claude button on the task page, or a hover-only Bot icon on the task row. Needs a folder linked to the project (else the sheet says Link a folder first).',
  'Add task with due date: phone + sheet has Due chips (Today, Tomorrow, Friday, Next week), Priority chips, Project chips and Add task / Add & open; no Assignee. Desktop: inline bar with tokens (due:fri), Shift+Enter opens the details form with date pickers for Start and Due; no Assignee. Assignee only on the task page (Assigned row, Who does it sheet).',
  'Desktop task row: no ... menu. Controls: progress button, hover-only Bot (Give to Claude), Priority select, Status select. Phone row: Actions for (task) button opens the task actions sheet.',
  'Declutter: project page ... menu (Project menu), then Declutter. Import: Today, More, Import tasks. Day plan: Today, Schedule button (only with a schedule).',
];
const index = [];
const note = (where, what) => { findings.push(`- [${where}] ${what}`); console.log('FINDING', where, what); };
const now = new Date();
const mins = n => new Date(Date.now() - n * 60000);

// ---------------------------------------------------------------- seed
const placed = { orgId: ME.orgId, ownerId: ME.userId, visibility: 'org' };
const must = async (n, a) => { const r = await call(n, a); if (r?.ERROR) throw new Error(`${n}: ${r.ERROR.slice(0, 200)}`); return r; };
const line = (i, text, by = ME.userId, extra = {}) => ({ id: `l_${i}${Math.random().toString(16).slice(2, 6)}`, text, by, at: mins(60 * 3 + i * 40), ...extra });
const dec = (i, text) => ({ id: `d_${i}`, at: mins(60 * 24 * i), by: ME.userId, via: 'app', text });

const P = {
  kestrel: { id: 'kestrel-billing', name: 'Kestrel Billing', client: 'Acme Dental', description: 'Invoicing and payout reconciliation for the Acme Dental clinic chain.' },
  site: { id: 'delpat-website', name: 'Delpat Website', client: '', description: 'The public Delpat site: pricing, case studies, blog.' },
  wos: { id: 'work-os', name: 'Work OS', client: '', description: 'Our own work tracker for people and their Claude sessions.' },
  maple: { id: 'maple-studio', name: 'Maple Studio', client: 'Maple Studio', description: 'Packaging redesign for a home-bakery brand.' },
  admin: { id: 'founder-admin', name: 'Founder Admin', client: '', description: 'Taxes, renewals, hiring, the odd chore.' },
};
const STATES = {
  kestrel: {
    now: 'Get the October payout reconciliation to zero unmatched lines before Acme finance closes the books on Friday: 14 lines are still unmatched, 9 of them refunds that arrive as negative invoices, and the webhook retries are making it worse by double-posting invoice.paid.',
    next: ['Fix duplicate invoice.paid webhook retries (idempotency key per event id)', 'Tag refunds as their own type in the payout export', 'Add the GST breakup to the invoice PDF', 'Send the revised quote to Acme with the two-clinic discount', 'Write the front-desk rollout note, one page, no jargon'],
    later: ['Move payout export to a nightly job once Friday is over (waits on the books closing)', 'Let clinics download their own statements', 'Add a sandbox mode for the Acme developer', 'Replace the PDF library: it breaks on Devanagari names', 'Dark mode for the statement page', 'Audit log for who edited an invoice'],
    decisions: ['Refunds stay negative invoices until Friday; we do not change the data model during close.', 'Webhook handler becomes idempotent by event id, not by invoice number.', 'GST breakup shows CGST and SGST separately, as Acme asked.'],
  },
  site: {
    now: 'Ship the new pricing page: three plans, one honest comparison table, and the case study for Anaspure above the fold. Copy is the last open piece.',
    next: ['Rewrite pricing page copy', 'Compress the hero video under 2 MB', 'Fix the mobile nav overlap at 360px', 'Case study: Anaspure webhook demo'],
    later: ['Blog: why we build in the open', 'Add a changelog page', 'Analytics without cookies', 'Translate the home page to Hindi', 'Press kit download', 'Fix the footer link colours in dark mode'],
    decisions: ['Pricing shows monthly first, yearly as a toggle.', 'No chat widget on the site.'],
  },
  wos: {
    now: 'Make Work OS something Akash and Om open every morning without friction: Needs on the phone, sessions that show what they are doing, and a Today page that fits on one screen.',
    next: ['Check the new Needs page on a real phone', 'Review the hand-in for the notes search fix', 'Move the alert cron to a systemd timer', 'Write the Monday digest wording', 'Cut dead CSS from globals'],
    later: ['Offline notes', 'Calendar two-way sync (waits on Google review)', 'Per-project colours', 'Voice capture from the + sheet', 'Export a project to markdown', 'Slack mirror of Needs'],
    decisions: ['Needs are answered by people only, never by an MCP tool.', 'Phone first: every screen is checked at 390 before desktop.', 'Sessions show the task they are on, not their id.'],
  },
  maple: {
    now: 'Close out packaging phase 1 with Riya: moodboard v2 and the quote for the redesign, so phase 2 can start in December.',
    next: ['Send moodboard v2 to Riya', 'Quote for the packaging redesign', 'Collect brand fonts from the client', 'Book the photographer for 12 Dec'],
    later: ['Label printing vendor shortlist', 'Instagram grid plan', 'Gift box dimensions', 'Sample pack for the pop-up', 'Packaging sustainability note', 'Second round of colour tests'],
    decisions: ['Kraft paper stock, matte lamination.', 'Two label sizes, not three.'],
  },
  admin: {
    now: 'Stay clean on taxes: October GST return filed, advance tax paid before the 15th.',
    next: ['File the GST return for October', 'Reply to the CA about advance tax', 'Renew the delpat.in domain', 'Plan Q1 hiring'],
    later: ['New office chair', 'Review insurance', 'Move invoices to one folder', 'Set up a petty cash sheet', 'Annual domain audit', 'Hardware inventory'],
    decisions: ['Hire one more builder in Q1, not two.'],
  },
};

// [title, project key, extra fields, how it ends: 'done' completes it]
const TASKS = [
  ['Reconcile Kestrel invoices against Razorpay payouts', 'kestrel', { priority: 'P1', due: 'today', assignee: 'me', status: 'In Progress', mode: 'Client Delivery', checklist: ['Export October payouts', 'Match the 14 unmatched lines', 'Send mismatches to Acme finance'], subtasks: [{ title: 'Pull the payout CSV' }, { title: 'Tag refunds as their own type', status: 'In Progress' }, { title: 'Write the summary for Acme' }] }],
  ['Fix duplicate webhook retries on invoice.paid', 'kestrel', { priority: 'P1', due: '-2d', assignee: 'me', status: 'In Progress', mode: 'Code & Dev' }],
  ['Send revised quote to Acme Dental', 'kestrel', { priority: 'P2', due: 'tomorrow', assignee: 'me', mode: 'Client Delivery' }],
  ['Add GST breakup to the invoice PDF', 'kestrel', { priority: 'P2', due: '+4d', assignee: 'priya@example.test', mode: 'Code & Dev' }],
  ['Client call: confirm the go-live date', 'kestrel', { priority: 'P2', due: '+2d', assignee: 'me', status: 'Blocked', blocked_reason: 'Waiting for Dr. Mehta to confirm the clinic closure dates' }],
  ['Archive 2024 test invoices', 'kestrel', { priority: 'P4' }],
  ['Write the rollout note for the Acme front desk', 'kestrel', { priority: 'P3', due: '+6d', assignee: 'priya@example.test', checklist: ['One page', 'Screenshots of the three screens they use'] }],
  ['Rewrite pricing page copy', 'site', { priority: 'P2', due: 'today', assignee: 'me', mode: 'Growth' }],
  ['Compress hero video to under 2 MB', 'site', { priority: 'P3', due: '+3d', assignee: 'priya@example.test' }],
  ['Fix mobile nav overlap at 360px', 'site', { priority: 'P1', due: '-1d', assignee: 'me', mode: 'Code & Dev' }],
  ['Add case study: Anaspure webhook demo', 'site', { priority: 'P3', due: '+9d' }],
  ['Publish blog: why we build in the open', 'site', { priority: 'P2' }, 'done'],
  ['Check the new Needs page on a real phone', 'wos', { priority: 'P2', due: 'today', assignee: 'me', status: 'In Progress', mode: 'Code & Dev' }],
  ['Move the alert cron to a systemd timer', 'wos', { priority: 'P3', due: '+5d' }],
  ['Review the hand-in for the notes search fix', 'wos', { priority: 'P1', due: 'today', assignee: 'me', mode: 'Code & Dev' }],
  ['Write the Monday digest wording', 'wos', { priority: 'P3', due: '+2d', assignee: 'priya@example.test', mode: 'Team Direction' }],
  ['Cut dead CSS from globals', 'wos', { priority: 'P4' }],
  ['Fix lane label ellipsis on the Claude page', 'wos', { priority: 'P3' }, 'done'],
  ['Send moodboard v2 to Riya', 'maple', { priority: 'P2', due: '-3d', assignee: 'me', mode: 'Client Delivery' }],
  ['Quote for the packaging redesign', 'maple', { priority: 'P1', due: 'tomorrow', assignee: 'me', mode: 'Outreach & Sales' }],
  ['Collect brand fonts from the client', 'maple', { priority: 'P3', status: 'Blocked', blocked_reason: 'Riya has not sent the licence' }],
  ['Book the photographer for 12 Dec', 'maple', { priority: 'P2', due: '+10d', assignee: 'priya@example.test' }],
  ['Invoice for phase 1', 'maple', { priority: 'P2' }, 'done'],
  ['File the GST return for October', 'admin', { priority: 'P1', due: '-4d', assignee: 'me', mode: 'Business Admin' }],
  ['Renew the delpat.in domain', 'admin', { priority: 'P2', due: '+12d', assignee: 'me', mode: 'Business Admin' }],
  ['Reply to the CA about advance tax', 'admin', { priority: 'P3', due: '+3d' }],
  ['Order two monitor stands', 'admin', { priority: 'P4' }],
  ['Plan Q1 hiring: one more builder', 'admin', { priority: 'P2', due: '+14d', assignee: 'me', mode: 'Team Direction' }],
  ['Pay the AWS bill', 'admin', { priority: 'P2' }, 'done'],
  ['Update the team handbook', 'admin', { priority: 'P3', due: '+7d', assignee: 'priya@example.test', subtasks: [{ title: 'Add the Needs section' }, { title: 'Remove the old Slack rules' }] }],
];

const longBody = () => {
  const out = ['# Weekly review, 14 Nov', '', 'A long note, to see how the page and the list behave with real text.', ''];
  for (let i = 1; i <= 14; i++) {
    out.push(`## ${['Billing', 'Website', 'Work OS', 'Maple', 'Admin', 'People', 'Money'][i % 7]}: week ${i}`, '');
    out.push(`This week we moved the reconciliation forward by three clinics. The webhook retries are now idempotent by event id, which cut the duplicates to zero in staging; production still needs a watch over one close. Riya answered on the moodboard with two small notes about the lamination and asked for the second label size to be dropped.`, '');
    out.push('- Decide what to do with the negative invoices before Friday', '- Ask Priya to check the GST breakup on a real PDF', '- Keep the Needs page honest: only what waits on a person', '');
  }
  return out.join('\n');
};

let REF = {}; // title -> { ref, id }
let LANE = {};
async function seed() {
  const priya = await makeUser({ email: 'priya@example.test', name: 'Priya Nair', orgId: ME.orgId, role: 'member' });
  const bySid = {};
  for (const k of Object.keys(P)) {
    const x = P[k];
    await rawDb.collection('projects').insertOne({ _id: x.id, name: x.name, nameLower: x.name.toLowerCase(), client: x.client, description: x.description, status: 'active', ...placed, createdAt: mins(60 * 24 * 20), updatedAt: now });
    const s = STATES[k];
    await rawDb.collection('states').insertOne({ _id: x.id, projectId: x.id, ...placed, now: { text: s.now, by: ME.userId, at: mins(300) }, next: s.next.map((t, i) => line(i, t)), later: s.later.map((t, i) => line(i + 10, t)), decisions: s.decisions.map((t, i) => dec(i + 1, t)), where: {}, version: 4, createdAt: now, updatedAt: now });
    bySid[k] = x.id;
  }
  for (const [title, pk, extra, end] of TASKS) {
    const due = /^-[0-9]+d$/.test(extra.due ?? '') ? new Date(Date.now() + 5.5 * 3600e3 - parseInt(extra.due.slice(1)) * 864e5).toISOString().slice(0, 10) : extra.due;
    const r = await must('add_task', { title, project: P[pk].name, ...extra, ...(due ? { due } : {}) });
    REF[title] = { ref: r.created.ref };
    if (end === 'done') await must('complete_task', { task: r.created.ref, note: 'Shipped and checked.' });
  }
  for (const t of Object.keys(REF)) REF[t].id = (await rawDb.collection('tasks').findOne({ title: t }))._id;
  // notes
  await must('write_note', { project: P.kestrel.name, title: 'Kestrel migration plan', body: '# Kestrel migration plan\n\nMove the payout export off the old cron.\n\n- Stage the new export beside the old\n- Compare totals for one full week\n- Cut over after the books close\n\nThe tessellate step in the exporter merges split payouts into one line.' });
  await must('write_note', { project: P.wos.name, title: 'Weekly review: 14 Nov', body: longBody() });
  await must('write_note', { project: P.maple.name, title: 'Call notes: Maple Studio', body: 'Riya wants kraft stock and two label sizes. She will send the font licence by Monday. Photographer is booked for 12 Dec if the moodboard is approved.' });
  // Claude sessions (presence rows)
  const T = t => REF[t].id;
  const lane = (n, pid, label, branch, doing, activity, result, extra = {}) => ({
    _id: `tour-lane-${n}`, ...placed, projectId: pid, userId: ME.userId, key: `tour-s${n}`, session: `tour-s${n}`, label, machine: 'dev1', machineName: 'Om-PC', tool: 'vscode', ai: 'Claude Code', agent: 'claude-code', model: 'Opus 4.5',
    branch, lastSeen: mins(1), createdAt: mins(120), forYouCursor: now, writesSinceSave: 0, activity, ...(doing ? { doing: { taskId: T(doing), at: mins(20) } } : {}), ...(result ? { lastResult: { text: result, at: mins(15) } } : {}), ...extra,
  });
  LANE = { a: 'tour-s1', b: 'tour-s2' };
  await rawDb.collection('presence').insertMany([
    lane(1, P.kestrel.id, 'Kestrel webhook fix', 'builder-a', 'Fix duplicate webhook retries on invoice.paid', { state: 'working', at: mins(0) }, 'Idempotency key added to the invoice.paid handler; 11 of 14 duplicate cases now pass in the replay test. Next: the refund path.', { slot: 'A' }),
    lane(2, P.kestrel.id, 'Payout export', 'builder-b', 'Reconcile Kestrel invoices against Razorpay payouts', { state: 'waiting', why: 'prompt', at: mins(7) }, 'Matched 31 of 45 payout lines. Stopped at a permission prompt to read the Razorpay export folder.', { slot: 'B' }),
    lane(3, P.wos.id, 'Needs page polish', 'dev', 'Check the new Needs page on a real phone', { state: 'idle', at: mins(25) }, 'Needs page checked at 390 and 1280 in both themes; no overflow; card buttons are 44px.'),
    lane(4, P.site.id, 'Pricing page', 'main', 'Rewrite pricing page copy', { state: 'working', at: mins(0) }, 'Draft one of the three plan descriptions is in; the comparison table is next.'),
  ]);
  // Needs
  const need = (id, ref, projectId, kind, ask, extra = {}) => ({ _id: id, ref, ...placed, projectId, taskId: null, taskRef: null, to: ME.userId, from: { actor: { kind: 'agent', name: 'Claude' }, word: 'agent', label: 'Claude Code', session: 'tour-s1' }, kind, ask, options: [], status: 'open', appOnly: false, createdAt: mins(30 + ref * 20), answeredAt: null, ...extra });
  const stdNeeds = () => [
    need('tour-need-1', 1, P.kestrel.id, 'decide', 'The 9 refund lines arrive as negative invoices. How should the payout export treat them before Friday?', { options: [{ id: 'a', label: 'Keep them negative for now', means: 'No data change during close; Acme finance subtracts them by hand.' }, { id: 'b', label: 'Tag them as refunds', means: 'A new type in the export; one more column for Acme to learn.' }, { id: 'c', label: 'Hold the export', means: 'Nothing goes to Acme until the model is settled.' }], from: { actor: { kind: 'agent', name: 'Claude' }, word: 'agent', label: 'Kestrel webhook fix', session: 'tour-s1' } }),
    need('tour-need-2', 2, P.site.id, 'approve', 'Publish the new pricing page copy to the staging site so Priya can read it on her phone?', { options: [{ id: 'yes', label: 'Yes', means: 'Publish to staging only' }, { id: 'no', label: 'No', means: 'Keep it as a draft' }], from: { actor: { kind: 'agent', name: 'Claude' }, word: 'agent', label: 'Pricing page', session: 'tour-s4' } }),
    need('tour-need-3', 3, P.wos.id, 'review', 'Review the hand-in for the notes search fix.', { options: [{ id: 'accept', label: 'Accept', means: 'It is good: close the task.' }, { id: 'send_back', label: 'Send back', means: 'It needs more work: write what to change.' }, { id: 'accept_file', label: 'Accept and file what is left', means: 'Close the task and make a task from what is left.' }], taskId: T('Review the hand-in for the notes search fix'), taskRef: REF['Review the hand-in for the notes search fix'].ref, from: { actor: { kind: 'agent', name: 'Claude' }, word: 'agent', label: 'Needs page polish', session: 'tour-s3' }, result: { changed: 'Notes search now matches words in the body, not only the title. The phone list searches live; the laptop list searches on Enter.', checked: 'Ran flow-notes-search at 390 and 1280; the body-only word is found in both and the other note is hidden.', rating: null, where: [{ url: 'https://github.com/delpat-tech/work-os/pull/412', label: 'Pull request 412' }, { url: 'https://example.test/notes?q=zorbulax', label: 'The notes list with the search applied' }], left: ['Highlight the matched word in the list'] } }),
    need('tour-need-4', 4, P.kestrel.id, 'approve', 'Run the new payout export against the production Razorpay account to compare totals?', { appOnly: true, options: [{ id: 'yes', label: 'Yes, once', means: 'One read-only run, today' }, { id: 'no', label: 'No', means: 'Stay on the sandbox account' }] }),
  ];
  await rawDb.collection('needs').insertMany(stdNeeds());
  seed.needs = stdNeeds;
  // a computer, so "Start Claude" shows; one block of the timetable is seeded by the owner's legacy week
  await rawDb.collection('devices').insertOne({ _id: 'dev1', name: 'Om-PC', ...placed, hash: 'h1', prefix: 'p1', createdAt: now, lastSeenAt: now, revokedAt: null });
  await rawDb.collection('workerFolders').insertMany([P.site.id, P.kestrel.id, P.maple.id].map((pid, i) => ({ _id: `tour-fold-${i}`, orgId: ME.orgId, ownerId: ME.userId, deviceId: 'dev1', folderId: `tf${i}`, name: pid, git: true, branch: 'main', projectId: pid, linkedAt: now, seenAt: now, missing: false })));
  await rawDb.collection('settings').updateOne({ _id: 'profile:' + ME.userId }, { $set: { checklistHidden: true } }, { upsert: true });
  return priya;
}

// ---------------------------------------------------------------- tour helpers
const slow = [];
const captured = new Set();
const pattern = u => { const x = new URL(B + u.replace(B, '')); return x.pathname.replace(/^\/tasks\/[^/]+$/, '/tasks/[id]').replace(/^\/notes\/[^/]+$/, '/notes/[id]').replace(/^\/projects\/[^/]+$/, '/projects/[id]') + (x.pathname === '/settings' && x.searchParams.get('section') ? '?section=' + x.searchParams.get('section') : '') + (/^\/(claude|projects\/\[id\])$/.test(x.pathname.replace(/^\/projects\/[^/]+$/, '/projects/[id]')) && x.searchParams.get('tab') ? '?tab=' + x.searchParams.get('tab') : '') + (x.pathname === '/review' && x.searchParams.get('view') ? '?view=' + x.searchParams.get('view') : ''); };
function watch(p, tag) {
  p.on('console', m => { if (m.type() === 'error') note(tag, `console error on ${new URL(p.url()).pathname}${new URL(p.url()).search}: ${m.text().slice(0, 220)}`); });
  p.on('pageerror', e => note(tag, `pageerror on ${new URL(p.url()).pathname}: ${String(e.message).slice(0, 220)}`));
  p.on('response', r => { const u = new URL(r.url()); if (u.origin === new URL(B).origin && r.status() >= 400 && r.status() !== 401 && !/\/api\/auth\/get-session|\.map$/.test(u.pathname)) note(tag, `HTTP ${r.status()} for ${u.pathname}${u.search} (page ${new URL(p.url()).pathname})`); });
}
async function ready(p) { await p.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(500); }
async function go(p, url, tag) {
  const t0 = Date.now();
  await p.goto(B + url, { waitUntil: 'load' });
  await p.locator('main, #app-main').first().waitFor({ timeout: 15000 }).catch(() => {});
  const ms = Date.now() - t0;
  await ready(p);
  if (ms > 3000) note(tag, `${url} took ${ms} ms to load (over 3 s)`);
}
async function shotOne(p, file, phone, full) {
  const vp = phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  let big = false;
  if (full) {
    const h = await p.evaluate(() => { const m = document.querySelector('#app-main'); return Math.max(document.documentElement.scrollHeight, m ? m.scrollHeight + m.getBoundingClientRect().top : 0); });
    if (h > vp.height + 20) { await p.setViewportSize({ width: vp.width, height: Math.min(h + 8, 6000) }); big = true; await p.waitForTimeout(350); }
  }
  await p.screenshot({ path: file });
  if (big) { await p.setViewportSize(vp); await p.waitForTimeout(200); }
}
/** Four-shot rule: this screen in light and dark (the caller's viewport is the tag). */
async function screen(p, tag, name, did, o = {}) {
  const phone = tag === '390';
  const full = o.full !== false;
  if (!o.noRoute) captured.add(`${pattern(p.url())}|${tag}`);
  if (phone) { const ov = await overflow(p); if (!okO(ov)) note(tag, `sideways scroll or overflow on ${name} (${new URL(p.url()).pathname}${new URL(p.url()).search}): ${JSON.stringify(ov)}`); }
  for (const theme of ['light', 'dark']) {
    await p.evaluate(d => document.documentElement.classList.toggle('dark', d), theme === 'dark');
    await p.waitForTimeout(250);
    const f = `${name}-${tag}-${theme}.png`;
    await shotOne(p, `${SP}/${f}`, phone, full);
    index.push({ f, text: `${o.shows ?? name}. Reached: ${did}` });
  }
  await p.evaluate(() => document.documentElement.classList.remove('dark'));
}
const tapOrClick = (loc, phone) => (phone ? loc.first().tap() : loc.first().click());

async function tour(br, tag) {
  const phone = tag === '390';
  const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  watch(p, tag);
  await login(p, { phone, next: '/today' });
  await ready(p);
  const g = u => go(p, u, tag);
  const kid = P.kestrel.id;

  await g('/today');
  await screen(p, tag, 'today', 'Sign in, land on /today', { shows: 'Today: counts, Needs you, Projects now, task sections, New in Work OS card' });
  if (phone) { await p.evaluate(() => window.scrollTo(0, 0)); await shotOne(p, `${SP}/phone-header-bar-390-light.png`, true, false); index.push({ f: 'phone-header-bar-390-light.png', text: 'The phone header and bottom tab bar at rest, first screen of Today. Reached: /today, no scrolling' }); }
  await g('/projects');
  await screen(p, tag, 'projects-list', 'Open /projects', { shows: 'The projects list with Now lines' });
  for (const [t, nm, shows] of [['overview', 'project-overview', 'Project Overview: State card (Now, Next, Later, Decisions), Claude card, tasks'], ['tasks', 'project-tasks', 'Project Tasks tab'], ['claude', 'project-claude', 'Project Claude tab: sessions working on it'], ['needs', 'project-needs', 'Project Needs tab'], ['notes', 'project-notes', 'Project Notes tab'], ['info', 'project-info', 'Project Info tab']]) {
    await g(`/projects/${kid}?tab=${t}`);
    await screen(p, tag, nm, `/projects/${kid}?tab=${t}`, { shows });
  }
  await g(`/projects/${P.site.id}`);
  await screen(p, tag, 'project-overview-site', `/projects/${P.site.id}`, { shows: 'A second project Overview (Delpat Website)' });
  // tasks
  const rec = REF['Reconcile Kestrel invoices against Razorpay payouts'].ref, plain = REF['Archive 2024 test invoices'].ref;
  await g(`/tasks/${rec}`);
  await screen(p, tag, 'task-subtasks-checklist', `/tasks/${rec}`, { shows: 'A task with 3 subtasks, a checklist, due today, assigned to Om' });
  await g(`/tasks/${plain}`);
  await screen(p, tag, 'task-plain', `/tasks/${plain}`, { shows: 'A plain P4 task with no extras' });
  await g('/tasks');
  if (phone) {
    await screen(p, tag, 'tasks-open', '/tasks, Open tab (default)', { shows: 'Tasks list, Open tab' });
    for (const [label, nm] of [['Due soon', 'tasks-due-soon'], ['Waiting', 'tasks-waiting'], ['Done', 'tasks-done']]) {
      await p.getByRole('button', { name: label, exact: true }).first().tap().catch(() => note(tag, `Tasks tab "${label}" not found`));
      await p.waitForTimeout(500);
      await screen(p, tag, nm, `/tasks, tapped the ${label} tab`, { shows: `Tasks list, ${label} tab` });
    }
  } else {
    await screen(p, tag, 'tasks-board', '/tasks', { shows: 'Tasks board (desktop)' });
  }
  // a task row's menu
  await g('/tasks');
  if (phone) {
    await p.locator('button[aria-label^="Actions for"]').first().tap();
    await p.locator('[data-sheet]').first().waitFor({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(400);
    await screen(p, tag, 'task-row-menu', '/tasks, tapped the ... on the first task row', { shows: 'The task actions sheet', full: false });
  } else {
    const row = p.locator('a[href^="/tasks/"]:visible').first();
    await row.hover();
    const more = p.locator('button[aria-label*="ctions"]:visible, button[aria-label*="More"]:visible, [data-slot=dropdown-menu-trigger]:visible').first();
    if (await more.count()) { await more.click().catch(() => {}); await p.waitForTimeout(400); }
    else note(tag, 'desktop task row has no visible menu button (hover or right-click only?)');
    await screen(p, tag, 'task-row-menu', '/tasks, hovered the first task and opened its menu', { shows: 'A task row menu (desktop)', full: false });
    await p.keyboard.press('Escape');
  }
  // needs, claude, notes
  await g('/needs');
  await screen(p, tag, 'needs', '/needs', { shows: 'Needs page: decide with options, approve, review, one app-only' });
  await g('/claude');
  await screen(p, tag, 'claude-now', '/claude', { shows: 'Claude page, Now tab: sessions and what waits' });
  await g('/claude?tab=workers');
  await screen(p, tag, 'claude-workers', '/claude?tab=workers', { shows: 'Claude page, Workers tab: the roster, state per session' });
  await g('/claude?tab=setup');
  await screen(p, tag, 'claude-setup', '/claude?tab=setup', { shows: 'Claude page, Set up tab' });
  await g('/notes');
  await screen(p, tag, 'notes-list', '/notes', { shows: 'Notes list' });
  const long = await rawDb.collection('notes').findOne({ title: 'Weekly review: 14 Nov' });
  await g(`/notes/${long._id}`);
  await screen(p, tag, 'note-long', `/notes/${long._id}`, { shows: 'The long note open in the editor' });
  const shortN = await rawDb.collection('notes').findOne({ title: 'Kestrel migration plan' });
  await g(`/notes/${shortN._id}`);
  await screen(p, tag, 'note-short', `/notes/${shortN._id}`, { shows: 'A short project note open' });
  // menu, inbox, review, schedule, whats new
  if (phone) { await g('/menu'); await screen(p, tag, 'menu', '/menu (the Menu button in the header)', { shows: 'The Menu screen' }); }
  await g('/notifications');
  await screen(p, tag, 'notifications', '/notifications', { shows: 'Notifications / Inbox' });
  await g('/review');
  await screen(p, tag, 'review', '/review', { shows: 'Review: Done, Activity, Stale, Archive, Trash' });
  await g('/timetable');
  await screen(p, tag, 'schedule', '/timetable', { shows: 'Schedule / timetable with its blocks' });
  for (const v of ['activity', 'stale', 'archive', 'trash']) { await g(`/review?view=${v}`); await screen(p, tag, `review-${v}`, `/review?view=${v}`, { shows: `Review, ${v} view` }); }
  await g('/whats-new');
  await screen(p, tag, 'whats-new', '/whats-new', { shows: "What's new page" });
  // settings
  await g('/settings');
  await screen(p, tag, 'settings-main', '/settings', { shows: phone ? 'Settings list' : 'Settings, first section' });
  for (const s of ['account', 'notifications', 'connections', 'ai-tools', 'started', 'team', 'server']) {
    await g(`/settings?section=${s}`);
    await screen(p, tag, `settings-${s}`, `/settings?section=${s}`, { shows: `Settings, ${s}` });
  }
  // search, the way Om uses it: each place x each kind of query. What came back is recorded in findings.md ("Search" section).
  const sref = REF['Rewrite pricing page copy'].ref;
  const QUERIES = [['title-word', 'pricing', 'Rewrite pricing page copy'], ['note-body-word', 'tessellate', 'Kestrel migration plan'], ['project-name', 'Maple', 'Maple Studio'], ['ref', `#${sref}`, 'Rewrite pricing page copy']];
  const places = phone ? [['phone-header', async () => { await p.locator('button[aria-label=Search]:visible').first().tap(); }]] : [['sidebar', async () => { await p.locator('aside button:has-text("Search")').first().click(); }], ['slash-key', async () => { await p.locator('main').first().click({ position: { x: 5, y: 5 } }).catch(() => {}); await p.keyboard.press('/'); }]];
  for (const [place, open] of places) {
    for (const [kind, word, want] of QUERIES) {
      await g('/today');
      await open();
      const input = p.locator('input[aria-controls=global-search-results]');
      const opened = await input.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
      if (!opened) { note(tag, `Search did not open from ${place}`); searchLog.push(`- [${tag}] ${place}, ${kind} "${word}": the search did not open`); continue; }
      if (place !== 'slash-key' && kind === 'title-word') await screen(p, tag, `search-open-${place}`, `/today, opened Search from ${place}`, { shows: 'Search opened, empty', full: false });
      await input.fill(word);
      await p.getByRole('option').first().waitFor({ timeout: 6000 }).catch(() => {});
      await p.waitForTimeout(600);
      const txt = (await p.locator('[role=listbox]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const n = await p.getByRole('option').count();
      const hit = txt.includes(want);
      searchLog.push(`- [${tag}] ${place}, ${kind} "${word}": ${n} result${n === 1 ? '' : 's'}; ${hit ? `lists "${want}"` : `DOES NOT list "${want}"`}. Shows: ${txt.slice(0, 200) || 'nothing'} (screenshot search-${place}-${kind}-${tag}-light.png)`);
      if (!hit) note(tag, `Search from ${place} for ${kind} "${word}" did not list "${want}" (got: ${txt.slice(0, 120) || 'nothing'})`);
      await screen(p, tag, `search-${place}-${kind}`, `Opened Search from ${place} and typed "${word}"`, { shows: `Search from ${place}, ${kind} "${word}"`, full: false, noRoute: true });
      await p.keyboard.press('Escape');
      await p.waitForTimeout(300);
    }
  }
  // notes list search
  await g('/notes');
  const nbox = phone ? p.locator('input[placeholder="Search notes"]') : p.locator('input[name=q]:visible');
  for (const [kind, w, want] of [['title-word', 'migration', 'Kestrel migration plan'], ['note-body-word', 'tessellate', 'Kestrel migration plan'], ['project-name', 'Maple', 'Call notes: Maple Studio'], ['ref', `#${sref}`, 'Rewrite pricing']]) {
    await nbox.fill(w);
    if (!phone) await nbox.press('Enter');
    await p.waitForTimeout(1600);
    const t = (await p.locator('a[href^="/notes/"]:visible').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
    const hit = t.includes(want);
    searchLog.push(`- [${tag}] Notes page search, ${kind} "${w}": ${hit ? `shows "${want}"` : `DOES NOT show "${want}"`}. Rows: ${t.slice(0, 200) || 'nothing'} (screenshot notes-search-${kind}-${tag}-light.png)`);
    if (!hit && kind !== 'ref') note(tag, `notes list search for "${w}" did not show "${want}" (shows: ${t.slice(0, 120) || 'nothing'})`);
    await screen(p, tag, `notes-search-${kind}`, `/notes, typed "${w}" in the notes search${phone ? '' : ' and pressed Enter'}`, { shows: `Notes list filtered by ${kind} "${w}"`, full: false, noRoute: true });
    if (!phone) await go(p, '/notes', tag);
  }
  // the + sheet / new task
  await g('/today');
  if (phone) {
    await p.locator('button[aria-label=Add]').tap();
    await p.locator('[data-sheet]').first().waitFor({ timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(500);
    await screen(p, tag, 'plus-sheet', '/today, tapped the + in the tab bar', { shows: 'The + quick-add sheet', full: false });
  } else {
    const add = p.locator('button:has-text("New task"), button[aria-label*="New task"], button:has-text("Add task")').first();
    if (await add.count()) { await add.click(); await p.waitForTimeout(600); } else note(tag, 'no New task button on desktop Today');
    await screen(p, tag, 'plus-sheet', '/today, opened New task', { shows: 'New task (desktop)', full: false });
    await p.keyboard.press('Escape');
  }
  // dialogs and sheets that were not captured before: Declutter, Import, Day Plan
  const shut = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(300); };
  try {
    await g(`/projects/${P.kestrel.id}`);
    await p.locator('[data-project-menu]:visible').first().click({ timeout: 5000 });
    await p.waitForTimeout(300);
    await screen(p, tag, 'project-menu', `/projects/${P.kestrel.id}, opened the project ... menu`, { shows: 'The project ... menu (Edit, Declutter, ...)', full: false, noRoute: true });
    await p.locator('[data-project-declutter]:visible').first().click({ timeout: 5000 });
    await p.locator('[data-declutter-dialog]').waitFor({ timeout: 8000 });
    await p.waitForTimeout(1500);
    await screen(p, tag, 'declutter-dialog', `/projects/${P.kestrel.id}, ... menu, Declutter`, { shows: 'The Declutter dialog', full: false, noRoute: true });
    await shut();
  } catch (e) { note(tag, `Declutter dialog not reached: ${String(e.message).split('\n')[0].slice(0, 140)}`); await shut(); }
  try {
    await g('/today');
    await p.getByRole('button', { name: 'More', exact: true }).first().click({ timeout: 5000 });
    await p.waitForTimeout(400);
    await screen(p, tag, 'today-more-menu', '/today, tapped More', { shows: 'Today More menu (Import tasks, work/flex day)', full: false, noRoute: true });
    await p.getByRole('button', { name: /Import tasks/ }).first().click({ timeout: 5000 });
    await p.waitForTimeout(600);
    await screen(p, tag, 'import-sheet', '/today, More, Import tasks', { shows: 'The Import tasks sheet, empty', full: false, noRoute: true });
    await p.locator('textarea[placeholder^="Paste your markdown"]:visible').first().fill('| Task | Priority | Due |\n|---|---|---|\n| Print the label proofs | P2 | 2026-11-28 |\n| Order kraft boxes | P3 | |\n| Call the photographer | P1 | 2026-11-25 |');
    await p.getByRole('button', { name: 'Preview', exact: true }).first().click({ timeout: 5000 });
    await p.waitForTimeout(600);
    await screen(p, tag, 'import-preview', 'Pasted a markdown table, tapped Preview', { shows: 'Import: the preview checklist', full: false, noRoute: true });
    await shut();
  } catch (e) { note(tag, `Import sheet not fully reached: ${String(e.message).split('\n')[0].slice(0, 140)}`); await shut(); }
  try {
    await g('/today');
    const sb = p.getByRole('button', { name: 'Schedule', exact: true }).first();
    if (!(await sb.count())) note(tag, 'Today has no Schedule button (the Day Plan needs a schedule for today); Day Plan not captured');
    else {
      await sb.click({ timeout: 5000 });
      await p.waitForTimeout(800);
      await screen(p, tag, 'day-plan', '/today, tapped Schedule', { shows: 'The Day Plan sheet', full: false, noRoute: true });
      await shut();
    }
  } catch (e) { note(tag, `Day Plan not reached: ${String(e.message).split('\n')[0].slice(0, 140)}`); await shut(); }
  // links on a few pages: 404 sweep (desktop only, once)
  if (!phone) {
    const seen = new Set();
    for (const u of ['/today', `/projects/${kid}`, '/menu', '/settings', '/claude', '/needs']) {
      await g(u);
      for (const h of await p.$$eval('a[href^="/"]', as => as.map(a => a.getAttribute('href')))) {
        const path0 = h.split('#')[0];
        if (!path0 || seen.has(path0) || /^\/(api|logout|sign)/.test(path0)) continue;
        seen.add(path0);
        const r = await ctx.request.get(B + path0, { maxRedirects: 0 }).catch(() => null);
        if (r && r.status() >= 400) note(tag, `link ${path0} answers HTTP ${r.status()} (found on ${u})`);
      }
    }
    console.log('links checked', seen.size);
  }
  await ctx.close();
}

// ---------------------------------------------------------------- jobs
const JOBS = [];
const jobLog = [];
async function jobs(br, tag) {
  const phone = tag === '390';
  const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  watch(p, tag + ' jobs');
  await login(p, { phone, next: '/today' });
  await ready(p);
  const kid = P.kestrel.id;
  // a job: start from Today; steps are recorded as they happen
  async function job(n, title, fn) {
    await rawDb.collection('needs').deleteMany({});
    await rawDb.collection('needs').insertMany(seed.needs());
    await rawDb.collection('tasks').updateMany({}, { $unset: { claude: '' } }); // a job starts with nothing given to Claude
    await rawDb.collection('tasks').deleteMany({ title: 'Send packaging samples to Riya' });
    await go(p, '/today', tag);
    const J = { n, title, tag, steps: [], taps: 0, routes: 0, awkward: [], failed: null };
    let k = 0, lastPath = new URL(p.url()).pathname + new URL(p.url()).search;
    const step = async (what, act, o = {}) => {
      k++;
      console.log(`job${n} ${tag} step ${k}: ${what}`);
      try { await Promise.race([act(), new Promise((_, rej) => setTimeout(() => rej(new Error('step timed out after 25 s')), 25000))]); } catch (e) { J.awkward.push(`step ${k} (${what}) failed: ${String(e.message).split('\n')[0].slice(0, 140)}`); J.failed = J.failed ?? what; }
      await p.waitForTimeout(700); await ready(p);
      const here = new URL(p.url()).pathname + new URL(p.url()).search;
      const moved = here !== lastPath;
      if (moved) J.routes++;
      if (o.tap !== false) J.taps++;
      J.steps.push(`${k}. ${what} -> ${here}${moved ? ' (new route)' : ''}`);
      lastPath = here;
      await p.screenshot({ path: `${SP}/job${n}-${tag}-step${k}.png`, timeout: 10000 }).catch(e => J.awkward.push(`screenshot failed: ${String(e.message).slice(0, 80)}`));
      index.push({ f: `job${n}-${tag}-step${k}.png`, text: `Job ${n} (${title}), step ${k}: ${what}. Now at ${here}` });
    };
    const hard = t => J.awkward.push(t);
    try { await fn({ step, hard, J }); } catch (e) { J.failed = J.failed ?? String(e.message).split('\n')[0]; J.awkward.push(`stopped: ${J.failed.slice(0, 160)}`); }
    jobLog.push(J);
    flush();
  }
  const T = x => tapOrClick(x, phone);
  const menuTo = async label => { // phone: Menu then entry; desktop: sidebar link
    if (phone) { await T(p.locator('a[href="/menu"]:visible')); await p.waitForURL(/\/menu/); await T(p.locator(`a[href^="/${label.toLowerCase()}"]:visible`)); }
    else await T(p.locator(`aside a:has-text("${label}")`));
  };
  const L = (sel, name) => p.locator(sel).filter({ hasText: name });

  await job(1, 'See what each Claude session is doing right now', async ({ step, hard }) => {
    if (phone) await step('Menu button in the header', () => T(p.locator('a[href="/menu"]:visible')));
    if (phone) await step('Menu: Claude', () => T(p.locator('a[href^="/claude"]:visible')));
    else await step('Sidebar: Claude', () => T(p.locator('aside a[href="/claude"]')));
    await step('Workers tab (state per session)', () => T(p.locator('a[data-tab=workers]')));
    const body = await p.locator('main').innerText();
    if (!/Kestrel webhook fix/.test(body)) hard('Workers tab does not list the session labels');
    if (!/last:/.test(body)) hard('what each session last did ("last:") is not on the Workers tab; it is on Now or the project page');
  });
  const BAR = `nav[aria-label=Main]:visible`;
  const tab = href => T(p.locator(phone ? `${BAR} a[href="${href}"]` : `aside a[href="${href}"]`));
  await job(2, 'Answer a Need that a Claude session asked, then check that session', async ({ step, hard }) => {
    await step(phone ? 'Needs tab in the bar' : 'Sidebar: Needs', () => tab('/needs'));
    await step('Pick the first option of the decide Need', () => T(p.locator('[data-need="1"] [data-need-option="a"]')));
    await step('Confirm if asked (Send / Answer)', async () => { const b = p.locator('[data-need="1"] [data-need-send]'); if (await b.count()) await T(b); else hard('the option tap answered at once (no confirm step)'); });
    await step(phone ? 'Menu' : 'Sidebar: Claude', () => T(p.locator(phone ? 'a[href="/menu"]:visible' : 'aside a[href="/claude"]')));
    if (phone) await step('Menu: Claude', () => T(p.locator('a[href^="/claude"]:visible')));
    await step('Workers tab: that session now', () => T(p.locator('a[data-tab=workers]')));
    hard('after answering, the session is checked on another page (/claude?tab=workers); the Need page does not show the session state');
  });
  await job(3, 'Give Claude a task (Give to Claude) on an existing task', async ({ step, hard }) => {
    const ref = REF['Rewrite pricing page copy'].ref;
    await step('Tasks', () => tab('/tasks'));
    await step('Open the task', () => T(p.locator(`a[href="/tasks/${ref}"]:visible`)));
    if (phone) await step('More actions (...) at the top right of the task page', () => T(p.locator('button[aria-label="More actions"]')));
    await step(phone ? 'Give to Claude (menu item)' : 'Give to Claude (button on the task page)', () => T(phone ? p.getByText('Give to Claude', { exact: true }) : p.locator('main button[data-claude-menu]')));
    const sheetTxt = await p.locator('[data-claude-sheet]').innerText().catch(() => '');
    if (!sheetTxt) hard('the Give to Claude sheet did not open');
    await step('Confirm: Give to Claude in the sheet', () => T(p.locator('[data-claude-give]')));
    const t = await rawDb.collection('tasks').findOne({ _id: REF['Rewrite pricing page copy'].id });
    if (t?.claude?.state !== 'queued' && t?.claude?.state !== 'running') hard(`after the confirm the task is not queued for Claude (state: ${t?.claude?.state ?? 'none'})`);
    if (!phone) hard('desktop task rows: no "..." menu; the controls are a hover-only Bot icon (Give to Claude), a progress button, and inline Priority and Status selects');
  });
  await job(4, 'Start a Claude session on a project (Start Claude)', async ({ step, hard }) => {
    if (phone) { await step('Menu button in the header', () => T(p.locator('a[href="/menu"]:visible'))); await step('Menu: Claude', () => T(p.locator('a[href^="/claude"]:visible'))); }
    else await step('Sidebar: Claude', () => T(p.locator('aside a[href="/claude"]')));
    await step('Start Claude', () => T(p.getByRole('link', { name: /Start Claude/ }).or(p.getByRole('button', { name: /Start Claude/ }))));
    await step('Pick the project', () => T(p.locator(`[data-start-project="${kid}"]`)));
    hard('stopped before the final Start button on purpose: it would launch a real session');
  });
  await job(5, "See a project's goal, next steps and who is working on it", async ({ step, hard }) => {
    await step(phone ? 'Projects in the bar' : 'Sidebar: Projects', () => tab('/projects'));
    await step('Open Kestrel Billing', () => T(p.locator(`a[href="/projects/${kid}"]:visible`)));
    const t = await p.locator('main').innerText();
    if (!/Get the October payout/.test(t)) hard('goal (Now) not visible on the project Overview first screen');
    if (!/Fix duplicate invoice\.paid/.test(t)) hard('Next lines not visible on Overview');
    if (!/Kestrel webhook fix|Working on it now|session/i.test(t)) hard('who is working on it is not visible on Overview');
  });
  await job(6, 'Find a note by a word in its title or body', async ({ step, hard }) => {
    if (phone) { await step('Projects in the bar (Notes sit under Projects on the phone)', () => tab('/projects')); await step('Notes link on the Projects page', () => T(p.locator('a[href="/notes"]:visible'))); }
    else await step('Sidebar: Notes', () => tab('/notes'));
    const box = phone ? p.locator('input[placeholder="Search notes"]') : p.locator('input[name=q]:visible');
    await step('Type a body word (tessellate)', async () => { await box.fill('tessellate'); if (!phone) await box.press('Enter'); await p.waitForTimeout(1200); }, { tap: true });
    if (!(await p.locator('a[href^="/notes/"]:visible').allInnerTexts()).join('').includes('Kestrel migration plan')) hard('body word not found');
    await step('Open the note', () => T(p.locator('a[href^="/notes/"]:visible', { hasText: 'Kestrel migration plan' })));
  });
  await job(7, 'Check what Claude finished today', async ({ step, hard }) => {
    await step(phone ? 'Menu' : 'Sidebar: Review', async () => { if (phone) { await T(p.locator('a[href="/menu"]:visible')); } else await T(p.locator('aside a[href="/review"]')); });
    if (phone) await step('Menu: Review', () => T(p.locator('a[href^="/review"]:visible')));
    const t = await p.locator('main').innerText();
    if (!/Done|done/.test(t)) hard('no Done list visible on Review');
    if (!/Claude|hand/i.test(t)) hard('Review does not say which finished work was Claude\'s (no hand-ins or results here)');
    hard('session results ("last:") live on Claude > Workers and the project Claude tab, not on Review');
  });
  await job(8, 'Approve a review Need (look at the work first, then accept)', async ({ step, hard }) => {
    await step(phone ? 'Needs in the bar' : 'Sidebar: Needs', () => tab('/needs'));
    if (!(await p.locator('[data-need="3"]').count())) hard('review Need not on the Needs page');
    hard('the Need has three buttons: Accept, Send back (needs a typed reason), Accept and file what is left; the agent result (Changed, Checked, Where, Left) sits above them');
    await step('Look at the work link in the card (not opened: it leaves Work OS)', async () => { const a = p.locator('[data-need="3"] a[href*="/pull/412"]').first(); await a.scrollIntoViewIfNeeded(); const tg = await a.getAttribute('target'); hard(`the work link is an external address (${(await a.getAttribute('href')).slice(0, 60)}) and opens in a ${tg === '_blank' ? 'new tab' : 'the same tab'}, leaving Work OS; the card itself has no in-app view of the work`); }, { tap: false });
    await step('Accept', () => T(p.locator('[data-need="3"] [data-need-option="accept"]')));
    const t = await rawDb.collection('needs').findOne({ _id: 'tour-need-3' });
    if (t?.status === 'open') hard('after Accept the Need is still open');
  });
  await job(9, 'Add a task to a project and set due + assignee', async ({ step, hard }) => {
    await step(phone ? 'Projects in the bar' : 'Sidebar: Projects', () => tab('/projects'));
    await step('Open Maple Studio', () => T(p.locator(`a[href="/projects/${P.maple.id}"]:visible`)));
    const title = 'Send packaging samples to Riya';
    if (phone) {
      await step('Add task (+ Task button on the project)', () => T(p.locator('[data-add-task]:visible')));
      await step('Type a title', async () => { await p.locator('[data-quick-add] textarea').fill(title); });
      await step('Due chip: Tomorrow', () => T(p.locator('[data-quick-add] button', { hasText: /^Tomorrow$/ })));
      hard('the + sheet has Due, Priority and Project chips but no Assignee control; assignee is set on the task page');
      await step('Add & open', () => T(p.locator('[data-quick-add] button', { hasText: /Add & open/ })));
    } else {
      await step('Add task (+ Task button on the project)', () => T(p.locator('[data-add-task]:visible')));
      await step('Type a title with due:tomorrow, Shift+Enter for details', async () => { const i = p.getByRole('dialog').locator('input[placeholder^="Add a task"]'); await i.fill(title + ' due:tomorrow'); await i.press('Shift+Enter'); await p.locator('input[placeholder=Title]').waitFor(); });
      hard('quick-add syntax has no assignee token (@ is the project); the details form has Due and Start dates but no Assignee field');
      await step('Details form: Create & open', () => T(p.getByRole('button', { name: /Create & open/ })));
    }
    await p.waitForURL(/\/tasks\//, { timeout: 8000 }).catch(() => hard('did not land on the new task page'));
    await step('Assigned: open the picker on the task page', () => T(p.locator('[data-assignee-picker]:visible')));
    await step('Pick Priya Nair', () => T(p.locator('[data-assignee-option]', { hasText: 'Priya' })));
    await step('Save', () => T(p.locator('[data-assignee-save]')));
    const t = await rawDb.collection('tasks').findOne({ title });
    if (!t) hard('the new task was not created'); else if (!t.due) hard('the new task has no due date'); else if (!(t.assigneeIds ?? t.assignees ?? []).length) hard('the new task has no assignee after Save');
  });
  await job(10, 'Change a setting reached from a notice (Discord or alerts)', async ({ step, hard }) => {
    await step(phone ? 'Bell in the Today header' : 'Sidebar: Inbox', () => T(p.locator(phone ? 'a[href="/notifications"]:visible, button[aria-label*="Notif"]:visible' : 'aside a[href="/notifications"]')));
    const link = p.locator('main a[href*="settings"]:visible').first();
    if (await link.count()) await step('Tap the settings link in the notice', () => T(link));
    else { hard('Inbox has no link to settings; went to Settings by Menu/sidebar'); await step(phone ? 'Menu' : 'Sidebar: Settings', () => T(p.locator(phone ? 'a[href="/menu"]:visible' : 'aside a[href="/settings"]'))); if (phone) await step('Menu: Settings', () => T(p.locator('a[href^="/settings"]:visible'))); }
    await step('Notifications section', async () => { const l = p.locator('a[href*="section=notifications"]:visible').first(); if (await l.count()) await T(l); else hard('already on the section'); });
  });
  await ctx.close();
}


// ---------------------------------------------------------------- signed-out screens and legacy routes
async function publicScreens(br, tag) {
  const phone = tag === '390';
  const ctx = await br.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  watch(p, tag + ' signed-out');
  for (const [u, nm, shows] of [['/login', 'login', 'Sign-in page'], ['/login/reset?token=not-a-real-token', 'login-reset', 'Password reset page with an invalid token'], ['/accept-invitation/not-an-invitation', 'accept-invitation', 'Accept-invitation page with an unknown invitation id (error state)'], ['/oauth/consent', 'oauth-consent', 'OAuth consent page opened without a request']]) {
    await go(p, u, tag);
    await screen(p, tag, nm, `Signed out, opened ${u}`, { shows, noRoute: true });
    captured.add(`${pattern(u.split('?')[0])}|${tag}|signed-out landed ${new URL(p.url()).pathname}`);
  }
  await ctx.close();
}
const redirectsSeen = [];
async function legacyRedirects() {
  const ctx = await (await launch()).newContext();
  // sign in through the API-free way: reuse the login form
  const p = await ctx.newPage();
  await login(p, { next: '/today' });
  for (const u of ['/', '/more', '/board', '/connect', '/connect?tab=alerts', '/connect?tab=discord', '/connect?tab=code', '/history', '/history?tab=trash', '/hidden', '/archive', '/recovery', '/modes/code-dev', '/settings?section=device', '/settings?section=security']) {
    const r = await ctx.request.get(B + u, { maxRedirects: 0, timeout: 10000 }).catch(() => null);
    console.log('redirect', u, r?.status());
    const to = r?.headers()['location'] ?? '';
    redirectsSeen.push({ u, status: r?.status() ?? 'none', to });
    if (!r || r.status() >= 400) note('redirects', `legacy route ${u} answers HTTP ${r?.status() ?? 'no answer'}${u.startsWith('/modes') ? ' (mode slug guess; a real slug redirects to /tasks?mode=)' : ''}`);
  }
  await ctx.browser().close();
}

function flush() {

fs.writeFileSync(`${OUT}/index.md`, '# UI tour screenshots\n\nFiles are in shots/. Light and dark of each screen; full page where the page scrolls (the browser is made as tall as the page).\n\n' + index.map(i => `- ${i.f}: ${i.text}`).join('\n') + '\n');
const uniq = [...new Set(findings)];
fs.writeFileSync(`${OUT}/findings.md`, '# Functional findings from the UI tour\n\n' + (uniq.length ? uniq.join('\n') : 'None found.') + '\n\n## Search, what each place returns\n\n' + (searchLog.length ? searchLog.join('\n') : 'Not run.') + '\n\n## Controls found by reading the code\n\n' + controls.map(c => '- ' + c).join('\n') + '\n');
fs.writeFileSync(`${OUT}/jobs.md`, '# Everyday jobs, shortest path the UI allows (each starts from Today)\n\n' + jobLog.map(J => `## Job ${J.n} (${J.tag}): ${J.title}\n\nSteps:\n${J.steps.map(s => '- ' + s).join('\n')}\n\nTaps: ${J.taps}. Route changes: ${J.routes}.${J.failed ? `\nDid not complete: ${J.failed}` : ''}\n\nAwkward:\n${J.awkward.length ? J.awkward.map(a => '- ' + a).join('\n') : '- nothing noted'}\n`).join('\n'));

const has = (pat, tag) => [...captured].some(c => c.startsWith(pat + '|' + tag));
const ROUTES = [
  ['/', 'redirect-only (app/page.tsx redirects to /today)', null],
  ['/today', 'linked: tab bar, sidebar', '/today'],
  ['/projects', 'linked: tab bar, sidebar', '/projects'],
  ['/projects/[id]', 'linked: project rows. Tabs overview, tasks, claude, needs, notes, info', '/projects/[id]'],
  ['/tasks', 'linked: tab bar, sidebar', '/tasks'],
  ['/tasks/[id]', 'linked: every task row', '/tasks/[id]'],
  ['/needs', 'linked: tab bar, sidebar', '/needs'],
  ['/claude', 'linked: Menu, sidebar. Tabs now, workers, setup', '/claude'],
  ['/notes', 'linked: Projects page (phone), sidebar', '/notes'],
  ['/notes/[id]', 'linked: note rows', '/notes/[id]'],
  ['/menu', 'linked: phone header. Desktop has no link (sidebar holds the same entries)', '/menu', true],
  ['/notifications', 'linked: bell, Menu, sidebar', '/notifications'],
  ['/review', 'linked: Menu, sidebar. Views done, activity, stale, archive, trash', '/review'],
  ['/timetable', 'linked: Menu', '/timetable'],
  ['/whats-new', 'linked: Menu, sidebar, Today card', '/whats-new'],
  ['/settings', 'linked: Menu, sidebar. Sections account, notifications, connections, ai-tools, started, team, server', '/settings'],
  ['/modes/[mode]', 'redirect-only (redirects to /tasks?mode=...) and nothing in the UI links to it (modeHref points at /tasks): a stale screen kept for old links', null],
  ['/login', 'signed-out entry', '/login'],
  ['/login/reset', 'linked from the sign-in form and reset emails', '/login/reset'],
  ['/accept-invitation/[id]', 'reached only from the invitation email (no in-app link): captured with an unknown id, so the error state only; a live invitation needs a real emailed id', '/accept-invitation/[id]'],
  ['/oauth/consent', 'reached only through an OAuth client\'s authorize request: captured without a request (its fallback state); the real consent screen needs a registered OAuth client', '/oauth/consent'],
];
const rt = ROUTES.map(([r, why, pat, noDesk]) => {
  const a = pat ? (has(pat, '390') || [...captured].some(c => c.startsWith(pat + '|390'))) : false;
  const b = pat ? [...captured].some(c => c.startsWith(pat + '|1280')) : false;
  const state = !pat ? (r === '/' ? 'redirect-only' : 'redirect-only, unreachable from the UI (stale)') : a && b ? 'captured (390 and 1280)' : noDesk && a ? 'captured (390; no desktop view by design)' : `NOT fully captured (390 ${a}, 1280 ${b})`;
  return `| ${r} | ${state} | ${why} |`;
});
const sub = [...captured].map(c => c.split('|').slice(0, 2).join(' @')).sort().join('\n- ');
fs.writeFileSync(`${OUT}/routes.md`, `# Routes found in the code (app/**/page.tsx, app/**/route.ts, next.config redirects)

| Route | Status | Notes |
|---|---|---|
${rt.join('\n')}

Route handlers (no screen): /api/*, /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource, /icons/[size], /worker/latest.json, /worker/work-os-worker.mjs.
Legacy redirects in next.config.ts (checked by request, redirect-only, none linked from the UI): ${redirectsSeen.map(r => r.u + ' -> ' + r.status + ' ' + r.to).join('; ')}

Dialogs and sheets captured: + quick-add sheet (phone) or New task (desktop), task row actions sheet, Search, Start Claude project step and Give to Claude (job screenshots 3 and 4). Declutter dialog, Import sheet (empty and preview), Day Plan sheet (when the owner has a schedule) are in the tour. Not captured: date pickers, Reauth password dialog.

Captured route patterns (pattern @ viewport):
- ${sub}
`);

}

// ---------------------------------------------------------------- run
try {
  await seed();
  const br = await launch();
  br.on('disconnected', () => {});
  if (!process.env.UI_TOUR_JOBS_ONLY) {
    await tour(br, '390'); flush();
    await tour(br, '1280'); flush();
    await publicScreens(br, '390');
    await publicScreens(br, '1280'); flush();
    await legacyRedirects(); flush();
  }
  await jobs(br, '390'); flush();
  await jobs(br, '1280'); flush();
  await br.close();
} catch (e) {
  check('ui-tour (error)', false, e?.stack || String(e));
}

check('ui-tour: screenshots taken', index.length >= 100, String(index.length));
check('ui-tour: no overflow at 390 on any screen', !findings.some(f => /^- \[390\] sideways/.test(f)), findings.filter(f => /sideways/.test(f)).join('; '));
flush();
console.log(`screenshots ${index.length}, findings ${new Set(findings).size}`);
await finish();
