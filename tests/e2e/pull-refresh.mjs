// Pull to refresh on a phone: the spinner stays up ~500 ms after the pull, then goes. Seed profile: nav.
import { launch, check, B, finish, fillLogin, SP } from './lib.mjs';
import path from 'node:path';
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = await ctx.newPage(); p.setDefaultTimeout(8000);
await p.goto(B + '/login?next=/today'); await fillLogin(p);
await p.locator('button[type=submit]').click(); await p.waitForURL(u => u.pathname === '/today', { timeout: 20000 });
await p.waitForTimeout(1500);
const spin = p.locator('div.pointer-events-none.fixed.z-40:has(svg.lucide-refresh-cw)');
const opacity = () => spin.evaluate(e => Number(getComputedStyle(e).opacity));
check('spinner hidden before the pull', (await opacity()) === 0);
const cdp = await ctx.newCDPSession(p);
const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 195, y }] });
const box = await p.locator('#app-main').boundingBox();
const y0 = box.y + 60;
await touch('touchStart', y0);
for (let dy = 20; dy <= 260; dy += 20) { await touch('touchMove', y0 + dy); await p.waitForTimeout(16); }
await p.screenshot({ path: path.join(SP, 'pull-mid.png') });
await touch('touchEnd');
await p.waitForTimeout(400);
check('spinner still shown 400 ms after release', (await opacity()) === 1, String(await opacity()));
await p.screenshot({ path: path.join(SP, 'pull-400.png') });
await p.waitForTimeout(1100);
check('spinner gone by 1500 ms', (await opacity()) === 0, String(await opacity()));
await b.close();
await finish();
