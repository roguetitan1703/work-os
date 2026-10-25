// Tenancy (docs/multi-user.md phase 2): two people in one organization (A = the owner, B = a member) and one person in
// another (C). B sees A's shared work but none of A's private things; C sees nothing of the first organization through
// MCP (every read tool), pages, search, the notes file routes or the worker and admin APIs; numbers restart per
// organization; inbox notices and alerts go only to their recipient, by the recipient's own settings. Also runs the
// static one-door check (tests/scope-check.mjs). Phase 3: each person's own schedule and timezone, and dispatcher caps
// that count only their own claims. Seed profile: none (this suite makes its own people and data).
import { B, CRON, EMAIL, ME, MCP, PW, check, db, finish, launch, login, makeUser, mkKey, rawDb, setProfile, setSchedule, sha } from './lib.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { scopeViolations } from '../scope-check.mjs';

let rid = 0;
async function as(key, name, args = {}) {
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split('\n').find(l => l.startsWith('data:'));
  const b = JSON.parse(line ? line.slice(5) : t);
  const text = b.result?.content?.[0]?.text ?? JSON.stringify(b.error ?? b);
  const isError = !!b.result?.isError || !!b.error;
  let json = null;
  try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError, text, json };
}
const must = async (key, name, args) => {
  const r = await as(key, name, args);
  if (r.isError) throw new Error(`${name}: ${r.text}`);
  return r.json;
};
const why = 'Fixture for the tenancy suite on the throwaway app; nothing real happens with this item at all.';
const quiet = (() => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  return h >= 23 || h < 8;
})();

try {
  // ---- static half of the one-door test ----
  const v = scopeViolations();
  check('static: no data access outside the scoped door', v.length === 0, v.join('; '));

  // ---- people ----
  const A = ME;
  const kA = MCP;
  const Bu = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: A.orgId, role: 'member' });
  const Cu = await makeUser({ email: 'cy@example.test', name: 'Cy', orgName: 'Other Org' });
  const kB = await mkKey({ agent: 'claude', userId: Bu.userId, orgId: Bu.orgId, name: 'bea chat' });
  const kBcode = await mkKey({ agent: 'claude-code', userId: Bu.userId, orgId: Bu.orgId, name: 'bea code' });
  const kC = await mkKey({ agent: 'claude', userId: Cu.userId, orgId: Cu.orgId, name: 'cy chat' });
  // Phase 3: the owner has the old week in Asia/Kolkata (lib.mjs makeIdentity); Bea has one all-day block of her own,
  // in New York; Cy has nothing (a new person: no schedule bar, no routine). Set before any request caches them.
  const BEA_TZ = 'America/New_York';
  await setProfile(Bu, { timezone: BEA_TZ });
  const allDay = { mon: 'Growth', tue: 'Growth', wed: 'Growth', thu: 'Growth', fri: 'Growth' };
  await setSchedule(Bu, { blocks: [{ start: '00:00', end: '23:59', block: 'Bea focus', modes: allDay, notes: '' }], colors: {}, taskModes: {}, routine: null, help: [] });

  // ---- A's work: shared (Zephyr) and private (Hidden) ----
  await must(kA, 'add_project', { name: 'Zephyr Shared' });
  await must(kA, 'add_project', { name: 'Hidden Vault', visibility: 'private' });
  const projs = await must(kA, 'list_projects', { include_inactive: true });
  const zephyr = projs.find(p => p.name === 'Zephyr Shared');
  const vault = projs.find(p => p.name === 'Hidden Vault');
  check('A: projects created with their visibility', zephyr?.visibility === 'org' && vault?.visibility === 'private', JSON.stringify(projs));
  const s1 = (await must(kA, 'add_task', { title: 'Zephyr shared task one', project: 'Zephyr Shared' })).created;
  const p1 = (await must(kA, 'add_task', { title: 'Hidden loose task', due: '2026-01-05' })).created;
  const pv = (await must(kA, 'add_task', { title: 'Hidden vault task', project: 'Hidden Vault' })).created;
  const pv2 = (await must(kA, 'add_task', { title: 'Hidden vault trash me', project: 'Hidden Vault' })).created;
  // add_task answers with the ref only; the id-based checks below need the task ids.
  for (const t of [s1, p1, pv, pv2]) t.id = (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t.ref }))._id;
  await must(kA, 'add_comment', { task: p1.ref, note: 'Hidden comment text' });
  const pNote = (await must(kA, 'write_note', { task: p1.ref, body: 'Hidden note body' })).created;
  const vMemo = (await must(kA, 'write_note', { project: 'Hidden Vault', title: 'Hidden memo', body: 'Hidden memo body' })).created;
  const zMemo = (await must(kA, 'write_note', { project: 'Zephyr Shared', title: 'Zephyr memo', body: 'Zephyr memo body' })).created;
  await must(kA, 'update_claude_items', { ops: [{ op: 'add', project: 'Hidden Vault', kind: 'feature', title: 'Hidden vault item for the tenancy check', why, done_when: 'The tenancy suite passes.' }] });
  await must(kA, 'delete_task', { task: pv2.ref, title: 'Hidden vault trash me' });
  const p1Detail = await must(kA, 'get_task', { task: p1.ref });
  check('A: a task with no project is private', p1Detail.visibility === 'private', p1Detail.visibility);
  check('A: a task in a shared project is shared', (await must(kA, 'get_task', { task: s1.ref })).visibility === 'org');

  // ---- numbers count per organization ----
  const sB = (await must(kB, 'add_task', { title: 'Zephyr task by Bea', project: 'Zephyr Shared' })).created;
  check('refs: B continues the organization\'s numbers', sB.ref === pv2.ref + 1, `${sB.ref} after ${pv2.ref}`);
  const c1 = (await must(kC, 'add_task', { title: 'Quokka task by Cy' })).created;
  check('refs: a second organization starts at #1', c1.ref === 1, String(c1.ref));
  await must(kC, 'add_project', { name: 'Quokka Project' });
  const ci = await must(kC, 'update_claude_items', { ops: [{ op: 'add', project: 'Quokka Project', kind: 'feature', title: 'Quokka item numbering check for tenancy', why, done_when: 'The tenancy suite passes.' }] });
  check('refs: Claude items start at C1 in a second organization', ci.results?.[0]?.ref === 'C1', JSON.stringify(ci.results));
  const cZephyr = await as(kC, 'add_project', { name: 'Zephyr Shared' });
  check('names: another organization may use the same project name', !cZephyr.isError, cZephyr.text);
  check('ids: new project ids are the name plus a random tail', /^hidden-vault-[0-9a-f]{8}$/.test(vault.id) && /^zephyr-shared-[0-9a-f]{8}$/.test(zephyr.id), `${vault.id} ${zephyr.id}`);
  const cz = await rawDb.collection('projects').findOne({ orgId: Cu.orgId, nameLower: 'zephyr shared' });
  check('ids: the same name in another organization gets an unrelated id (no -2)', !!cz && cz._id !== zephyr.id && /^zephyr-shared-[0-9a-f]{8}$/.test(cz._id), cz?._id);

  // ---- apply_changes keeps the visibility it was asked for ----
  await must(kA, 'apply_changes', { ops: [{ op: 'add_project', name: 'Hidden batch project', visibility: 'private' }] });
  const bpDoc = await rawDb.collection('projects').findOne({ orgId: A.orgId, nameLower: 'hidden batch project' });
  check('apply_changes: add_project with visibility private is private', bpDoc?.visibility === 'private' && bpDoc.ownerId === A.userId, JSON.stringify(bpDoc && bpDoc.visibility));

  // ---- B: shared yes, private no (every read tool) ----
  const readAll = async key => {
    const out = [];
    const calls = [
      ['list_tasks', { include_closed: true }], ['list_projects', { include_inactive: true }], ['daily_summary', { since: '7d' }],
      ['recent_activity', { since: '7d' }], ['list_trash', {}], ['list_notes', { state: 'all' }], ['get_project', { project: 'Zephyr Shared', depth: 'full' }],
      ['get_task', { task: p1.ref }], ['get_task', { task: p1.id }], ['get_task', { task: pv.id }], ['get_task', { task: s1.id }],
      ['get_project', { project: vault.id }], ['get_project', { project: 'Hidden Vault' }],
      ['read_note', { note_id: pNote.id }], ['read_note', { note_id: vMemo.id }], ['read_note', { note_id: zMemo.id }], ['read_note', { task: p1.ref }],
      ['list_notes', { query: 'Hidden', state: 'all' }], ['list_tasks', { query: 'Hidden', include_closed: true, archived: false }],
    ];
    for (const [n, a] of calls) out.push({ n, a, ...(await as(key, n, a)) });
    return out;
  };
  const bReads = await readAll(kB);
  // A refusal may repeat the name that was asked for ('Project "Hidden Vault" not found'); that is not a leak.
  const echoFree = r => r.text.replaceAll('Project "Hidden Vault" not found', '');
  const bText = bReads.map(echoFree).join('\n');
  check('B (same org): no private content in any MCP read', !/Hidden/.test(bText), bReads.filter(r => /Hidden/.test(echoFree(r))).map(r => r.n).join(', '));
  check('B: sees the shared task', /Zephyr shared task one/.test(bReads[0].text));
  check('B: sees the shared project note', /Zephyr memo/.test(bReads.find(r => r.n === 'read_note' && r.a.note_id === zMemo.id).text));
  check('B: A\'s private task by ref is not found', bReads.find(r => r.n === 'get_task' && r.a.task === p1.ref).isError);
  const bWrite = await as(kB, 'update_task', { task: p1.id, title: 'Hidden renamed by Bea' });
  check('B: cannot change A\'s private task', bWrite.isError, bWrite.text);
  const bNote = await as(kB, 'write_note', { note_id: vMemo.id, append: 'Bea was here' });
  check('B: cannot write to A\'s private note', bNote.isError, bNote.text);
  const bProj = await as(kB, 'add_task', { title: 'Into the vault', project: 'Hidden Vault' });
  check('B: cannot add to A\'s private project (and does not create a clash)', bProj.isError || bProj.json?.created?.ref !== undefined, bProj.text);
  const into = await rawDb.collection('tasks').findOne({ orgId: A.orgId, title: 'Into the vault' });
  check('names: B\'s task did not go into A\'s private project', !into || into.projectId !== vault.id, into?.projectId);
  check('names: nothing tells B that someone has a private project of that name', !/private to someone|already exists/i.test(bProj.text), bProj.text.slice(0, 160));
  // B made their own "Hidden Vault": remove it so the later checks look for A's private things only.
  if (into) {
    await rawDb.collection('tasks').deleteOne({ _id: into._id });
    await rawDb.collection('activity').deleteMany({ taskId: into._id });
    if (into.projectId && into.projectId !== vault.id) await rawDb.collection('projects').deleteOne({ _id: into.projectId });
  }

  // ---- C: nothing of the first organization ----
  const cReads = await readAll(kC);
  const cText = cReads.map(echoFree).join('\n');
  check('C (other org): nothing of the first organization in any MCP read', !/Hidden|Zephyr shared|Zephyr memo|Bea/.test(cText), cReads.filter(r => /Hidden|Zephyr shared|Zephyr memo|Bea/.test(echoFree(r))).map(r => `${r.n} ${JSON.stringify(r.a)}`).join(', '));
  check('C: #1 is C\'s own task', /Quokka task by Cy/.test(cReads.find(r => r.n === 'get_task' && r.a.task === p1.ref)?.text ?? '') || p1.ref !== 1);
  for (const [n, a] of [['update_task', { task: s1.id, title: 'C was here' }], ['add_comment', { task: s1.id, note: 'C was here' }], ['complete_task', { task: s1.id }], ['delete_task', { task: s1.id, title: 'Zephyr shared task one' }], ['write_note', { note_id: zMemo.id, append: 'C was here' }], ['apply_changes', { ops: [{ op: 'update_task', task: s1.id, priority: 'P1' }] }]]) {
    const r = await as(kC, n, a);
    check(`C: ${n} on the first organization's data is refused`, r.isError || (n === 'apply_changes' && /not found/i.test(r.text)), r.text.slice(0, 200));
  }
  const s1After = await rawDb.collection('tasks').findOne({ _id: s1.id });
  check('C: the shared task is unchanged', s1After.title === 'Zephyr shared task one' && s1After.priority !== 'P1' && s1After.status !== 'Done');
  const cDiscord = await as(kC, 'discord_list_channels', {});
  check('C: Discord tools are not available (linked to the first organization or off)', cDiscord.isError);

  // ---- inbox notices go to their recipient, by the recipient's own settings ----
  await rawDb.collection('settings').insertOne({ _id: `notify:${A.userId}`, area: 'notify', orgId: A.orgId, userId: A.userId, notify: { kinds: { claude_waiting: false } } });
  await must(kA, 'update_claude_items', { ops: [
    { op: 'add', project: 'Zephyr Shared', kind: 'feature', title: 'Zephyr question for Bea in the tenancy run', why, done_when: 'Bea has answered the question.', waiting_on_om: 'Bea: pick a colour', waiting_on: 'bea@example.test' },
    { op: 'add', project: 'Zephyr Shared', kind: 'feature', title: 'Zephyr question for the owner in this run', why, done_when: 'The owner has answered the question.', waiting_on_om: 'Owner: pick a size' },
  ] });
  const waitB = await rawDb.collection('notifications').countDocuments({ userId: Bu.userId, kind: 'claude_waiting' });
  const waitA = await rawDb.collection('notifications').countDocuments({ userId: A.userId, kind: 'claude_waiting' });
  check('inbox: the item waiting on B tells B', waitB === 1, String(waitB));
  check('inbox: A turned "Claude needs you" off, so A gets none (A\'s own settings)', waitA === 0, String(waitA));
  const bad = await as(kA, 'update_claude_items', { ops: [{ op: 'add', project: 'Zephyr Shared', kind: 'feature', title: 'Zephyr question for an outsider in this run', why, done_when: 'Nobody can answer this one.', waiting_on_om: 'x', waiting_on: 'cy@example.test' }] });
  check('waiting_on: someone outside the organization is refused', bad.isError, bad.text);
  // B's Claude Code changes A's shared task: A (its recipient) is told, B is not
  await must(kBcode, 'update_task', { task: s1.ref, priority: 'P1' });
  const chA = await rawDb.collection('notifications').countDocuments({ userId: A.userId, kind: 'claude_code_changes' });
  const chB = await rawDb.collection('notifications').countDocuments({ userId: Bu.userId, kind: 'claude_code_changes' });
  check('inbox: a teammate\'s Claude Code change tells the task\'s owner only', chA === 1 && chB === 0, `A ${chA} B ${chB}`);

  // ---- alerts: queued for the recipient only ----
  const dep = (await must(kA, 'add_task', { title: 'Zephyr waits on Bea', project: 'Zephyr Shared', depends_on: [sB.ref] })).created;
  dep.id = (await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: dep.ref }))._id;
  await must(kB, 'complete_task', { task: sB.ref });
  await new Promise(r => setTimeout(r, 2500));
  const q = await rawDb.collection('alertQueue').find({ taskId: dep.id }).toArray();
  check('alerts: "unblocked" is queued for the waiting task\'s owner (A), in A\'s organization', q.length === 1 && q[0].userId === A.userId && q[0].orgId === A.orgId, JSON.stringify(q.map(x => [x.userId === A.userId ? 'A' : x.userId, x.orgId === A.orgId])));
  if (!quiet) {
    const inA = await rawDb.collection('notifications').countDocuments({ userId: A.userId, kind: 'unblocked' });
    const inB = await rawDb.collection('notifications').countDocuments({ userId: Bu.userId, kind: 'unblocked' });
    check('alerts: delivered to A\'s inbox only', inA === 1 && inB === 0, `A ${inA} B ${inB}`);
  } else console.log('(quiet hours in Asia/Kolkata: delivery is held; checked the queue only)');
  // the cron runs per person: each gets a run record of their own
  await fetch(`${B}/api/cron/alerts`, { headers: { authorization: `Bearer ${CRON}` } }).then(r => r.json());
  const runs = await rawDb.collection('settings').find({ area: 'alerts' }).toArray();
  check('cron: one run per person (A, B and C)', [A.userId, Bu.userId, Cu.userId].every(u => runs.some(r => r._id === `alerts:${u}`)), runs.map(r => r._id).join(','));
  // push devices: each person's own (the same query sendPush uses)
  await rawDb.collection('pushSubs').insertMany([
    { _id: 'https://push.example.test/a1', orgId: A.orgId, userId: A.userId, keys: { p256dh: 'x', auth: 'y' }, device: 'A phone', createdAt: new Date(), updatedAt: new Date() },
    { _id: 'https://push.example.test/a2', orgId: A.orgId, userId: A.userId, keys: { p256dh: 'x', auth: 'y' }, device: 'A laptop', createdAt: new Date(), updatedAt: new Date() },
  ]);

  // ---- worker and admin APIs ----
  const devKey = 'wkr_' + randomBytes(32).toString('base64url');
  await rawDb.collection('devices').insertOne({ _id: randomUUID(), name: 'Cy-PC', ownerId: Cu.userId, orgId: Cu.orgId, hash: sha(devKey), prefix: devKey.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  const aDev = randomUUID();
  await rawDb.collection('devices').insertOne({ _id: aDev, name: 'A-PC', ownerId: A.userId, orgId: A.orgId, hash: sha('nope' + aDev), prefix: 'wkr_nope', createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  await rawDb.collection('workerJobs').insertOne({ _id: randomUUID(), orgId: A.orgId, ownerId: A.userId, deviceId: aDev, kind: 'start', state: 'pending', createdAt: new Date(), payload: { text: 'Hidden job' } });
  const poll = await fetch(B + '/api/worker/jobs', { headers: { authorization: `Bearer ${devKey}` } }).then(async r => ({ status: r.status, text: await r.text() }));
  check('worker: C\'s computer polls fine and gets nothing of A\'s', poll.status === 200 && !/Hidden/.test(poll.text), `${poll.status} ${poll.text.slice(0, 200)}`);
  const ownerless = 'wkr_' + randomBytes(32).toString('base64url');
  await rawDb.collection('devices').insertOne({ _id: randomUUID(), name: 'Old-PC', hash: sha(ownerless), prefix: ownerless.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  const old = await fetch(B + '/api/worker/jobs', { headers: { authorization: `Bearer ${ownerless}` } });
  check('worker: a computer with no owner is refused', old.status === 401, String(old.status));
  const hC = await fetch(B + '/api/admin/health', { headers: { authorization: `Bearer ${kC}` } });
  check('admin/health: another organization\'s owner is not the operator -> 403', hC.status === 403, hC.status);
  const reg = await fetch(B + '/api/admin/discord/register', { headers: { authorization: `Bearer ${kC}` } });
  check('admin/discord/register: another organization\'s owner -> 403', reg.status === 403, reg.status);
  const health = await fetch(B + '/api/admin/health', { headers: { authorization: `Bearer ${kA}` } }).then(r => r.json());
  const aTasks = await rawDb.collection('tasks').countDocuments({ orgId: A.orgId, $or: [{ visibility: 'org' }, { ownerId: A.userId }] });
  check('admin/health: the operator\'s counts are of their own view', health.counts?.tasks === aTasks, `${health.counts?.tasks} vs ${aTasks}`);

  // ---- restore follows the project as it is now ----
  await must(kA, 'add_project', { name: 'Restore Room' });
  const rr = (await must(kB, 'add_task', { title: 'Restore room task by Bea', project: 'Restore Room' })).created;
  await must(kB, 'delete_task', { task: rr.ref, title: 'Restore room task by Bea' });
  await must(kA, 'update_project', { project: 'Restore Room', visibility: 'private' });
  const rB = await as(kB, 'restore_task', { task: rr.ref });
  check('restore: a task whose project went private is not found for the teammate', rB.isError && /not in the trash|not found/i.test(rB.text), rB.text.slice(0, 160));
  const rA = await as(kA, 'restore_task', { task: rr.ref });
  const rrDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: rr.ref });
  check('restore: the private project\'s owner gets it back private to them', !rA.isError && rrDoc?.visibility === 'private' && rrDoc.ownerId === A.userId, `${rA.text.slice(0, 100)} ${rrDoc?.visibility}`);
  const rrAct = await rawDb.collection('activity').find({ taskId: rrDoc?._id }).toArray();
  check('restore: its history follows (the trashed line included)', rrAct.length >= 3 && rrAct.every(a => a.visibility === 'private' && a.ownerId === A.userId), JSON.stringify(rrAct.map(a => [a.type, a.visibility])));
  await must(kA, 'add_project', { name: 'Restore Den', visibility: 'private' });
  const rd = (await must(kA, 'add_task', { title: 'Restore den task', project: 'Restore Den' })).created;
  await must(kA, 'delete_task', { task: rd.ref, title: 'Restore den task' });
  await must(kA, 'update_project', { project: 'Restore Den', visibility: 'org' });
  const rB2 = await as(kB, 'restore_task', { task: rd.ref });
  const rdDoc = await rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: rd.ref });
  check('restore: a task whose project became shared comes back shared (a teammate may restore it)', !rB2.isError && rdDoc?.visibility === 'org' && rdDoc.ownerId === A.userId, `${rB2.text.slice(0, 120)} ${rdDoc?.visibility}`);
  check('restore: ...and the teammate sees what they restored', !(await as(kB, 'get_task', { task: rd.ref })).isError);

  // ---- note files: what is shown inline (lib/note-files.ts, imported as is) ----
  const nf = await import('../../lib/note-files.ts');
  const hd = (t, n) => nf.noteFileHeaders(t, n);
  check('note files: png shows inline', hd('image/png', 'a.png')['Content-Disposition'].startsWith('inline') && hd('image/png', 'a.png')['Content-Type'] === 'image/png');
  for (const [t, n] of [['image/svg+xml', 'a.svg'], ['text/html', 'a.html'], ['text/html; charset=utf-8', 'x.png'], ['application/xhtml+xml', 'a.xhtml'], ['', 'a'], ['text/plain', 'a.txt']]) {
    const h = hd(t, n);
    check(`note files: ${t || '(no type)'} downloads and cannot render`, h['Content-Disposition'].startsWith('attachment') && !/html|svg|xml|text\//.test(h['Content-Type']), JSON.stringify(h));
  }
  check('note files: every file gets the sandbox policy and nosniff', /sandbox/.test(hd('image/png', 'a.png')['Content-Security-Policy']) && hd('text/html', 'a')['X-Content-Type-Options'] === 'nosniff');
  check('note files: no SVG, HTML, XML or script in the upload list', !nf.UPLOAD_TYPES.some(t => /svg|html|javascript|^(text|application)\/xml/.test(t)), nf.UPLOAD_TYPES.join(' '));
  check('note files: only notes/<org>/<note>/<name> paths', !!nf.parseNoteFilePath('notes/o1/n1/a.png') && !nf.parseNoteFilePath('notes/o1/a.png') && !nf.parseNoteFilePath('notes/a.png') && !nf.parseNoteFilePath('notes/o1/n1/../a.png') && !nf.parseNoteFilePath('notes/o1/n1/.htaccess'));

  // ---- the operator's things (OPERATOR_EMAILS = the e2e owner) ----
  const tB = await fetch(B + '/api/timetable/today', { headers: { authorization: `Bearer ${kB}` } }).then(r => r.json());
  const tA = await fetch(B + '/api/timetable/today', { headers: { authorization: `Bearer ${kA}` } }).then(r => r.json());
  const tC = await fetch(B + '/api/timetable/today', { headers: { authorization: `Bearer ${kC}` } }).then(r => r.json());
  const weekdayIn = tz => !/Sat|Sun/.test(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()));
  check('schedule: the owner gets their own week, in their timezone', tA.schedule?.length === 17 && tA.timezone === 'Asia/Kolkata', `${tA.schedule?.length} ${tA.timezone}`);
  check('schedule: a teammate gets their own, in their timezone', tB.schedule?.length === 1 && tB.schedule[0].block === 'Bea focus' && tB.timezone === BEA_TZ, JSON.stringify(tB).slice(0, 160));
  check('schedule: the teammate\'s current block is theirs (weekdays in their zone)', !weekdayIn(BEA_TZ) || tB.currentBlock === 'Bea focus', `${tB.currentBlock}`);
  check('schedule: a new person has none', Array.isArray(tC.schedule) && tC.schedule.length === 0 && tC.currentBlock === null, JSON.stringify(tC).slice(0, 120));
  // what "today" means follows each person's timezone
  const dayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dueA = (await must(kA, 'add_task', { title: 'Zephyr due today for owner', project: 'Zephyr Shared', due: 'today' })).created;
  const dueB = (await must(kB, 'add_task', { title: 'Zephyr due today for Bea', project: 'Zephyr Shared', due: 'today' })).created;
  const [dA, dB] = await Promise.all([dueA, dueB].map(t => rawDb.collection('tasks').findOne({ orgId: A.orgId, ref: t.ref })));
  check('timezone: "today" is the owner\'s date in Asia/Kolkata and Bea\'s in New York', dA?.due === dayIn('Asia/Kolkata') && dB?.due === dayIn(BEA_TZ), `${dA?.due} ${dB?.due}`);

  // ---- dispatcher: each person's switch, rules note and cap; the cap counts only their own claims ----
  {
    const now = Date.now();
    const pid = 'tn-dispatch';
    await rawDb.collection('projects').insertOne({ _id: pid, name: 'Tenancy Dispatch', nameLower: 'tenancy dispatch', client: '', description: '', status: 'active', orgId: A.orgId, ownerId: A.userId, visibility: 'org', createdAt: new Date(), updatedAt: new Date() });
    const dev = async (who, name) => {
      const key = 'wkr_' + randomBytes(32).toString('base64url');
      const _id = randomUUID();
      await rawDb.collection('devices').insertOne({ _id, name, ownerId: who.userId, orgId: who.orgId, hash: sha(key), prefix: key.slice(0, 8), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
      await rawDb.collection('workerFolders').insertOne({ _id: `${_id}:f1`, deviceId: _id, folderId: 'f1', name: 'dispatch', git: false, projectId: pid, linkedAt: new Date(), seenAt: new Date(), missing: false, orgId: who.orgId, ownerId: who.userId });
      return { id: _id, key };
    };
    const call = (d, method, path, body) => fetch(B + path, { method, headers: { authorization: `Bearer ${d.key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
    const ready = d => call(d, 'POST', '/api/worker/status', { worker: { version: '0.1.0', os: 'win32', allowPrompts: true }, jobs: [], sessions: [] });
    const poll = d => call(d, 'GET', '/api/worker/jobs');
    const devA = await dev(A, 'Owner PC'), devB = await dev(Bu, 'Bea PC');
    for (const [who, id] of [[A, 'tn-rules-a'], [Bu, 'tn-rules-b']]) {
      await db.collection('notes').insertOne({ _id: id, title: 'Rules', blocks: [], body: 'x', parentId: null, taskId: null, projectId: null, archived: false, createdBy: 'me', createdAt: new Date(), updatedBy: 'me', updatedAt: new Date(), deletedAt: null, orgId: who.orgId, ownerId: who.userId, visibility: 'private' });
    }
    await rawDb.collection('settings').insertMany([
      { _id: `dispatcher:${A.userId}`, area: 'dispatcher', orgId: A.orgId, userId: A.userId, enabled: true, maxConcurrent: 1, boilerplateNoteId: 'tn-rules-a' },
      { _id: `dispatcher:${Bu.userId}`, area: 'dispatcher', orgId: A.orgId, userId: Bu.userId, enabled: true, maxConcurrent: 2, boilerplateNoteId: 'tn-rules-b' },
    ]);
    const base = { description: '', mode: null, projectId: pid, priority: 'P2', status: 'Not Started', tags: [], due: null, start: null, estimateMins: null, progress: 0, checklist: [], links: [], blockedReason: '', dependsOn: [], recurrence: null, nextRef: null, archived: false, createdBy: 'me', createdAt: new Date(now - 864e5), updatedAt: new Date(now - 36e5), doneAt: null, doneOn: null, doneBy: null, orgId: A.orgId, visibility: 'org', assigneeId: null };
    const mark = (who, n, o = {}) => ({ state: 'queued', markedAt: new Date(now - (100 - n) * 60_000), markedBy: 'user', markedByUserId: who.userId, markedByOrgId: who.orgId, ...o });
    await rawDb.collection('tasks').insertMany([
      { ...base, _id: 'tn-d1', ref: 901, title: 'Owner running one', ownerId: A.userId, status: 'In Progress', claude: mark(A, 1, { state: 'running', claimedAt: new Date(), deviceId: devA.id, sessionId: randomUUID(), prevStatus: 'Not Started' }) },
      { ...base, _id: 'tn-d2', ref: 902, title: 'Owner queued two', ownerId: A.userId, claude: mark(A, 2) },
      { ...base, _id: 'tn-d3', ref: 903, title: 'Bea queued one', ownerId: Bu.userId, claude: mark(Bu, 3) },
      { ...base, _id: 'tn-d4', ref: 904, title: 'Bea queued two', ownerId: Bu.userId, claude: mark(Bu, 4) },
      { ...base, _id: 'tn-d5', ref: 905, title: 'Bea queued three', ownerId: Bu.userId, claude: mark(Bu, 5) },
    ]);
    const st = async id => (await rawDb.collection('tasks').findOne({ _id: id }))?.claude?.state;
    await ready(devA); await ready(devB);
    const pa = await poll(devA);
    check('dispatcher: the owner at their cap of 1 gets nothing more', pa.status === 200 && pa.body.jobs.length === 0 && (await st('tn-d2')) === 'queued', JSON.stringify(pa.body).slice(0, 160));
    await poll(devB); await poll(devB); await poll(devB);
    const bStates = await Promise.all(['tn-d3', 'tn-d4', 'tn-d5'].map(st));
    check('dispatcher: Bea\'s cap of 2 does not count the owner\'s running claim', bStates.filter(s => s === 'running').length === 2 && bStates[2] === 'queued', bStates.join(','));
    check('dispatcher: Bea\'s computer never claims the owner\'s task', (await st('tn-d2')) === 'queued');
    await rawDb.collection('settings').updateOne({ _id: `dispatcher:${Bu.userId}` }, { $set: { enabled: false } });
    await rawDb.collection('settings').updateOne({ _id: `dispatcher:${A.userId}` }, { $set: { maxConcurrent: 2 } });
    await poll(devA);
    check('dispatcher: the owner\'s switch and cap are their own (Bea\'s off switch does not stop the owner)', (await st('tn-d2')) === 'running');
    await poll(devB);
    check('dispatcher: Bea\'s switch off stops only Bea\'s claims', (await st('tn-d5')) === 'queued');
  }
  const hB = await fetch(B + '/api/admin/health', { headers: { authorization: `Bearer ${kB}` } });
  check('admin/health: a member -> 403', hB.status === 403, hB.status);

  // ---- pages, search and note files (browser) ----
  const b = await launch();
  const session = async (email, fn) => {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await login(p, { email, password: PW, next: '/today' });
    try { await fn(p, ctx); } finally { await ctx.close(); }
  };
  const text = async (p, path) => {
    const r = await p.goto(B + path);
    await p.waitForTimeout(500);
    return { status: r?.status() ?? 0, text: await p.locator('body').innerText() };
  };
  // A not-found page under the app's loading boundary streams with status 200; its body says so.
  const gone = r => (r.status === 404 || /could not be found/i.test(r.text));
  const missing = async (p, path, secret) => {
    const r = await text(p, path);
    return { ok: gone(r) && !secret.test(r.text), why: `${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}` };
  };
  const search = async (p, q) => {
    await p.goto(B + '/today');
    await p.waitForTimeout(600);
    await p.locator('aside button:has-text("Search")').click();
    const input = p.locator('input[aria-controls=global-search-results]');
    await input.waitFor();
    await input.fill(q);
    await p.waitForTimeout(1200);
    const n = await p.getByRole('option').count();
    const t = n ? await p.locator('[role=listbox]').innerText() : '';
    await p.keyboard.press('Escape');
    return { n, t };
  };
  const filePath = async (p, path) => (await p.request.get(`${B}/api/notes/file?p=${encodeURIComponent(path)}`)).status();
  const upload = async (p, pathname) => (await p.request.post(`${B}/api/notes/upload`, { data: { type: 'blob.generate-client-token', payload: { pathname, callbackUrl: B, clientPayload: null, multipart: false } } })).status();

  await session('bea@example.test', async p => {
    const tasks = await text(p, '/tasks');
    check('B pages: /tasks shows the shared task, not A\'s private ones', /Zephyr shared task one/.test(tasks.text) && !/Hidden/.test(tasks.text));
    let m = await missing(p, `/tasks/${p1.ref}`, /Hidden/);
    check('B pages: A\'s private task page is not found', m.ok, m.why);
    for (const path of ['/notes', '/projects', '/today', '/review?view=activity', '/review?view=trash', '/review?view=done', '/notifications', `/projects/${zephyr.id}`, `/projects/${zephyr.id}?tab=claude`]) {
      const r = await text(p, path);
      check(`B pages: ${path} shows nothing private of A`, r.status === 200 && !/Hidden/.test(r.text), `${r.status} ${(r.text.match(/.{0,40}Hidden.{0,40}/) ?? [''])[0]}`);
    }
    m = await missing(p, `/projects/${vault.id}`, /Hidden/);
    check('B pages: A\'s private project is not found', m.ok, m.why);
    m = await missing(p, `/notes/${vMemo.id}`, /Hidden/);
    check('B pages: A\'s private note is not found', m.ok, m.why);
    const inbox = await text(p, '/notifications');
    check('B inbox: B\'s notice, not A\'s', /Claude needs you/.test(inbox.text) && !/changed #/.test(inbox.text) && !/Owner: pick a size/.test(inbox.text));
    const dev = await text(p, '/settings?section=device');
    check('B settings: push devices are B\'s own (0)', /0 devices receiving push/.test(dev.text), (dev.text.match(/\d+ devices? receiving push/) ?? ['none'])[0]);
    const sh = await search(p, 'Hidden');
    check('B search: nothing private of A', sh.n === 0 || !/Hidden/.test(sh.t), sh.t);
    const sz = await search(p, 'Zephyr');
    check('B search: finds shared work', sz.n > 0 && /Zephyr/.test(sz.t), sz.t);
    check('B notes upload: into A\'s private note is refused', (await upload(p, `notes/${A.orgId}/${vMemo.id}/x.png`)) === 400);
    check('B notes upload: into a shared note passes the checks', (await upload(p, `notes/${A.orgId}/${zMemo.id}/x.png`)) === 503);
    check('B notes file: A\'s private note\'s file is not served', (await filePath(p, `notes/${A.orgId}/${vMemo.id}/x.png`)) === 404);
    check('B notes file: a shared note\'s file passes the checks', (await filePath(p, `notes/${A.orgId}/${zMemo.id}/x.png`)) === 503);
    check('B notes file: a path without a note is not served', (await filePath(p, `notes/${A.orgId}/x.png`)) === 404);
    const use = await text(p, '/settings?section=usage');
    check('B settings: Usage is the operator\'s only', !/Last 24 h/.test(use.text) && (await p.locator('[data-usage], [data-section=usage], [data-row=usage]').count()) === 0, use.text.slice(0, 120));
    const sched = await text(p, '/timetable');
    check('B schedule page: Bea\'s own week', /Bea focus/.test(sched.text) && !/Morning Anchor/.test(sched.text), sched.text.slice(0, 120));
  });

  await session(EMAIL, async p => {
    const dev = await text(p, '/settings?section=device');
    check('A settings: push devices are A\'s own (2)', /2 devices receiving push/.test(dev.text), (dev.text.match(/\d+ devices? receiving push/) ?? ['none'])[0]);
    const inbox = await text(p, '/notifications');
    check('A inbox: A\'s notices, not B\'s', /changed #/.test(inbox.text) && !/Bea: pick a colour/.test(inbox.text));
    check('notes upload: into one\'s own note passes the checks', (await upload(p, `notes/${A.orgId}/${vMemo.id}/x.png`)) === 503);
    check('notes file: one\'s own private note\'s file passes the checks', (await filePath(p, `notes/${A.orgId}/${vMemo.id}/x.png`)) === 503);
    const use = await text(p, '/settings?section=usage');
    check('A settings: the operator sees Usage', /Last 24 h/.test(use.text));
    const aToday = await text(p, '/today');
    const aBar = await p.locator('[data-block-bar]').count();
    check('A today: the schedule bar, and no routine card (removed)', aBar === 1 && !/Fiverr Ritual/.test(aToday.text), `bar ${aBar} routine ${/Fiverr Ritual/.test(aToday.text)}`);
  });

  const FIRST = /Hidden|Zephyr shared task|Zephyr memo|Zephyr waits|Bea/; // C has its own "Zephyr Shared" project (names check above)
  await session('cy@example.test', async p => {
    for (const path of ['/tasks', '/notes', '/projects', '/today', '/review?view=activity', '/review?view=trash', '/notifications', '/claude']) {
      const r = await text(p, path);
      check(`C pages: ${path} shows nothing of the first organization`, r.status === 200 && !FIRST.test(r.text), `${r.status} ${(r.text.match(/.{0,40}(Hidden|Zephyr shared task|Zephyr memo|Zephyr waits|Bea).{0,40}/) ?? [''])[0]}`);
    }
    for (const path of [`/projects/${zephyr.id}`, `/projects/${vault.id}`, `/notes/${zMemo.id}`, `/tasks/${s1.id}`]) {
      const m = await missing(p, path, FIRST);
      check(`C pages: ${path} is not found`, m.ok, m.why);
    }
    const t1 = await text(p, '/tasks/1');
    // the title is an input on the task page
    t1.text += ' ' + (await p.locator('input, textarea').evaluateAll(es => es.map(e => e.value).join(' ')));
    check('C pages: /tasks/1 is C\'s own task', /Quokka task by Cy/.test(t1.text) && !FIRST.test(t1.text), t1.text.slice(0, 160).replace(/\s+/g, ' '));
    for (const q of ['Zephyr', 'Hidden']) {
      const r = await search(p, q);
      check(`C search: "${q}" finds nothing of the first organization`, r.n === 0 || !FIRST.test(r.t), r.t);
    }
    check('C notes file: the first organization\'s files are not served', (await filePath(p, `notes/${A.orgId}/${zMemo.id}/x.png`)) === 404);
    check('C notes file: older paths are not served', (await filePath(p, 'notes/legacy.png')) === 404);
    check('C notes upload: into the first organization\'s note is refused', (await upload(p, `notes/${A.orgId}/${zMemo.id}/x.png`)) === 400);
    check('C notes upload: an old-style path (no organization) is refused', (await upload(p, 'notes/x.png')) === 400);
    const cToday = await text(p, '/today');
    check('C today: a new person has no schedule bar and no routine', (await p.locator('[data-block-bar]').count()) === 0 && !/not logged|Fiverr/.test(cToday.text));
    const sched = await text(p, '/timetable');
    check('C schedule page: offers to set one up', /No schedule yet/.test(sched.text) && /Set up your schedule/.test(sched.text), sched.text.slice(0, 120));
  });
  await b.close();
} catch (e) {
  check('tenancy (error)', false, e?.stack || String(e));
}
await finish();
