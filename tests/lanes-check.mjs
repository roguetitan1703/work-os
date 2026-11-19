// Unit test for lib/data/lanes.ts (Lanes plan note 666b20a6e9, Step 0): busy, lineHolder and the refusal texts.
// Run: npm run check:lanes (Node 22.6+, type stripping). Not part of prebuild.
import { register } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// lib files import siblings without an extension (as Next wants); give Node's resolver the .ts for this test.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && spec.startsWith('.')) return next(spec + '.ts', ctx);
    throw e;
  }
}`));

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { busy, lineHolder, laneOut, nowHeldText, lineHeldText, dispatchedText } = await import(pathToFileURL(join(ROOT, 'lib/data/lanes.ts')).href);

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`);
};

const NOW = Date.parse('2026-11-19T12:00:00Z');
const minAgo = m => new Date(NOW - m * 60_000);
const row = (state, ageMin, extra = {}) => ({ key: 'k', label: 'L', lastSeen: minAgo(ageMin), activity: { state, at: minAgo(ageMin), ...extra } });

// busy
check('busy: working', busy(row('working', 2), NOW) === true);
check('busy: working but stale is idle', busy(row('working', 15), NOW) === false);
check('busy: waiting at a prompt', busy(row('waiting', 3, { why: 'prompt' }), NOW) === true);
check('busy: waiting on a need', busy(row('waiting', 3), NOW) === false);
check('busy: idle', busy(row('idle', 3), NOW) === false);
check('busy: off', busy(row('off', 3), NOW) === false);
check('busy: ended row', busy({ ...row('working', 1), endedAt: minAgo(0) }, NOW) === false);

// lineHolder
const rowA = { ...row('working', 1), key: 'a' };
const rowB = { ...row('idle', 5), key: 'b' };
const ref = r => r.refNo;
const doer = { ...rowA, refNo: 12 };
const other = { ...rowB, refNo: undefined };
check('lineHolder: doing beats hold', lineHolder({ ref: 12, hold: { key: 'b', at: minAgo(9) } }, [other, doer], ref, NOW)?.key === 'a');
check('lineHolder: hold when nobody is on the task', lineHolder({ ref: 12, hold: { key: 'b', at: minAgo(9) } }, [other], ref, NOW)?.key === 'b');
check('lineHolder: hold without ref', lineHolder({ hold: { key: 'b', at: minAgo(9) } }, [other], ref, NOW)?.key === 'b');
const gone = { ...row('off', 45), key: 'b', lastSeen: minAgo(45) };
check('lineHolder: off 45 min frees the line', lineHolder({ hold: { key: 'b', at: minAgo(90) } }, [gone], ref, NOW) === null);
const justOff = { ...row('off', 5), key: 'b' };
check('lineHolder: off 5 min still holds', lineHolder({ hold: { key: 'b', at: minAgo(90) } }, [justOff], ref, NOW)?.key === 'b');
check('lineHolder: missing hold row', lineHolder({ hold: { key: 'zz', at: minAgo(9) } }, [other], ref, NOW) === null);
check('lineHolder: no hold, no doer', lineHolder({ ref: 12 }, [other], ref, NOW) === null);
check('lineHolder: no rows', lineHolder({ ref: 12, hold: { key: 'b', at: minAgo(9) } }, [], ref, NOW) === null);
check('lineHolder: off doer does not count', lineHolder({ ref: 12 }, [{ ...doer, ...row('off', 1), key: 'a', refNo: 12 }], ref, NOW) === null);

// laneOut
const out = laneOut({ ...row('waiting', 2, { why: 'prompt' }), person: 'Om', slot: 'S', branch: 'builder-s', doing: 7, lastResult: { text: 'done', at: minAgo(1) } }, NOW, { writtenBy: true });
check('laneOut fields', out.label === 'L' && out.person === 'Om' && out.slot === 'S' && out.branch === 'builder-s' && out.task === 7 && out.state === 'waiting' && out.why === 'prompt' && out.lastResult.text === 'done' && out.writtenBy === true, JSON.stringify(out));
check('laneOut has no session id', !('key' in out) && !('session' in out));

// refusal texts
check('Now held text', nowHeldText({ label: 'Builder A', person: 'Om', state: 'working', at: minAgo(2) }, NOW) ===
  'Now is held by "Builder A" (Om, working, 2 min ago). Nothing was written. Keep your lane instead: set_doing your task, log_progress, add_next or add_decision. Now passes to you once that session is not working, or your person changes it in the app.');
check('Line held text', lineHeldText({ id: 'ab12', text: 'Ship it', label: 'Builder A', state: 'working', ref: 12, nowHolder: 'Lead' }) ===
  'Next line ab12 "Ship it" is held by "Builder A" (working, on #12). Nothing was written. That session, the Now holder "Lead" or a person in the app can finish or edit it; add_next a new line, or send_message "Builder A".');
check('Line held text: long text cut, no ref', lineHeldText({ id: 'x', text: 'y'.repeat(100), label: 'B', state: 'idle' }).includes(`"${'y'.repeat(60)}…"`) && !lineHeldText({ id: 'x', text: 'y', label: 'B', state: 'idle' }).includes(', on #'));
check('Dispatched text', dispatchedText({ label: 'Worker', state: 'working', ref: 12 }) ===
  'A dispatched run never sets Now (held by "Worker", working). log_progress on #12, hand_in when done, or add_next.');

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
