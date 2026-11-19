// Unit test for lib/declutter-core.ts (docs/flows/agent-system.md section 7, H11): when a project is due, which lines and
// notes count, the stable item ids and where an open Claude item goes. Run: npm run check:declutter (Node 22.6+, type stripping).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const core = await import(pathToFileURL(join(ROOT, 'lib/declutter-core.ts')).href);
const { titleKey } = await import(pathToFileURL(join(ROOT, 'lib/notes-match.ts')).href);
const { GROWTH, dueReasons, duplicateGroups, itemId, itemPlan, noteItems, stateItems, isStale } = core;

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};

const NOW = new Date('2026-11-19T10:00:00Z');
const ago = d => new Date(NOW.getTime() - d * 86_400_000 + 60_000); // a minute inside the day
const exactly = d => new Date(NOW.getTime() - d * 86_400_000);
let n = 0;
const line = (o = {}) => ({ id: `l_${++n}`, text: `line number ${n} distinct words ${'x'.repeat(n)}`, at: ago(1), ...o });
const lines = (k, o) => Array.from({ length: k }, () => line(o));
const due = (st, now = NOW) => dueReasons(st, now, 'Work OS');

// 1. Counts: Later 25/26, Next 10/11
check('Later 25 is not due', !due({ next: [], later: lines(25) }).due);
check('Later 26 is due and says so', due({ next: [], later: lines(26) }).reasons[0] === 'Later 26 (over 25)', JSON.stringify(due({ next: [], later: lines(26) })));
check('Next 10 is not due', !due({ next: lines(10), later: [] }).due);
check('Next 11 is due', due({ next: lines(11), later: [] }).reasons[0] === 'Next 11 (over 10)');
check('nothing in the State: not due, no text', due({ next: [], later: [] }).text === null);
check('no State at all: not due', due(null).text === null);

// 2. Stale lines: 13 / 14 days, and a waiting line is never stale
check('13 days is not stale', !isStale({ at: ago(13) }, NOW));
check('14 days is stale', isStale({ at: exactly(14) }, NOW));
check('a line waiting on someone is never stale', !isStale({ at: ago(200), waitsOn: 'Akash' }, NOW));
check('a stale line makes the project due', due({ next: [line({ at: exactly(20) })], later: [] }).reasons[0] === '1 line untouched 14 days');
check('two stale lines are counted', due({ next: [line({ at: exactly(20) })], later: [line({ at: exactly(30) })] }).reasons[0] === '2 lines untouched 14 days');
check('a waiting line alone does not make it due', !due({ next: [], later: [line({ at: ago(100), waitsOn: 'Akash' })] }).due);

// 3. Cache, quiet window, open Need
const cache = (o = {}) => ({ checkedAt: NOW, reasons: [], ...o });
check('cached reasons are added to the count reasons', due({ next: lines(11), later: [], declutter: cache({ reasons: ['2 notes share a title'] }) }).reasons.join('|') === 'Next 11 (over 10)|2 notes share a title');
check('cached reasons alone make it due', due({ next: [], later: [], declutter: cache({ reasons: ['3 open Claude items'] }) }).due);
check('the text names the project and the tool', due({ next: lines(11), later: [] }).text === 'Declutter due: Next 11 (over 10). Call declutter {project: "Work OS"}.');
const quiet = { next: lines(30), later: lines(40), declutter: cache({ reasons: ['x'], quietUntil: new Date(NOW.getTime() + 86_400_000) }) };
check('quiet: nothing is said while quietUntil is in the future', !due(quiet).due && due(quiet).text === null);
check('quiet is over once quietUntil has passed', due({ ...quiet, declutter: { ...quiet.declutter, quietUntil: new Date(NOW.getTime() - 1) } }).due);
const open = due({ next: lines(30), later: [], declutter: cache({ needId: 'n1', needRef: 14 }) });
check('an open declutter Need says so instead of due', !open.due && open.openNeed === 14 && open.text === 'Declutter Need #14 is open.');
check('the open Need wins over a quiet window too', due({ next: [], later: [], declutter: cache({ needId: 'n1', needRef: 7, quietUntil: new Date(NOW.getTime() + 1e9) }) }).openNeed === 7);

// 4. Duplicate grouping through titleKey
const T = (title, o = {}) => ({ title, ...o });
const g1 = duplicateGroups([T('Om’s Plan'), T("om's  plan"), T('Other')], titleKey);
check('curly quote, case and spacing share a key', g1.length === 1 && g1[0].length === 2, JSON.stringify(g1));
check('different titles make no group', duplicateGroups([T('A'), T('B')], titleKey).length === 0);
check('Untitled is exempt', duplicateGroups([T('Untitled'), T('untitled')], titleKey).length === 0);
check('an empty title is exempt', duplicateGroups([T(''), T('  ')], titleKey).length === 0);
check('handovers are exempt', duplicateGroups([T('Handover', { exempt: true }), T('Handover', { exempt: true })], titleKey).length === 0);
check('a handover does not pair with a normal page', duplicateGroups([T('Handover', { exempt: true }), T('Handover')], titleKey).length === 0);
check('three pages with one title make one group of three', duplicateGroups([T('X'), T('x'), T('X ')], titleKey)[0].length === 3);
check('two separate pairs make two groups', duplicateGroups([T('a'), T('A'), T('b'), T('B')], titleKey).length === 2);

// 5. The note proposal keeps the newest
const ni = noteItems([[{ id: 'n1', title: 'Plan', updatedAt: ago(10) }, { id: 'n2', title: 'Plan', updatedAt: ago(1) }, { id: 'n3', title: 'plan', updatedAt: ago(5) }]]);
check('notes: the newest stays, the two older are proposed', ni.length === 2 && ni.every(i => i.kind === 'archive_note') && ni.map(i => i.target).sort().join() === 'n1,n3', JSON.stringify(ni));

// 6. State items and stable ids
const s1 = line({ text: 'Old next without a task', at: exactly(20) });
const s2 = line({ text: 'Old next with an open task', ref: 5, at: exactly(20) });
const s3 = line({ text: 'Next whose task is closed', ref: 6, at: ago(1) });
const s4 = line({ text: 'Old next waiting on Akash', waitsOn: 'Akash', at: exactly(60) });
const s5 = line({ text: 'Fresh next', at: ago(1) });
const l1 = line({ text: 'Stale later', at: exactly(30) });
const l2 = line({ text: 'Dup one: the same words', at: ago(5) });
const l3 = line({ text: 'dup one: the same words', at: ago(2) });
const l4 = line({ text: 'Waiting later', waitsOn: 'Om', at: exactly(90) });
const st = { next: [s1, s2, s3, s4, s5], later: [l1, l2, l3, l4] };
const si = stateItems(st, NOW, new Set([6]), titleKey);
const byId = Object.fromEntries(si.map(i => [i.id, i]));
check('next: stale without a task is archived', byId[`next:${s1.id}`]?.kind === 'archive_line');
check('next: a line with an open task is left alone', !byId[`next:${s2.id}`]);
check('next: a line whose task is closed is done', byId[`next:${s3.id}`]?.kind === 'done_next' && /#6/.test(byId[`next:${s3.id}`].why));
check('next: a waiting line is left alone', !byId[`next:${s4.id}`]);
check('next: a fresh line is left alone', !byId[`next:${s5.id}`]);
check('later: a stale line is archived', byId[`later:${l1.id}`]?.kind === 'archive_line');
check('later: of two duplicates the older goes, the newer stays', byId[`later:${l2.id}`]?.kind === 'archive_line' && !byId[`later:${l3.id}`]);
check('later: a waiting line is left alone however old', !byId[`later:${l4.id}`]);
check('item ids are stable between two calls', JSON.stringify(si.map(i => i.id)) === JSON.stringify(stateItems(st, NOW, new Set([6]), titleKey).map(i => i.id)));
check('item ids carry a group and the target', itemId('later', 'l_x') === 'later:l_x' && itemId('note', 'abc') === 'note:abc' && itemId('need', 7) === 'need:7' && itemId('item', 'C41') === 'item:C41');
check('item text stays within the limit', stateItems({ next: [], later: [line({ text: 'y'.repeat(500), at: exactly(40) })] }, NOW, new Set(), titleKey)[0].text.length <= GROWTH.itemText);

// 7. Where a Claude item goes
const it = (o = {}) => ({ ref: 41, title: 'Fix the thing', why: 'It breaks on Mondays. More detail follows here.', doneWhen: 'The test passes', kind: 'task', state: 'queued', waitingText: '', waitingOn: null, ...o });
const p1 = itemPlan(it());
check('item with a done-when becomes a task', p1?.kind === 'item_to_task' && p1.id === 'item:C41' && p1.target === 'C41', JSON.stringify(p1));
const p2 = itemPlan(it({ kind: 'idea' }));
check('an idea becomes a Later line with the first sentence', p2?.kind === 'item_to_later' && p2.text === 'Fix the thing: It breaks on Mondays.', JSON.stringify(p2));
check('an item without a done-when becomes a Later line', itemPlan(it({ doneWhen: '' }))?.kind === 'item_to_later');
const p3 = itemPlan(it({ waitingOn: 'u1', waitingText: 'needs the key' }), 'Akash');
check('an item waiting on a person becomes a Later line naming them', p3?.kind === 'item_to_later' && /Akash/.test(p3.why) && /needs the key/.test(p3.why), JSON.stringify(p3));
check('an active or blocked item moves too', itemPlan(it({ state: 'active' }))?.kind === 'item_to_task' && itemPlan(it({ state: 'blocked' }))?.kind === 'item_to_task');
check('done and dropped items stay as history', itemPlan(it({ state: 'done' })) === null && itemPlan(it({ state: 'dropped' })) === null);
check('the limits are the plan numbers', GROWTH.later === 25 && GROWTH.next === 10 && GROWTH.staleDays === 14 && GROWTH.quietDays === 14 && GROWTH.noteDays === 30 && GROWTH.items === 60 && GROWTH.adds === 40 && GROWTH.disk === 20);

console.log(failed ? `${failed} FAILED` : 'declutter check: ok');
process.exit(failed ? 1 : 0);
