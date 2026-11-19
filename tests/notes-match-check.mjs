// Unit test for lib/notes-match.ts (docs/flows/agent-system.md section 8, H14): write_note edits match through typography
// and markdown dress. Run: npm run check:notes-match (Node 22.6+, type stripping). Not part of prebuild.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { fold, locate, locateExact, locateFolded, hasMarkdown, titleKey } = await import(pathToFileURL(join(ROOT, 'lib/notes-match.ts')).href);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};
// The text a hit selects in the original.
const pick = (hay, needle) => locate(hay, needle).map(h => hay.slice(h.start, h.end));
const one = (name, hay, needle, want) => {
  const got = pick(hay, needle);
  check(name, got.length === 1 && got[0] === want, JSON.stringify(got));
};

// 1. Typography, both directions
one('curly stored, straight find (quotes and en dash)', 'Om\u2019s \u201Crelease\u201D rule \u2013 one tap', 'Om\'s "release" rule - one tap', 'Om\u2019s \u201Crelease\u201D rule \u2013 one tap');
one('straight stored, curly find', 'Om\'s "release" rule - one tap', 'Om\u2019s \u201Crelease\u201D rule \u2013 one tap', 'Om\'s "release" rule - one tap');
one('em dash vs double hyphen vs hyphen', 'a \u2014 b', 'a -- b', 'a \u2014 b');
one('ellipsis', 'wait\u2026 what', 'wait... what', 'wait\u2026 what');
one('NBSP', 'ten\u00A0items', 'ten items', 'ten\u00A0items');
one('hit maps back to the part, not the line', 'Say \u201Chi\u201D now, then \u201Cbye\u201D', 'then "bye"', 'then \u201Cbye\u201D');
check('exact match wins over the folded one', JSON.stringify(locate('x \u2019 y \' z', '\'')) === JSON.stringify([{ start: 6, end: 7 }]));
check('exact hits are returned as written, not folded ones', locateExact('a\u2019b', "'").length === 0 && locateFolded('a\u2019b', "'").length === 1);

// 2. List numbers (read_note's whole-page markdown numbers items, the block outline says 1.)
one('"2. second" finds the block outline "1. second"', '1. second', '2. second', '1. second');
one('"- x" finds "* x"', '* second', '- second', '* second');
one('nested list indent kept apart', '  * child', '* child', '  * child'.slice(2));

// 3. Table padding and hard breaks
const table = '| name        | value      |\n| ----------- | ---------- |\n| x_y         | "q"        |';
one('padded table cell', table, '| x_y | "q" |', '| x_y         | "q"        |');
one('padded table with curly quotes in the find', table, '| x_y | \u201Cq\u201D |', '| x_y         | "q"        |');
const BS = String.fromCharCode(92); // a backslash, spelled so no tool or editor can swallow it
const stored = 'Line one' + BS + '\n Line two';
one('hard break exported as backslash, newline, space', stored, 'Line one\nLine two', stored);
one('trailing spaces before a newline', 'a  \nb', 'a\nb', 'a  \nb');

// 4. Escaped find
one('escaped underscore', 'call _init_ first', `call ${BS}_init${BS}_ first`, 'call _init_ first');
one('escaped star and bracket', 'a *x* and [y]', `a ${BS}*x${BS}* and ${BS}[y]`, 'a *x* and [y]');
one('escaped angle bracket', 'use <b> here', `use ${BS}<b${BS}> here`, 'use <b> here');
check('a backslash before a letter is kept', fold(`C:${BS}Users`).text === `C:${BS}Users`);

// 5. Counting and not found
check('two folded hits are both reported', locate('\u201Ca\u201D and \u201Ca\u201D', '"a"').length === 2);
check('nothing found gives no hits', locate('hello', 'goodbye').length === 0);
check('a find across a block boundary is not found inside one block, but is in the page', locate('one\n\ntwo', 'one two').length === 0 && locate('one\n\ntwo', 'one\n\ntwo').length === 1);
check('empty find gives no hits', locate('abc', '').length === 0);
check('case stays', locate('Hello', 'hello').length === 0);

// fold offsets
{
  const f = fold('a\u2026b');
  check('fold: ellipsis becomes three dots, all pointing at the one character', f.text === 'a...b' && f.at.join() === '0,1,1,1,2' && f.to.join() === '1,2,2,2,3', JSON.stringify(f));
}

// hasMarkdown and titleKey
for (const s of ['plain words here', 'it\'s "fine" - really', 'snake_case_name', '2 * 3 = 6', 'a_b and c_d']) check(`hasMarkdown false: ${s}`, !hasMarkdown(s));
for (const s of ['two\nlines', '**bold**', '__bold__', '`code`', '~~gone~~', '[a](http://x)', '*em*', 'an _em_ word']) check(`hasMarkdown true: ${JSON.stringify(s)}`, hasMarkdown(s));
check('titleKey folds quotes, dashes, case and spaces', titleKey('  H8 Plan \u2013 Om\u2019s   Rule ') === titleKey('h8 plan - om\'s rule'));
check('titleKey keeps list-looking titles apart', titleKey('2. Foo') !== titleKey('1. Foo'));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
