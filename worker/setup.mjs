import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { loadConfig, configPath, configDir, checkBaseUrl } from './config.mjs';

export const DEFAULT_SERVER = 'https://work-os-puce-delta.vercel.app';

export function parseSetupArgs(argv) {
  const out = { roots: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') out.server = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--root') { if (argv[i + 1]) out.roots.push(argv[++i]); }
  }
  return out;
}

export const rootHint = () => (process.platform === 'win32' ? 'D:\Work' : '~/Work');

export function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
}

// Merge answers into the config file's existing JSON. Unknown/extra fields (allowPrompts, ...) are kept.
export function mergeConfig(existing, { baseUrl, deviceName, roots }) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const merged = { enabled: true, scanEveryMinutes: 15, maxDepth: 6, ...base, baseUrl, deviceName, roots };
  return merged;
}

export function readRawConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

export function writeConfig(merged) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2) + '\n');
}

// One real call with the candidate key: jobs GET. Returns { ok, status }.
export async function verifyKey(baseUrl, token, fetchImpl = fetch) {
  const base = checkBaseUrl(baseUrl);
  const res = await fetchImpl(base + '/api/worker/jobs', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
  return { ok: res.status === 200, status: res.status };
}

export async function runSetup({ argv, deps }) {
  const { getToken, setToken, readSecret, scanAndReport, install } = deps;
  const args = parseSetupArgs(argv);
  const raw = readRawConfig();
  const cur = loadConfig();
  const had = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const ask = async (q, def) => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def || '';
  };
  let baseUrl, deviceName, roots;
  let key = null;
  try {
    baseUrl = args.server || (cur.baseUrl && had('baseUrl') ? cur.baseUrl : '') || await ask('Server', DEFAULT_SERVER);
    checkBaseUrl(baseUrl);
    deviceName = args.name || (had('deviceName') && cur.deviceName) || await ask('Device name', os.hostname());
    roots = args.roots.length ? args.roots : had('roots') && cur.roots.length ? cur.roots : null;
    if (!roots) {
      const r = await ask(`Folder to scan for projects (e.g. ${rootHint()})`, '');
      if (!r) throw new Error('a folder to scan is required');
      roots = [expandHome(r)];
    }
    roots = roots.map(expandHome);
    for (const r of roots) if (!fs.existsSync(r)) console.log(`warning: ${r} does not exist`);

    const stored = getToken();
    let replace = true;
    if (stored) replace = /^y/i.test(await ask('A device key is already stored. Replace it? (y/N)', 'N'));
    if (replace && !process.stdin.isTTY) key = (await rl.question('Device key: ')).trim(); // piped input
    rl.close();
    if (replace && process.stdin.isTTY) key = await readSecret();
  } finally { rl.close(); }

  // Check the key before anything is written (a new key is checked as typed, a stored one as stored).
  const token = key || getToken();
  if (!token) throw new Error('no device key given');
  let v;
  try { v = await verifyKey(baseUrl, token); } catch (e) { throw new Error(`could not reach ${baseUrl}: ${String(e.message || e).slice(0, 100)}`); }
  if (v.status === 401 || v.status === 403) throw new Error('key refused (the server did not accept this device key; nothing was changed)');
  if (!v.ok) throw new Error(`server answered HTTP ${v.status}; nothing was changed`);
  console.log('key accepted');

  if (key) { setToken(key); console.log('device key stored'); }
  writeConfig(mergeConfig(raw, { baseUrl, deviceName, roots }));
  console.log(`config written: ${configPath()}`);

  const n = await scanAndReport();
  console.log(`${n} folders reported`);
  install();
  console.log('autostart installed');
  console.log('Done: open a project in Work OS → Sessions to link a folder');
}
