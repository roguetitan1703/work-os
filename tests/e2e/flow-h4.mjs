// H4 State polish (docs/flows/agent-system.md sections 6 and 16.2-16.4), the data-layer half: a Next line and its task finish
// together, an import cuts a long line at a sentence and never makes fragment lines, text above Now is skipped and named,
// and the repo copy leaves Decisions out when the repo is not known to be private. The answer-shape cases (short answers,
// the hook marking, /api/agent/state) come with the server stage. Seed profile: none.
import { ME, MCP, check, finish, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const A = 'H4 Alpha';
const Bn = 'H4 Beta';
const stateOf = async (name, copy = false) => must(MCP, 'get_state', { project: name, ...(copy ? { copy: true } : {}) });
const nextTexts = s => s.state.next.map(l => l.text);
const task = async (title, project, extra = {}) => (await must(MCP, 'add_task', { title, project, ...extra })).created;
const status = async ref => (await rawDb.collection('tasks').findOne({ ref })).status;
try {
  await must(MCP, 'add_project', { name: A });
  await must(MCP, 'add_project', { name: Bn });
  const t1 = await task('Linked one', A);
  const t2 = await task('Linked two', A);
  const t3 = await task('Linked three (other project)', A);
  const t4 = await task('Linked four', A);
  const t5 = await task('Linked five (code)', A, { result_kind: 'code' });
  const t6 = await task('Linked six (already done)', A);

  const seedA = await must(MCP, 'save_state', {
    project: A,
    ops: [
      { op: 'add_next', text: 'Do linked one', ref: t1.ref },
      { op: 'add_next', text: 'Do linked two', ref: t2.ref },
      { op: 'add_next', text: 'A line with no task' },
      { op: 'add_next', text: 'Do linked four', ref: t4.ref },
      { op: 'add_next', text: 'Do linked five', ref: t5.ref },
      { op: 'add_next', text: 'Do linked six', ref: t6.ref },
    ],
  });
  await must(MCP, 'save_state', { project: Bn, ops: [{ op: 'add_next', text: 'Beta waits for linked three', ref: t3.ref }, { op: 'add_next', text: 'Beta other' }] });

  // Short answers and the hook marking (H4 item 1, D1)
  check('H4 short: a save answers with a message and no state, textRule, markdown or repoCopy', !('state' in seedA) && !('textRule' in seedA) && !('markdown' in seedA) && !('repoCopy' in seedA) && /^Saved v\d+\. Next 6/.test(seedA.message) && JSON.stringify(seedA).length < 250, JSON.stringify(seedA));
  check('H4 short: get_state without copy has no markdown', !('markdown' in (await stateOf(A))));
  const hookOf = async sess => (await rawDb.collection('presence').findOne({ session: sess }))?.hook;
  const ccH = await mkKey({ agent: 'claude-code', name: 'H4 hook marks' });
  const hdr = (sess, hook) => ({ 'X-Work-OS-Session': sess, ...(hook ? { 'X-Work-OS-Hook': String(hook) } : {}) });
  await must(ccH, 'start_work', { project: A, label: 'Claude Code', session: 'h4oldhook' }, hdr('h4oldhook'));
  await must(ccH, 'start_work', { project: A, label: 'Claude Code', session: 'h4newhook' }, hdr('h4newhook', 2));
  check('H4 hook: a start_work labelled "Claude Code" with no header is marked hook 1; with X-Work-OS-Hook: 2 it is marked 2', (await hookOf('h4oldhook')) === 1 && (await hookOf('h4newhook')) === 2, JSON.stringify([await hookOf('h4oldhook'), await hookOf('h4newhook')]));
  const sv = (sess, h) => must(ccH, 'save_state', { project: A, session: sess, ops: [{ op: 'add_later', text: `Later for ${sess}` }] }, h);
  const oldSave = await sv('h4oldhook', hdr('h4oldhook'));
  check('H4 hook: a session marked hook 1 still gets the copy in a save answer', typeof oldSave.markdown === 'string' && oldSave.markdown.startsWith('Copy of the Work OS state, version '), JSON.stringify(oldSave).slice(0, 200));
  const newSave = await sv('h4newhook', hdr('h4newhook', 2));
  check('H4 hook: with the hook 2 header the save answer has no markdown', !('markdown' in newSave), JSON.stringify(newSave).slice(0, 200));
  const oldByRow = await sv('h4oldhook', { 'X-Work-OS-Session': 'h4oldhook' });
  check('H4 hook: hook 1 is remembered per session (the next call without a header still gets the copy)', typeof oldByRow.markdown === 'string');
  const newHeaderWins = await sv('h4oldhook', hdr('h4oldhook', 2));
  check('H4 hook: a header 2 on a call wins over a hook 1 row', !('markdown' in newHeaderWins));

  // Task to line
  const v0 = (await stateOf(A)).version;
  await must(MCP, 'complete_task', { task: t1.ref, note: 'done' });
  let sa = await stateOf(A);
  check('H4 link: completing a task takes its Next line off the State and bumps the version once', !nextTexts(sa).includes('Do linked one') && sa.version === v0 + 1 && nextTexts(sa).includes('A line with no task'), JSON.stringify({ v: sa.version, n: nextTexts(sa) }));
  const doc = await rawDb.collection('states').findOne({ _id: (await rawDb.collection('projects').findOne({ name: A }))._id });
  check('H4 link: the log says task_closed and the feed has a next_done row', doc.log.some(x => x.op === 'task_closed') && (await rawDb.collection('activity').countDocuments({ type: 'next_done', note: /Closed with #\d+ \(Done\)/ })) >= 1, JSON.stringify(doc.log.slice(-2)));

  await must(MCP, 'update_task', { task: t2.ref, status: 'Dropped', note: 'not needed' });
  sa = await stateOf(A);
  check('H4 link: Dropped through update_task takes its line off too', !nextTexts(sa).includes('Do linked two') && (await status(t2.ref)) === 'Dropped', JSON.stringify(nextTexts(sa)));

  await must(MCP, 'complete_task', { task: t3.ref, note: 'done' });
  const sb = await stateOf(Bn);
  check('H4 link: another project’s line for the task is closed too', !nextTexts(sb).includes('Beta waits for linked three') && nextTexts(sb).includes('Beta other'), JSON.stringify(nextTexts(sb)));

  // Line to task
  await must(MCP, 'complete_task', { task: t6.ref, note: 'done early' }); // its line goes with it
  sa = await stateOf(A);
  const v1 = sa.version;
  await must(MCP, 'save_state', { project: A, ops: [{ op: 'done_next', find: 'Do linked four' }] });
  check('H4 link: done_next on a line with a ref finishes the task', (await status(t4.ref)) === 'Done', await status(t4.ref));
  const afterDone = await stateOf(A);
  check('H4 link: no loop and no second bump from the task closing (one save, one bump)', afterDone.version === v1 + 1 && !nextTexts(afterDone).includes('Do linked four'), `${v1} -> ${afterDone.version}`);
  await must(MCP, 'save_state', { project: A, ops: [{ op: 'edit_line', find: 'Do linked five', new: '' }] });
  check('H4 link: an agent removing a code task’s line opens a review and the task stays open', (await status(t5.ref)) !== 'Done' && (await status(t5.ref)) !== 'Dropped', await status(t5.ref));
  const needsOnT5 = await rawDb.collection('needs').find({}).toArray();
  check('H4 link: that review Need exists for the code task', needsOnT5.some(n => JSON.stringify(n).includes(t5.title)), `${needsOnT5.length} needs`);

  // Import: one long line is cut at a sentence; the rest is dropped, not made into new lines; text above Now is skipped
  const sentence = 'This is a full sentence of about sixty characters, fine here.';
  const long = Array.from({ length: 14 }, () => sentence).join(' ');
  const md = `Stray text above everything.\n\n# Work state\n\nAnother stray line.\n\n## Now\n- ${long}\n\n## Next\n1. ${long}\n2. Short line\n\n## Later\n- Later one\n`;
  await must(MCP, 'add_project', { name: 'H4 Import' });
  const cc = await mkKey({ agent: 'claude-code', name: 'H4 Claude Code' });
  const impAns = await must(cc, 'import_state', { project: 'H4 Import', markdown: md });
  check('H4 short: an import answers short (message, imported, shortened, no state or markdown)', !('state' in impAns) && !('markdown' in impAns) && /^Imported v1\./.test(impAns.message) && /cut at a sentence/.test(String(impAns.shortened)), JSON.stringify(impAns).slice(0, 300));
  const imp = { ...impAns, state: (await must(cc, 'get_state', { project: 'H4 Import' })).state };
  const n0 = imp.state.next[0].text;
  check('H4 import: a 700+ character line is cut after a sentence end, within 500 characters', long.length > 700 && n0.length <= 500 && n0.endsWith('here.') && long.startsWith(n0), `${long.length} -> ${n0.length}: ${n0.slice(-40)}`);
  check('H4 import: no fragment Later lines (Later holds only what it was given)', imp.state.later.length === 1 && imp.state.later[0].text === 'Later one', JSON.stringify(imp.state.later.map(l => l.text.slice(0, 40))));
  check('H4 import: Now is cut at a sentence too (long Now stays one line)', imp.state.now.text.endsWith('here.') && imp.state.next.length === 2, imp.state.now.text.slice(-30));
  check('H4 import: text above Now is skipped and named', !JSON.stringify(imp.state).includes('Stray text') && !JSON.stringify(imp.state).includes('Another stray') && /Text above Now \(2 lines\)/.test(imp.notImported ?? ''), imp.notImported);

  // Decisions stay out of the repo copy when the repo is not known to be private (here: no remote, and no network in the e2e run)
  await must(MCP, 'save_state', { project: A, ops: [{ op: 'add_decision', text: 'Secret pricing decision' }] });
  const g = await stateOf(A, true);
  check('H4 copy: Decisions are not in the repo copy when the repo is unknown, but are in the State', !g.markdown.includes('Secret pricing decision') && !g.markdown.includes('## Decisions') && g.state.decisions.some(d => d.text === 'Secret pricing decision'), g.markdown);
  check('H4 copy: no Where section and no author labels in the copy', !g.markdown.includes('## Where') && !/\(by /.test(g.markdown), g.markdown);
  // …and they are in it once the repo is known private (cached answer, as the 7-day cache would hold it)
  await rawDb.collection('projects').updateOne({ name: A }, { $set: { code: [{ remote: 'acme/h4-alpha' }], repoPublic: false, repoPublicAt: new Date() } });
  const priv = await stateOf(A, true);
  check('H4 copy: with a cached private verdict the copy lists Decisions', priv.markdown.includes('## Decisions') && priv.markdown.includes('Secret pricing decision'), priv.markdown);
  await rawDb.collection('projects').updateOne({ name: A }, { $set: { repoPublic: true } });
  const pub = await stateOf(A, true);
  check('H4 copy: with a public verdict the Decisions are left out again', !pub.markdown.includes('Secret pricing decision'), pub.markdown);
  void ME;
} catch (e) {
  check('flow-h4 (error)', false, e?.stack || String(e));
}
void mcpH;
await finish();
