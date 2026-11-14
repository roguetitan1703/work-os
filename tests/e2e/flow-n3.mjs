// Flow N3 (docs/flows/plan-1-3.md slice 4 meets slice 1): Needs inside start_work, the forYou line and State.
//   - start_work lists the Needs the caller asked that were answered (once), then the open ones addressed to the caller;
//   - the forYou line says "your Need #N was answered" to the asker's session and "1 Need for you" to the addressee, ids only;
//   - a session finds only its own answers; a caller with no session id finds those of the same key, never another key's;
//   - State's Next lines get waitsOn from the open Need on their task;
//   - the 5-open limit holds when asks race (eight at once: five land, three are refused).
// Seed profile: none.
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const answer = async need => {
  const doc = await rawDb.collection('needs').findOne({ _id: need.id });
  const now = new Date();
  await rawDb.collection('needs').updateOne({ _id: need.id }, { $set: { status: 'answered', answer: { option: doc.options[0].id, by: doc.to, via: 'app', at: now }, answeredAt: now, closedAt: now, waitedMs: 1000 } });
};
const H = id => ({ 'x-work-os-session': id });

try {
  const bea = await makeUser({ email: 'bea@example.test', name: 'Bea', orgId: ME.orgId, role: 'member' });
  const cara = await makeUser({ email: 'cara@example.test', name: 'Cara', orgId: ME.orgId, role: 'member' });
  const kBea = await mkKey({ agent: 'claude-code', userId: bea.userId, orgId: ME.orgId, name: 'bea code' });
  const kA = await mkKey({ agent: 'claude-code', name: 'om code A' });
  const kB = await mkKey({ agent: 'claude-code', name: 'om code B' });
  await must(MCP, 'add_project', { name: 'N3 Proj' });
  const task = (await must(MCP, 'add_task', { title: 'Cut the release', project: 'N3 Proj' })).created;
  const projId = (await rawDb.collection('projects').findOne({ name: 'N3 Proj' }))._id;

  // ======== the limit holds under a race ========
  {
    const asks = await Promise.all(Array.from({ length: 6 }, (_, i) => mcpH(kA, 'ask', { project: 'N3 Proj', to: 'Cara', kind: 'do', ask: `Race ${i}` })));
    const ok = asks.filter(r => !r.isError).length;
    const open = await rawDb.collection('needs').countDocuments({ 'to': cara.userId, status: 'open' });
    check('limit: six asks at once to one person: exactly five land', ok === 5 && open === 5, `ok ${ok}, open ${open}`);
    check('limit: the refusals say why', asks.filter(r => r.isError).every(r => /5 open Needs/.test(r.text)), asks.filter(r => r.isError)[0]?.text.slice(0, 150));
  }

  // ======== start_work: answers first, then what is open for the caller ========
  const sA1 = (await must(kA, 'start_work', { project: 'N3 Proj', label: 'A one' }, H('sess-a-1'))).session;
  const sA2 = (await must(kA, 'start_work', { project: 'N3 Proj', label: 'A two' }, H('sess-a-2'))).session;
  const sBea = (await must(kBea, 'start_work', { project: 'N3 Proj' }, H('sess-bea'))).session;
  check('sessions are the ones named by the header', sA1 === 'sess-a-1' && sA2 === 'sess-a-2' && sBea === 'sess-bea', `${sA1} ${sA2} ${sBea}`);

  const asked = (await must(kA, 'ask', { project: 'N3 Proj', to: 'Bea', kind: 'decide', ask: 'Ship Friday or Monday?', task: task.ref, options: [{ label: 'Friday' }, { label: 'Monday' }] }, H('sess-a-1'))).need;
  const rowN = await rawDb.collection('needs').findOne({ _id: asked.id });
  check('the Need records the asker session and key', rowN.from.session === 'sess-a-1' && !!rowN.from.keyId, JSON.stringify(rowN.from));

  // The addressee: start_work lists it as open for them
  const bea1 = await must(kBea, 'start_work', { project: 'N3 Proj' }, H('sess-bea'));
  check('start_work (addressee): the open Need is listed under needs.openForYou', bea1.needs?.openForYou?.some(n => n.id === asked.id), JSON.stringify(bea1.needs).slice(0, 200));
  check('start_work (addressee): nothing answered, none claimed', !bea1.needs?.answeredForYou);

  // The asker's State shows the wait on its Next line
  await must(kA, 'save_state', { project: 'N3 Proj', ops: [{ op: 'add_next', text: 'Cut the release', ref: task.ref }, { op: 'add_next', text: 'Write the notes' }] });
  const st = await must(kA, 'get_state', { project: 'N3 Proj' });
  const l1 = st.state.next.find(l => l.ref === task.ref);
  const l2 = st.state.next.find(l => !l.ref);
  check('State: the Next line on the task gets waitsOn from the open Need', l1?.waitsOn === `Need #${asked.ref} (Bea)`, JSON.stringify(st.state.next));
  check('State: a line with no task is left alone', l2 && !l2.waitsOn);
  const stored = await rawDb.collection('states').findOne({ _id: projId });
  check('State: waitsOn is read-side only, nothing is stored', !stored.next.some(l => l.waitsOn), JSON.stringify(stored.next.map(l => l.waitsOn)));

  // The forYou line for the addressee: a new Need arrives while they are present
  const second = (await must(kA, 'ask', { project: 'N3 Proj', to: 'Bea', kind: 'approve', ask: 'OK to tag v2?' }, H('sess-a-1'))).need;
  const peek = await must(kBea, 'get_state', { project: 'N3 Proj' }, H('sess-bea'));
  const fy = (peek.forYou ?? []).join(' | ');
  check('forYou (addressee): "1 Need for you" with the id, no body text', /1 Need for you: #\d+/.test(fy) && !/tag v2|Ship Friday/.test(JSON.stringify(peek.forYou)), fy);
  const peek2 = await must(kBea, 'get_state', { project: 'N3 Proj' }, H('sess-bea'));
  check('forYou (addressee): said once', !(peek2.forYou ?? []).some(x => /Need/.test(x)), JSON.stringify(peek2.forYou));

  // Answers: the asking session hears, the other session of the same key does not
  await answer(asked);
  await answer(second);
  const hear = await must(kA, 'get_state', { project: 'N3 Proj' }, H('sess-a-1'));
  const fa = (hear.forYou ?? []).join(' | ');
  check('forYou (asker): "your Need #N was answered", ids only', new RegExp(`your Need #${asked.ref} was answered`).test(fa) && !/Friday|Monday/.test(fa), fa);
  const other = await must(kA, 'get_state', { project: 'N3 Proj' }, H('sess-a-2'));
  check('forYou (other session of the same key): does not hear it', !(other.forYou ?? []).some(x => /was answered/.test(x)), JSON.stringify(other.forYou));
  check('forYou (asker): said once', !((await must(kA, 'get_state', { project: 'N3 Proj' }, H('sess-a-1'))).forYou ?? []).some(x => /was answered/.test(x)));

  // start_work: the answered ones come first, once; another key never gets them
  const back = await must(kA, 'start_work', { project: 'N3 Proj' }, H('sess-a-1'));
  const got = back.needs?.answeredForYou ?? [];
  check('start_work (asker session): its answered Needs come under needs.answeredForYou with the answer', got.length === 2 && got.every(n => n.status === 'answered' && n.answer?.option), JSON.stringify(got).slice(0, 200));
  const keys = Object.keys(back);
  check('start_work: the needs block comes before the State', keys.indexOf('needs') > -1 && keys.indexOf('needs') < keys.indexOf('state'), keys.join());
  const again = await must(kA, 'start_work', { project: 'N3 Proj' }, H('sess-a-1'));
  check('start_work: an answer is handed over once', !again.needs?.answeredForYou, JSON.stringify(again.needs));
  const third = (await must(kA, 'ask', { project: 'N3 Proj', to: 'Bea', kind: 'approve', ask: 'Another one?' }, H('sess-a-2'))).need;
  await answer(third);
  const sess1 = await must(kA, 'start_work', { project: 'N3 Proj' }, H('sess-a-1'));
  check('start_work: a session does not get another session\'s answer', !sess1.needs?.answeredForYou, JSON.stringify(sess1.needs));
  const foreign = await must(kB, 'start_work', { project: 'N3 Proj' }, H('sess-b-1'));
  check('start_work: another key never gets them', !foreign.needs?.answeredForYou, JSON.stringify(foreign.needs));
  // A Need asked with no session id belongs to its key: any session of that key finds it, another key never does
  await must(kA, 'start_work', { project: 'N3 Proj' }, H('sess-a-3'));
  const loose = (await must(kA, 'ask', { project: 'N3 Proj', to: 'Bea', kind: 'approve', ask: 'No session here?' })).need;
  check('a Need asked with no session id records the key only', !(await rawDb.collection('needs').findOne({ _id: loose.id })).from.session);
  await answer(loose);
  const viaKey = await must(kA, 'start_work', { project: 'N3 Proj' });
  check('start_work: a session of the same key finds a keyed Need', viaKey.needs?.answeredForYou?.some(n => n.id === loose.id), JSON.stringify(viaKey.needs).slice(0, 200));
  await answer((await must(kA, 'ask', { project: 'N3 Proj', to: 'Bea', kind: 'approve', ask: 'Key B must not see this' })).need);
  const viaB = await must(kB, 'start_work', { project: 'N3 Proj' });
  check('start_work: another key does not', !viaB.needs?.answeredForYou, JSON.stringify(viaB.needs));
  // ======== an ask to 'me' is not "for you" to the session that made it, and its answer is still told once ========
  {
    await rawDb.collection('needs').updateMany({ 'from.actor.userId': ME.userId, to: ME.userId }, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    const selfAsk = (await must(kB, 'ask', { project: 'N3 Proj', to: 'me', kind: 'approve', ask: 'Self ask probe?' }, H('sess-b-1'))).need;
    const nx = await must(kB, 'get_state', { project: 'N3 Proj' }, H('sess-b-1'));
    check('forYou (self ask): the asking session is not told it has a Need for you', !(nx.forYou ?? []).some(x => /Need.* for you/.test(x)), JSON.stringify(nx.forYou));
    await answer(selfAsk);
    const nx2 = await must(kB, 'get_state', { project: 'N3 Proj' }, H('sess-b-1'));
    check('forYou (self ask): the same session hears it was answered', (nx2.forYou ?? []).some(x => new RegExp(`your Need #${selfAsk.ref} was answered`).test(x)), JSON.stringify(nx2.forYou));
    const nx3 = await must(kB, 'get_state', { project: 'N3 Proj' }, H('sess-b-1'));
    check('forYou (self ask): ...once', !(nx3.forYou ?? []).some(x => /was answered/.test(x)), JSON.stringify(nx3.forYou));
  }
} catch (e) {
  check('flow-n3 ran to the end', false, String(e?.stack ?? e));
}
finish();
