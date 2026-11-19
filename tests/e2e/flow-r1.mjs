// Flow R1 (docs/flows/plan-1-3.md slice 5, "results and review"): an agent closing code, data or client work gets a review
// Need to the task's owner instead of Done; check and report work, and a person, still finish directly.
//   - every path to Done for an agent is gated: update_task, log_progress, an apply_changes op (update_task, complete_task),
//     complete_task, hand_in (and the dispatcher's agent, which uses the same calls);
//   - Accept closes it; Send back (with a line) reopens it, the line comes first in get_task and in start_work, and a dispatched
//     task goes back in the queue; Accept and file what is left closes it and files one task per `left` line;
//   - the review outcome is recorded (accepted first time, or after a send-back);
//   - a dispatched task that goes to review sends the review alert, not "Claude finished";
//   - an agent cannot loosen a task's kind to get past the gate.
// Seed profile: none.
import { B, CRON, ME, MCP, check, finish, launch, login, makeUser, mkKey, rawDb, setProfile } from './lib.mjs';
import { mcpH, must, sleep } from './flow-lib.mjs';

const col = n => rawDb.collection(n);
const task = ref => col('tasks').findOne({ orgId: ME.orgId, ref });
const reviewOf = async ref => col('needs').findOne({ taskRef: ref, kind: 'review', status: 'open' });
const reviews = ref => col('needs').find({ taskRef: ref, kind: 'review' }).toArray();

const browser = await launch();
try {
  await setProfile(ME, { quietStart: 0, quietEnd: 0, checklistHidden: true });
  const kA = await mkKey({ agent: 'claude-code', name: 'om code' });
  const bea = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const kBea = await mkKey({ agent: 'claude-code', userId: bea.userId, orgId: ME.orgId, name: 'bea code' });
  await must(MCP, 'add_project', { name: 'R1 Proj' });
  const mk = async (title, kind, extra = {}) => (await must(MCP, 'add_task', { title, project: 'R1 Proj', ...(kind ? { result_kind: kind } : {}), ...extra })).created;
  const gated = async (label, ref, call) => {
    const r = await call();
    const t = await task(ref);
    const n = await reviewOf(ref);
    check(`${label}: the task is not closed`, t.status !== 'Done' && !t.doneAt, t.status);
    check(`${label}: a review Need went to the owner, from an agent`, !!n && n.to === ME.userId && n.from.word === 'agent' && n.options.map(o => o.id).slice(0, 2).join() === 'accept,send_back', JSON.stringify([n?.to, n?.from?.word]));
    return { r, n };
  };

  // ======== every path to Done for an agent is gated ========
  {
    const t1 = await mk('Code via update_task', 'code');
    const a = await gated('update_task', t1.ref, () => mcpH(kA, 'update_task', { task: t1.ref, status: 'Done', note: 'shipped' }));
    check('update_task: the answer says it went to review', a.r.json?.notClosed === true && /review Need #/.test(a.r.json.message), a.r.text.slice(0, 200));
    const t2 = await mk('Code via log_progress', 'code');
    await gated('log_progress at 100 with Done', t2.ref, () => mcpH(kA, 'log_progress', { task: t2.ref, progress: 100, status: 'Done', note: 'all done' }));
    const t3 = await mk('Code via apply_changes update', 'code');
    await gated('apply_changes update_task', t3.ref, () => mcpH(kA, 'apply_changes', { ops: [{ op: 'update_task', task: t3.ref, status: 'Done' }] }));
    const t4 = await mk('Code via apply_changes complete', 'code');
    await gated('apply_changes complete_task', t4.ref, () => mcpH(kA, 'apply_changes', { ops: [{ op: 'complete_task', task: t4.ref }] }));
    const t5 = await mk('Code via complete_task', 'code');
    await gated('complete_task (code)', t5.ref, () => mcpH(kA, 'complete_task', { task: t5.ref, note: 'did the thing' }));
    check('complete_task: its summary is on the Need', (await reviewOf(t5.ref)).result.changed === 'did the thing');
    await mcpH(kA, 'complete_task', { task: t5.ref, note: 'did the thing again' });
    const all5 = await reviews(t5.ref);
    check('closing again replaces the open review (one open, one replaced)', all5.filter(n => n.status === 'open').length === 1 && all5.filter(n => n.status === 'replaced').length === 1, all5.map(n => n.status).join());
    const t6 = await mk('Code via hand_in', 'code');
    const h = await gated('hand_in', t6.ref, () => mcpH(kA, 'hand_in', { task: t6.ref, changed: 'Rewrote the quote wording', checked: 'Opened it on staging', rating: 'works', where: [{ url: 'https://github.com/acme/app/pull/12', label: 'PR 12' }], left: ['Write the German copy'] }));
    const hn = await reviewOf(t6.ref);
    check('hand_in: the Need carries what changed, how it was checked, the rating, the links and what is left', hn.result.changed === 'Rewrote the quote wording' && hn.result.checked === 'Opened it on staging' && hn.result.rating === 'works' && hn.result.where[0].url.includes('/pull/12') && hn.result.left[0] === 'Write the German copy', JSON.stringify(hn.result));
    check('hand_in: with something left, the third option is offered', hn.options.map(o => o.id).join() === 'accept,send_back,accept_file', hn.options.map(o => o.id).join());
    check('hand_in: the answer says the task stays open', h.r.json?.closed === false && h.r.json?.notClosed === true);
    const t7 = await mk('Data via complete_task', 'data');
    await gated('complete_task (data)', t7.ref, () => mcpH(kA, 'complete_task', { task: t7.ref }));
    const t8 = await mk('Client via complete_task', 'client');
    await gated('complete_task (client)', t8.ref, () => mcpH(kA, 'complete_task', { task: t8.ref }));
    const t9 = await mk('Progress only', 'code');
    await mcpH(kA, 'log_progress', { task: t9.ref, progress: 100 });
    check('log_progress at 100 alone does not close it and asks nothing', (await task(t9.ref)).status !== 'Done' && !(await reviewOf(t9.ref)));
  }

  // ======== link safety, no project, drop and archive ========
  {
    const t = await mk('Bad link', 'code');
    const bad = await mcpH(kA, 'hand_in', { task: t.ref, changed: 'x', where: [{ url: 'javascript:alert(1)', label: 'PR' }] });
    check('hand_in: a javascript: link is refused and nothing is stored or closed', bad.isError && (await task(t.ref)).status !== 'Done' && !(await task(t.ref)).handIn, bad.text.slice(0, 140));
    const np = (await must(MCP, 'add_task', { title: 'No project code task', result_kind: 'code' })).created;
    await mcpH(kA, 'complete_task', { task: np.ref, note: 'done without a project' });
    const npn = await reviewOf(np.ref);
    check('a task with no project is reviewed too (the Need has no project)', (await task(np.ref)).status !== 'Done' && !!npn && npn.to === ME.userId && npn.projectId === '', JSON.stringify([npn?.projectId]));
    const d = await mk('Agent drops code', 'code');
    await mcpH(kA, 'update_task', { task: d.ref, status: 'Dropped' });
    const dn = await reviewOf(d.ref);
    check('an agent dropping code work opens a review instead (the task is not Dropped)', (await task(d.ref)).status !== 'Dropped' && dn?.closing === 'Dropped' && /wants to drop/.test(dn.ask), JSON.stringify([dn?.closing]));
    const ar = await mk('Agent archives code', 'code');
    await mcpH(kA, 'apply_changes', { ops: [{ op: 'archive_task', task: ar.ref }] });
    check('an agent archiving code work opens a review instead (not archived)', !(await task(ar.ref)).archived && (await reviewOf(ar.ref))?.closing === 'archived');
    // Moving between the two closed states is a close too: Dropped -> Done and Done -> Dropped stay gated for an agent.
    const dd = await mk('Dropped then Done', 'code');
    await col('tasks').updateOne({ orgId: ME.orgId, ref: dd.ref }, { $set: { status: 'Dropped' } });
    await mcpH(kA, 'update_task', { task: dd.ref, status: 'Done' });
    check('an agent cannot move code work from Dropped to Done (stays Dropped, review opened)', (await task(dd.ref)).status === 'Dropped' && !!(await reviewOf(dd.ref)), (await task(dd.ref)).status);
    const dx = await mk('Done then Dropped', 'data');
    await col('tasks').updateOne({ orgId: ME.orgId, ref: dx.ref }, { $set: { status: 'Done' } });
    await mcpH(kA, 'apply_changes', { ops: [{ op: 'update_task', task: dx.ref, status: 'Dropped' }] });
    check('an agent cannot move data work from Done to Dropped (stays Done, review opened)', (await task(dx.ref)).status === 'Done' && !!(await reviewOf(dx.ref)), (await task(dx.ref)).status);
    // Born finished is refused: no code, data or client task is created already Done or Dropped by an agent.
    for (const [kind, status] of [['code', 'Done'], ['client', 'Dropped']]) {
      const r = await mcpH(kA, 'add_task', { title: `Born ${status}`, project: 'R1 Proj', result_kind: kind, status });
      check(`an agent cannot add ${kind} work as ${status}`, r.isError && !(await col('tasks').findOne({ orgId: ME.orgId, title: `Born ${status}` })), r.text.slice(0, 160));
    }
    const bo = await mcpH(kA, 'apply_changes', { ops: [{ op: 'create_task', title: 'Born Done op', project: 'R1 Proj', result_kind: 'code', status: 'Done' }] });
    check('an agent cannot create finished code work through apply_changes either', !(await col('tasks').findOne({ orgId: ME.orgId, title: 'Born Done op' })), bo.text.slice(0, 160));
    const bp = await mcpH(kA, 'add_task', { title: 'Born Done report', project: 'R1 Proj', result_kind: 'report', status: 'Done' });
    check('...while report work may be added as Done', !bp.isError && (await col('tasks').findOne({ orgId: ME.orgId, title: 'Born Done report' }))?.status === 'Done', bp.text.slice(0, 160));
    const rp = await mk('Agent drops a report');
    await mcpH(kA, 'update_task', { task: rp.ref, status: 'Dropped' });
    check('an agent dropping report work drops it', (await task(rp.ref)).status === 'Dropped');
  }

  // ======== check, report and no kind finish by themselves ========
  {
    for (const [label, kind] of [['check', 'check'], ['report', 'report'], ['no kind', null]]) {
      const t = await mk(`Plain ${label}`, kind);
      const r = await mcpH(kA, 'complete_task', { task: t.ref, note: 'finished' });
      check(`${label}: an agent's complete_task finishes it, no review`, (await task(t.ref)).status === 'Done' && !(await reviewOf(t.ref)) && !r.json?.notClosed, r.text.slice(0, 160));
    }
    const th = await mk('Report via hand_in', 'report');
    const r = await mcpH(kA, 'hand_in', { task: th.ref, changed: 'Wrote the report', checked: 'Read it twice', rating: 'works' });
    check('report: hand_in finishes it and stores the result', r.json?.closed === true && (await task(th.ref)).status === 'Done' && (await task(th.ref)).handIn.changed === 'Wrote the report', r.text.slice(0, 160));
  }

  // ======== the kind cannot be loosened by an agent ========
  {
    const t = await mk('Strict code', 'code');
    const loose = await mcpH(kA, 'update_task', { task: t.ref, result_kind: 'report', status: 'Done' });
    check('an agent cannot set a code task to report (not even in the same call as Done)', loose.isError && /loosened by a person/.test(loose.text) && (await task(t.ref)).status !== 'Done' && (await task(t.ref)).resultKind === 'code', loose.text.slice(0, 160));
    const n = await mk('Kind set late');
    await mcpH(kA, 'update_task', { task: n.ref, result_kind: 'code' });
    await mcpH(kA, 'complete_task', { task: n.ref });
    check('an agent may make a task stricter: a task with no kind set to code goes to review', (await task(n.ref)).status !== 'Done' && !!(await reviewOf(n.ref)));
  }

  // ======== dispatched: one alert, not two ========
  const claim = () => ({ state: 'running', markedAt: new Date(), markedBy: 'user', markedByUserId: ME.userId, markedByOrgId: ME.orgId, sessionId: 'sess-r1', claimedAt: new Date() });
  // (The tests above made more than ten reviews from one agent in this hour: age them so the hourly alert limit does not hide the one under test.)
  await col('needs').updateMany({ kind: 'review' }, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
  const dCode = await mk('Dispatched code', 'code');
  const dRep = await mk('Dispatched report', null);
  for (const t of [dCode, dRep]) await col('tasks').updateOne({ orgId: ME.orgId, ref: t.ref }, { $set: { claude: claim() } });
  await mcpH(kA, 'complete_task', { task: dCode.ref, note: 'ready' });
  await mcpH(kA, 'complete_task', { task: dRep.ref, note: 'ready' });
  {
    const dc = await task(dCode.ref);
    const dr = await task(dRep.ref);
    const q = async t => col('alertQueue').find({ taskId: t._id }).toArray();
    const qc = await q(dc);
    const qr = await q(dr);
    check('dispatched code: the run ends as finished, "sent to review", and the task stays open', dc.claude.state === 'finished' && dc.claude.note === 'sent to review' && dc.status !== 'Done', JSON.stringify(dc.claude));
    check('dispatched code: the review replaces "Claude finished" and sends no phone alert at all (H12: a review waits on Today and the digest)', qc.filter(x => x.kind === 'claude_finished').length === 0 && qc.filter(x => x.kind === 'need').length === 0 && (await col('needs').countDocuments({ taskId: dc._id, kind: 'review', status: 'open' })) === 1, JSON.stringify(qc.map(x => x.kind)));
    check('dispatched with no kind: finishes as today, with its "Claude finished" alert and no review', dr.status === 'Done' && qr.some(x => x.kind === 'claude_finished') && !qr.some(x => x.kind === 'need'), JSON.stringify(qr.map(x => x.kind)));
  }

  // ======== in the app: Accept, Send back, Accept and file what is left ========
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await login(p, { next: '/today' });
    const card = ref => p.locator(`[data-variant=desk] [data-section="needs-you"] [data-need="${ref}"]`);
    const decide = async (taskRef, option, text) => {
      await p.goto(`${B}/today`);
      const n = await reviewOf(taskRef);
      const c = card(n.ref);
      await c.waitFor({ timeout: 20000 });
      if (text) await c.locator('[data-need-text]').fill(text);
      await c.locator(`[data-need-option="${option}"]`).click();
      await c.waitFor({ state: 'detached', timeout: 20000 });
      return n;
    };

    // the card shows what was handed in
    const withResult = await mk('Review card shows the result', 'code');
    await mcpH(kA, 'hand_in', { task: withResult.ref, changed: 'Moved the button', checked: 'Clicked it twice', rating: 'awkward', where: [{ url: 'https://example.com/preview/1', label: 'Preview' }], left: ['Dark mode'] });
    await p.goto(`${B}/today`);
    const wc = card((await reviewOf(withResult.ref)).ref);
    await wc.waitFor({ timeout: 20000 });
    const txt = await wc.innerText();
    check('review card: it shows what changed, how it was checked, the verdict, the link and what is left', /Moved the button/.test(txt) && /Clicked it twice/.test(txt) && /awkward/.test(txt) && /Preview/.test(txt) && /Dark mode/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 300));
    check('review card: Send back needs a line (the button waits for one)', await wc.locator('[data-need-option="send_back"]').isDisabled());
    check('review card: three buttons when something is left', (await wc.locator('[data-need-option]').count()) === 3);

    // Send back: the line comes first in the next brief; Accept after it records the outcome
    const sb = await mk('Send me back', 'code');
    await mcpH(kA, 'hand_in', { task: sb.ref, changed: 'First try' });
    await decide(sb.ref, 'send_back', 'Use the short wording, not the long one.');
    const after = await task(sb.ref);
    check('send back: the task is In Progress again with the owner\'s line and a count', after.status === 'In Progress' && after.sentBack?.line === 'Use the short wording, not the long one.' && after.sentBack.by === ME.userId && after.review?.sentBack === 1, JSON.stringify([after.status, after.sentBack, after.review]));
    const gt = await must(kA, 'get_task', { task: sb.ref });
    check('send back: the line is the first thing get_task says', Object.keys(gt)[0] === 'sentBack' && gt.sentBack.line.includes('short wording'), Object.keys(gt).slice(0, 3).join());
    const sw = await must(kA, 'start_work', { project: 'R1 Proj' });
    const row = sw.openTasks.tasks.find(x => x.ref === sb.ref);
    check('send back: the line is first in start_work\'s brief of that task', row && Object.keys(row)[0] === 'sentBack' && row.sentBack.line.includes('short wording'), JSON.stringify(row)?.slice(0, 200));
    const nr = await col('needs').findOne({ taskRef: sb.ref, kind: 'review', status: 'answered' });
    check('send back: the Need is answered "send_back" with the line, in the app', nr.answer.option === 'send_back' && nr.answer.text.includes('short wording') && nr.answer.via === 'app');
    await mcpH(kA, 'hand_in', { task: sb.ref, changed: 'Second try, short wording' });
    check('handing in again: a new review, and the old line is cleared', !!(await reviewOf(sb.ref)) && !(await task(sb.ref)).sentBack);
    await decide(sb.ref, 'accept');
    const acc = await task(sb.ref);
    check('accept after a send-back: Done, recorded as accepted after a send-back', acc.status === 'Done' && acc.review.outcome === 'accepted_after_send_back' && acc.review.sentBack === 1 && acc.doneBy.kind === 'user', JSON.stringify([acc.status, acc.review, acc.doneBy]));

    const first = await mk('Accepted first time', 'data');
    await mcpH(kA, 'hand_in', { task: first.ref, changed: 'Imported the rows', rating: 'works' });
    await decide(first.ref, 'accept');
    const f = await task(first.ref);
    check('accept first time: Done, recorded as accepted first time', f.status === 'Done' && f.review.outcome === 'accepted_first_time' && (f.review.sentBack ?? 0) === 0, JSON.stringify([f.status, f.review]));

    // Accept and file what is left
    const fl = await mk('File what is left', 'client');
    await mcpH(kA, 'hand_in', { task: fl.ref, changed: 'Sent the proposal', left: ['Chase the signature', 'Update the invoice'] });
    const flProj = (await task(fl.ref)).projectId;
    const before = await col('tasks').countDocuments({ orgId: ME.orgId });
    const fn = await decide(fl.ref, 'accept_file');
    const filed = await col('needs').findOne({ _id: fn._id });
    const made = await col('tasks').find({ orgId: ME.orgId, title: { $in: ['Chase the signature', 'Update the invoice'] } }).toArray();
    check('accept and file: the task is Done and one task per left line is made in its project', (await task(fl.ref)).status === 'Done' && made.length === 2 && (await col('tasks').countDocuments({ orgId: ME.orgId })) === before + 2 && made.every(m => m.projectId === flProj), JSON.stringify(made.map(m => m.title)));
    check('accept and file: the Need records the numbers it filed', filed.filed?.length === 2 && made.every(m => filed.filed.includes(m.ref)), JSON.stringify(filed.filed));

    // Stale evidence: after a send-back, a close with no new hand_in does not reuse the old one
    const st = await mk('Stale evidence', 'code');
    await mcpH(kA, 'hand_in', { task: st.ref, changed: 'OLD evidence', checked: 'old check' });
    await decide(st.ref, 'send_back', 'Redo the footer.');
    check('send back: the old hand-in is cleared from the task', !(await task(st.ref)).handIn);
    await mcpH(kA, 'complete_task', { task: st.ref, note: 'quick fix' });
    const stn = await reviewOf(st.ref);
    check('a close without a fresh hand_in shows only the new note, not the old evidence', stn.result.changed === 'quick fix' && stn.result.checked === '' && !JSON.stringify(stn.result).includes('OLD'), JSON.stringify(stn.result));
    await decide(st.ref, 'accept');

    // What the agent wrote is labelled for everyone else
    const lb = await mk('Labelled hand-in', 'code');
    await mcpH(kA, 'hand_in', { task: lb.ref, changed: 'Handed in by the agent', left: ['Filed by the agent line'] });
    const seenByBea = await must(kBea, 'get_task', { task: lb.ref });
    check('get_task: a teammate sees the hand-in labelled writtenBy', !!seenByBea.handIn?.writtenBy && /Claude Code/.test(seenByBea.handIn.writtenBy), JSON.stringify(seenByBea.handIn));
    await decide(lb.ref, 'accept_file');
    const filedLine = await col('tasks').findOne({ orgId: ME.orgId, title: 'Filed by the agent line' });
    const filedSeen = await must(kBea, 'get_task', { task: filedLine.ref });
    check('accept and file: the filed title is labelled as the agent\'s text, not the owner\'s', !!filedSeen.titleWrittenBy && /Claude Code/.test(filedSeen.titleWrittenBy), JSON.stringify([filedSeen.titleWrittenBy]));

    // A recurring task keeps its kind in the next occurrence
    const rc = await mk('Recurring code', 'code', { due: 'today', recurrence: { freq: 'daily', interval: 1 } });
    await mcpH(kA, 'hand_in', { task: rc.ref, changed: 'Did today\'s' });
    await decide(rc.ref, 'accept');
    const rk = await mk('Recurring check', 'check', { due: 'today', recurrence: { freq: 'daily', interval: 1 } });
    await mcpH(kA, 'complete_task', { task: rk.ref });
    // The next copies come on the due date (today), from the alerts cron (docs/HANDOVER.md "Recurring tasks").
    await fetch(`${B}/api/cron/alerts`, { headers: { authorization: `Bearer ${CRON}` } });
    const rcd = await task(rc.ref);
    const nxt = rcd.nextRef ? await task(rcd.nextRef) : null;
    check('recurring: the next occurrence keeps the result kind', !!nxt && nxt.resultKind === 'code', JSON.stringify([rcd.nextRef, nxt?.resultKind]));
    const rkd = await task(rk.ref);
    check('recurring: a check task finishes and its next keeps "check"', rkd.status === 'Done' && (await task(rkd.nextRef))?.resultKind === 'check');

    // A dispatched task that is sent back goes into the queue again
    await p.goto(`${B}/today`);
    await decide(dCode.ref, 'send_back', 'Add the missing test.');
    const dq = await task(dCode.ref);
    check('send back (dispatched): the task is queued for Claude again', dq.claude?.state === 'queued' && dq.status === 'In Progress', JSON.stringify(dq.claude));
    check('send back (dispatched): the line is first in its brief', Object.keys(await must(kA, 'get_task', { task: dCode.ref }))[0] === 'sentBack');

    // A person still finishes directly, and a waiting review has nothing left to ask
    const pt = await mk('Person closes it', 'code');
    await mcpH(kA, 'complete_task', { task: pt.ref });
    check('person: before they act, the agent\'s close is waiting as a review', !!(await reviewOf(pt.ref)));
    await p.goto(`${B}/projects/${encodeURIComponent((await col('projects').findOne({ name: 'R1 Proj' }))._id)}?tab=tasks`);
    const rowP = p.locator('div.group', { hasText: 'Person closes it' }).first();
    await rowP.waitFor({ timeout: 20000 });
    await rowP.locator('button[title="Mark done"]').first().click();
    let tp;
    for (let i = 0; i < 40; i++) { tp = await task(pt.ref); if (tp.status === 'Done') break; await sleep(300); }
    check('person: a person closing a code task finishes it directly (Done, by them)', tp.status === 'Done' && tp.doneBy.kind === 'user', JSON.stringify([tp.status, tp.doneBy]));
    const pr = await reviews(pt.ref);
    check('person: the waiting review is withdrawn (nothing left to ask)', pr.length === 1 && pr[0].status === 'withdrawn' && pr[0].withdrawnReason === 'done', JSON.stringify(pr.map(x => [x.status, x.withdrawnReason])));
    check('no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} catch (e) {
  check('flow-r1 ran to the end', false, String(e?.stack ?? e));
}
await browser.close();
finish();
