// State line editing (docs/flows/agent-system.md section 16 item 2): save_state op edit_line {find, new}, and `find` in
// place of `id` for move_next, done_next and promote_later. Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must as mustRaw } from './flow-lib.mjs';

// A save answers short (H4: no State in it): a saved answer gets the State from get_state, so the checks below read it as before.
const must = async (key, name, args = {}, headers = {}) => {
  const r = await mustRaw(key, name, args, headers);
  return name === 'save_state' && r.saved ? { ...r, state: (await mustRaw(key, 'get_state', { project: args.project })).state } : r;
};

const NAME = 'Flow Edit';
const texts = l => l.map(x => x.text);
try {
  const T = await makeUser({ email: 'edith@example.test', name: 'Edith', orgId: ME.orgId, role: 'member' }); // before the first call: the server caches member names for a minute
  await must(MCP, 'add_project', { name: NAME });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Edith Claude Code' });

  const seed = await must(MCP, 'save_state', {
    project: NAME,
    ops: [
      { op: 'set_now', text: 'Building the editor' },
      { op: 'add_next', text: 'Write the migration script' },
      { op: 'add_next', text: 'Review the billing page' },
      { op: 'add_next', text: 'Review the settings page' },
      { op: 'add_next', text: 'Stale line to remove from Next' },
      { op: 'add_later', text: 'The full long list stays in the repo WORK-STATE.md Later section' },
      { op: 'add_later', text: 'Try the new chart library' },
      { op: 'add_later', text: 'Chart library: compare sizes' },
    ],
    base_version: 0,
  });
  let v = seed.version;

  // Edit: replaces the text inside the one line; the line keeps its id and place
  const idBefore = seed.state.next[0].id;
  const e1 = await must(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'migration script', new: 'data migration' }] });
  v = e1.version;
  check('edit_line: the text is replaced inside the line', e1.state.next[0].text === 'Write the data migration', JSON.stringify(e1.state.next));
  check('edit_line: the line keeps its id and place', e1.state.next[0].id === idBefore && e1.state.next.length === 4, JSON.stringify(e1.state.next));
  check('edit_line: the version went up by one', v === seed.version + 1, `${seed.version} -> ${v}`);

  // Now can be edited too
  const eN = await must(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'the editor', new: 'the State editor' }] });
  v = eN.version;
  check('edit_line: Now can be edited', eN.state.now.text === 'Building the State editor', JSON.stringify(eN.state.now));

  // Zero matches: an error, nothing written
  const zero = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'no such text', new: 'x' }] });
  check('edit_line: no match is an error and nothing is written', zero.isError && /no line/.test(zero.text) && (await rawDb.collection('states').findOne({ projectId: (await rawDb.collection('projects').findOne({ name: NAME }))._id })).version === v, zero.text.slice(0, 300));

  // Several matches: an error naming the candidates, nothing written
  const two = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'Review the', new: 'Check the' }] });
  check('edit_line: two matches is an error that names both candidates', two.isError && /matches 2 lines/.test(two.text) && two.text.includes('billing page') && two.text.includes('settings page'), two.text.slice(0, 400));
  const two2 = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'hart library', new: 'x' }] });
  check('edit_line: matches across Later lines count together', two2.isError && /matches 2 lines/.test(two2.text), two2.text.slice(0, 300));
  const reread = await must(MCP, 'get_state', { project: NAME });
  check('edit_line: after the refusals the State is unchanged', reread.version === v && reread.state.next.some(l => l.text === 'Review the billing page'), JSON.stringify(reread.state.next));

  // find is case-sensitive
  const cs = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'DATA MIGRATION', new: 'x' }] });
  check('edit_line: find is case-sensitive', cs.isError && /no line/.test(cs.text), cs.text.slice(0, 200));

  // base_version is only for set_now: a stale one writes nothing there, and is not needed (or checked) for line edits
  const stale = await must(MCP, 'save_state', { project: NAME, base_version: v - 1, ops: [{ op: 'set_now', text: 'Stale goal' }] });
  check('set_now: a stale base_version is a conflict and nothing is written', stale.conflict === true && stale.state.now.text === 'Building the State editor', JSON.stringify(stale).slice(0, 200));
  const noBase = await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'edit_line', find: 'Try the new chart library', new: 'Try the new chart lib' }] });
  v = noBase.version;
  check('edit_line: needs no base_version, and the edit lands', noBase.saved === true && texts(noBase.state.later).includes('Try the new chart lib') && v === stale.version + 1, JSON.stringify(noBase).slice(0, 200));
  const behind = await must(MCP, 'save_state', { project: NAME, base_version: 1, ops: [{ op: 'edit_line', find: 'Try the new chart lib', new: 'Try the new chart library' }] });
  v = behind.version;
  check('edit_line: a stale base_version is ignored (the line is checked, not the version)', behind.saved === true && texts(behind.state.later).includes('Try the new chart library'), JSON.stringify(behind).slice(0, 200));
  const nextBefore = (await must(MCP, 'get_state', { project: NAME })).state.next;
  const idLine = nextBefore.find(l => l.text.includes('Review the billing page'));
  const wrongId = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'edit_line', id: nextBefore.find(l => l.text.includes('settings page')).id, find: 'billing', new: 'x' }] });
  check('edit_line: id narrows the search; the line with that id must hold find', wrongId.isError && /no line/.test(wrongId.text), wrongId.text.slice(0, 200));
  const byId = await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'edit_line', id: idLine.id, find: 'Review the', new: 'Check the' }] });
  v = byId.version;
  check('edit_line: id + find edits one of two lines that both match find', byId.state.next.find(l => l.id === idLine.id)?.text === 'Check the billing page' && byId.state.next.some(l => l.text === 'Review the settings page'), JSON.stringify(texts(byId.state.next)));
  const back = await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'edit_line', id: idLine.id, find: 'Check the', new: 'Review the' }] });
  v = back.version;

  // Remove from Next: counts as done
  const rN = await must(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'Stale line to remove from Next', new: '' }] });
  v = rN.version;
  check('edit_line: an empty new removes a Next line, counted as done', !texts(rN.state.next).some(t => t.includes('Stale line')) && rN.done?.includes('Stale line to remove from Next') && !rN.dropped, JSON.stringify({ n: rN.state.next, d: rN.done }));

  // Remove from Later: counts as dropped (the example from the review)
  const rL = await must(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'edit_line', find: 'The full long list stays in the repo WORK-STATE.md Later section', new: '' }] });
  v = rL.version;
  check('edit_line: an empty new removes a Later line, counted as dropped', !texts(rL.state.later).some(t => t.includes('full long list')) && rL.dropped?.length === 1 && !rL.done, JSON.stringify({ l: rL.state.later, d: rL.dropped }));

  // Removals stay in the history
  const doc = await rawDb.collection('states').findOne({ projectId: (await rawDb.collection('projects').findOne({ name: NAME }))._id });
  const editLogs = (doc.log ?? []).filter(x => x.op === 'edit_line');
  check('edit_line: every edit and removal is in the State history, with the line id', editLogs.length >= 4 && editLogs.every(x => x.by === ME.userId) && editLogs.filter(x => x.id).length >= 3, JSON.stringify(editLogs.map(x => [x.op, x.id])));

  // by: the editor owns the edited line (no rewriting under someone else's name)
  const mine = await must(MCP, 'get_state', { project: NAME });
  check('by: lines written by the owner carry no writtenBy for the owner', mine.state.next.every(l => !l.writtenBy), JSON.stringify(mine.state.next));
  const tEdit = await must(kT, 'save_state', { project: NAME, base_version: mine.version, ops: [{ op: 'edit_line', find: 'billing page', new: 'billing screen' }] });
  const asT = tEdit.state.next.find(l => l.text === 'Review the billing screen');
  check('by: the editor (Edith) now owns the line she edited: no writtenBy for her', !!asT && !asT.writtenBy, JSON.stringify(tEdit.state.next));
  const ownerView = await must(MCP, 'get_state', { project: NAME });
  const ownerSees = ownerView.state.next.find(l => l.text === 'Review the billing screen');
  check('by: the owner sees that line as written by Edith', !!ownerSees && ownerSees.writtenBy === 'Edith', JSON.stringify(ownerSees));
  const untouched = ownerView.state.next.find(l => l.text === 'Review the settings page');
  check('by: a line nobody edited keeps its author', !!untouched && !untouched.writtenBy, JSON.stringify(untouched));
  const raw = await rawDb.collection('states').findOne({ projectId: doc.projectId });
  check('by: the stored line has by = the editor', raw.next.find(l => l.text === 'Review the billing screen')?.by === T.userId, JSON.stringify(raw.next));
  v = ownerView.version;

  // find in place of id
  const bad = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'move_next', find: 'no such line', to: 'top' }] });
  check('move_next by find: no match is an error', bad.isError && /no line/.test(bad.text), bad.text.slice(0, 200));
  const amb = await mcpH(MCP, 'save_state', { project: NAME, ops: [{ op: 'promote_later', find: 'hart library' }] });
  check('promote_later by find: two matches is an error', amb.isError && /matches 2 lines/.test(amb.text), amb.text.slice(0, 300));
  const both = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'done_next', id: 'l_x', find: 'settings' }] });
  check('done_next: id and find together is an error', both.isError && /not both/.test(both.text), both.text.slice(0, 200));
  const neither = await mcpH(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'done_next' }] });
  check('done_next: neither id nor find is an error', neither.isError && /id or find/.test(neither.text), neither.text.slice(0, 200));

  const mv = await must(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'move_next', find: 'settings page', to: 'top' }] });
  v = mv.version;
  check('move_next by find moves the line', mv.state.next[0].text === 'Review the settings page', JSON.stringify(texts(mv.state.next)));
  const dn = await must(MCP, 'save_state', { project: NAME, base_version: v, ops: [{ op: 'done_next', find: 'billing screen' }] });
  v = dn.version;
  check('done_next by find finishes the line', dn.done?.[0] === 'Review the billing screen' && !texts(dn.state.next).some(t => t.includes('billing')), JSON.stringify(dn.done));
  const pr = await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'promote_later', find: 'new chart library', priority: 'P2' }] });
  check('promote_later by find makes the task and takes the line off Later', pr.promotedToTasks?.length === 1 && /new chart library/.test(pr.promotedToTasks[0]) && !texts(pr.state.later).some(t => t.includes('new chart library')), JSON.stringify(pr.promotedToTasks));

  // Decisions stay append-only: edit_line does not reach them
  await must(MCP, 'save_state', { project: NAME, ops: [{ op: 'add_decision', text: 'Use the zebra pattern' }] });
  const dec = await mcpH(MCP, 'save_state', { project: NAME, base_version: pr.version + 1, ops: [{ op: 'edit_line', find: 'zebra', new: 'horse' }] });
  check('edit_line does not touch Decisions', dec.isError && /no line/.test(dec.text), dec.text.slice(0, 200));
} catch (e) {
  check('flow-state-edit (error)', false, e?.stack || String(e));
}
await finish();
