// H10 feedback (docs/flows/agent-system.md section 7): one line, mid-work, on what got in an agent's way in Work OS. It is
// a `feedback` row on the project's State in the shape of end_work's session_ended row; the same text twice in an hour is
// written once; 10 an hour per session; never a message or a Need. Seed profile: none.
import { ME, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { mcpH, must } from './flow-lib.mjs';

const P = 'H10 Alpha';
const Q = 'H10 Private';
const hdr = sess => ({ 'X-Work-OS-Session': sess });
const feed = type => rawDb.collection('activity').find({ type }).sort({ at: 1 }).toArray();
const pid = async name => (await rawDb.collection('projects').findOne({ name }))._id;
try {
  const T = await makeUser({ email: 'h10-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const X = await makeUser({ email: 'h10-xavier@example.test', name: 'Xavier', orgName: 'H10 Other Org' });
  const cc = await mkKey({ agent: 'claude-code', name: 'H10 cc' });
  const chat = await mkKey({ agent: 'claude', name: 'H10 chat' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess cc' });
  const kX = await mkKey({ agent: 'claude-code', userId: X.userId, orgId: X.orgId, name: 'Xavier cc' });
  await must(cc, 'add_project', { name: P, visibility: 'org' });
  await must(cc, 'add_project', { name: Q, visibility: 'private' });
  const fb = (key, args, sess) => mcpH(key, 'feedback', { project: P, ...args, ...(sess ? { session: sess } : {}) }, sess ? hdr(sess) : {});

  // ── 1. Recorded: a feedback row on the project's State, no State needed
  check('H10 setup: the project has no State yet', (await rawDb.collection('states').countDocuments({})) === 0);
  const r1 = await fb(cc, { text: 'edit_line find matched two Next lines; quoted the whole line', tool: 'save_state', rule: 'Quote the Next line' }, 'h10s1');
  check('H10 recorded: the answer is {recorded: true} and nothing more', !r1.isError && JSON.stringify(r1.json) === '{"recorded":true}', r1.text.slice(0, 200));
  const rows = await feed('feedback');
  const id = await pid(P);
  check('H10 recorded: one feedback row on the State of the project with note, tool, rule and session', rows.length === 1 && rows[0].note.startsWith('edit_line find matched') && rows[0].subject.kind === 'state' && rows[0].subject.id === id && rows[0].projectId === id && rows[0].feedback?.tool === 'save_state' && rows[0].feedback?.rule === 'Quote the Next line' && rows[0].session === 'h10s1', JSON.stringify(rows));
  check('H10 recorded: it made no State, message or Need', (await rawDb.collection('states').countDocuments({})) === 0 && (await rawDb.collection('needs').countDocuments({})) === 0 && (await rawDb.collection('messages').countDocuments({})) === 0);
  const r1b = await fb(chat, { text: 'plain line from a chat key' });
  const plain = (await feed('feedback')).find(x => x.note.startsWith('plain line'));
  check('H10 recorded: a line without tool and rule has no feedback field; a chat key works', !r1b.isError && plain && !plain.feedback && !plain.session, JSON.stringify(plain));

  // ── 2. Read side: recent_activity what=state
  const raText = JSON.stringify(await must(cc, 'recent_activity', { what: 'state', limit: 20 }));
  check('H10 reader: recent_activity (State) shows "Feedback: ..." with the tool and rule', /Feedback: edit_line find matched[^"]*\(save_state; rule Quote the Next line\)/.test(raText), raText.slice(0, 400));
  const tRa = JSON.stringify(await must(kT, 'recent_activity', { what: 'state', limit: 20 }));
  check('H10 reader: a member who reads the project sees it too', tRa.includes('Feedback: edit_line'), tRa.slice(0, 200));

  // ── 3. Dedup: the same text from the same session in an hour is written once
  const d1 = await fb(cc, { text: 'edit_line find matched two Next lines; quoted the whole line' }, 'h10s1');
  check('H10 dedup: the same text from the same session is not written again (recorded: false, duplicate: true)', !d1.isError && d1.json?.recorded === false && d1.json?.duplicate === true && (await feed('feedback')).length === 2, d1.text);
  const d2 = await fb(cc, { text: 'edit_line find matched two Next lines; quoted the whole line' }, 'h10s2');
  check('H10 dedup: another session may say the same thing', d2.json?.recorded === true && (await feed('feedback')).length === 3, d2.text);

  // ── 4. Cap: 10 per session per hour, the 11th refused with the end_work hint
  for (let i = 1; i <= 9; i++) await must(cc, 'feedback', { project: P, text: `cap line ${i}`, session: 'h10cap' }, hdr('h10cap'));
  const ten = await fb(cc, { text: 'cap line 10' }, 'h10cap');
  const eleven = await fb(cc, { text: 'cap line 11' }, 'h10cap');
  check('H10 cap: the 10th is recorded, the 11th is refused and names end_work', ten.json?.recorded === true && eleven.isError && /end_work/.test(eleven.text) && !(await feed('feedback')).some(x => x.note === 'cap line 11'), eleven.text);
  const other = await fb(cc, { text: 'cap line 11' }, 'h10cap2');
  check('H10 cap: another session is not held back by it', other.json?.recorded === true, other.text);
  await rawDb.collection('activity').updateMany({ type: 'feedback', session: 'h10cap' }, { $set: { at: new Date(Date.now() - 2 * 3_600_000) } });
  const later = await fb(cc, { text: 'cap line 12' }, 'h10cap');
  check('H10 cap: rows older than an hour do not count', later.json?.recorded === true, later.text);

  // ── 5. Validation: nothing is written
  const before = (await feed('feedback')).length;
  const bad = [
    ['empty text', await fb(cc, { text: '   ' })],
    ['301 characters', await fb(cc, { text: 'x'.repeat(301) })],
    ['tool over 80', await fb(cc, { text: 'ok', tool: 't'.repeat(81) })],
    ['rule over 80', await fb(cc, { text: 'ok', rule: 'r'.repeat(81) })],
    ['unknown project', await mcpH(cc, 'feedback', { project: 'H10 No Such Project', text: 'ok' })],
    ['another organization', await mcpH(kX, 'feedback', { project: P, text: 'from outside' })],
    ['private project of Om, as Tess', await mcpH(kT, 'feedback', { project: Q, text: 'from Tess' })],
  ];
  for (const [what, r] of bad) check(`H10 validation: ${what} is refused`, r.isError, r.text.slice(0, 160));
  check('H10 validation: none of them wrote a row', (await feed('feedback')).length === before);
  check('H10 validation: the outside organization gets a plain not-found', /not found/i.test(bad[5][1].text), bad[5][1].text.slice(0, 160));
  const long300 = await fb(cc, { text: 'y'.repeat(300) });
  check('H10 validation: exactly 300 characters is kept whole', long300.json?.recorded === true && (await feed('feedback')).some(x => x.note === 'y'.repeat(300)));

  // ── 6. Who reads it: another organization and a member without the project do not
  await must(cc, 'feedback', { project: Q, text: 'private line h10canary', tool: 'save_state' });
  const xRa = JSON.stringify(await must(kX, 'recent_activity', { what: 'state', limit: 50 }));
  const tRa2 = JSON.stringify(await must(kT, 'recent_activity', { what: 'state', limit: 50 }));
  const omRa2 = JSON.stringify(await must(cc, 'recent_activity', { what: 'state', limit: 50 }));
  check('H10 tenancy: the other organization sees no feedback line', !xRa.includes('Feedback:') && !xRa.includes('h10canary'), xRa.slice(0, 200));
  check('H10 tenancy: Tess sees the org project lines, not the private one; Om sees both', tRa2.includes('Feedback: plain line') && !tRa2.includes('h10canary') && omRa2.includes('h10canary'), tRa2.slice(0, 200));

  // ── 7. Refusals the server saw are attached as tool:kind (no error text), per session, for 30 minutes
  const R = 'H10 Refusals';
  await must(cc, 'add_project', { name: R, visibility: 'org' });
  // (An argument the tool's schema refuses never reaches the tool, so it is not noted; these reach it.)
  const badSave = await mcpH(cc, 'end_work', { project: R, state: [{ op: 'set_where', machine: 'b', branch: 'c' }], friction: 'none', session: 'h10r1' }, hdr('h10r1'));
  const badSave2 = await mcpH(cc, 'get_state', { project: 'H10 No Such Project', session: 'h10r1' }, hdr('h10r1'));
  const lost = await mcpH(cc, 'get_task', { task: 999999, session: 'h10r1' }, hdr('h10r1'));
  check('H10 refusals setup: the three calls were refused', badSave.isError && badSave2.isError && lost.isError, [badSave.text, badSave2.text, lost.text].map(t => t.slice(0, 80)).join(' | '));
  const rf = await mcpH(cc, 'feedback', { project: R, text: 'save_state kept refusing me', tool: 'save_state', session: 'h10r1' }, hdr('h10r1'));
  const kinds = rf.json?.refusals ?? [];
  check('H10 refusals: the answer and the row carry tool:kind of this session refused calls', rf.json?.recorded === true && kinds.length === 3 && kinds.every(k => /^[a-z_]+:(policy|input|not_found|internal)$/.test(k)) && kinds.includes('get_task:not_found') && kinds.includes('end_work:input') && kinds.includes('get_state:not_found'), rf.text);
  const rfRow = (await feed('feedback')).find(x => x.note === 'save_state kept refusing me');
  check('H10 refusals: the feed row keeps the same list, and no error text anywhere in it', JSON.stringify(rfRow.feedback.refusals) === JSON.stringify(kinds) && !JSON.stringify(rfRow).includes('Error'), JSON.stringify(rfRow));
  const text = JSON.stringify(await must(cc, 'recent_activity', { what: 'state', limit: 50 }));
  check('H10 refusals: recent_activity shows "refused: ..." in the line', /Feedback: save_state kept refusing me \(save_state; refused: [^)]*get_task:not_found/.test(text), text.slice(0, 300));
  const rfOther = await mcpH(cc, 'feedback', { project: R, text: 'another session, nothing refused', session: 'h10r2' }, hdr('h10r2'));
  check('H10 refusals: another session refusals are not attached', rfOther.json?.recorded === true && !('refusals' in rfOther.json), rfOther.text);
  const rfKey = await mcpH(chat, 'feedback', { project: R, text: 'another key, nothing refused' });
  check('H10 refusals: another key refusals are not attached', rfKey.json?.recorded === true && !('refusals' in rfKey.json), rfKey.text);
  // end_work: the session_ended row carries them too; the friction line is unchanged
  await must(cc, 'start_work', { project: R, session: 'h10r1' }, hdr('h10r1')); // set_now needs a session Work OS knows (Lanes)
  const ew = await mcpH(cc, 'end_work', { project: R, base_version: 0, state: [{ op: 'set_now', text: 'h10 refusals' }], friction: 'none', session: 'h10r1' }, hdr('h10r1'));
  const ended = (await feed('session_ended')).find(x => x.session === 'h10r1');
  check('H10 refusals: the end_work session_ended row carries them, its note is still the friction line', !ew.isError && ended?.note === 'none' && JSON.stringify(ended.feedback?.refusals) === JSON.stringify(kinds), JSON.stringify(ended));
  const endText = JSON.stringify(await must(cc, 'recent_activity', { what: 'state', limit: 50 }));
  check('H10 refusals: the session-ended line shows them too', /Session ended: none \(refused: /.test(endText), endText.slice(0, 200));
  const none = await mcpH(cc, 'end_work', { project: R, state: [{ op: 'set_where', machine: 'b', branch: 'c' }], friction: 'none', session: 'h10r3' }, hdr('h10r3'));
  const noneRow = (await feed('session_ended')).find(x => x.session === 'h10r3');
  check('H10 refusals: a session that was refused nothing has a session_ended row without a feedback field', !none.isError && noneRow && !noneRow.feedback, JSON.stringify(noneRow));

  // ── 8. The memory itself: 5 per session, 30 minutes, 2,000 sessions (injected clock)
  const mem = await import('../../lib/mcp/refusals.ts');
  const t0 = 1_000_000;
  for (let i = 0; i < 7; i++) mem.noteRefusal('k1', `tool${i}`, 'input', t0 + i);
  check('H10 refusals memory: the last 5 of a session are kept, oldest first', JSON.stringify(mem.recentRefusals('k1', t0 + 10)) === JSON.stringify(['tool2', 'tool3', 'tool4', 'tool5', 'tool6'].map(t => t + ':input')));
  check('H10 refusals memory: nothing is attached after 30 minutes', mem.recentRefusals('k1', t0 + 6 + 30 * 60_000).length === 0 && mem.recentRefusals('k1', t0 + 6 + 30 * 60_000 - 1).length === 1);
  mem.noteRefusal('k2', 'old', 'policy', t0);
  mem.noteRefusal('k2', 'new', 'not_found', t0 + 29 * 60_000);
  check('H10 refusals memory: old entries drop out while newer ones stay', JSON.stringify(mem.recentRefusals('k2', t0 + 31 * 60_000)) === '["new:not_found"]');
  for (let i = 0; i < 2100; i++) mem.noteRefusal(`s${i}`, 't', 'input', t0);
  check('H10 refusals memory: at most 2,000 sessions, the oldest dropped', mem.recentRefusals('s0', t0).length === 0 && mem.recentRefusals('s2099', t0).length === 1 && mem.recentRefusals('s100', t0).length === 1);

  // ── 9. The feedback hint: the third same refusal in 30 minutes suggests feedback (plan v6)
  {
    const N = 'H10 Nudge';
    const say = (sess, name, args) => mcpH(cc, name, { project: N, ...args, session: sess }, hdr(sess));
    const LONG = 'Process tooling (Om 22 Nov): ' + 'x'.repeat(420);                                          // 449 characters
    const over = { op: 'edit_line', find: 'Process tooling (Om 22 Nov)', new: 'Process tooling (Om 22 Nov): ' + 'y'.repeat(160) }; // 611 > 500
    const M = 60_000;
    const hard = /Looks hard/;
    const hint = /Looks hard\? save_state was refused 3 times/;
    // Step 1. Setup
    await must(cc, 'add_project', { name: N, visibility: 'org' });
    for (const sess of ['h10n1', 'h10n2', 'h10n3', 'h10n4', 'h10n5', 'h10n6', 'h10n8']) await must(cc, 'start_work', { project: N, session: sess }, hdr(sess));
    const setup = await must(cc, 'save_state', { project: N, base_version: 0, ops: [{ op: 'set_now', text: 'H10 nudge goal ' + 'g'.repeat(700) }, { op: 'add_later', text: LONG }], session: 'h10n1' }, hdr('h10n1'));
    check('H10 nudge setup: the State is at version 1', setup?.version === 1, JSON.stringify(setup).slice(0, 200));
    // Step 2. Refusal 1
    const n1 = await say('h10n1', 'save_state', { ops: [over] });
    check('H10 nudge: refusal 1 is an error', n1.isError, n1.text);
    check('H10 nudge: refusal 1 names the length', /The line would be 611 characters \(max 500\)\./.test(n1.text), n1.text);
    check('H10 nudge: refusal 1 says edit_line replaces only the find text', /replaces only the text in find \(27 of the line's 449 characters\)/.test(n1.text), n1.text);
    check('H10 nudge: refusal 1 says nothing was written', /Nothing was written\./.test(n1.text), n1.text);
    check('H10 nudge: refusal 1 has no feedback line', !hard.test(n1.text), n1.text);
    // Step 3. Refusal 2
    const n2 = await say('h10n1', 'save_state', { ops: [over] });
    check('H10 nudge: refusal 2 is an error with no feedback line', n2.isError && !hard.test(n2.text), n2.text);
    // Step 4. Refusal 3
    const n3 = await say('h10n1', 'save_state', { ops: [over] });
    check('H10 nudge: the third same refusal carries the feedback line', n3.isError && /Looks hard\? save_state was refused 3 times in the last 30 minutes \(input\)/.test(n3.text) && /feedback \{project, text, tool: "save_state"\}/.test(n3.text), n3.text);
    // Step 5. Once per 30 minutes
    const n4 = await say('h10n1', 'save_state', { ops: [over] });
    check('H10 nudge: the 4th refusal is an error with no feedback line', n4.isError && !hard.test(n4.text), n4.text);
    for (let i = 0; i < 3; i++) {
      const g = await mcpH(cc, 'get_task', { task: 999999, session: 'h10n1' }, hdr('h10n1'));
      check(`H10 nudge: get_task refusal ${i + 1} is an error with no feedback line`, g.isError && !hard.test(g.text), g.text);
    }
    // Step 6. Per session
    const h2a = await say('h10n2', 'save_state', { ops: [over] });
    const h2b = await say('h10n2', 'save_state', { ops: [over] });
    const h2c = await say('h10n2', 'save_state', { ops: [over] });
    check('H10 nudge: another session counts for itself (1st and 2nd have no hint)', !hard.test(h2a.text) && !hard.test(h2b.text), h2a.text + ' | ' + h2b.text);
    check('H10 nudge: another session gets its own hint on its 3rd', hint.test(h2c.text), h2c.text);
    // Step 7. Feedback silences the hint
    const fb3 = await say('h10n3', 'feedback', { text: 'h10n3 first' });
    check('H10 nudge: feedback from h10n3 is recorded', !fb3.isError && fb3.json?.recorded === true, fb3.text);
    for (let i = 0; i < 3; i++) { const r = await say('h10n3', 'save_state', { ops: [over] }); check(`H10 nudge: after feedback, h10n3 refusal ${i + 1} has no hint`, r.isError && !hard.test(r.text), r.text); }
    const fbRow = (await feed('feedback')).find(x => x.note === 'h10n3 first'); const { _id, ...base } = fbRow;
    await rawDb.collection('activity').insertMany(Array.from({ length: 10 }, (_, i) => ({ ...base, _id: `h10n6-fb-${i}`, session: 'h10n6', note: `n6 line ${i}`, at: new Date() })));
    const fb6 = await say('h10n6', 'feedback', { text: 'h10n6 over limit' });
    check('H10 nudge: feedback over the limit is refused', fb6.isError && /end_work/.test(fb6.text), fb6.text);
    const o6 = [];
    for (let i = 0; i < 3; i++) o6.push(await say('h10n6', 'save_state', { ops: [over] }));
    check('H10 nudge: over-limit feedback does not silence the hint (3rd refusal hints, first two not)', !hard.test(o6[0].text) && !hard.test(o6[1].text) && hint.test(o6[2].text), o6.map(x => x.text).join(' | '));
    await rawDb.collection('activity').insertOne({ ...base, _id: 'h10n8-dup', session: 'h10n8', note: 'h10n8 dup', at: new Date() });
    const fb8 = await say('h10n8', 'feedback', { text: 'h10n8 dup' });
    check('H10 nudge: a duplicate feedback answer is not recorded and duplicate', !fb8.isError && fb8.json?.recorded === false && fb8.json?.duplicate === true, fb8.text);
    for (let i = 0; i < 3; i++) { const r = await say('h10n8', 'save_state', { ops: [over] }); check(`H10 nudge: after a duplicate feedback, h10n8 refusal ${i + 1} has no hint`, r.isError && !hard.test(r.text), r.text); }
    // Step 8. Now error
    const n8 = await say('h10n4', 'save_state', { base_version: setup.version, ops: [{ op: 'edit_line', find: 'H10 nudge goal', new: 'H10 nudge goal ' + 'z'.repeat(400) }] });
    check('H10 nudge: the Now refusal says to use set_now', /Now would be 1116 characters \(max 1000\)\. To rewrite Now, use set_now with base_version\. Nothing was written\./.test(n8.text) && !/replaces only the text in find/.test(n8.text), n8.text);
    // Step 9. Schema refusals are not counted
    for (let i = 0; i < 3; i++) {
      const r = await say('h10n5', 'save_state', { ops: [{ op: 'edit_line', id: 'l_x', text: 't' }] });
      check(`H10 nudge: schema refusal ${i + 1} is -32602 with no hint`, r.isError && /-32602/.test(r.text) && !hard.test(r.text), r.text);
    }
    const fb5 = await say('h10n5', 'feedback', { text: 'schema refusals' });
    check('H10 nudge: schema refusals are not counted (feedback has no refusals)', fb5.json?.recorded === true && !('refusals' in fb5.json), fb5.text);
    // Step 10 g. Rate limit, real refusal
    const k = (await rawDb.collection('policyEvents').findOne({ kind: 'call', sid: 'h10n1' }))?.keyId;
    await rawDb.collection('policyEvents').insertMany(Array.from({ length: 300 }, (_, i) => ({ _id: `h10n7-${i}`, keyId: k, kind: 'call', at: new Date(Date.now() - 10 * 60_000), sid: 'h10n7' })));
    for (let i = 0; i < 3; i++) {
      const r = await say('h10n7', 'get_state', {});
      check(`H10 nudge: rate-limit refusal ${i + 1} has no hint`, r.isError && /Rate limit: this session made \d+ Work OS calls/.test(r.text) && !hard.test(r.text), r.text);
    }
    await rawDb.collection('policyEvents').deleteMany({ kind: 'call', sid: 'h10n7' });
    // Step 10 a-f, p4. Pure checks (on dev some of these functions do not exist; a throw is reported)
    try {
      const isStr = v => typeof v === 'string';
      const a = [0, 1, 2, 3].map(i => mem.noteRefusal('h10n-p1', 'save_state', 'input', t0 + i));
      check('H10 nudge memory a: null, null, hint on the 3rd, null on the 4th', a[0] === null && a[1] === null && isStr(a[2]) && /refused 3 times/.test(a[2]) && a[3] === null, JSON.stringify(a));
      const b = [0, 1, 2].map(i => mem.noteRefusal('h10n-p1', 'save_state', 'input', t0 + 31 * M + i));
      check('H10 nudge memory b: after 30 minutes the hint is allowed again', b[0] === null && b[1] === null && isStr(b[2]), JSON.stringify(b));
      mem.noteFeedback('h10n-p2', t0);
      const c1 = [1, 2, 3].map(i => mem.noteRefusal('h10n-p2', 'save_state', 'input', t0 + i));
      const c2 = [0, 1, 2].map(i => mem.noteRefusal('h10n-p2', 'save_state', 'input', t0 + 31 * M + i));
      check('H10 nudge memory c: feedback silences 30 minutes, then the hint returns', c1.every(v => v === null) && c2[0] === null && c2[1] === null && isStr(c2[2]), JSON.stringify([c1, c2]));
      const d = [['a', 'input'], ['a', 'not_found'], ['a', 'input'], ['b', 'input']].map(([tool, kind], i) => mem.noteRefusal('h10n-p3', tool, kind, t0 + i));
      check('H10 nudge memory d: the counter is per tool and per kind', d.every(v => v === null), JSON.stringify(d));
      const e1 = mem.withHint({ content: [{ type: 'text', text: 'Error: x' }], isError: true }, 'H');
      const okRes = { content: [{ type: 'text', text: 'fine' }] };
      check('H10 nudge memory e: withHint adds the hint to errors only', e1.content[0].text === 'Error: x\n\nH' && JSON.stringify(mem.withHint(okRes, 'H')) === JSON.stringify(okRes), JSON.stringify(e1));
      const f = mem.recentRefusals('h10n-p1', t0 + 31 * M + 3);
      check('H10 nudge memory f: recentRefusals still returns tool:kind strings', f.length > 0 && f.every(x => x === 'save_state:input'), JSON.stringify(f));
      const p4 = [0, 1, 2].map(i => mem.noteRefusal('h10n-p4', 'get_task', 'policy', t0 + i, false));
      check('H10 nudge memory g: policy refusals without hint give null and are still listed', p4.every(v => v === null) && mem.recentRefusals('h10n-p4', t0 + 3).filter(x => x === 'get_task:policy').length === 3, JSON.stringify(p4));
      const p4h = mem.noteRefusal('h10n-p4', 'get_task', 'policy', t0 + 3);
      check('H10 nudge memory g: the suppressed refusals did not set hintAt', isStr(p4h), JSON.stringify(p4h));
    } catch (e) {
      check('H10 nudge memory: pure checks ran', false, e?.message || String(e));
    }
  }
} catch (e) {
  check('flow-h10 (error)', false, e?.stack || String(e));
}
await finish();
