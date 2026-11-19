// H14 (docs/flows/agent-system.md section 8, Notes): write_note `edits` match through typography and markdown dress.
// Part 1 (step 1, lib/notes-match.ts): curly vs straight quotes and dashes, list numbers, padded table cells, hard breaks,
// escaped finds, a find across two blocks, two hits, and exact text still winning. Only the matched characters change.
// Later parts (formatting kept, duplicate titles, shelves) are added by the later steps. Seed profile: none.
import { check, finish, mkKey } from './lib.mjs';
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
} catch (e) {
  check('flow-h14 (error)', false, e?.stack || String(e));
}
await finish();
