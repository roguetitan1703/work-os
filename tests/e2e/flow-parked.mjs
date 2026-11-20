// Parked and the decision log (plan note 82ae5908f1): the ops park, park_line and unpark, edit_line and archive_line on Parked
// lines, no limit (Parked and decisions are rows of their own), list_parked and list_decisions, the short State for agents (latest 10 decisions, a Parked count),
// the compact answer and the WORK-STATE.md copy, import of a Parked section, and the State card. Seed profile: none.
import { B, ME, MCP, check, finish, launch, login, overflow, rawDb, SP } from './lib.mjs';
import { mkdirSync } from 'node:fs';
import { mcpH, must } from './flow-lib.mjs';

mkdirSync(SP, { recursive: true });

const NAME = 'Flow Parked';
const texts = l => l.map(x => x.text);
const stateOf = async project => (await must(MCP, 'get_state', { project })).state;
// The State document with its Parked rows as `parked` (oldest first): the lines live in stateParked now (plan note 4a1ccbf69d).
const docOf = async project => {
  const projectId = (await rawDb.collection('projects').findOne({ name: project }))._id;
  const d = await rawDb.collection('states').findOne({ projectId });
  const rows = await rawDb.collection('stateParked').find({ projectId }).sort({ parkedAt: 1, id: 1 }).toArray();
  return { ...d, parked: rows.map(({ _id: _i, projectId: _j, orgId: _x, ownerId: _y, visibility: _z, sharedWith: _u, parkedAt: _k, ...l }) => l) };
};
let browser;
try {
  const P = (await must(MCP, 'add_project', { name: NAME })).project;
  await must(MCP, 'start_work', { project: NAME, session: 'fpk1' });
  const task = (await must(MCP, 'add_task', { title: 'Parked flow task', project: NAME })).created;
  const seed = await must(MCP, 'save_state', {
    project: NAME,
    session: 'fpk1',
    ops: [
      { op: 'set_now', text: 'Testing Parked' },
      { op: 'add_next', text: 'Next line with a task', ref: task.ref, waits_on: 'Om' },
      { op: 'add_next', text: 'Next line two' },
      { op: 'add_later', text: 'Later line one', waits_on: 'a quote' },
      { op: 'add_later', text: 'Later line two' },
      { op: 'park', text: 'Dark mode for the phone app', when: 'a customer asks twice' },
      { op: 'park', text: 'Bulk import of contacts' },
    ],
    base_version: 0,
  });
  check('park: the save is answered', seed.saved === true, JSON.stringify(seed).slice(0, 200));
  let st = await stateOf(NAME);
  check('park: the lines are in Parked, with a date; the State shows a count and no lines', st.parkedTotal === 2 && st.parked === undefined, JSON.stringify(st).slice(0, 300));
  let doc = await docOf(NAME);
  check('park: text and when kept, the line has id, author and date', doc.parked.length === 2 && doc.parked[0].text === 'Dark mode for the phone app' && doc.parked[0].when === 'a customer asks twice' && !doc.parked[1].when && /^l_/.test(doc.parked[0].id) && doc.parked[0].by === ME.userId && doc.parked[0].at instanceof Date, JSON.stringify(doc.parked));
  const feed1 = await rawDb.collection('activity').countDocuments({ type: 'line_parked', projectId: P.id });
  check('park: one line_parked feed row per line', feed1 === 2, String(feed1));

  // park_line from Later (by find) and from Next (by id, with its task ref kept)
  const nextId = doc.next[0].id;
  const laterId = doc.later[0].id;
  const pl = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'park_line', find: 'Later line one', when: 'the quote comes' }, { op: 'park_line', id: nextId }] });
  check('park_line: Later by find and Next by id are taken', !pl.isError && pl.json?.saved === true, pl.text.slice(0, 300));
  doc = await docOf(NAME);
  const fromLater = doc.parked.find(l => l.id === laterId);
  const fromNext = doc.parked.find(l => l.id === nextId);
  check('park_line: the Later line is at the end of Parked with its id, text, waitsOn and the new when', !!fromLater && fromLater.text === 'Later line one' && fromLater.waitsOn === 'a quote' && fromLater.when === 'the quote comes' && !fromLater.hold, JSON.stringify(fromLater));
  check('park_line: the Next line keeps its task ref and waitsOn, has no when, and both left their lists', !!fromNext && fromNext.ref === task.ref && fromNext.waitsOn === 'Om' && !fromNext.when && !doc.next.some(l => l.id === nextId) && !doc.later.some(l => l.id === laterId) && doc.parked.length === 4, JSON.stringify(doc.parked.map(l => l.id)));
  const task2 = await rawDb.collection('tasks').findOne({ ref: task.ref });
  check('park_line: the task of a parked Next line stays open', !!task2 && !['Done', 'Dropped'].includes(task2.status), JSON.stringify(task2?.status));
  const plBad = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'park_line', id: 'l_nonexist' }] });
  check('park_line: an unknown id is refused naming Next and Later', plBad.isError && /Next and Later have no line l_nonexist/.test(plBad.text), plBad.text.slice(0, 200));
  const plBoth = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'unpark', id: 'x', find: 'y' }] });
  check('unpark: id and find together are refused', plBoth.isError && /give id or find, not both/.test(plBoth.text), plBoth.text.slice(0, 200));

  // unpark: to Later (default) and to Next; when dropped
  const up = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'unpark', find: 'Bulk import' }, { op: 'unpark', id: nextId, to: 'next' }] });
  check('unpark: both lines are taken', !up.isError && up.json?.saved === true, up.text.slice(0, 300));
  doc = await docOf(NAME);
  const bulk = doc.later[doc.later.length - 1];
  const backNext = doc.next[doc.next.length - 1];
  check('unpark: to Later (default) puts the line at the end of Later without when', bulk.text === 'Bulk import of contacts' && !bulk.when && !doc.parked.some(l => l.text.startsWith('Bulk')), JSON.stringify(bulk));
  check('unpark: to next puts the line at the end of Next, with its task ref and without when', backNext.id === nextId && backNext.ref === task.ref && !backNext.when && !doc.parked.some(l => l.id === nextId) && doc.parked.length === 2, JSON.stringify(backNext));
  const types = await rawDb.collection('activity').find({ projectId: P.id, note: { $in: ['Bulk import of contacts', 'Next line with a task'] }, type: { $in: ['later_added', 'next_added'] } }).toArray();
  check('unpark: feed rows later_added and next_added', types.some(t => t.type === 'later_added') && types.some(t => t.type === 'next_added'), JSON.stringify(types.map(t => t.type)));

  // edit_line on a parked line
  const edId = doc.parked.find(l => l.text.startsWith('Dark mode')).id;
  const ed = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'edit_line', find: 'phone app', new: 'tablet app' }] });
  doc = await docOf(NAME);
  const edLine = doc.parked.find(l => l.id === edId);
  check('edit_line: finds and edits a Parked line, keeping id, place and when', !ed.isError && edLine?.text === 'Dark mode for the tablet app' && edLine.when === 'a customer asks twice' && doc.parked[0].id === edId, ed.text.slice(0, 200) + JSON.stringify(edLine));

  // archive a parked line (by id), then put it back from the card (below)
  const arch = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'archive_line', id: fromLater.id, why: 'tested' }] });
  doc = await docOf(NAME);
  const archived = (doc.archived ?? []).find(a => a.id === fromLater.id);
  check('archive_line: a Parked line is archived with from Parked and its text', !arch.isError && archived?.from === 'Parked' && archived.text === 'Later line one' && !doc.parked.some(l => l.id === fromLater.id), arch.text.slice(0, 200) + JSON.stringify(archived));
  const arch2 = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'archive_line', find: 'Dark mode for the tablet' }, { op: 'park', text: 'Dark mode for the phone app', when: 'a customer asks twice' }] });
  doc = await docOf(NAME);
  check('archive_line: by find reaches a Parked line too', !arch2.isError && doc.archived.some(a => a.from === 'Parked' && a.text.includes('tablet app')) && doc.parked.length === 1, arch2.text.slice(0, 200));

  // no limit: Parked lines are rows, there is no cap
  const LIM = 'Flow Parked Limit';
  await must(MCP, 'add_project', { name: LIM });
  await must(MCP, 'save_state', { project: LIM, ops: [{ op: 'park', text: 'first' }] });
  const limDoc = await docOf(LIM);
  const place = { orgId: limDoc.orgId, ownerId: limDoc.ownerId, visibility: limDoc.visibility, ...(limDoc.sharedWith ? { sharedWith: limDoc.sharedWith } : {}) };
  const lines = Array.from({ length: 1000 }, (_, i) => ({ _id: `fill${i}`, projectId: limDoc.projectId, id: `l_fill${i}`, text: `filler ${i}`, by: ME.userId, at: new Date(), parkedAt: new Date(Date.now() - 100000 + i), ...place }));
  await rawDb.collection('stateParked').insertMany(lines);
  await rawDb.collection('states').updateOne({ _id: limDoc._id }, { $set: { parkedCount: 1001 } });
  const over = await mcpH(MCP, 'save_state', { project: LIM, ops: [{ op: 'park', text: 'one more' }] });
  check('no limit: the 1002nd Parked line is taken', !over.isError, over.text.slice(0, 200));
  const stillOk = await mcpH(MCP, 'save_state', { project: LIM, ops: [{ op: 'unpark', id: 'l_fill7', to: 'later' }, { op: 'park', text: 'fits now' }] });
  check('no limit: an unpark and a park in one call work', !stillOk.isError, stillOk.text.slice(0, 200));
  const bigS = await must(MCP, 'start_work', { project: LIM, session: 'fpk-lim' });
  check('no limit: start_work on a project with 1002 parked lines carries a count and no lines', bigS.state.parkedTotal === 1002 && !bigS.state.parked && JSON.stringify(bigS).length < 60000, String(JSON.stringify(bigS).length));

  // list_parked
  await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'park', text: 'Alpha idea about pricing', when: 'pricing is revisited' }, { op: 'park', text: 'Beta idea about the API' }, { op: 'park', text: 'Gamma idea about pricing tiers' }] });
  const lp = await must(MCP, 'list_parked', { project: NAME });
  check('list_parked: newest first with id, date, text and when', lp.total === 4 && lp.parked[0].text === 'Gamma idea about pricing tiers' && /^\d{4}-\d\d-\d\d$/.test(lp.parked[0].date) && /^l_/.test(lp.parked[0].id) && lp.parked.find(x => x.text.startsWith('Alpha')).when === 'pricing is revisited', JSON.stringify(lp).slice(0, 400));
  const lq = await must(MCP, 'list_parked', { project: NAME, query: 'PRICING' });
  check('list_parked: query is a case-insensitive substring', lq.parked.length === 2 && lq.parked.every(x => /pricing/i.test(x.text)), JSON.stringify(lq.parked.map(x => x.text)));
  const ll = await must(MCP, 'list_parked', { project: NAME, limit: 1 });
  check('list_parked: limit cuts the list, total stays', ll.parked.length === 1 && ll.total === 4, JSON.stringify(ll).slice(0, 200));

  // decisions: 12 of them, the State carries the latest 10 and the total
  const D = 'Flow Parked Decisions';
  await must(MCP, 'add_project', { name: D });
  const ops = Array.from({ length: 12 }, (_, i) => ({ op: 'add_decision', text: `Decision number ${i + 1}${i === 4 ? ' about pricing' : ''}` }));
  await must(MCP, 'save_state', { project: D, ops });
  const dStart = await must(MCP, 'start_work', { project: D, session: 'fpk-d2' });
  check('start_work: 10 decisions (the latest), decisionsTotal 12, parkedTotal 0', dStart.state.decisions.length === 10 && dStart.state.decisionsTotal === 12 && dStart.state.decisions[9].text === 'Decision number 12' && dStart.state.decisions[0].text === 'Decision number 3' && dStart.state.parkedTotal === 0, JSON.stringify(dStart.state.decisions.map(d => d.text)));
  const dGet = await must(MCP, 'get_state', { project: D });
  check('get_state: 10 decisions and decisionsTotal 12', dGet.state.decisions.length === 10 && dGet.state.decisionsTotal === 12, String(dGet.state.decisions.length));
  const ld = await must(MCP, 'list_decisions', { project: D });
  check('list_decisions: all 12, newest first, with id, date, text, by and via', ld.total === 12 && ld.decisions.length === 12 && ld.decisions[0].text === 'Decision number 12' && ld.decisions[11].text === 'Decision number 1' && /^\d{4}-\d\d-\d\d$/.test(ld.decisions[0].date) && ld.decisions[0].via && ld.decisions[0].by && ld.decisions[0].id, JSON.stringify(ld.decisions[0]));
  const lds = await must(MCP, 'list_decisions', { project: D, since: '24h' });
  const ldf = await must(MCP, 'list_decisions', { project: D, since: '2999-01-01' });
  check('list_decisions: since keeps what is newer (24h: all, a date far ahead: none)', lds.decisions.length === 12 && ldf.decisions.length === 0, `${lds.decisions.length} ${ldf.decisions.length}`);
  const ldq = await must(MCP, 'list_decisions', { project: D, query: 'ABOUT PRICING' });
  check('list_decisions: query is a case-insensitive substring', ldq.decisions.length === 1 && ldq.decisions[0].text === 'Decision number 5 about pricing', JSON.stringify(ldq.decisions));
  const ldl = await must(MCP, 'list_decisions', { project: D, limit: 3 });
  check('list_decisions: limit gives the newest 3', ldl.decisions.length === 3 && ldl.decisions[2].text === 'Decision number 10', JSON.stringify(ldl.decisions.map(d => d.text)));

  // start_work and get_state on the Parked project carry a count and no lines
  const sw = await must(MCP, 'start_work', { project: NAME, session: 'fpk2' });
  check('start_work: parkedTotal and no parked lines', sw.state.parkedTotal === 4 && sw.state.parked === undefined && !JSON.stringify(sw.state).includes('Alpha idea'), JSON.stringify(sw.state).slice(0, 200));
  const gs = await must(MCP, 'get_state', { project: NAME });
  check('get_state: parkedTotal and no parked lines', gs.state.parkedTotal === 4 && gs.state.parked === undefined && !JSON.stringify(gs).includes('Alpha idea'), JSON.stringify(gs.state).slice(0, 200));
  const gc = await must(MCP, 'get_state', { project: NAME, compact: true });
  check('compact: the parked pointer and decisionsTotal', gc.state.parked === '4 lines: list_parked' && gc.state.decisionsTotal === 0 && !JSON.stringify(gc).includes('Alpha idea'), JSON.stringify(gc.state).slice(0, 300));
  const gcD = await must(MCP, 'get_state', { project: D, compact: true });
  check('compact: no parked key without parked lines, decisionsTotal 12 with 10 lines', gcD.state.parked === undefined && gcD.state.decisionsTotal === 12 && gcD.state.decisions.length === 10, JSON.stringify(gcD.state).slice(0, 200));
  const copy = await must(MCP, 'get_state', { project: NAME, copy: true });
  check('copy: ## Parked with the count line after Later, never the lines', /## Later[\s\S]*## Parked\n- 4 lines in Work OS: list_parked, or the project page\./.test(copy.markdown) && !copy.markdown.includes('Alpha idea'), copy.markdown);
  const copyD = await must(MCP, 'get_state', { project: D, copy: true });
  check('copy: no Parked section when nothing is parked', !copyD.markdown.includes('## Parked'), copyD.markdown.slice(0, 200));

  // import_state with a Parked section
  const IMP = 'Flow Parked Import';
  await must(MCP, 'add_project', { name: IMP });
  const md = ['# Work state: Import', '', '## Now', '- Importing', '', '## Next', '1. Step one', '', '## Later', '- Later one', '', '## Parking lot', '- Voice control — bring back when the API is stable', '- Offline mode (when users ask for it)', '- Plain idea', '', '## Decisions', '- thing'].join('\n');
  const imp = await must(MCP, 'import_state', { project: IMP, markdown: md });
  check('import_state: the Parking lot section is imported, not skipped', imp.imported.parked === 3 && !JSON.stringify(imp.notImported ?? '').includes('Parking'), JSON.stringify(imp).slice(0, 400));
  const ip = await must(MCP, 'list_parked', { project: IMP });
  const byText = t => ip.parked.find(x => x.text === t);
  check('import_state: "— bring back when X" and "(when X)" become when, a plain line has none', byText('Voice control')?.when === 'the API is stable' && byText('Offline mode')?.when === 'users ask for it' && byText('Plain idea') && !byText('Plain idea').when, JSON.stringify(ip.parked));
  const impSt = await docOf(IMP);
  check('import_state: no parked line leaked into Later (other sections still go there)', impSt.later.some(l => l.text === 'Later one') && !impSt.later.some(l => /Voice|Offline|Plain idea/.test(l.text)), JSON.stringify(impSt.later.map(l => l.text)));

  // ── the State card ──
  const dark = async p => { await p.evaluate(() => document.documentElement.classList.add('dark')); await p.waitForTimeout(200); };
  const light = async p => { await p.evaluate(() => document.documentElement.classList.remove('dark')); await p.waitForTimeout(200); };
  const shot = async (p, name, theme) => { await (theme === 'dark' ? dark(p) : light(p)); await p.locator('[data-card="state"]').first().screenshot({ path: `${SP}/${name}-${theme}.png` }).catch(() => {}); };
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await login(page, { phone: false, next: `/projects/${P.id}` });
  await page.waitForSelector('[data-part="parked"]', { timeout: 30000 });
  check('card: the section reads "Parked · 4", after Later and before Decisions, folded', (await page.locator('[data-part="parked"] summary').innerText()).includes('Parked · 4') && !(await page.locator('[data-part="parked"]').evaluate(e => e.open)) && (await page.evaluate(() => { const o = [...document.querySelectorAll('[data-card="state"] [data-part]')].map(e => e.getAttribute('data-part')); return o.indexOf('later') < o.indexOf('parked') && o.indexOf('parked') < o.indexOf('decisions'); })), '');
  await page.locator('[data-part="parked"] > summary').click();
  check('card: each row shows the text, the date and "bring back when …"; one Unpark button on the right', (await page.locator('[data-parked-id]').count()) === 4 && (await page.locator('[data-parked-unpark]').count()) === 4 && /Alpha idea about pricing[\s\S]*\d{4}-\d\d-\d\d[\s\S]*bring back when pricing is revisited/.test(await page.locator('[data-part="parked"]').innerText()), await page.locator('[data-part="parked"]').innerText());
  await page.locator('[data-part="later"] > summary').click();
  await shot(page, 'parked-desk', 'light');
  await shot(page, 'parked-desk', 'dark');
  await light(page);
  const beta = await page.locator('[data-parked-id]', { hasText: 'Beta idea about the API' }).first();
  const betaId = await beta.getAttribute('data-parked-id');
  await beta.locator('[data-parked-unpark]').click();
  await page.waitForFunction(id => !document.querySelector(`[data-parked-id="${id}"]`) && !!document.querySelector(`[data-later-id="${id}"]`), betaId, { timeout: 20000 }).catch(() => {});
  doc = await docOf(NAME);
  check('card: Unpark moves the line to Later (the end of it)', doc.later[doc.later.length - 1].id === betaId && !doc.parked.some(l => l.id === betaId) && (await page.locator(`[data-later-id="${betaId}"]`).count()) === 1, JSON.stringify(doc.later.map(l => l.text)));
  check('card: the count follows ("Parked · 3")', (await page.locator('[data-part="parked"] summary').innerText()).includes('Parked · 3'), await page.locator('[data-part="parked"] summary').innerText());
  // Add control: Parked kind
  await page.locator('[data-state-add-open]').click();
  await page.locator('[data-state-add-kind="parked"]').click();
  await page.locator('[data-state-add="parked"]').fill('Idea added from the card');
  await page.locator('[data-state-add-button="parked"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-parked-id]')].some(e => e.textContent.includes('Idea added from the card')), null, { timeout: 20000 }).catch(() => {});
  doc = await docOf(NAME);
  check('card: the Add control has Parked, and the line lands in Parked', doc.parked.some(l => l.text === 'Idea added from the card'), JSON.stringify(doc.parked.map(l => l.text)));
  // an archived Parked line is put back in Later
  await page.goto(`${B}/projects/${P.id}`);
  await page.locator('[data-part="later"] > summary').click({ timeout: 20000 });
  await page.waitForSelector('[data-part="archived"]', { timeout: 20000 });
  await page.locator('[data-part="archived"] summary').click();
  check('card: the archived line says it came from Parked', (await page.locator('[data-part="archived"]').innerText()).includes('from Parked'), await page.locator('[data-part="archived"]').innerText());
  await page.locator('[data-archived-restore]').first().click();
  await page.waitForTimeout(1500);
  doc = await docOf(NAME);
  check('restore: a Parked line put back lands in Later', doc.later.some(l => l.text === 'Later line one' || l.text.includes('tablet app')), JSON.stringify(doc.later.map(l => l.text)));
  // Decisions on the card: dated, newest first
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dpage = await dctx.newPage();
  const DID = (await rawDb.collection('projects').findOne({ name: D }))._id;
  await login(dpage, { phone: false, next: `/projects/${DID}` });
  await dpage.locator('[data-part="decisions"] > summary').click({ timeout: 30000 });
  const dtext = await dpage.locator('[data-part="decisions"]').innerText();
  check('card: Decisions shows the count of all 12 and each entry with its date in front, newest first', dtext.includes('Decisions · 12') && /^[\s\S]*\d{4}-\d\d-\d\d · Decision number 12[\s\S]*Decision number 11/.test(dtext), dtext.slice(0, 300));
  await dctx.close();

  // 390 px
  const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageP = await ctxP.newPage();
  await login(pageP, { phone: true, next: `/projects/${P.id}` });
  await pageP.waitForSelector('[data-part="parked"]', { timeout: 30000 });
  await pageP.locator('[data-part="parked"] > summary').click();
  await pageP.locator('[data-part="later"] > summary').click();
  await pageP.waitForTimeout(400);
  const sideways = await pageP.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const bad = await overflow(pageP);
  check('390 px: no sideways scroll with Later and Parked open', sideways <= 1 && !bad.length, `${sideways} ${JSON.stringify(bad).slice(0, 300)}`);
  await shot(pageP, 'parked-phone', 'light');
  await shot(pageP, 'parked-phone', 'dark');
  await light(pageP);
} catch (e) {
  check('suite ran without throwing', false, String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser?.close().catch(() => {});
}
await finish();
