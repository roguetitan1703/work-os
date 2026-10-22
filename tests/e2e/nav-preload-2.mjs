// First-tap speed after idling on a page: does a tap need a server round trip?
// WAIT=<seconds> idle on Today before tapping (default 70, i.e. past the old 60s prefetch life).
import { launch, check, B, PW, finish, fillLogin } from './lib.mjs';
const WAIT = Number(process.env.E2E_WAIT ?? 65);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const rsc = []; // RSC fetches: [time, url, isPrefetch]
p.on('request', r => { const h = r.headers(); if (h['rsc'] === '1') rsc.push([Date.now(), r.url().replace(B, ''), !!h['next-router-prefetch'] || !!h['next-router-segment-prefetch']]); });
if (process.env.CLOCK) await p.clock.install();
await p.goto(B + '/login?next=/today'); await fillLogin(p); await p.locator('button:text-is("Sign in")').click();
await p.waitForURL(u => u.pathname === '/today'); await p.waitForLoadState('networkidle').catch(() => {});
console.log(`idle ${WAIT}s on Today…`);
const t0 = Date.now(); if (process.env.CLOCK) { await p.clock.runFor(WAIT * 1000); await p.waitForTimeout(3000); } else await p.waitForTimeout(WAIT * 1000);
console.log('timeline', rsc.filter(r => r[0] >= t0 && /^\/(menu|settings)/.test(r[1])).map(r => Math.round((r[0]-t0)/1000)+'s '+r[1].split('?')[0]+(r[2]?'(pf)':'')).join(', '));
console.log(`requests while idle: ${rsc.filter(r => r[0] >= t0).length} (${[...new Set(rsc.filter(r => r[0] >= t0).map(r => r[1].split('?')[0]))].join(' ')})`);

// During a tap every server (RSC) request is held 1.5 s: a page that shows well under that came from the preload.
let slow = false;
await p.route('**/*', async r => { if (slow && r.request().headers()['rsc'] === '1') await new Promise(x => setTimeout(x, 1500)); await r.continue(); });
async function tap(label, loc, ready) {
  const s = Date.now(); const before = rsc.length;
  slow = true; await loc.tap(); await ready.waitFor({ timeout: 15000 }); slow = false;
  const ms = Date.now() - s; const nav = ms < 800 ? 0 : 1;
  console.log(`${label}: ${ms} ms (${nav ? 'waited on the server' : 'from preload'})`, 'requests during tap:', rsc.slice(before).filter(r => !r[2]).map(r => r[1]).join(' '));
  return { ms, nav };
}
// Claude and the tab links are no longer prefetched in full (one server render per link per visit): they open after one server round trip.
const T=async(label,loc,ready)=>{const r=await tap(label,loc,ready);check(label+' opens (one server round trip allowed)',r.ms<8000,r.ms+' ms');};
await T('Today -> Claude', p.locator('nav[aria-label=Main]:visible a[href="/claude"]').first(), p.locator('h1:visible',{hasText:/^Claude$/}).first());
await p.waitForTimeout(3000);
await T('Claude -> Queue tab', p.locator('[data-tab="queue"]'), p.locator('[data-tab="queue"][aria-current="page"]'));
await T('Queue -> Setup tab', p.locator('[data-tab="setup"]'), p.locator('[data-tab="setup"][aria-current="page"]'));
await p.goto(B + '/projects/alpha-client'); await p.waitForTimeout(3500);
for (const t of ['tasks','claude','notes','info']) await T('Project -> '+t+' tab', p.locator('[data-tab="'+t+'"]').first(), p.locator('[data-tab="'+t+'"][aria-current="page"]').first());
await b.close();
await finish();
