#!/usr/bin/env node
// Gives a downloaded build its own secrets (docs/hosting.md "The build's secrets"). Installed root-owned as
// /usr/local/sbin/work-os-fresh-secrets.mjs; deploy.sh runs it as the build user on a release's .next after
// unpacking a build from the public "builds" release, before anything serves it:
//
//   node work-os-fresh-secrets.mjs /srv/work-os/releases/<commit>/.next
//
// A Next build writes secrets into .next, and the published tarball shows them to anyone:
// - prerender-manifest.json `preview`: previewModeId (also the token that x-prerender-revalidate and the
//   __prerender_bypass cookie must carry), previewModeSigningKey, previewModeEncryptionKey. `next start` reads them
//   from this file and, since Next 16.4, from server/preview-props.json (no environment variable overrides them), so
//   both are replaced here with the same fresh random values in the same format.
// - server/server-reference-manifest.{json,js} `encryptionKey`: the key that encrypts server actions' bound
//   arguments. Next uses NEXT_SERVER_ACTIONS_ENCRYPTION_KEY from the environment when it is set
//   (next/dist/server/app-render/encryption-utils.js getActionEncryptionKey), and the server sets it
//   (/etc/work-os/env). The manifest's copy is replaced too, so the published one is good for nothing even without.
// Prints what it changed, never a value.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'BUILD_ID'))) {
  console.error('usage: work-os-fresh-secrets.mjs <release>/.next (a finished build)');
  process.exit(2);
}
const hex = n => randomBytes(n).toString('hex');

// Preview mode.
const pmFile = path.join(dir, 'prerender-manifest.json');
const pm = JSON.parse(fs.readFileSync(pmFile, 'utf8'));
if (!pm.preview || typeof pm.preview.previewModeId !== 'string') {
  console.error('prerender-manifest.json has no preview values: Next changed its format; stopping (check docs/hosting.md)');
  process.exit(1);
}
const oldPreview = [pm.preview.previewModeId, pm.preview.previewModeSigningKey, pm.preview.previewModeEncryptionKey].filter(v => typeof v === 'string' && v.length >= 16);
pm.preview = { ...pm.preview, previewModeId: hex(16), previewModeSigningKey: hex(32), previewModeEncryptionKey: hex(32) };
fs.writeFileSync(pmFile, JSON.stringify(pm));
// Next 16.4 also writes the same three values to server/preview-props.json and reads them from there at runtime: the
// same fresh values, so both copies agree.
const ppFile = path.join(dir, 'server', 'preview-props.json');
if (fs.existsSync(ppFile)) {
  const pp = JSON.parse(fs.readFileSync(ppFile, 'utf8'));
  if (typeof pp.previewModeId !== 'string') {
    console.error('server/preview-props.json has no previewModeId: Next changed its format; stopping (check docs/hosting.md)');
    process.exit(1);
  }
  const { previewModeId, previewModeSigningKey, previewModeEncryptionKey } = pm.preview;
  fs.writeFileSync(ppFile, JSON.stringify({ ...pp, previewModeId, previewModeSigningKey, previewModeEncryptionKey }));
}
console.log('  fresh preview-mode id and keys');

// Server actions key: the same value appears once in the .json and once (JSON-escaped) in the .js copy.
const jsonFile = path.join(dir, 'server', 'server-reference-manifest.json');
const jsFile = path.join(dir, 'server', 'server-reference-manifest.js');
const ref = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
const old = ref.encryptionKey;
if (typeof old !== 'string' || !/^[A-Za-z0-9+/=]{20,}$/.test(old)) {
  console.error('server-reference-manifest.json has no encryptionKey: Next changed its format; stopping (check docs/hosting.md)');
  process.exit(1);
}
const fresh = randomBytes(32).toString('base64');
ref.encryptionKey = fresh;
fs.writeFileSync(jsonFile, JSON.stringify(ref, null, 2));
if (fs.existsSync(jsFile)) {
  const js = fs.readFileSync(jsFile, 'utf8');
  const n = js.split(old).length - 1;
  if (n !== 1) {
    console.error(`server-reference-manifest.js holds the key ${n} times, not once: stopping (check docs/hosting.md)`);
    process.exit(1);
  }
  fs.writeFileSync(jsFile, js.replace(old, fresh));
}
console.log('  fresh server-actions key in the manifest (NEXT_SERVER_ACTIONS_ENCRYPTION_KEY wins when set)');

// Nothing else in .next may still hold an old value.
const olds = [old, ...oldPreview];
const left = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink() || e.name === 'cache' || e.name === 'node_modules') continue;
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && fs.statSync(p).size < 50e6) {
      const text = fs.readFileSync(p, 'latin1');
      if (olds.some(v => text.includes(v))) left.push(path.relative(dir, p));
    }
  }
};
walk(dir);
if (left.length) {
  console.error(`an old secret is still in: ${left.join(', ')}; stopping`);
  process.exit(1);
}
