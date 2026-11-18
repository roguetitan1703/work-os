// Throwaway probe (not committed): screenshots of a handover note and the "Session ended" feed row at 390 and 1280 px.
import fs from 'node:fs';
import { B, ME, SP, check, finish, launch, login, mkKey, overflow, okO } from './lib.mjs';
import { must } from './flow-lib.mjs';

fs.mkdirSync(SP, { recursive: true });
const b = await launch();
try {
  const cc = await mkKey({ agent: 'claude-code', name: 'probe cc' });
  await must(cc, 'add_project', { name: 'Probe Alpha', visibility: 'org' });
  await must(cc, 'start_work', { project: 'Probe Alpha', label: 'Work OS builder B', machine: 'VICTUS', branch: 'builder-b', session: 'probeb' }, { 'X-Work-OS-Session': 'probeb' });
  const r = await must(cc, 'end_work', { project: 'Probe Alpha', base_version: 0, state: [{ op: 'set_now', text: 'Probe goal' }, { op: 'set_where', machine: 'VICTUS', branch: 'builder-b', head: '4c1e9a0' }], friction: 'save_state answer is still 1,500 tokens long and the hook copy lags', handover: { step: 'flow-h5 cases 1-8 pass; next: write cases 9-12, then run tests/e2e/run.sh flow-h5 on slot B ports', in_flight: ['Sonnet agent hook tests on builder-b: look for commit hook: end_work'], tried: ['Marking pick-up on read_note: dropped, a read must not write'], rules: ['Om 19 Nov: questions go to me in chat while I am here'], check: ['tests/e2e/run.sh flow-h5', 'node --test worker/test'] }, session: 'probeb' }, { 'X-Work-OS-Session': 'probeb' });
  const id = r.handover.id;
  for (const [w, h, phone] of [[390, 844, true], [1280, 800, false]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone, colorScheme: scheme });
      const p = await ctx.newPage(); p.setDefaultTimeout(10000);
      await login(p, { phone });
      for (const [name, url] of [['note', `/notes/${id}`], ['activity', '/review?view=activity']]) {
        await p.goto(B + url);
        await p.waitForTimeout(1200);
        await p.screenshot({ path: `${SP}/probe-h5-${name}-${w}-${scheme}.png`, fullPage: true });
        const o = await overflow(p);
        check(`no horizontal scroll ${name} ${w} ${scheme}`, okO(o), JSON.stringify(o).slice(0, 200));
      }
      await ctx.close();
    }
  }
  void ME;
} catch (e) {
  check('probe (error)', false, e?.stack || String(e));
}
await b.close();
await finish();
