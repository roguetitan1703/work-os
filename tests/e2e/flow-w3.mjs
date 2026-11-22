// Flow W3 (docs/archive/plan-1-3.md slice 7): heavy slots. A computer allows 2 heavy slots at once across every session on
// it; a third request waits until one is released or its 30-minute lease ends; concurrent requests never exceed the cap.
// A machine name that matches one of the person's devices is that device (so two spellings are one machine).
// Seed profile: none.
import { randomUUID } from 'node:crypto';
import { ME, MCP, check, finish, makeUser, mkKey, rawDb } from './lib.mjs';
import { clean, mcpH, must, sleep } from './flow-lib.mjs';

const slot = (key, args) => mcpH(key, 'slot', { action: 'acquire', ...args });
const holds = async machineId => (await rawDb.collection('slots').findOne({ machine: machineId }))?.holds ?? [];
try {
  await clean();
  await rawDb.collection('slots').deleteMany({});
  const cc = await mkKey({ agent: 'claude-code', name: 'Claude Code' });
  const box = 'w3-box';
  const key = `u:${ME.userId}:${box}`; // an unknown name is kept per person

  // The cap of two
  const a1 = await slot(cc, { machine: box, session: 's1' });
  const a2 = await slot(cc, { machine: box, session: 's2' });
  check('W3: the first two requests get a slot', a1.json?.acquired === true && a2.json?.acquired === true && a2.json.held === 2 && a2.json.cap === 2, `${a1.text.slice(0, 150)} | ${a2.text.slice(0, 150)}`);
  const a3 = await slot(cc, { machine: box, session: 's3' });
  check('W3: a third request does not get one, and says when to retry', a3.json?.acquired === false && a3.json.held === 2 && a3.json.retryAfterSeconds > 0, a3.text.slice(0, 250));
  check('W3: the answer names the holders by session, with minutes left', a3.json.holders.length === 2 && a3.json.holders.every(h => h.session && h.minutesLeft > 0 && h.minutesLeft <= 30), JSON.stringify(a3.json.holders));
  const again = await slot(cc, { machine: box, session: 's1' });
  check('W3: asking again as a holder renews its place, it does not take a second one', again.json?.acquired === true && again.json.held === 2 && (await holds(key)).length === 2, again.text.slice(0, 200));
  const stray = await mcpH(cc, 'slot', { action: 'release', machine: box, session: 's9' });
  check('W3: releasing a slot you do not hold changes nothing', stray.json?.released === false && (await holds(key)).length === 2, stray.text.slice(0, 200));

  // A waiting request is let in when a holder releases
  const waiting = slot(cc, { machine: box, session: 's3', wait_seconds: 8 });
  await sleep(1500);
  const rel = await mcpH(cc, 'slot', { action: 'release', machine: box, session: 's1' });
  check('W3: release gives the place back', rel.json?.released === true && rel.json.held === 1, rel.text.slice(0, 200));
  const w3 = await waiting;
  check('W3: the waiting third request got the released place', w3.json?.acquired === true && w3.json.held === 2, w3.text.slice(0, 200));
  const again3 = await slot(cc, { machine: box, session: 's4' });
  check('W3: and the machine is full again', again3.json?.acquired === false, again3.text.slice(0, 200));

  // A lease that ended frees its place by itself
  await rawDb.collection('slots').updateOne({ machine: key }, { $set: { 'holds.$[h].until': new Date(Date.now() - 1000) } }, { arrayFilters: [{ 'h.session': 's2' }] });
  const s4 = await slot(cc, { machine: box, session: 's4' });
  check('W3: a lease that ended is free to take without any release', s4.json?.acquired === true && s4.json.holders.every(h => h.session !== 's2'), s4.text.slice(0, 250));
  const lease = (await holds(key)).find(h => h.session === 's4');
  const mins = (lease.until.getTime() - Date.now()) / 60_000;
  check('W3: a new lease runs 30 minutes', mins > 29 && mins <= 30.1, String(mins));

  // The wait runs out: it answers acquired:false (not an error) after the time given
  const t0 = Date.now();
  const late = await slot(cc, { machine: box, session: 's5', wait_seconds: 2 });
  check('W3: a wait that runs out answers "not acquired" after about the time asked', late.json?.acquired === false && Date.now() - t0 >= 1500 && Date.now() - t0 < 6000, `${Date.now() - t0} ms ${late.text.slice(0, 120)}`);

  // Concurrent requests never exceed the cap (fresh machines each round, so the first creation of the document races too)
  for (let round = 1; round <= 4; round++) {
    const m = `w3-conc-${round}-${randomUUID().slice(0, 6)}`;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => slot(cc, { machine: m, session: `c${round}-${i}` })));
    const got = rs.filter(r => r.json?.acquired === true).length;
    const errs = rs.filter(r => r.isError).length;
    const held = (await holds(`u:${ME.userId}:${m}`)).length;
    check(`W3: round ${round}: 10 concurrent requests, exactly 2 get a slot and the document holds 2`, got === 2 && held === 2 && errs === 0, `got ${got}, held ${held}, errors ${errs}`);
  }

  // The cap is per machine: another machine, and another person's machine of the same name, are separate
  const other = await slot(cc, { machine: 'w3-box-2', session: 's1' });
  check('W3: another machine has its own slots', other.json?.acquired === true && other.json.held === 1, other.text.slice(0, 150));
  const T = await makeUser({ email: 'w3-tess@example.test', name: 'Tess', orgId: ME.orgId, role: 'member' });
  const kT = await mkKey({ agent: 'claude-code', userId: T.userId, name: 'Tess Claude Code' });
  const tess = await slot(kT, { machine: box, session: 's1' });
  check('W3: a teammate who calls their machine the same name has their own (not the owner’s full one)', tess.json?.acquired === true && tess.json.held === 1, tess.text.slice(0, 200));

  // Slot writes are the holder's own: another person cannot release (or take over) a hold by quoting its session id
  {
    const m = 'w3-own-box';
    const mine = await slot(cc, { machine: m, session: 'shared-id' });
    const theirs = await mcpH(kT, 'slot', { action: 'release', machine: m, session: 'shared-id' });
    check('W3: another person releasing with the same session id leaves the hold alone', mine.json?.acquired === true && theirs.json?.released === false && (await holds(`u:${ME.userId}:${m}`)).length === 1, theirs.text.slice(0, 200));
    const doc = await rawDb.collection('slots').findOne({ machine: `u:${ME.userId}:${m}` });
    check('W3: the machine document records its person and when it was last touched', doc?.ownerId === ME.userId && doc.touchedAt instanceof Date, JSON.stringify([doc?.ownerId, doc?.touchedAt]));
    const ttl = (await rawDb.collection('slots').indexes()).find(i => i.name === 'touched_ttl');
    check('W3: slot documents expire a day after the last touch (TTL index)', ttl?.expireAfterSeconds === 86400, JSON.stringify(ttl));
  }

  // A device of the person is one machine however it is spelled; the default machine is the one start_work gave
  const devId = randomUUID();
  await rawDb.collection('devices').insertOne({ _id: devId, name: 'W3-PC', ownerId: ME.userId, orgId: ME.orgId, hash: randomUUID(), prefix: 'wkr_w3', createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null });
  await must(MCP, 'add_project', { name: 'Flow Slots' });
  const sw = await must(cc, 'start_work', { project: 'Flow Slots', machine: 'w3-pc', label: 'slot user' });
  const row = await rawDb.collection('presence').findOne({ userId: ME.userId, session: sw.session });
  check('W3: start_work resolves a machine name that is one of the person’s devices to the device id', row?.machine === devId && row.machineName === 'W3-PC', JSON.stringify([row?.machine, row?.machineName]));
  const d1 = await slot(cc, { session: sw.session }); // machine from the present session
  const d2 = await slot(cc, { machine: 'W3-PC', session: 'd2' });
  const d3 = await slot(cc, { machine: devId, session: 'd3' });
  check('W3: the default machine is the present session’s, and the name in any case and the id are the same machine', d1.json?.acquired === true && d2.json?.acquired === true && d3.json?.acquired === false && d3.json.machine === devId, `${d1.text.slice(0, 100)} | ${d2.text.slice(0, 100)} | ${d3.text.slice(0, 100)}`);
  const noMachine = await mcpH(MCP, 'slot', { action: 'acquire' });
  check('W3: with no machine and no present session it says what to pass', noMachine.isError && /machine/i.test(noMachine.text), noMachine.text.slice(0, 200));
  const bad = await mcpH(cc, 'slot', { action: 'acquire', machine: box, session: 's7', kind: 'light' });
  check('W3: only the heavy kind exists', bad.isError, bad.text.slice(0, 150));
} catch (e) {
  check('flow-w3 (error)', false, e?.stack || String(e));
}
await finish();
