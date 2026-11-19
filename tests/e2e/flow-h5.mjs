// H5 end_work and list_sessions (docs/flows/agent-system.md 5.5, 16.5, 16.6): the State is saved first (made when missing),
// a session's slots, task and row are freed, one friction line goes into the feed, and an optional capped handover note
// is shown first to the next session of the same person (any tool), once. Seed profile: none.
import { ME, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'H5 Alpha';
const Q = 'H5 Private';
const hdr = sess => ({ 'X-Work-OS-Session': sess });
const notes = () => rawDb.collection('notes');
const noteOf = id => notes().findOne({ _id: id });
const feed = type => rawDb.collection('activity').find({ type }).sort({ at: 1 }).toArray();
const pid = async name => (await rawDb.collection('projects').findOne({ name }))._id;
try {
  const T = await makeUser({ email: 'h5-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' }); // before the first call: member names are cached for a minute
  const X = await makeUser({ email: 'h5-xavier@example.test', name: 'Xavier', orgName: 'H5 Other Org' });
  const cc = await mkKey({ agent: 'claude-code', name: 'H5 cc' });
  const chat = await mkKey({ agent: 'claude', name: 'H5 chat' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess cc' });
  const kX = await mkKey({ agent: 'claude-code', userId: X.userId, orgId: X.orgId, name: 'Xavier cc' });
  await must(cc, 'add_project', { name: P, visibility: 'org' });
  await must(cc, 'add_project', { name: Q, visibility: 'private' });
  const start = (key, sess, extra = {}) => must(key, 'start_work', { project: P, session: sess, ...extra }, hdr(sess));
  const state = () => must(cc, 'get_state', { project: P });

  // ── 1. State first: none yet and no set_now → refused, nothing written
  await start(cc, 'h5s1', { label: 'H5 builder A', machine: 'h5box', branch: 'builder-a' });
  const noState = await mcpH(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'builder-a' }], friction: 'none', session: 'h5s1' }, hdr('h5s1'));
  check('H5 state: no State and no set_now is refused with the "no State yet" text', noState.isError && /no State yet/.test(noState.text) && /set_now/.test(noState.text), noState.text.slice(0, 200));
  check('H5 state: the refusal wrote nothing (no State, no feed row, row not ended)', (await rawDb.collection('states').countDocuments({})) === 0 && (await feed('session_ended')).length === 0 && !(await rawDb.collection('presence').findOne({ session: 'h5s1' })).endedAt);
  const made = await must(cc, 'end_work', { project: P, base_version: 0, state: [{ op: 'set_now', text: 'H5 goal: hand work over' }, { op: 'add_next', text: 'H5 first next step, long enough to matter' }, { op: 'add_next', text: 'H5 second next step, also long enough' }], friction: 'none', session: 'h5s1' }, hdr('h5s1'));
  check('H5 state: with set_now and add_next the State is made and the answer is short', made.ended === true && !('saved' in made) && /^Saved v\d+\. Next 2, Later 0\./.test(made.message) && !('state' in made) && !('handover' in made) && JSON.stringify(made).length < 400, JSON.stringify(made));
  const feedRows = await feed('session_ended');
  check('H5 feed: one session_ended row with the friction line, on the State of the project', feedRows.length === 1 && feedRows[0].note === 'none' && feedRows[0].subject.kind === 'state' && feedRows[0].subject.id === (await pid(P)), JSON.stringify(feedRows));

  // ── 2. A stale base_version is a conflict: no note, no feed row, the slot is still held
  await start(cc, 'h5s2', { label: 'H5 builder S', machine: 'h5box', branch: 'builder-s' });
  const acq = await must(cc, 'slot', { action: 'acquire', machine: 'h5box', session: 'h5s2' }, hdr('h5s2'));
  const rowsBefore = (await feed('session_ended')).length;
  const stale = await must(cc, 'end_work', { project: P, base_version: 0, state: [{ op: 'set_now', text: 'stale goal' }], friction: 'stale', handover: { step: 'should not be written' }, session: 'h5s2' }, hdr('h5s2'));
  const slotDoc = await rawDb.collection('slots').find({}).toArray();
  check('H5 conflict: a stale base_version answers ended:false with the current State', acq.acquired && stale.ended === false && stale.conflict === true && stale.version >= 1 && stale.state?.now?.text === 'H5 goal: hand work over', JSON.stringify(stale).slice(0, 300));
  check('H5 conflict: no handover note, no feed row, row not ended, slot still held', (await notes().countDocuments({ handover: { $exists: true } })) === 0 && (await feed('session_ended')).length === rowsBefore && !(await rawDb.collection('presence').findOne({ session: 'h5s2' })).endedAt && slotDoc.some(d => d.holds.some(h => h.session === 'h5s2')), JSON.stringify(slotDoc.map(d => d.holds)));

  // ── 3. A handover: slot and task freed, Need left open and listed, auto Where / Task / Waiting
  await start(cc, 'h5s3', { label: 'H5 builder B', machine: 'h5box', branch: 'builder-b' });
  const task = (await must(cc, 'add_task', { title: 'H5 the task in hand', project: P }, hdr('h5s3'))).created;
  await must(cc, 'set_doing', { task: task.ref, session: 'h5s3' }, hdr('h5s3'));
  await must(cc, 'log_progress', { task: task.ref, progress: 20, note: 'started' }, hdr('h5s3'));
  const holds = async sess => (await rawDb.collection('slots').find({}).toArray()).some(d => d.holds.some(h => h.session === sess));
  await must(cc, 'slot', { action: 'acquire', machine: 'h5box', session: 'h5s3' }, hdr('h5s3'));
  const need = await must(cc, 'ask', { project: P, to: 'me', kind: 'decide', ask: 'H5 ship tonight or Monday?', options: [{ label: 'tonight', means: 'ship now' }, { label: 'Monday', means: 'wait' }], session: 'h5s3' }, hdr('h5s3'));
  const wBefore = (await rawDb.collection('presence').findOne({ session: 'h5s3' })).writesSinceSave;
  const handoverIn = { step: 'flow-h5 cases 1-8 pass; next: write the rest', in_flight: ['Sonnet agent "hook tests" on builder-b'], tried: ['marking pick-up on read_note: dropped'], rules: ['Om 19 Nov: questions go to me in chat'], check: ['tests/e2e/run.sh flow-h5'] };
  const ended = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'builder-b', head: '4c1e9a0' }], friction: 'save answer still long', handover: handoverIn, session: 'h5s3' }, hdr('h5s3'));
  const hid = ended.handover?.id;
  check('H5 handover: the answer has the id, title, url, for, the pick-up line and the chat line', !!hid && ended.handover.title === 'Handover: H5 builder B' && ended.handover.for === 'me' && ended.handover.pickUp === `/transfer pick up ${hid}` && ended.handover.chat === `Continue from Work OS handover ${hid}` && ended.handover.url.endsWith(`/notes/${hid}`), JSON.stringify(ended));
  const note = await noteOf(hid);
  check('H5 handover: a project note with the handover field, whole body with headings and the automatic Where, Task and Waiting', note.title === 'Handover: H5 builder B' && note.projectId === (await pid(P)) && note.handover.by === ME.userId && note.handover.for === ME.userId && ['## Next step', '## Where', 'h5box, branch builder-b', 'head 4c1e9a0', '## Task', `#${task.ref} H5 the task in hand`, '## Waiting', `Need #${need.need?.ref ?? need.ref}`, '## In flight', '## Tried', '## Rules', '## Check'].every(x => note.body.includes(x)), note.body);
  check('H5 leftovers: the slot and the task are released, the open Need is listed and still open', ended.released?.slots?.length === 1 && ended.released.doing === `#${task.ref}` && ended.leftovers?.some(l => /^Need #\d+ to me \(decide\)/.test(l)) && ended.leftovers?.some(l => l.includes(`Task #${task.ref} is still`)) && !(await holds('h5s3')) && (await rawDb.collection('needs').countDocuments({ status: 'open' })) === 1, JSON.stringify(ended));
  const row3 = await rawDb.collection('presence').findOne({ session: 'h5s3' });
  check('H5 leftovers: the row is ended with no task, and the save count restarts', !!row3.endedAt && !row3.doing && wBefore > 0 && row3.writesSinceSave === 0, JSON.stringify({ wBefore, row3 }));
  const f2 = (await feed('session_ended')).find(r => r.note.startsWith('save answer still long'));
  check('H5 feed: the friction row names the handover', f2 && f2.note === `save answer still long · handover ${hid}`, JSON.stringify(f2));

  // ── 4. Caps, copies of the State, a person who cannot read the project: refused, nothing written
  const v = (await state()).version;
  const nrows = (await feed('session_ended')).length;
  const refuse = async (label, handover, re) => {
    const r = await mcpH(cc, 'end_work', { project: P, state: [{ op: 'add_later', text: `H5 later from ${label}` }], friction: 'x', handover, session: 'h5s2' }, hdr('h5s2'));
    check(`H5 refused: ${label}`, r.isError && re.test(r.text), r.text.slice(0, 200));
  };
  await refuse('a step of 601 characters', { step: 'x'.repeat(601) }, /600|too_big|characters/i);
  await refuse('7 items in a list', { step: 's', tried: Array.from({ length: 7 }, (_, i) => `try ${i}`) }, /6|too_big|items/i);
  await refuse('an item of 301 characters', { step: 's', check: ['y'.repeat(301)] }, /300|too_big|characters/i);
  await refuse('more than 3,000 characters in all', { step: 's'.repeat(600), in_flight: Array(6).fill('a'.repeat(250)), tried: Array(6).fill('b'.repeat(250)) }, /3,000/);
  await refuse('2 Next lines copied into it', { step: 'Do: h5 first next step, long enough to matter, then h5 second next step, also long enough' }, /in the State already/);
  await refuse('an unknown field', { step: 's', extra: 'no' }, /unrecognized|Unrecognized/i);
  await refuse('a person who is not a member', { step: 's', for: 'nobody-here@example.test' }, /./);
  const priv = await mcpH(cc, 'end_work', { project: Q, state: [{ op: 'set_now', text: 'private goal' }], base_version: 0, friction: 'x', handover: { step: 's', for: 'Tess' }, session: 'h5s2' }, hdr('h5s2'));
  check('H5 refused: a handover for someone who cannot read the project', priv.isError && /cannot see this project/.test(priv.text), priv.text.slice(0, 200));
  check('H5 refused: nothing was written by any refusal (State, feed, notes, row, slot)', (await state()).version === v && (await feed('session_ended')).length === nrows && (await notes().countDocuments({ handover: { $exists: true } })) === 1 && !(await rawDb.collection('presence').findOne({ session: 'h5s2' })).endedAt && (await holds('h5s2')) && (await rawDb.collection('states').countDocuments({ _id: await pid(Q) })) === 0);
  const one = await must(cc, 'end_work', { project: P, state: [{ op: 'add_later', text: 'H5 one copy is fine' }], friction: 'one line', handover: { step: 'Mentions h5 first next step, long enough to matter only once', title: 'Handover: one copy' }, session: 'h5s2' }, hdr('h5s2'));
  check('H5 refused: one copied line is allowed (the limit is 2)', !!one.handover?.id, JSON.stringify(one));
  const oneNote = await noteOf(one.handover.id);
  check('H5 default: a title may be given', oneNote.title === 'Handover: one copy' && oneNote.handover.for === ME.userId);
  await notes().deleteOne({ _id: one.handover.id }); // keep the later pick-up cases about the first handover

  // ── 5. Pick-up across tools: a claude.ai chat key (no session id) takes it first, once
  const chatStart = await must(chat, 'start_work', { project: P });
  const hv = chatStart.handover;
  check('H5 pick up: a chat start_work shows the handover with its id, from, and the body', Array.isArray(hv) && hv.some(h => h.id === hid && h.from === 'H5 builder B' && h.markdown.includes('## Next step') && !('writtenBy' in h)), JSON.stringify(chatStart.handover));
  const after = await noteOf(hid);
  check('H5 pick up: the note says who picked it up, with a "Picked up by" line', after.handover.pickedUp?.by === ME.userId && after.handover.pickedUp.session && after.body.includes('Picked up by'), JSON.stringify(after.handover.pickedUp));
  const chatSid = chatStart.session;
  const fresh1 = await start(cc, 'h5fresh1');
  check('H5 pick up: another fresh session is not shown a handover that was picked up', !fresh1.handover || !fresh1.handover.some(h => h.id === hid), JSON.stringify(fresh1.handover));
  const again = await must(chat, 'start_work', { project: P, session: chatSid });
  check('H5 pick up: the same session again (after compaction) is shown it again', again.handover?.some(h => h.id === hid), JSON.stringify(again.handover));
  const own = await start(cc, 'h5s3');
  check('H5 pick up: the writing session\'s own re-call is not shown it', !own.handover?.some(h => h.id === hid) && !(await rawDb.collection('presence').findOne({ session: 'h5s3' })).endedAt, JSON.stringify(own.handover));
  const pending = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'main' }], friction: 'for a builder', handover: { step: 'waiting for a session that takes no parent', title: 'Handover: pending' }, session: 'h5s2' }, hdr('h5s2'));
  const builder = await start(cc, 'h5builder1', { parent: 'h5s2' });
  check('H5 pick up: a builder (with a parent) is never shown a handover, and does not take it', !builder.handover && !(await noteOf(pending.handover.id)).handover.pickedUp, JSON.stringify(builder.handover));

  // ── 6. A rewrite keeps the id, replaces the whole body, clears pickedUp
  const rew = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'builder-b' }], friction: 'again', handover: { step: 'second version of the step' }, session: 'h5s3' }, hdr('h5s3'));
  const rewNote = await noteOf(hid);
  check('H5 rewrite: same id, body replaced whole, pickedUp cleared, one note for the writer and title', rew.handover?.id === hid && rewNote.body.includes('second version of the step') && !rewNote.body.includes('flow-h5 cases 1-8') && !rewNote.body.includes('Picked up by') && !rewNote.handover.pickedUp && (await notes().countDocuments({ title: 'Handover: H5 builder B' })) === 1, rewNote.body);
  const chatNo = await must(chat, 'start_work', { project: P, session: chatSid });
  check('H5 rewrite: the session that had picked up the old one is not shown the new one (not fresh)', !chatNo.handover?.some(h => h.id === hid), JSON.stringify(chatNo.handover));

  // ── 7. The picking session's end_work without a handover archives what it picked up
  const f2s = await start(cc, 'h5fresh2');
  check('H5 pick up: a fresh session is shown the rewritten handover', f2s.handover?.some(h => h.id === hid && h.markdown.includes('second version')), JSON.stringify(f2s.handover));
  const bye = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box2', branch: 'main' }], friction: 'none', session: 'h5fresh2' }, hdr('h5fresh2'));
  check('H5 lifecycle: end_work without a handover archives the handover this session picked up', bye.archivedHandovers?.includes(hid) && (await noteOf(hid)).archived === true && !bye.handover, JSON.stringify(bye));
  const after2 = await start(cc, 'h5fresh3');
  check('H5 lifecycle: an archived handover is not shown to a later fresh session', !after2.handover?.some(h => h.id === hid), JSON.stringify(after2.handover));
  const rew2 = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'builder-b' }], friction: 'rewrite unarchives', handover: { step: 'third version' }, session: 'h5s3' }, hdr('h5s3'));
  check('H5 lifecycle: a rewrite unarchives it', rew2.handover?.id === hid && (await noteOf(hid)).archived === false);

  // ── 7b. A teammate's edit of my handover is labelled in my next brief (any project reader can edit a note)
  const edited = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'main' }], friction: 'edit probe', handover: { step: 'my own handover, before an edit', title: 'Handover: edit probe' }, session: 'h5s2' }, hdr('h5s2'));
  const own1 = await start(cc, 'h5fresh5');
  check('H5 label: my own unedited handover carries no writtenBy', own1.handover?.some(h => h.id === edited.handover.id && !('writtenBy' in h)), JSON.stringify(own1.handover?.map(h => [h.id, h.writtenBy])));
  await rawDb.collection('notes').updateOne({ _id: edited.handover.id }, { $unset: { 'handover.pickedUp': '' } });
  await must(kT, 'write_note', { note_id: edited.handover.id, append: 'Tess added a line here' });
  const own2 = await start(cc, 'h5fresh6');
  check('H5 label: after a teammate edited it, my next brief marks the handover writtenBy that teammate', own2.handover?.some(h => h.id === edited.handover.id && /Tess/.test(h.writtenBy ?? '') && h.markdown.includes('Tess added a line here')), JSON.stringify(own2.handover?.map(h => [h.id, h.writtenBy])));

  // ── 8. For another member: Om's next session does not get it, Tess's does, marked writtenBy
  const forT = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'main' }], friction: 'for tess', handover: { step: 'Tess takes the review from here', for: 'Tess', title: 'Handover: for Tess' }, session: 'h5s2' }, hdr('h5s2'));
  check('H5 for: the answer says who it is for', forT.handover?.for === 'Tess', JSON.stringify(forT));
  const omNext = await start(cc, 'h5fresh4');
  check('H5 for: Om\'s next fresh session does not get Tess\'s handover', !omNext.handover?.some(h => h.id === forT.handover.id), JSON.stringify(omNext.handover));
  const tNext = await start(kT, 'h5tess1');
  check('H5 for: Tess\'s fresh session gets it, marked as written by Om', tNext.handover?.some(h => h.id === forT.handover.id && h.writtenBy), JSON.stringify(tNext.handover));
  const anyone = await must(cc, 'end_work', { project: P, state: [{ op: 'set_where', machine: 'h5box', branch: 'main' }], friction: 'for anyone', handover: { step: 'Whoever is next', for: 'anyone', title: 'Handover: for anyone' }, session: 'h5s2' }, hdr('h5s2'));
  const tAny = await start(kT, 'h5tess2');
  check('H5 for: "anyone" reaches a teammate\'s fresh session', tAny.handover?.some(h => h.id === anyone.handover.id), JSON.stringify(tAny.handover));

  // ── 9. list_sessions: gone after end_work, working after a new start_work; nobody else's sessions
  const ls = async (key, args = {}) => must(key, 'list_sessions', args);
  const listed = await ls(cc, { project: P, include_off: true });
  const s3 = listed.sessions.find(x => x.session === 'h5s3');
  check('H5 list_sessions: after end_work the session is off (listed only with include_off)', s3?.state === 'off' && !(await ls(cc, { project: P })).sessions.some(x => x.session === 'h5s3'), JSON.stringify(s3));
  await start(cc, 'h5s3');
  const s3b = (await ls(cc, { project: P })).sessions.find(x => x.session === 'h5s3');
  // Lanes step 2: the chat session that picked up the handover (case 5) was given h5s3's open Need, so h5s3 is working, not waiting.
  const openNeed = await rawDb.collection('needs').findOne({ status: 'open' });
  check('H5 list_sessions: live again after a new start_work (working: its open Need went with the handover to the session that picked it up)', s3b?.state === 'working' && s3b.person === 'me' && s3b.project === P && s3b.branch === 'builder-b' && openNeed?.from.session === chatSid, JSON.stringify([s3b, openNeed?.from]));
  const tList = await ls(kT, {});
  check('H5 list_sessions: a teammate sees the sessions on the shared project without their session ids', tList.sessions.some(x => x.project === P) && tList.sessions.every(x => !('session' in x) || x.person === 'me'), JSON.stringify(tList).slice(0, 300));
  await must(kX, 'add_project', { name: 'H5 Other Project' });
  await must(kX, 'start_work', { project: 'H5 Other Project', label: 'h5-xavier-canary', session: 'h5x1' }, hdr('h5x1'));
  const omAll = JSON.stringify(await ls(cc, { include_off: true }));
  const tAll = JSON.stringify(await ls(kT, { include_off: true }));
  const xAll = JSON.stringify(await ls(kX, { include_off: true }));
  check('H5 list_sessions: another organization\'s sessions are never listed', !omAll.includes('h5-xavier-canary') && !tAll.includes('h5-xavier-canary') && !omAll.includes('H5 Other Project'), omAll.slice(0, 200));
  check('H5 list_sessions: the other organization sees none of ours', xAll.includes('h5-xavier-canary') && !xAll.includes('H5 builder') && !xAll.includes(P), xAll.slice(0, 200));
  await must(cc, 'start_work', { project: Q, label: 'h5-private-canary', session: 'h5q1' }, hdr('h5q1'));
  const tNoQ = JSON.stringify(await ls(kT, { include_off: true }));
  check('H5 list_sessions: a teammate does not see a session on a private project', !tNoQ.includes('h5-private-canary') && !tNoQ.includes(Q));
} catch (e) {
  check('flow-h5 (error)', false, e?.stack || String(e));
}
await finish();
