// H14 (docs/flows/agent-system.md section 8, Notes): write_note `edits` match through typography and markdown dress.
// Part 1 (step 1, lib/notes-match.ts): curly vs straight quotes and dashes, list numbers, padded table cells, hard breaks,
// escaped finds, a find across two blocks, two hits, and exact text still winning. Only the matched characters change.
// Part 2 (step 2, editInPlace): a plain-text edit changes only the touched runs, so colours, bold, mentions and literal
// <tag> text stay; a replacement with markdown takes the markdown path.
// Part 3 (step 3, sameTitle): a second note with the same title beside one is refused with its id (project notes, sub-pages),
// folded and case-blind, archived ones count; task notes, Untitled and handovers are exempt; the editor keeps the blocks.
// Part 4 (step 4, shelves data and MCP): shelf on write_note and list_notes, defaults, refusals.
// Later parts (the shelves UI) are added by the later steps. Seed profile: none.
import { B, ME, SP, check, finish, launch, login, makeUser, mkKey, pick, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const BS = String.fromCharCode(92); // a backslash, spelled so no tool or editor can swallow it
const P = 'H14 Alpha';
const md = async (key, id) => (await must(key, 'read_note', { note_id: id })).markdown;
try {
  const cc = await mkKey({ agent: 'claude-code', name: 'H14 cc' });
  await must(cc, 'add_project', { name: P, visibility: 'org' });
  let n = 0;
  const mk = async body => (await must(cc, 'write_note', { project: P, title: `H14 page ${++n}`, body })).created.id;
  const edit = (id, find, replace) => mcpH(cc, 'write_note', { note_id: id, edits: [{ find, replace }] });

  // ── 1. Typography, both directions
  {
    const id = await mk('Om’s “release” rule – one tap\n\nKeep the rest.');
    const r = await edit(id, 'Om\'s "release" rule - one tap', 'Om\'s "release" rule - two taps');
    const m = await md(cc, id);
    check('H14 quotes: straight find lands on curly text with an en dash', !r.isError && m.includes('two taps') && m.includes('Keep the rest.'), r.text.slice(0, 200) + ' | ' + m);
    check('H14 quotes: the replacement is written as given (no auto-curling)', m.includes('Om\'s "release" rule - two taps'), m);
  }
  {
    const id = await mk('Om\'s "release" rule - one tap');
    const r = await edit(id, 'Om’s “release” rule – one tap', 'changed');
    check('H14 quotes: curly find lands on straight text', !r.isError && (await md(cc, id)).trim() === 'changed', r.text.slice(0, 200));
  }
  {
    const id = await mk('wait… then — go');
    const r = await edit(id, 'wait... then -- go', 'done');
    check('H14 dashes: ellipsis and em dash fold', !r.isError && (await md(cc, id)).trim() === 'done', r.text.slice(0, 200));
  }
  {
    const id = await mk('Say “hi” now, then “bye”.');
    const r = await edit(id, 'then "bye"', 'then "see you"');
    const m = await md(cc, id);
    check('H14 part: only the matched part changes, the rest of the block keeps its characters', !r.isError && m.includes('Say “hi” now, then "see you".'), m);
  }

  // ── 2. List numbers: the page markdown numbers items, the block outline says 1.
  {
    const id = await mk('1. first\n2. second\n3. third');
    const whole = await md(cc, id);
    check('H14 lists: setup, read_note numbers the items', whole.includes('2. second') && whole.includes('3. third'), whole);
    const r = await edit(id, '3. third', '3. last');
    const m = await md(cc, id);
    check('H14 lists: "3. third" copied from the page markdown matches the third item', !r.isError && m.includes('last') && m.includes('first') && m.includes('second') && !m.includes('third'), r.text.slice(0, 200) + ' | ' + m);
    const bid = await mk('* apple\n* pear');
    const r2 = await edit(bid, '- pear', '- plum');
    check('H14 lists: "- x" matches a "*" item', !r2.isError && (await md(cc, bid)).includes('plum') && (await md(cc, bid)).includes('apple'), r2.text.slice(0, 200));
  }

  // ── 3. Table padding, hard breaks
  {
    const id = await mk('| name | value |\n| --- | --- |\n| x_y | "q" |');
    const r = await edit(id, '| x_y | "q" |', '| x_y | "r" |');
    const m = await md(cc, id);
    check('H14 table: an unpadded row matches the padded cells', !r.isError && m.includes('"r"') && !m.includes('"q"'), r.text.slice(0, 200) + ' | ' + m);
  }
  {
    const id = await mk('Line one' + BS + '\nLine two');
    const stored = await md(cc, id);
    check('H14 break: setup, the note has a hard break', stored.includes('Line one') && stored.includes('Line two') && stored.includes(BS), JSON.stringify(stored));
    const r = await edit(id, 'Line one\nLine two', 'Joined');
    check('H14 break: a find with a plain newline matches the hard break', !r.isError && (await md(cc, id)).trim() === 'Joined', r.text.slice(0, 200));
  }

  // ── 4. Escaped find
  {
    const id = await mk(`call ${BS}_init${BS}_ first, see ${BS}[x${BS}] and ${BS}<b${BS}> here`);
    const raw = await md(cc, id);
    check('H14 escaped: setup, the note holds the raw characters', raw.includes('_init_') && raw.includes('<b>') && raw.includes('[x]'), raw);
    const r = await edit(id, `call ${BS}_init${BS}_ first, see ${BS}[x${BS}] and ${BS}<b${BS}> here`, 'ok');
    check('H14 escaped: a find with backslash escapes matches the raw text', !r.isError && (await md(cc, id)).trim() === 'ok', r.text.slice(0, 200));
  }

  // ── 5. Errors say what is wrong
  {
    const id = await mk('alpha end\n\nbeta start');
    const r = await edit(id, 'alpha end\n\nbeta start', 'x');
    check('H14 two blocks: a find that crosses blocks says so', r.isError && /spans two blocks/.test(r.text) && /one edit per block/.test(r.text), r.text);
    const r3 = await edit(id, 'gamma', 'x');
    check('H14 not found: names read_note and blocks[].markdown', r3.isError && /not found: "gamma"/.test(r3.text) && /blocks\[\]\.markdown/.test(r3.text), r3.text);
    check('H14 errors: nothing was saved', (await md(cc, id)).includes('alpha end') && (await md(cc, id)).includes('beta start'));
  }
  {
    const id = await mk('same “word”\n\nsame "word"');
    const r = await edit(id, 'same "word"', 'x');
    check('H14 exact wins: the straight text matches itself only, once', !r.isError, r.text.slice(0, 200));
    const m = await md(cc, id);
    check('H14 exact wins: the curly twin is untouched', m.includes('same “word”') && !m.includes('same "word"'), m);
  }
  {
    const id = await mk('it’s here\n\nit’s here too');
    const r = await edit(id, 'it\'s here', 'x');
    check('H14 two hits: folded finds that occur twice are refused with the count', r.isError && /occurs 2 times/.test(r.text) && /unique/.test(r.text), r.text);
  }

  // ── 6. The edit is one version, and the same applies through apply_changes
  {
    const id = await mk('Om’s rule');
    const r = await must(cc, 'apply_changes', { ops: [{ op: 'write_note', note_id: id, edits: [{ find: 'Om\'s rule', replace: 'Om\'s other rule' }] }] }).catch(e => ({ error: String(e) }));
    check('H14 batch: apply_changes edits fold the same way', !r.error && (await md(cc, id)).includes('other rule'), JSON.stringify(r).slice(0, 300));
  }
  // ── 7. Part 2: edits keep formatting
  {
    const id = await mk('seed');
    const T = (text, styles = {}) => ({ type: 'text', text, styles });
    const blocks = [
      { id: 'b1', type: 'paragraph', props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' }, content: [T('Ship the '), T('red', { textColor: 'red', bold: true }), T(' button and keep <tag> as typed, 2 * 3 * 4.')], children: [] },
      { id: 'b2', type: 'paragraph', props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'center' }, content: [T('Centered Om’s “quote” line', { underline: true })], children: [] },
      { id: 'b3', type: 'paragraph', props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' }, content: [T('See '), { type: 'mention', props: { kind: 'task', target: '1', label: '#1 Thing' } }, T(' and bold '), T('part', { bold: true }), T(' end')], children: [] },
    ];
    await rawDb.collection('notes').updateOne({ _id: id }, { $set: { blocks } });
    const blk = async () => (await rawDb.collection('notes').findOne({ _id: id })).blocks;
    const r = await edit(id, 'Ship the', 'Launch the');
    let b = await blk();
    check('H14 in place: a plain word changes', !r.isError && b[0].content[0].text === 'Launch the ', r.text.slice(0, 200) + JSON.stringify(b[0].content));
    check('H14 in place: colour and bold on the next run stay', b[0].content[1].styles.textColor === 'red' && b[0].content[1].styles.bold === true && b[0].content[1].text === 'red', JSON.stringify(b[0].content));
    check('H14 in place: literal <tag> and asterisks stay as typed', b[0].content[2].text.includes('<tag>') && b[0].content[2].text.includes('2 * 3 * 4'), JSON.stringify(b[0].content[2]));
    check('H14 in place: the block keeps its id and other blocks are untouched', b[0].id === 'b1' && b[1].props.textAlignment === 'center' && b[2].content[1].type === 'mention', JSON.stringify(b.map(x => x.id)));
    const r2 = await edit(id, 'Centered Om\'s "quote" line', 'Still centered');
    b = await blk();
    check('H14 in place: a curly find lands, underline and alignment stay', !r2.isError && b[1].content[0].text === 'Still centered' && b[1].content[0].styles.underline === true && b[1].props.textAlignment === 'center', r2.text.slice(0, 200) + JSON.stringify(b[1]));
    const r3 = await edit(id, 'and bold part end', 'and bold plain end');
    b = await blk();
    check('H14 in place: a find across runs puts the new text in the first run and trims the rest', !r3.isError && b[2].content.some(c => c.type === 'mention') && b[2].content.map(c => c.text ?? '').join('').endsWith('and bold plain end'), r3.text.slice(0, 200) + JSON.stringify(b[2].content));
    const r4 = await edit(id, 'Launch the', 'Launch **the**');
    b = await blk();
    check('H14 markdown path: a replacement with ** is parsed as markdown', !r4.isError && b[0].id === 'b1' && b[0].content.some(c => c.styles?.bold && c.text === 'the'), r4.text.slice(0, 200) + JSON.stringify(b[0].content));
    const r5 = await edit(id, 'Centered', 'x');
    check('H14 in place: a find that is gone is still refused', r5.isError && /not found/.test(r5.text), r5.text.slice(0, 200));
  }
  // ── 8. Part 3: duplicate titles refused
  const P2 = 'H14 Beta';
  await must(cc, 'add_project', { name: P2, visibility: 'org' });
  const dupe = (project, title, extra = {}) => mcpH(cc, 'write_note', { project, title, body: 'x', ...extra });
  {
    const a = await must(cc, 'write_note', { project: P, title: 'H8 plan: the three blocks', body: 'first' });
    const r = await dupe(P, 'H8 plan: the three blocks');
    check('H14 dup: the same title in the same project is refused with the existing id', r.isError && r.text.includes(`note_id ${a.created.id}`) && /Nothing was saved/.test(r.text) && r.text.includes(P), r.text.slice(0, 300));
    const r2 = await dupe(P, '  h8 PLAN:  the three blocks ');
    check('H14 dup: case and spacing do not make it a new title', r2.isError && r2.text.includes(a.created.id), r2.text.slice(0, 300));
    const q = await must(cc, 'write_note', { project: P, title: 'Om’s “release” plan', body: 'q' });
    const r3 = await dupe(P, 'Om\'s "release" plan');
    check('H14 dup: curly and straight quotes are the same title', r3.isError && r3.text.includes(q.created.id), r3.text.slice(0, 300));
    const listed = await must(cc, 'list_notes', { project: P, query: 'H8 plan: the three blocks' });
    check('H14 dup: nothing was created by the refusals', listed.notes.filter(n => n.title.toLowerCase().includes('h8 plan')).length === 1, JSON.stringify(listed.notes.map(n => n.title)));
    const ok = await dupe(P2, 'H8 plan: the three blocks');
    check('H14 dup: the same title in another project is allowed', !ok.isError, ok.text.slice(0, 200));
    // archived
    await must(cc, 'write_note', { note_id: a.created.id, archived: true });
    const r4 = await dupe(P, 'H8 plan: the three blocks');
    check('H14 dup: an archived note still counts, and the message says how to bring it back', r4.isError && /archived/.test(r4.text) && /archived:false/.test(r4.text) && r4.text.includes(a.created.id), r4.text.slice(0, 300));
    // rename
    const other = await must(cc, 'write_note', { project: P, title: 'H14 rename me', body: 'z' });
    const r5 = await mcpH(cc, 'write_note', { note_id: other.created.id, title: 'om’s "release" PLAN' });
    check('H14 dup: renaming into a sibling title is refused with its id', r5.isError && r5.text.includes(q.created.id), r5.text.slice(0, 300));
    check('H14 dup: the refused rename changed nothing', (await must(cc, 'read_note', { note_id: other.created.id })).title === 'H14 rename me');
    const r6 = await mcpH(cc, 'write_note', { note_id: q.created.id, title: 'OM’S “RELEASE” PLAN' });
    check('H14 dup: a note may change its own title key (only case)', !r6.isError, r6.text.slice(0, 200));
  }
  {
    // sub-pages: siblings under one parent only
    const p1 = await must(cc, 'write_note', { project: P, title: 'H14 parent one', body: 'p' });
    const p2 = await must(cc, 'write_note', { project: P, title: 'H14 parent two', body: 'p' });
    const s1 = await must(cc, 'write_note', { parent_id: p1.created.id, title: 'Sub same', body: 's' });
    const r = await mcpH(cc, 'write_note', { parent_id: p1.created.id, title: 'sub SAME', body: 's' });
    check('H14 dup: a sub-page with a sibling sub-page title is refused with its id', r.isError && r.text.includes(s1.created.id) && /this page/.test(r.text), r.text.slice(0, 300));
    const r2 = await mcpH(cc, 'write_note', { parent_id: p2.created.id, title: 'Sub same', body: 's' });
    check('H14 dup: the same sub-page title under another parent is allowed', !r2.isError, r2.text.slice(0, 200));
    const r3 = await mcpH(cc, 'write_note', { project: P, title: 'Sub same', body: 's' });
    check('H14 dup: a sub-page title does not clash with a project note', !r3.isError, r3.text.slice(0, 200));
  }
  {
    // exempt: Untitled, task notes
    const u1 = await mcpH(cc, 'write_note', { project: P, title: 'Untitled', body: 'u' });
    const u2 = await mcpH(cc, 'write_note', { project: P, title: 'untitled', body: 'u' });
    check('H14 dup: "Untitled" pages are never refused', !u1.isError && !u2.isError, u1.text.slice(0, 120) + ' | ' + u2.text.slice(0, 120));
    const t1 = await must(cc, 'add_task', { title: 'H14 task one', project: P });
    const t2 = await must(cc, 'add_task', { title: 'H14 task two', project: P });
    const ref1 = t1.created.ref;
    const ref2 = t2.created.ref;
    const n1 = await mcpH(cc, 'write_note', { task: ref1, body: 'a', title: 'H14 shared title' });
    const n2 = await mcpH(cc, 'write_note', { task: ref2, body: 'a', title: 'H14 shared title' });
    check('H14 dup: two task notes may share a title', !n1.isError && !n2.isError, n1.text.slice(0, 150) + ' | ' + n2.text.slice(0, 150));
    const n3 = await mcpH(cc, 'write_note', { project: P, title: 'H14 shared title', body: 'a' });
    check('H14 dup: a project note may take a task note\'s title', !n3.isError, n3.text.slice(0, 200));
  }
  {
    // apply_changes: the batch is all or nothing
    await must(cc, 'write_note', { project: P, title: 'H14 batch taken', body: 'b' });
    const r = await mcpH(cc, 'apply_changes', { ops: [{ op: 'write_note', project: P, title: 'H14 batch first', body: 'b' }, { op: 'write_note', project: P, title: 'H14 batch taken', body: 'b' }] });
    const l = await must(cc, 'list_notes', { project: P, query: 'H14 batch first' });
    check('H14 dup: apply_changes with a duplicate is refused and rolls back the whole batch', r.isError && /note_id/.test(r.text) && !l.notes.some(n => n.title === 'H14 batch first'), r.text.slice(0, 300) + JSON.stringify(l.notes.map(n => n.title)));
  }
  {
    // privacy: a teammate who cannot read a private project learns nothing about its note titles by trying them
    const priv = 'H14 Private';
    await must(cc, 'add_project', { name: priv, visibility: 'private' });
    const secret = await must(cc, 'write_note', { project: priv, title: 'H14 secret title', body: 's' });
    const mate = await makeUser({ email: 'h14-mate@example.test', name: 'H14 Mate', orgId: ME.orgId });
    const mk2 = await mkKey({ agent: 'claude-code', userId: mate.userId, orgId: ME.orgId, name: 'H14 mate' });
    const r = await mcpH(mk2, 'write_note', { project: priv, title: 'H14 secret title', body: 'x' });
    check('H14 privacy: a teammate trying a private note title in a private project is refused without its id or title', r.isError && !r.text.includes(secret.created.id) && !/already in/.test(r.text), r.text.slice(0, 300));
    const own = await mcpH(mk2, 'write_note', { project: P, title: 'H14 secret title', body: 'x' });
    check('H14 privacy: the same title in a shared project simply creates (different siblings)', !own.isError && !own.text.includes(secret.created.id), own.text.slice(0, 200));
  }
  {
    // an Orders page is outside the rule (it is not compared)
    const o = await must(cc, 'write_note', { project: P, title: 'H14 orders-like', body: 'o' });
    await rawDb.collection('notes').updateOne({ _id: o.created.id }, { $set: { orders: 'person', ordersBy: ME.userId } });
    const r = await mcpH(cc, 'write_note', { project: P, title: 'H14 orders-like', body: 'x' });
    check('H14 dup: an Orders page is not compared', !r.isError, r.text.slice(0, 200));
  }
  {
    // end_work: two writers with one handover title both write (the title rule is not applied to handovers)
    const writer = await makeUser({ email: 'h14-writer@example.test', name: 'H14 Writer', orgId: ME.orgId });
    const wk = await mkKey({ agent: 'claude-code', userId: writer.userId, orgId: ME.orgId, name: 'H14 writer' });
    const hdr = sid => ({ 'X-Work-OS-Session': sid });
    const hin = { step: 'flow-h14 part 3 passes; next: write the shelves part', check: ['tests/e2e/run.sh flow-h14'] };
    await must(cc, 'end_work', { project: P2, base_version: 0, state: [{ op: 'set_now', text: 'H14 goal: handovers on shelves' }, { op: 'add_next', text: 'H14 first next step, long enough to matter' }, { op: 'add_next', text: 'H14 second next step, also long enough' }], friction: 'none', session: 'h14h0' }, hdr('h14h0'));
    await must(cc, 'start_work', { project: P2, session: 'h14h1', label: 'H14 same label' }, hdr('h14h1'));
    await must(wk, 'start_work', { project: P2, session: 'h14h2', label: 'H14 same label' }, hdr('h14h2'));
    const a = await mcpH(cc, 'end_work', { project: P2, state: [{ op: 'set_where', machine: 'h14box', branch: 'one' }], friction: 'none', handover: hin, session: 'h14h1' }, hdr('h14h1'));
    const b = await mcpH(wk, 'end_work', { project: P2, state: [{ op: 'set_where', machine: 'h14box', branch: 'two' }], friction: 'none', handover: hin, session: 'h14h2' }, hdr('h14h2'));
    check('H14 dup: end_work from two writers with one handover title both write', !a.isError && !b.isError && a.json?.handover?.id && b.json?.handover?.id && a.json.handover.id !== b.json.handover.id && a.json.handover.title === b.json.handover.title, a.text.slice(0, 250) + ' | ' + b.text.slice(0, 250));
  }
  {
    // the editor: the blocks save, the title goes back (saveNoteAction keeps the old title)
    const keep = await must(cc, 'write_note', { project: P, title: 'H14 editor taken', body: 'k' });
    const mine = await must(cc, 'write_note', { project: P, title: 'H14 editor mine', body: 'm' });
    const bro = await launch();
    try {
      const ctx = await bro.newContext({ viewport: { width: 1280, height: 800 } });
      const pg = await ctx.newPage();
      await login(pg, { next: `/notes/${mine.created.id}` });
      const ti = pg.locator('input[placeholder="Untitled"]');
      await ti.waitFor({ timeout: 20000 });
      await pg.locator('.wo-editor [contenteditable=true]').first().waitFor({ timeout: 20000 }); // the editor loads after the title
      await ti.fill('H14 editor taken');
      await pg.locator('.wo-editor [contenteditable=true]').first().click();
      await pg.keyboard.type(' typed');
      await pg.waitForSelector('text=A note with this title is already here', { timeout: 15000 });
      await pg.screenshot({ path: `${SP}/h14-title-clash-desktop.png` });
      check('H14 editor: the title field goes back to the kept title', (await ti.inputValue()) === 'H14 editor mine', await ti.inputValue());
      await pg.waitForTimeout(500);
      const stored = await rawDb.collection('notes').findOne({ _id: mine.created.id });
      check('H14 editor: the typed text saved, the title did not change', stored.title === 'H14 editor mine' && /typed/.test(stored.body), stored.title + ' | ' + stored.body);
      check('H14 editor: the toast offers the existing note', (await pg.locator('[data-sonner-toast] button:has-text("Open")').count()) > 0);
      await pg.locator('[data-sonner-toast] button:has-text("Open")').first().click();
      await pg.waitForURL(u => u.pathname === `/notes/${keep.created.id}`, { timeout: 15000 });
      check('H14 editor: Open goes to the existing note', true);
      await ctx.close();
    } finally {
      await bro.close();
    }
  }
  // ── 9. Part 4: shelves (data and MCP)
  {
    const sh = await must(cc, 'write_note', { project: P, title: 'H14 shelf note', body: 'plain' });
    const r0 = await must(cc, 'read_note', { note_id: sh.created.id });
    check('H14 shelf: a note nobody moved sits on Designs', r0.shelf === 'designs', JSON.stringify(r0.shelf));
    const r1 = await mcpH(cc, 'write_note', { note_id: sh.created.id, shelf: 'runbooks' });
    const r2 = await must(cc, 'read_note', { note_id: sh.created.id });
    check('H14 shelf: write_note moves it to Runbooks', !r1.isError && r2.shelf === 'runbooks', r1.text.slice(0, 200));
    const l = await must(cc, 'list_notes', { project: P, shelf: 'runbooks' });
    check('H14 shelf: list_notes shelf returns it, and only the Runbooks', l.notes.some(n => n.id === sh.created.id) && l.notes.every(n => n.shelf === 'runbooks'), JSON.stringify(l.notes.map(n => [n.title, n.shelf])));
    const l2 = await must(cc, 'list_notes', { project: P, shelf: 'designs' });
    check('H14 shelf: the Designs listing no longer holds it', !l2.notes.some(n => n.id === sh.created.id) && l2.notes.length > 0, JSON.stringify(l2.notes.map(n => n.title)));
    const born = await must(cc, 'write_note', { project: P, title: 'H14 born on overview', body: 'o', shelf: 'overview' });
    check('H14 shelf: a note can be created on a shelf', (await must(cc, 'read_note', { note_id: born.created.id })).shelf === 'overview');
    const bt = await must(cc, 'apply_changes', { ops: [{ op: 'write_note', note_id: sh.created.id, shelf: 'overview' }] }).catch(e => ({ error: String(e) }));
    check('H14 shelf: apply_changes carries shelf', !bt.error && (await must(cc, 'read_note', { note_id: sh.created.id })).shelf === 'overview', JSON.stringify(bt).slice(0, 300));
    // refusals
    const hv = await mcpH(cc, 'write_note', { note_id: sh.created.id, shelf: 'handovers' });
    check('H14 shelf: handovers is not a shelf write_note can give', hv.isError, hv.text.slice(0, 200));
    const tk = await must(cc, 'add_task', { title: 'H14 shelf task', project: P });
    const tn = await must(cc, 'write_note', { task: tk.created.ref, body: 't', title: 'H14 shelf task note' });
    const rt = await mcpH(cc, 'write_note', { note_id: tn.created.id, shelf: 'runbooks' });
    check('H14 shelf: refused on a task note, with the reason', rt.isError && /task's note and a sub-page sit with/.test(rt.text), rt.text.slice(0, 250));
    check('H14 shelf: a task note has no shelf', (await must(cc, 'read_note', { note_id: tn.created.id })).shelf === undefined);
    const sp = await must(cc, 'write_note', { parent_id: sh.created.id, title: 'H14 shelf sub', body: 's' });
    const rs = await mcpH(cc, 'write_note', { note_id: sp.created.id, shelf: 'runbooks' });
    const rs2 = await mcpH(cc, 'write_note', { parent_id: sh.created.id, title: 'H14 shelf sub two', body: 's', shelf: 'runbooks' });
    check('H14 shelf: refused on a sub-page (move and create)', rs.isError && rs2.isError && (await must(cc, 'read_note', { note_id: sp.created.id })).shelf === undefined, rs.text.slice(0, 150) + ' | ' + rs2.text.slice(0, 150));
    // handovers, archive, Orders
    const hl = await must(cc, 'list_notes', { project: P2, shelf: 'handovers' });
    check('H14 shelf: end_work\'s notes sit on Handovers', hl.notes.length >= 1 && hl.notes.every(n => n.shelf === 'handovers'), JSON.stringify(hl.notes.map(n => [n.title, n.shelf])));
    const hm = await mcpH(cc, 'write_note', { note_id: hl.notes[0].id, shelf: 'designs' });
    check('H14 shelf: an agent cannot move a handover off Handovers', hm.isError, hm.text.slice(0, 200));
    const al = await must(cc, 'list_notes', { project: P, shelf: 'archive' });
    check('H14 shelf: list_notes shelf archive returns the archived project notes', al.notes.some(n => n.title === 'H8 plan: the three blocks') && al.notes.every(n => n.archived), JSON.stringify(al.notes.map(n => [n.title, n.archived])));
    const ov = await must(cc, 'list_notes', { project: P, shelf: 'overview' });
    const orders = (await rawDb.collection('notes').findOne({ projectId: (await rawDb.collection('projects').findOne({ name: P }))._id, orders: 'person' }));
    check('H14 shelf: an Orders page defaults to Overview', ov.notes.some(n => n.id === orders._id), JSON.stringify(ov.notes.map(n => n.title)));
    const om = await mcpH(cc, 'write_note', { note_id: orders._id, shelf: 'runbooks', why: 'h14 shelf test' });
    check('H14 shelf: an agent cannot move an Orders page (guardOrders still holds)', om.isError, om.text.slice(0, 200));
    const noShelf = await must(cc, 'list_notes', { project: P });
    check('H14 shelf: every project note in a plain listing carries its shelf', noShelf.notes.filter(n => !/task/.test(n.attachedTo ?? '') && !/sub-page/.test(n.attachedTo ?? '')).every(n => n.shelf), JSON.stringify(noShelf.notes.filter(n => !n.shelf).map(n => n.title)));
  }
  // ── 11. Review fixes: a find also in a code block or table is not unique; an emptied link goes
  {
    const id = await mk('Use zebraquux now.\n\n```\nzebraquux\n```');
    const r = await edit(id, 'zebraquux', 'x');
    check('H14 unique: a find in a paragraph and a code block is refused as not unique', r.isError && /occurs 2 times/.test(r.text) && (await md(cc, id)).includes('Use zebraquux now.'), r.text.slice(0, 200));
    const t = await mk('Table word zebratab here.\n\n| h | v |\n| --- | --- |\n| a | zebratab |');
    const r2 = await edit(t, 'zebratab', 'x');
    check('H14 unique: a find in a paragraph and a table cell is refused as not unique', r2.isError && /occurs 2 times/.test(r2.text), r2.text.slice(0, 200));
    const only = await mk('Only zebraone here.\n\n```\nother\n```');
    const r3 = await edit(only, 'zebraone', 'x');
    check('H14 unique: a find only in the paragraph still lands', !r3.isError && (await md(cc, only)).includes('Only x here.'), r3.text.slice(0, 200));
    const l = await mk('See [linktext](https://example.com/x) now.');
    const r4 = await edit(l, 'linktext', '');
    const lm = await md(cc, l);
    check('H14 link: removing all of a link\'s text drops the link', !r4.isError && !lm.includes('[](') && !lm.includes('example.com') && lm.includes('See'), r4.text.slice(0, 200) + ' | ' + lm);
  }
  // ── 10. Part 5: shelves in the app (project Notes tab, Notes filter, note header), looked at on both widths and themes
  {
    const pid = (await rawDb.collection('projects').findOne({ name: P }))._id;
    const rb = await must(cc, 'write_note', { project: P, title: 'H14 ui runbook', body: 'How to run it.', shelf: 'runbooks' });
    const dn = await must(cc, 'write_note', { project: P, title: 'H14 ui design', body: 'The design.' });
    const bro = await launch();
    try {
      for (const kind of ['desktop', 'phone']) {
        for (const scheme of ['light', 'dark']) {
          const ctx = await bro.newContext(kind === 'phone' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme } : { viewport: { width: 1280, height: 800 }, colorScheme: scheme });
          const pg = await ctx.newPage();
          await login(pg, { phone: kind === 'phone', next: `/projects/${pid}?tab=notes` });
          const tag = `${kind}-${scheme}`;
          const grp = pg.locator('[data-view="notes"] [data-shelf="runbooks"]');
          await grp.waitFor({ timeout: 20000 });
          if (tag === 'desktop-light') {
            const heads = await pg.locator('[data-view="notes"] [data-shelf] h3').allInnerTexts();
            check('H14 shelves UI: the Notes tab groups notes by shelf, in shelf order, empty shelves hidden', heads.length >= 2 && heads.findIndex(h => /^designs/i.test(h)) < heads.findIndex(h => /^runbooks/i.test(h)) && heads.findIndex(h => /^overview/i.test(h)) < heads.findIndex(h => /^designs/i.test(h)) && !heads.some(h => /^handovers/i.test(h)), JSON.stringify(heads));
            check('H14 shelves UI: a runbook sits under Runbooks only', (await grp.innerText()).includes('H14 ui runbook') && !(await grp.innerText()).includes('H14 ui design'));
          }
          await pg.screenshot({ path: `${SP}/h14-shelves-project-${tag}.png`, fullPage: true });
          await pg.goto(B + '/notes?shelf=runbooks');
          await pg.locator('text=H14 ui runbook >> visible=true').first().waitFor({ timeout: 20000 });
          if (tag === 'desktop-light') {
            const txt = await pg.locator('main').innerText();
            check('H14 shelves UI: /notes?shelf=runbooks lists the runbook, not the design, and the row names its shelf', txt.includes('H14 ui runbook') && !txt.includes('H14 ui design') && /H14 Alpha · Runbooks/.test(txt), txt.slice(0, 300));
          }
          await pg.screenshot({ path: `${SP}/h14-shelves-notes-${tag}.png` });
          if (kind === 'phone') {
            const before = pg.url();
            await pg.getByRole('button', { name: 'Any shelf' }).tap();
            await pg.waitForURL(u => !u.search.includes('shelf='), { timeout: 10000 });
            check('H14 shelves UI: the phone chips set and clear the shelf', before.includes('shelf=runbooks') && !pg.url().includes('shelf='), before + ' -> ' + pg.url());
          }
          await pg.goto(B + `/notes/${dn.created.id}`);
          await pg.locator('[data-shelf-switch]').waitFor({ timeout: 20000 });
          if (tag === 'desktop-light') {
            check('H14 shelves UI: the note header shows the shelf', (await pg.locator('[data-shelf-switch]').getAttribute('data-shelf')) === 'designs');
            await pick(pg, '[data-shelf-select]', 'runbooks');
            for (let k = 0; k < 40 && (await rawDb.collection('notes').findOne({ _id: dn.created.id })).shelf !== 'runbooks'; k++) await pg.waitForTimeout(250);
            const moved = await rawDb.collection('notes').findOne({ _id: dn.created.id });
            check('H14 shelves UI: picking a shelf in the header moves the note (setShelfAction)', moved.shelf === 'runbooks', JSON.stringify(moved.shelf));
            await pick(pg, '[data-shelf-select]', 'designs');
            for (let k = 0; k < 40 && (await rawDb.collection('notes').findOne({ _id: dn.created.id })).shelf !== 'designs'; k++) await pg.waitForTimeout(250);
          }
          await pg.screenshot({ path: `${SP}/h14-shelves-note-${tag}.png` });
          await ctx.close();
        }
      }
    } finally {
      await bro.close();
    }
    void rb;
  }
} catch (e) {
  check('flow-h14 (error)', false, e?.stack || String(e));
}
await finish();
