// What a real browser sends (tests/load/README.md): one Chromium tab goes through a short working session
// (session.mjs) and every request to the app is printed per step and kind. clients.mjs's scripted Browser copies
// these patterns; run this after a change to links, prefetching or actions, and compare.
//   LOAD_SCRIPT=patterns.mjs SKIP_BUILD=1 bash tests/load/run.sh
// Writes patterns.json (every request with its router headers) to LOAD_OUT_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../e2e/lib.mjs';
import { loadTeam } from './team.mjs';
import { browserSession } from './session.mjs';
import { meter } from './measure.mjs';

const team = loadTeam();
const browser = await launch();
const { steps, log } = await browserSession({ browser, team, person: team.people[5], teammate: team.people[0] });
await browser.close();
for (const [s, kinds] of Object.entries(steps)) {
  const pages = [...new Set(log.filter(r => r.step === s).map(r => `${r.kind}:${r.page}`))].slice(0, 14).join(' ');
  console.log(`STEP ${s.padEnd(44)} ${JSON.stringify(kinds)}  ${pages}`);
}
const out = process.env.LOAD_OUT_DIR;
if (out) fs.writeFileSync(path.join(out, 'patterns.json'), JSON.stringify(log, null, 1));
const m = await meter();
if (m) for (const [k, v] of Object.entries(m.routes).sort((a, b) => b[1].n - a[1].n)) console.log('METER', k.padEnd(40), 'n=' + v.n, 'db=' + v.dbCalls, 'KB=' + Math.round(v.bytes / 1024), 'ms=' + Math.round(v.ms / v.n));
process.exit(0);
