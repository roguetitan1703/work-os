// Unit test for lib/search/match.ts and lib/search/static.ts (the one search): words in any order at a word start, case
// and accents ignored, "#11" a task only, "N3" a Need only, the tiers, the marks, the database regex never stricter than
// the exact rule, and Settings and Pages matched in the browser. Run: npm run check:search (Node 22.6+, type stripping).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// lib/search/static.ts imports '@/app/...' and '.../sections' without an extension: resolve them like the bundler does.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) spec = pathToFileURL(join(ROOT, spec.slice(2))).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (/^(\.|file:)/.test(spec) && !/\.[a-z]+$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});
const M = await import(pathToFileURL(join(ROOT, 'lib/search/match.ts')).href);
const S = await import(pathToFileURL(join(ROOT, 'lib/search/static.ts')).href);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Query
let q = M.parseQuery('#11');
check('"#11" is task 11 only', q.taskRef === 11 && q.refOnly && q.words.length === 0, JSON.stringify(q));
q = M.parseQuery('N3');
check('"N3" is Need 3 only', q.needRef === 3 && q.refOnly && !q.words.length, JSON.stringify(q));
q = M.parseQuery('n12');
check('"n12" is Need 12', q.needRef === 12, JSON.stringify(q));
q = M.parseQuery('11');
check('a plain "11" is task 11 and the word 11', q.taskRef === 11 && !q.refOnly && eq(q.words, ['11']), JSON.stringify(q));
q = M.parseQuery('  Pricing   COPY pricing ');
check('words folded, deduped, trimmed', eq(q.words, ['pricing', 'copy']) && q.q === 'Pricing   COPY pricing', JSON.stringify(q));
check('query capped at 80', M.parseQuery('x'.repeat(200)).q.length === 80);
check('non-string query is empty', M.parseQuery(undefined).q === '' && M.parseQuery({}).q === '');

// Matching
const w = s => M.parseQuery(s).words;
check('"pricing copy" finds "Rewrite pricing page copy" (any order)', M.matchesAll(['Rewrite pricing page copy'], w('copy pricing')));
check('every word must match', !M.matchesAll(['Rewrite pricing page'], w('pricing copy')));
check('word start only: "hook" not in "webhook"', !M.matchesAll(['Fix webhook retries'], w('hook')));
check('word start: "web" in "webhook"', M.matchesAll(['Fix webhook retries'], w('web')));
check('after punctuation: "retries" in "(retries)"', M.matchesAll(['fix (retries)'], w('retries')));
check('case ignored', M.matchesAll(['DISCORD alerts'], w('discord')));
check('accents ignored both ways', M.matchesAll(['Café menu'], w('cafe')) && M.matchesAll(['Cafe menu'], w('café')));
check('words across fields', M.matchesAll(['Discord', null, 'quiet hours'], w('quiet discord')));
check('"week 11" does not match "#11"', !M.matchesAll(['week 11'], M.parseQuery('#11').words));
check('a word starting with punctuation matches anywhere', M.matchesAll(['Call notes(v2)'], w('(v2)')));
check('Devanagari word start', M.matchesAll(['काम की सूची'], w('सूची')) && !M.matchesAll(['काम की सूची'], w('ूची')));

// Tiers
const tier = (title, s) => M.tierOf(title, M.parseQuery(s));
check('tier 1: title starts with the query', tier('Pricing copy rewrite', 'pricing copy') === 1);
check('tier 2: all words in the title', tier('Rewrite pricing page copy', 'copy pricing') === 2);
check('tier 3: some words in the title', tier('Pricing page', 'pricing copy') === 3);
check('tier 4: none in the title', tier('Landing page', 'pricing copy') === 4);
const h = (o) => ({ kind: 'tasks', id: 'x', title: 't', href: '/', tier: 2, open: true, mine: false, at: 0, ...o });
const sorted = [h({ id: 'done', open: false }), h({ id: 'old', at: 1 }), h({ id: 'mine', mine: true }), h({ id: 'best', tier: 0, open: false }), h({ id: 'new', at: 5 })].sort(M.compareHits).map(x => x.id);
check('order: tier, open, yours, newest', eq(sorted, ['best', 'mine', 'new', 'old', 'done']), sorted.join(','));

// Marks
const mk = (t, s) => M.marks(t, w(s)).filter(p => p.hit).map(p => p.text);
check('marks the matched word starts', eq(mk('Rewrite pricing page copy', 'copy pri'), ['pri', 'copy']), JSON.stringify(mk('Rewrite pricing page copy', 'copy pri')));
check('marks keep accents', eq(mk('Café menu', 'cafe'), ['Café']), JSON.stringify(mk('Café menu', 'cafe')));
check('marks join back to the text', M.marks('a Café b', ['cafe']).map(p => p.text).join('') === 'a Café b');
check('excerpt centres on the first word', M.excerpt('x '.repeat(100) + 'zorbulax lives here', ['zorbulax']).includes('zorbulax'));

// Database regex: never stricter than the exact rule
const samples = ['Fix webhook retries', 'Café menu', 'CAFÉ MENU', 'Rewrite pricing page copy', 'week 11', 'a-b c_d', 'naïve plan', 'Ångström unit', 'fix (retries)', 'Call notes(v2)'];
const queries = ['web', 'cafe', 'café', 'copy', '11', 'b', 'd', 'naive', 'angstrom', 'retries', '(v2)', 'unit'];
let loose = true;
for (const t of samples) for (const s of queries) for (const word of w(s)) if (M.matchesAll([t], [word]) && !M.wordRegex(word).test(t)) (loose = false), console.log('  regex misses', JSON.stringify(word), 'in', JSON.stringify(t));
check('wordRegex finds everything the exact rule finds', loose);
check('wordRegex escapes regex characters', M.wordRegex('a.*').test('x a.* y') && !M.wordRegex('a.*').test('abc'));
check('wordsFilter: every word, any field', eq(Object.keys(M.wordsFilter(['title', 'body'], ['a', 'b'])), ['$and']) && M.wordsFilter(['title', 'body'], ['a', 'b']).$and.length === 2);

// Settings and Pages (browser)
const titles = (kind, s) => S.matchStatic(kind, M.parseQuery(s)).map(x => x.title);
check('Settings: "discord" finds the Discord settings', titles('settings', 'discord').some(t => /Discord/.test(t)), titles('settings', 'discord').join(','));
check('Settings: "quiet hours" finds Quiet hours first', titles('settings', 'hours quiet')[0] === 'Quiet hours', titles('settings', 'hours quiet').join(','));
check('Settings: "passkey" finds Passkeys', titles('settings', 'passkey')[0] === 'Passkeys', titles('settings', 'passkey').join(','));
check('Pages: "trash" finds Review › Trash', S.matchStatic('pages', M.parseQuery('trash')).some(x => x.title === 'Trash' && x.href === '/review?view=trash'));
check('Pages: "set up" finds Claude › Set up', titles('pages', 'set up').includes('Set up'));
check('Pages: "new task" is the quick add action', S.matchStatic('pages', M.parseQuery('new task'))[0]?.action === 'quick-add');
check('Pages: a ref finds no page', S.matchStatic('pages', M.parseQuery('#3')).length === 0);
check('Pages: no query lists every page and action', S.matchStatic('pages', null).length >= 20);

console.log(failed ? `\n${failed} failed` : '\nsearch check: ok');
process.exit(failed ? 1 : 0);
