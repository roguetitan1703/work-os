// Delpat OS import is hidden when the server has no Delpat OS client set (docs/auth.md "Linking Delpat OS"): no card in
// Settings › Connections, no tabs in New project, the callback is a 404 and the actions refuse. Seed profile: none.
import { B, check, finish, launch, login } from './lib.mjs';

const browser = await launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await login(p);
  await p.goto(B + '/settings?section=connections');
  await p.waitForSelector('[data-connections]', { timeout: 20000 });
  check('off: no Delpat OS card in Connections', (await p.locator('[data-connection="delpat-os"]').count()) === 0);
  check('off: no Link button', (await p.locator('[data-delpat-link]').count()) === 0);
  await p.goto(B + '/projects');
  await p.getByRole('button', { name: 'New project' }).first().click();
  await p.waitForSelector('input[placeholder="Name"]', { timeout: 10000 });
  await p.waitForTimeout(1500); // the status question has been answered by now
  check('off: New project has no mode tabs', (await p.locator('[data-new-project-mode]').count()) === 0);
  const cb = await ctx.request.get(B + '/api/delpat-os/callback?code=x&state=y', { maxRedirects: 0 });
  check('off: the callback is a 404', cb.status() === 404, String(cb.status()));
  await ctx.close();
} catch (e) {
  check('suite error', false, e?.stack || String(e));
}
await browser.close();
await finish();
