// Unit test for lib/claude-items-migrate.ts (H11 step 7): where an open Claude item goes. No database.
// Run: npm run check:claude-items-migrate (Node 22.6+, type stripping).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { migratePlan, movedToTask, movedToLine } = await import(pathToFileURL(join(ROOT, 'lib/claude-items-migrate.ts')).href);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};
const item = (o = {}) => ({ ref: 12, title: 'Fix the thing', why: 'It breaks on save. More detail follows.', doneWhen: 'Save works', kind: 'bug', state: 'queued', waitingOn: null, waitingText: '', ...o });

let p = migratePlan(item());
check('feature/bug/debt with a done-when becomes a P3 task', p?.to === 'task' && p.priority === 'P3' && p.tags[0] === 'from-claude-item' && p.title === 'Fix the thing', JSON.stringify(p));
check('task description is why plus Done when', p?.description === 'It breaks on save. More detail follows.\n\nDone when: Save works', JSON.stringify(p));
for (const state of ['active', 'blocked']) check(`${state} items are open`, migratePlan(item({ state }))?.to === 'task');
for (const state of ['done', 'dropped']) check(`${state} items stay as history`, migratePlan(item({ state })) === null);
p = migratePlan(item({ kind: 'idea' }));
check('an idea becomes a Later line with the first sentence', p?.to === 'later' && p.text === 'Fix the thing: It breaks on save.' && !p.waitsOn, JSON.stringify(p));
p = migratePlan(item({ doneWhen: '  ' }));
check('no done-when becomes a Later line', p?.to === 'later');
p = migratePlan(item({ doneWhen: '', waitingText: 'needs a key' }));
check('Later line without a person waits on the item waiting text', p?.to === 'later' && p.waitsOn === 'needs a key', JSON.stringify(p));
p = migratePlan(item({ waitingOn: 'u1', waitingText: 'pick a colour' }), 'Akash');
check('waiting on a person: Later line waiting on them by name', p?.to === 'later' && p.waitsOn === 'Akash: pick a colour', JSON.stringify(p));
p = migratePlan(item({ waitingOn: 'u1', waitingText: '' }));
check('waiting on an unknown person says "a person"', p?.to === 'later' && p.waitsOn === 'a person');
p = migratePlan(item({ why: 'x'.repeat(900), kind: 'idea' }));
check('a Later line is at most 500 characters', p?.to === 'later' && p.text.length <= 500);
p = migratePlan(item({ waitingOn: 'u1', waitingText: 'y'.repeat(400) }), 'Om');
check('waits-on is at most 200 characters', p?.to === 'later' && p.waitsOn.length <= 200);
p = migratePlan(item({ title: 't'.repeat(400) }));
check('a task title is at most 300 characters', p?.to === 'task' && p.title.length <= 300);
p = migratePlan(item({ why: '' , kind: 'idea' }));
check('empty why: the line is the title', p?.to === 'later' && p.text === 'Fix the thing');
check('movedTo forms', movedToTask(7) === '#7' && movedToLine('l_ab') === 'later:l_ab');

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
