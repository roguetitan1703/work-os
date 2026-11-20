// Ratchet for the UI library (docs/HANDOVER.md section 8): files under app/ and components/ may not gain hand-typed
// `text-[..px]` sizes or raw `<button` beyond tests/ui-baseline.json (today's counts). Use the type steps
// (text-label/meta/body/title/page) and components/ui (Button, IconButton, Chip, Row, ...) instead.
// Run: npm run check:ui. After removing some, lower the baseline: npm run check:ui -- --update (only ever lowers or
// removes entries; --update never accepts an increase).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BASE = join(ROOT, 'tests/ui-baseline.json');
const update = process.argv.includes('--update');
const init = process.argv.includes('--init');

const PX = /\btext-\[\d+(?:\.\d+)?px\]/g;
const BTN = /<button\b/g;

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.next') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx|ts|jsx)$/.test(f)) yield p;
  }
}

const now = {};
for (const d of ['app', 'components']) {
  for (const p of walk(join(ROOT, d))) {
    const src = readFileSync(p, 'utf8');
    const px = (src.match(PX) ?? []).length;
    const btn = (src.match(BTN) ?? []).length;
    if (px || btn) now[relative(ROOT, p).split(sep).join('/')] = { px, btn };
  }
}

if (init || !existsSync(BASE)) {
  writeFileSync(BASE, JSON.stringify(Object.fromEntries(Object.entries(now).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + '\n');
  console.log(`ui baseline written: ${Object.keys(now).length} files`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(BASE, 'utf8'));
const fails = [];
const lower = [];
for (const [f, c] of Object.entries(now)) {
  const b = base[f] ?? { px: 0, btn: 0 };
  if (c.px > b.px) fails.push(`${f}: ${c.px} hand-typed text-[..px] (allowed ${b.px}); use text-label/meta/body/title/page`);
  if (c.btn > b.btn) fails.push(`${f}: ${c.btn} raw <button (allowed ${b.btn}); use Button, IconButton or Chip from components/ui`);
  if (c.px < b.px || c.btn < b.btn) lower.push(f);
}
for (const f of Object.keys(base)) if (!now[f]) lower.push(f);

if (fails.length) {
  console.error('check:ui failed:\n' + fails.map(l => '  ' + l).join('\n'));
  process.exit(1);
}
if (lower.length) {
  if (update) {
    const out = {};
    for (const f of Object.keys(now).sort()) out[f] = { px: Math.min(now[f].px, base[f]?.px ?? 0), btn: Math.min(now[f].btn, base[f]?.btn ?? 0) };
    writeFileSync(BASE, JSON.stringify(out, null, 2) + '\n');
    console.log(`ui baseline lowered for ${lower.length} file(s)`);
  } else {
    console.log(`check:ui ok. ${lower.length} file(s) are below the baseline: run npm run check:ui -- --update to lock it in.`);
  }
} else console.log('check:ui ok');
