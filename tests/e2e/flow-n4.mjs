// Flow N4 (security review of Needs): what must hold when things move, when an agent pushes, and when someone loses access.
//   - a task that moves takes its Needs along (project and placement), the ones whose addressee cannot read it there are
//     withdrawn, and the task's `need` mark follows (shared to private, private to shared, to a list without the addressee, subtasks);
//   - an agent cannot flood a phone: the 11th Need to one person in an hour is refused whatever happened to the first ten,
//     and a replacement of a Need alerted minutes ago sends no second alert;
//   - withdraw_need: same word, and the same session (else the same key); a person's Needs and review Needs are not withdrawn by agents;
//   - "chat" is only a claude.ai app that signed in through OAuth; a static chat key is "agent";
//   - a person taken off a project's list, or removed from the organization, has no open Need left;
//   - two answers at once: one wins; update_task and apply_changes cannot write a `need` mark; a trashed task keeps its Need.
// Seed profile: none.
import { B, ME, MCP, check, finish, launch, login, makeUser, mkKey, rawDb, setProfile } from './lib.mjs';
import { mcpH, mkOAuth, must, sleep } from './flow-lib.mjs';

const H = id => ({ 'x-work-os-session': id });
const need = id => rawDb.collection('needs').findOne({ _id: id });
const mark = ref => rawDb.collection('tasks').findOne({ orgId: ME.orgId, ref }).then(t => t?.need ?? null);
const seen = async (key, id, project) => { const r = await mcpH(key, 'needs', { project, status: 'all', limit: 100 }); return !r.isError && (r.json.needs ?? []).some(n => n.id === id); };

const browser = await launch();
try {
  await setProfile(ME, { quietStart: 0, quietEnd: 0, checklistHidden: true });
  const mk = (e, n) => makeUser({ email: `${e}@example.test`, name: n, orgId: ME.orgId, role: 'member' });
  const bea = await mk('bea', 'Bea');
  const cara = await mk('cara', 'Cara');
  const dan = await mk('dan', 'Dan');
  const eve = await mk('eve', 'Eve');
  const kBea = await mkKey({ agent: 'claude-code', userId: bea.userId, orgId: ME.orgId, name: 'bea code' });
  const kA = await mkKey({ agent: 'claude-code', name: 'om code A' });
  const kB = await mkKey({ agent: 'claude-code', name: 'om code B' });
  const kOAuth = await mkOAuth({ userId: ME.userId, orgId: ME.orgId });
  for (const n of ['N4 Shared', 'N4 Shared 2']) await must(MCP, 'add_project', { name: n });
  await must(MCP, 'add_project', { name: 'N4 Private', visibility: 'private' });
  await must(MCP, 'add_project', { name: 'N4 Circle', visibility: 'members', shared_with: ['me'] });
  const proj = async name => (await rawDb.collection('projects').findOne({ name }))._id;
  const task = async (title, project) => (await must(MCP, 'add_task', { title, project })).created;
  const ask = (key, to, extra = {}) => must(key, 'ask', { project: 'N4 Shared', to, kind: 'do', ask: 'Please look', ...extra }).then(r => r.need);

  // ======== a moved task takes its Needs along ========
  {
    const t1 = await task('Moves to private', 'N4 Shared');
    const nb = await ask(kA, 'Bea', { task: t1.ref, ask: 'Bea, check the invoice' });
    check('move: the task shows the mark before the move', (await mark(t1.ref))?.id === nb.id);
    await must(MCP, 'update_task', { task: t1.ref, project: 'N4 Private' });
    const d = await need(nb.id);
    check('shared to private: a Need to someone who cannot read the new place is withdrawn (reason moved)', d.status === 'withdrawn' && d.withdrawnReason === 'moved', JSON.stringify([d.status, d.withdrawnReason]));
    check('shared to private: it is stamped private to the owner, in the new project', d.visibility === 'private' && d.ownerId === ME.userId && d.projectId === (await proj('N4 Private')), JSON.stringify([d.visibility, d.projectId]));
    check('shared to private: the addressee can no longer read it, and the mark is gone', !(await seen(kBea, nb.id, 'N4 Shared')) && !(await seen(kBea, nb.id, 'N4 Private')) && (await mark(t1.ref)) === null);

    const t2 = await task('Moves to shared', 'N4 Private');
    const nm = (await must(kA, 'ask', { project: 'N4 Private', to: 'me', kind: 'decide', task: t2.ref, ask: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] })).need;
    check('private to shared: before the move only the owner reads it', !(await seen(kBea, nm.id, 'N4 Private')) && (await need(nm.id)).visibility === 'private');
    await must(MCP, 'update_task', { task: t2.ref, project: 'N4 Shared' });
    const d2 = await need(nm.id);
    check('private to shared: the Need is shared with the task and open', d2.visibility === 'org' && d2.status === 'open' && d2.projectId === (await proj('N4 Shared')), JSON.stringify([d2.visibility, d2.status]));
    check('private to shared: a teammate reads it now, and the mark on the shared task matches it', (await seen(kBea, nm.id, 'N4 Shared')) && (await mark(t2.ref))?.id === nm.id);

    const t3 = await task('Moves to a list', 'N4 Shared');
    const nc = await ask(kA, 'Bea', { task: t3.ref, ask: 'Bea, review the plan' });
    const t4 = await task('Moves to a list, mine', 'N4 Shared');
    const nme = await ask(kA, 'me', { task: t4.ref, ask: 'Owner decides' });
    await must(MCP, 'update_task', { task: t3.ref, project: 'N4 Circle' });
    await must(MCP, 'update_task', { task: t4.ref, project: 'N4 Circle' });
    const d3 = await need(nc.id);
    const d4 = await need(nme.id);
    check('to a list the addressee is not on: the Need is withdrawn and restamped to the list', d3.status === 'withdrawn' && d3.visibility === 'members' && !d3.sharedWith.includes(bea.userId), JSON.stringify([d3.status, d3.visibility, d3.sharedWith]));
    check('to a list: a Need to someone on it stays open, with the list', d4.status === 'open' && d4.visibility === 'members' && d4.sharedWith.includes(ME.userId) && (await mark(t4.ref))?.id === nme.id, JSON.stringify([d4.status, d4.sharedWith]));

    const parent = await task('Parent that moves', 'N4 Shared');
    const kid = (await must(MCP, 'add_task', { title: 'Kid of the parent', parent: parent.ref })).created;
    const nk = await ask(kA, 'Bea', { task: kid.ref, ask: 'Bea, the kid' });
    await must(MCP, 'update_task', { task: parent.ref, project: 'N4 Private' });
    const dk = await need(nk.id);
    check('a parent moving takes its subtasks\' Needs: withdrawn, private, mark gone', dk.status === 'withdrawn' && dk.visibility === 'private' && (await mark(kid.ref)) === null, JSON.stringify([dk.status, dk.visibility]));
  }

  // ======== an agent cannot flood a phone ========
  {
    const made = [];
    for (let i = 0; i < 12; i++) {
      const r = await mcpH(kA, 'ask', { project: 'N4 Shared', to: 'Cara', kind: 'do', ask: `Loop ${i}` });
      made.push(r);
      if (!r.isError) await must(kA, 'withdraw_need', { id: r.json.need.ref });
    }
    const ok = made.filter(r => !r.isError).length;
    check('flood: ask, withdraw, ask again: ten land in an hour, the rest are refused', ok === 10 && made.slice(10).every(r => r.isError && /last hour/.test(r.text)), made.map(r => (r.isError ? 'x' : 'ok')).join(''));
    await sleep(2500);
    const alerts = await rawDb.collection('notifications').countDocuments({ userId: cara.userId, kind: 'need' });
    check('flood: at most ten alerts reached the person', alerts <= 10, String(alerts));

    const t = await task('Replaced over and over', 'N4 Shared');
    const first = await ask(kA, 'Dan', { task: t.ref, ask: 'First wording' });
    for (let i = 0; i < 5; i++) await ask(kA, 'Dan', { task: t.ref, ask: `Wording ${i + 2}` });
    await sleep(3000);
    const dn = await rawDb.collection('notifications').countDocuments({ userId: dan.userId, kind: 'need' });
    const queued = await rawDb.collection('alertQueue').countDocuments({ userId: dan.userId, kind: 'need', taskId: (await rawDb.collection('tasks').findOne({ orgId: ME.orgId, ref: t.ref }))._id });
    check('replace: six replacing asks within minutes alert the person once', queued === 1 && dn <= 1 && (await need(first.id)).status === 'replaced', `notifications ${dn}, queued ${queued}`);
    const open = await rawDb.collection('needs').countDocuments({ to: dan.userId, status: 'open' });
    check('replace: only the newest is open', open === 1, String(open));
  }

  // ======== withdraw_need: who may take one back ========
  {
    const x = await ask(kA, 'Eve', { ask: 'Session one asks' });
    const x1 = (await must(kA, 'ask', { project: 'N4 Shared', to: 'Bea', kind: 'do', ask: 'Pinned to session s1' }, H('s1'))).need;
    const other = await mcpH(kB, 'withdraw_need', { id: x1.ref }, H('s1'));
    check('withdraw: another key cannot take it back, even naming the same session', other.isError && /did not ask/.test(other.text), other.text.slice(0, 120));
    const wrongSession = await mcpH(kA, 'withdraw_need', { id: x1.ref }, H('s2'));
    check('withdraw: another session of the same key cannot', wrongSession.isError && /did not ask/.test(wrongSession.text), wrongSession.text.slice(0, 120));
    const noSession = await mcpH(kA, 'withdraw_need', { id: x1.ref });
    check('withdraw: a call naming no session cannot take back a session\'s Need', noSession.isError, noSession.text.slice(0, 120));
    const same = await mcpH(kA, 'withdraw_need', { id: x1.ref }, H('s1'));
    check('withdraw: the asking session can', !same.isError && same.json.need.status === 'withdrawn', same.text.slice(0, 120));
    const byKey = await mcpH(kB, 'withdraw_need', { id: x.ref });
    check('withdraw: a Need asked without a session belongs to its key: another key cannot', byKey.isError);
    check('withdraw: ...the same key can', !(await mcpH(kA, 'withdraw_need', { id: x.ref })).isError);

    const base = await need(x1.id);
    const person = { ...base, _id: 'person-need-1', ref: 9001, status: 'open', closedAt: null, from: { actor: base.from.actor, word: 'person' } };
    const review = { ...base, _id: 'review-need-1', ref: 9002, status: 'open', closedAt: null, kind: 'review' };
    await rawDb.collection('needs').insertMany([person, review]);
    const pw = await mcpH(kA, 'withdraw_need', { id: 9001 });
    const rw = await mcpH(kA, 'withdraw_need', { id: 9002 }, H('s1'));
    check('withdraw: a Need a person asked is never taken back by an agent', pw.isError && (await need('person-need-1')).status === 'open', pw.text.slice(0, 120));
    check('withdraw: a review Need is never taken back by an agent', rw.isError && (await need('review-need-1')).status === 'open', rw.text.slice(0, 120));
    await rawDb.collection('needs').deleteMany({ _id: { $in: ['person-need-1', 'review-need-1'] } });
  }

  // ======== the word ========
  {
    const viaOAuth = await mcpH(kOAuth, 'ask', { project: 'N4 Shared', to: 'Bea', kind: 'do', ask: 'From the claude.ai app' });
    const viaKey = await mcpH(MCP, 'ask', { project: 'N4 Shared', to: 'Bea', kind: 'do', ask: 'From a static chat key' });
    check('word: a claude.ai app signed in through OAuth is "chat"', !viaOAuth.isError && viaOAuth.json.need.word === 'chat', viaOAuth.text.slice(0, 160));
    check('word: a static Claude chat API key is "agent"', !viaKey.isError && viaKey.json.need.word === 'agent', viaKey.text.slice(0, 160));
    const rows = await rawDb.collection('needs').find({ 'from.keyId': { $exists: true } }).toArray();
    check('word: the stored Need names the key behind it (oauth_ for the app)', rows.some(r => r.from.word === 'chat' && r.from.keyId.startsWith('oauth_')));
  }

  // ======== lost access ========
  {
    await must(MCP, 'add_project', { name: 'N4 List', visibility: 'members', shared_with: [bea.userId] });
    const nl = (await must(kA, 'ask', { project: 'N4 List', to: 'Bea', kind: 'do', ask: 'On the list' })).need;
    await must(MCP, 'update_project', { project: 'N4 List', shared_with: ['me'] });
    const d = await need(nl.id);
    check('taken off a list: the Need addressed to them is withdrawn (reason access)', d.status === 'withdrawn' && d.withdrawnReason === 'access', JSON.stringify([d.status, d.withdrawnReason]));

    const t = await task('Eve will leave', 'N4 Shared 2');
    const ne = (await must(kA, 'ask', { project: 'N4 Shared 2', to: 'Eve', kind: 'do', task: t.ref, ask: 'Eve, do this' })).need;
    check('removal: before it, the task shows the mark', (await mark(t.ref))?.id === ne.id);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await login(p, { next: '/settings?section=members' });
    await p.waitForSelector('button[aria-label="Remove eve@example.test"]', { timeout: 20000 });
    await p.click('button[aria-label="Remove eve@example.test"]');
    await p.click('[data-remove-confirm="eve@example.test"] button:has-text("Remove")');
    let de;
    for (let i = 0; i < 40; i++) { de = await need(ne.id); if (de.status !== 'open') break; await sleep(300); }
    check('removal: a removed member\'s open Needs are withdrawn and the task mark is rebuilt', de.status === 'withdrawn' && de.withdrawnReason === 'access' && (await mark(t.ref)) === null, JSON.stringify([de.status, de.withdrawnReason]));
    await ctx.close();
  }

  // ======== other review items ========
  {
    // update_task and apply_changes cannot write the mark
    const t = await task('Mark is the server\'s', 'N4 Shared');
    const real = await ask(kA, 'Bea', { task: t.ref, ask: 'The real ask' });
    const fake = { id: 'fake', ref: 777, to: ME.userId, ask: 'FAKE MARK' };
    await mcpH(MCP, 'update_task', { task: t.ref, title: 'Mark is the server\'s (edited)', need: fake });
    await mcpH(MCP, 'apply_changes', { ops: [{ op: 'update_task', task: t.ref, priority: 'P2', need: fake }] });
    const m = await mark(t.ref);
    check('update_task and apply_changes cannot write a Need mark', m?.id === real.id && !JSON.stringify(m).includes('FAKE'), JSON.stringify(m));

    // a trashed task keeps its open Need, and restoring brings the mark back
    await must(MCP, 'delete_task', { task: t.ref, title: "Mark is the server's (edited)" });
    const trashed = await need(real.id);
    check('trash: a trashed task\'s open Need is withdrawn (nothing left to ask)', trashed.status === 'withdrawn' && trashed.withdrawnReason === 'task trashed', JSON.stringify([trashed.status, trashed.withdrawnReason]));
    await must(MCP, 'restore_task', { task: t.ref });
    check('trash: restored, the task has no stale mark and the Need stays closed', (await mark(t.ref)) === null && (await need(real.id)).status === 'withdrawn');
    const dr = await task('Dropped with a Need', 'N4 Shared');
    const nd = await ask(kA, 'Bea', { task: dr.ref, ask: 'Before it was dropped' });
    await must(MCP, 'update_task', { task: dr.ref, status: 'Dropped' });
    check('dropped: the task\'s open Need is withdrawn too', (await need(nd.id)).status === 'withdrawn' && (await mark(dr.ref)) === null);
  }

  // ======== reviews cannot flood an owner either ========
  {
    const ids = [];
    for (let i = 0; i < 50; i++) {
      const t = (await must(MCP, 'add_task', { title: `Flood ${i}`, project: 'N4 Shared', result_kind: 'code' })).created;
      await mcpH(kA, 'hand_in', { task: t.ref, changed: 'done' });
      ids.push(t.ref);
    }
    const needsMade = await rawDb.collection('needs').find({ taskRef: { $in: ids }, kind: 'review' }).toArray();
    const queued = await rawDb.collection('alertQueue').countDocuments({ needId: { $in: needsMade.map(n => n._id) } });
    check('review flood: one agent handing in 50 tasks of one owner makes 50 reviews but at most 10 alerts', needsMade.length === 50 && queued > 0 && queued <= 10, `needs ${needsMade.length}, alerts ${queued}`);
    check('review flood: the ones past the limit are marked as made without an alert', needsMade.filter(n => n.noAlert).length === 50 - queued);
  }

  // ======== two answers at once: one wins ========
  {
    const t = await task('Double click', 'N4 Shared');
    const n = (await must(kA, 'ask', { project: 'N4 Shared', to: 'me', kind: 'decide', task: t.ref, ask: 'Double click question?', options: [{ label: 'Yes please' }, { label: 'No thanks' }] })).need;
    const pages = [];
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const p = await ctx.newPage();
      await login(p, { next: '/today' });
      const card = p.locator(`[data-variant=desk] [data-section="needs-you"] [data-need="${n.ref}"]`);
      await card.waitFor({ timeout: 20000 });
      pages.push({ ctx, p, card });
    }
    await Promise.all([pages[0].card.locator('[data-need-option="a"]').click(), pages[1].card.locator('[data-need-option="b"]').click()]);
    await sleep(2500);
    const d = await need(n.id);
    check('two answers at once: exactly one is recorded, the Need is answered once', d.status === 'answered' && ['a', 'b'].includes(d.answer.option), JSON.stringify([d.status, d.answer?.option]));
    check('two answers at once: the task mark is gone', (await mark(t.ref)) === null);
    for (const x of pages) await x.ctx.close();
  }
} catch (e) {
  check('flow-n4 ran to the end', false, String(e?.stack ?? e));
}
await browser.close();
finish();
