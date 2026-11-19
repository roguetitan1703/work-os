// Flow H9 (plan note 50de971034): Orders versions and edits. Every change of an Orders page's text is a version (who, when,
// why, the lines that went and came, the text before it for undo); the holder's own Claude may change the text, anyone
// else's may not; teammates' agents propose. Part 1 (step 1): versions made by a person in the app: a version per change,
// autosaves within ten minutes folded into one, the feed row, nothing for a person's own Orders, the log never in a list.
// Later parts (holder's Claude, brief, delivery, undo, propose_order) are added by their steps. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { B, EMAIL, ME, MCP, PW, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must, markOrders } from './flow-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Server actions, the way the leak audit calls them: the build's manifest gives each export its id and a page that serves it.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')).node;
const ACTIONS = {};
for (const [id, v] of Object.entries(MANIFEST)) {
  const workers = Object.keys(v.workers);
  const w = v.exportedName ? v : v.workers[workers[0]];
  const page = workers.map(p => '/' + p.replace(/^app\//, '').replace(/\/page$/, '').split('/').filter(s => !/^\(.*\)$/.test(s)).join('/')).sort((a, b) => (/\[/.test(a) - /\[/.test(b)) || a.length - b.length)[0];
  ACTIONS[`${w.filename}#${w.exportedName}`] = { id, page: page.replace(/\[[^\]]+\]/g, 'x') || '/' };
}
function rsc(text) {
  const rows = new Map();
  for (const line of text.split('\n')) { const m = line.match(/^([0-9a-f]+):(.*)$/); if (m) rows.set(m[1], m[2]); }
  let head = null;
  try { head = JSON.parse(rows.get('0') ?? 'null'); } catch { /* not a result */ }
  const a = head?.a;
  if (typeof a === 'string' && a.startsWith('$@')) {
    const row = rows.get(a.slice(2)) ?? '';
    if (row.startsWith('E')) return { error: true, value: null };
    try { return { value: JSON.parse(row) }; } catch { return { value: row }; }
  }
  return { value: a === undefined ? null : a, error: head === null };
}
async function action(name, args, cookie) {
  const a = ACTIONS[name];
  if (!a) return { value: { error: 'not in the build: ' + name } };
  const r = await fetch(B + a.page, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'next-action': a.id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' }, body: JSON.stringify(args) });
  return { value: rsc(await r.text()).value };
}
async function signIn(email, password = PW) {
  const r = await fetch(B + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: B, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
}
const NA = 'app/(app)/notes/actions.ts#';
const paragraph = (text, i) => ({ id: `p${i}-${Math.random().toString(36).slice(2, 8)}`, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });
const blocksOf = lines => lines.map(paragraph);
const noteDoc = id => rawDb.collection('notes').findOne({ _id: id });
const feed = id => rawDb.collection('activity').find({ 'subject.id': id, type: 'orders_changed' }).sort({ at: 1 }).toArray();

try {
  const cookie = await signIn(EMAIL);
  const mk = async (project, title, body) => (await must(MCP, 'write_note', { project, title, body })).created.id;
  await must(MCP, 'add_project', { name: 'H9 One' });
  // The organization Orders must be shared with everyone: a page in the shared project; the suite sets what the app sets.
  const org = await mk('H9 One', 'H9 Delpat Orders', 'Rule one.\n\nRule two.\n\nRule three.');
  await rawDb.collection('notes').updateOne({ _id: org }, { $set: { visibility: 'org' } });
  await markOrders(org, 'org', ME.userId);
  const mine = await mk('H9 One', 'H9 my Orders', 'My rule.');
  await markOrders(mine, 'person', ME.userId);

  // ---- 1: a person's save makes version 2; a second save within ten minutes folds into it ----
  const n0 = await noteDoc(org);
  check('1: a page marked before versions began reads as version 1 (no field)', n0.ordersV === undefined && !n0.ordersLog);
  const s1 = await action(NA + 'saveNoteAction', [org, { blocks: blocksOf(['Rule one.', 'Rule two changed.', 'Rule three.']) }], cookie);
  const n1 = await noteDoc(org);
  check('1: a save through the app makes version 2 with the text before it kept for undo', s1.value?.ok === true && n1.ordersV === 2 && n1.ordersLog?.length === 1 && n1.ordersLog[0].v === 2 && n1.ordersLog[0].before === n0.body, JSON.stringify([s1.value, n1.ordersV, n1.ordersLog?.length]));
  check('1: the version records who, when, and the lines that went and came', n1.ordersLog[0].by?.kind === 'user' && n1.ordersLog[0].by.userId === ME.userId && JSON.stringify(n1.ordersLog[0].removed) === JSON.stringify(['Rule two.']) && JSON.stringify(n1.ordersLog[0].added) === JSON.stringify(['Rule two changed.']), JSON.stringify(n1.ordersLog?.[0]));
  const s2 = await action(NA + 'saveNoteAction', [org, { blocks: blocksOf(['Rule one.', 'Rule two changed again.', 'Rule three.']) }], cookie);
  const n2 = await noteDoc(org);
  check('1: a second save by the same person within ten minutes folds into the same version (first before-text kept)', s2.value?.ok === true && n2.ordersV === 2 && n2.ordersLog.length === 1 && n2.ordersLog[0].before === n0.body && JSON.stringify(n2.ordersLog[0].added) === JSON.stringify(['Rule two changed again.']) && JSON.stringify(n2.ordersLog[0].removed) === JSON.stringify(['Rule two.']), JSON.stringify(n2.ordersLog));
  const s3 = await action(NA + 'saveNoteAction', [org, { blocks: blocksOf(['Rule one.', 'Rule two changed again.', 'Rule three.']) }], cookie);
  check('1: a save that leaves the text as it is makes no version', s3.value?.ok === true && (await noteDoc(org)).ordersV === 2);
  const s4 = await action(NA + 'saveNoteAction', [org, { title: 'H9 Delpat Orders (renamed)' }], cookie);
  const n4 = await noteDoc(org);
  check('1: a rename alone makes no version', s4.value?.ok === true && n4.ordersV === 2 && n4.title === 'H9 Delpat Orders (renamed)');
  // Make the version old, then edit: a new version, never folded into an old one.
  await rawDb.collection('notes').updateOne({ _id: org }, { $set: { 'ordersLog.0.at': new Date(Date.now() - 11 * 60_000) } });
  const s5 = await action(NA + 'saveNoteAction', [org, { blocks: blocksOf(['Rule one.', 'Rule two changed again.', 'Rule three.', 'Rule four.']) }], cookie);
  const n5 = await noteDoc(org);
  check('1: a save after ten minutes starts version 3', s5.value?.ok === true && n5.ordersV === 3 && n5.ordersLog.length === 2 && n5.ordersLog[1].v === 3 && JSON.stringify(n5.ordersLog[1].added) === JSON.stringify(['Rule four.']), JSON.stringify([n5.ordersV, n5.ordersLog?.length]));
  // A stale save is a conflict, not a lost version.
  const stale = await action(NA + 'saveNoteAction', [org, { blocks: blocksOf(['x']), expectUpdatedAt: new Date(Date.now() - 86_400_000).toISOString() }], cookie);
  check('1: a stale save is refused and changes nothing', stale.value?.conflict === true && (await noteDoc(org)).ordersV === 3);

  // ---- feed rows: one per version, none for a person's own Orders ----
  const rows = await feed(org);
  check('1: the feed has one orders_changed row per version, carrying the version and the line counts', rows.length === 2 && rows[0].note?.startsWith('v2: -1 +1') && rows[1].note?.startsWith('v3: -0 +1') && rows.every(r => r.subject?.kind === 'note' && r.subject.id === org), JSON.stringify(rows.map(r => r.note)));
  const sm = await action(NA + 'saveNoteAction', [mine, { blocks: blocksOf(['My rule changed.']) }], cookie);
  const nm = await noteDoc(mine);
  check('1: a person-layer page keeps versions too, but makes no feed row', sm.value?.ok === true && nm.ordersV === 2 && nm.ordersLog?.length === 1 && (await feed(mine)).length === 0 && (await rawDb.collection('activity').countDocuments({ 'subject.id': mine, type: { $ne: 'note_created' } })) === 0);

  // ---- the log never leaves in a list, a search or a read ----
  const grab = JSON.stringify([await mcpH(MCP, 'list_notes', {}), await mcpH(MCP, 'read_note', { note_id: org }), await mcpH(MCP, 'start_work', { project: 'H9 One' })]);
  check('1: no list, read or brief carries the log or the before-text key', !/ordersLog|"before"/.test(grab) && grab.includes('Rule four.'), grab.slice(0, 200));
  const found = await mcpH(MCP, 'recent_activity', { what: 'notes' });
  check('1: recent_activity names the Orders change as a note change', !found.isError && /Orders|orders/.test(found.text), found.text.slice(0, 300));

  // ---- 2: the holder's own Claude edits the text, with a why; nobody else's does ----
  const T = await makeUser({ email: 'tess-h9@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const kCode = await mkKey({ agent: 'claude-code', name: 'H9 Code' });
  const kTess = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Code' });
  const cur = async () => (await noteDoc(org));
  const w1 = await mcpH(kCode, 'write_note', { note_id: org, edits: [{ find: 'Rule four.', replace: 'Rule four, by the holder Claude Code.' }], why: 'H9 test: edits' });
  const c1 = await cur();
  check('2: the holder Claude Code key edits the organization Orders with edits and a why: v4, and the answer says so', !w1.isError && w1.json?.orders?.version === 4 && w1.json.orders.layer === 'org' && /^\d+ of 40$/.test(w1.json.orders.lines) && w1.json.orders.removed === 1 && w1.json.orders.added === 1 && c1.ordersV === 4 && c1.ordersLog.at(-1).why === 'H9 test: edits' && c1.ordersLog.at(-1).by?.kind === 'agent' && c1.ordersLog.at(-1).by.agent === 'claude-code' && c1.ordersLog.at(-1).by.userId === ME.userId, w1.text.slice(0, 300));
  const w2 = await mcpH(MCP, 'write_note', { note_id: org, body: 'Rule one.\n\nRule two changed again.\n\nRule three.\n\nRule four, by the holder Claude Code.\n\nRule five.', why: 'H9 test: body' });
  const c2 = await cur();
  check('2: the holder chat key rewrites the whole page with body: v5 (an agent write is never folded)', !w2.isError && w2.json?.orders?.version === 5 && c2.ordersV === 5 && c2.ordersLog.length === 4 && c2.ordersLog.at(-1).by.agent === 'claude' && /Rule five\./.test(c2.body), w2.text.slice(0, 300));
  const w3 = await mcpH(kCode, 'write_note', { note_id: org, append: 'Rule six.' });
  check('2: an agent write without a why is refused and changes nothing', w3.isError && /why/.test(w3.text) && (await cur()).ordersV === 5, w3.text.slice(0, 200));
  const bodyBefore = (await cur()).body;
  const wt = await mcpH(kTess, 'write_note', { note_id: org, append: 'Injected.', why: 'x' });
  check('2: a teammate Claude Code key cannot change the organization Orders, even with a why', wt.isError && /Orders/.test(wt.text) && (await cur()).body === bodyBefore && (await cur()).ordersV === 5, wt.text.slice(0, 200));
  const batch = await mcpH(kTess, 'apply_changes', { ops: [{ op: 'write_note', note_id: org, append: 'Injected via batch.', why: 'x' }] });
  check('2: nor through apply_changes', batch.isError && (await cur()).body === bodyBefore, batch.text.slice(0, 200));
  const batchOk = await mcpH(kCode, 'apply_changes', { ops: [{ op: 'write_note', note_id: org, edits: [{ find: 'Rule five.', replace: 'Rule five, batch.' }], why: 'H9 test: batch' }] });
  check('2: the holder own apply_changes write_note op works and makes v6 (its result names the version)', !batchOk.isError && (await cur()).ordersV === 6 && /Orders org v6/.test(batchOk.text), batchOk.text.slice(0, 300));
  const arch = await mcpH(kCode, 'write_note', { note_id: org, archived: true, why: 'x' });
  check('2: the holder Claude cannot archive the Orders page', arch.isError && /Orders/.test(arch.text) && !(await cur()).archived, arch.text.slice(0, 200));
  const sub = await mcpH(kCode, 'write_note', { parent_id: org, title: 'H9 sub', why: 'x' });
  check('2: nor add a sub-page to it', sub.isError && /Orders/.test(sub.text), sub.text.slice(0, 200));
  const del = await mcpH(kCode, 'delete_note', { note_id: org, title: (await cur()).title });
  check('2: nor move it to the trash', del.isError && /Orders/.test(del.text) && !(await cur()).deletedAt, del.text.slice(0, 200));
  const ti = await mcpH(kCode, 'write_note', { note_id: org, title: 'H9 Delpat Orders (by Claude)', why: 'H9 title' });
  check('2: the title may change (no new version for a rename alone)', !ti.isError && (await cur()).title === 'H9 Delpat Orders (by Claude)' && (await cur()).ordersV === 6, ti.text.slice(0, 200));

  // The holder person layer is theirs; the project layer belongs to the project owner.
  const own = await mcpH(kCode, 'write_note', { note_id: mine, append: 'My second rule.', why: 'H9 mine' });
  check('2: the holder Claude may change the holder own person Orders (a version, no feed row)', !own.isError && (await noteDoc(mine)).ordersV === 3 && (await feed(mine)).length === 0, own.text.slice(0, 200));
  const projNote = await mk('H9 One', 'H9 project Orders', 'Project rule.');
  await rawDb.collection('notes').updateOne({ _id: projNote }, { $set: { visibility: 'org' } }); // readable by the teammate, so the refusal is about Orders
  await markOrders(projNote, 'project', ME.userId);
  const tp = await mcpH(kTess, 'write_note', { note_id: projNote, append: 'Tess rule.', why: 'x' });
  check('2: a teammate Claude cannot change the project Orders', tp.isError && /Orders/.test(tp.text) && (await noteDoc(projNote)).body === 'Project rule.', tp.text.slice(0, 200));
  const op = await mcpH(kCode, 'write_note', { note_id: projNote, append: 'Project rule two.', why: 'H9 project' });
  check('2: the project owner Claude may', !op.isError && op.json?.orders?.layer === 'project' && op.json.orders.lines === '2' && (await noteDoc(projNote)).ordersV === 2, op.text.slice(0, 200));

  // ---- the org budget: 40 rule lines; one in, one out ----
  const lines40 = Array.from({ length: 40 }, (_, i) => `Budget rule ${i + 1}.`);
  const big = await mk('H9 One', 'H9 Budget Orders', lines40.join('\n\n'));
  await rawDb.collection('notes').updateOne({ _id: big }, { $set: { visibility: 'org' } });
  await markOrders(big, 'org', ME.userId);
  const over = await mcpH(kCode, 'write_note', { note_id: big, append: 'Budget rule 41.', why: 'H9 budget' });
  check('2: an agent write that leaves the organization Orders above 40 lines is refused, naming the count', over.isError && /40 lines at most \(now 41\)/.test(over.text) && !(await noteDoc(big)).ordersV && !(await noteDoc(big)).body.includes('rule 41'), over.text.slice(0, 250));
  const swap = await mcpH(kCode, 'write_note', { note_id: big, edits: [{ find: 'Budget rule 40.', replace: 'Budget rule 40, swapped.' }], why: 'H9 one in one out' });
  check('2: one in, one out (40 lines) is allowed and carries no warning', !swap.isError && swap.json?.orders?.lines === '40 of 40' && !swap.json.orders.warning, swap.text.slice(0, 250));
  const retired = await mcpH(kCode, 'write_note', { note_id: mine, append: 'Never write a boilerplate note.', why: 'H9 retired' });
  check('2: a retired phrase is saved and the answer carries a warning naming it', !retired.isError && /boilerplate/.test(retired.json?.orders?.warning ?? '') && /boilerplate/.test((await noteDoc(mine)).body), retired.text.slice(0, 300));
  const clean = await mcpH(kCode, 'write_note', { note_id: mine, append: 'A clean rule.', why: 'H9 clean' });
  check('2: a later write of other lines carries no warning (only the lines added are checked)', !clean.isError && !clean.json?.orders?.warning, clean.text.slice(0, 300));
  const fr = await feed(org);
  check('2: every agent version has its own feed row with the why (no folding), attributed to the agent', fr.length === 5 && fr.filter(r => r.actor?.kind === 'agent').length === 3 && /· H9 test: edits$/.test(fr[2].note), JSON.stringify(fr.map(r => [r.actor?.kind, r.note])));
} catch (e) {
  check('suite ran without throwing', false, e?.stack || String(e));
}
await finish();
