// Recurring tasks over MCP: completing one makes the next occurrence (due moved on, start kept the same distance
// before it, checklist reset, same owner), links the two with nextRef, and completing it again makes no second copy.
// Seed profile: none.
import { call, check, finish, rawDb } from './lib.mjs';

const t = (await call('add_task', { title: 'Weekly report', due: '2030-01-07', start: '2030-01-05', checklist: ['Collect numbers', 'Send'], recurrence: { freq: 'weekly', interval: 1 } }))?.created;
check('add_task with recurrence', t?.ref && !t.ERROR, JSON.stringify(t));
await call('update_checklist', { task: t.ref, check: [1] });
const done = await call('complete_task', { task: t.ref, note: 'sent' });
check('complete_task on a recurring task', !done?.ERROR, JSON.stringify(done));

const first = await rawDb.collection('tasks').findOne({ ref: t.ref });
const next = first?.nextRef ? await rawDb.collection('tasks').findOne({ ref: first.nextRef }) : null;
check('the done task points at its next occurrence', !!next && first.status === 'Done', JSON.stringify({ status: first?.status, nextRef: first?.nextRef }));
check('next occurrence: open, same title and recurrence', next?.status === 'Not Started' && next.title === 'Weekly report' && next.recurrence?.freq === 'weekly', JSON.stringify(next));
check('next occurrence: due one week on, start the same 2 days before', next?.due === '2030-01-14' && next.start === '2030-01-12', JSON.stringify({ due: next?.due, start: next?.start }));
check('next occurrence: checklist copied and all unticked', next?.checklist?.length === 2 && next.checklist.every(i => !i.done), JSON.stringify(next?.checklist));
check('next occurrence: same owner', next?.ownerId === first?.ownerId);

await call('complete_task', { task: t.ref });
const copies = await rawDb.collection('tasks').countDocuments({ title: 'Weekly report' });
check('completing the done task again makes no second copy', copies === 2, String(copies));

await finish();
