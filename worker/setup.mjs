import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { resolveClaude } from './launch.mjs';
import { loadConfig, configPath, configDir, checkBaseUrl } from './config.mjs';

export const DEFAULT_SERVER = 'https://work.delpat.in';
export const NODE_URL = 'https://nodejs.org/en/download';
export const CLAUDE_URL = 'https://docs.claude.com/en/docs/claude-code/overview';

// What setup needs before it asks for anything: Node 22+ (the version running this) and Claude Code on the PATH.
// Returns a list of problems, each a plain sentence with a link; empty when all is well.
export function checkPrereqs(roots = [], { nodeVersion = process.versions.node, find = resolveClaude } = {}) {
  const problems = [];
  if (Number(nodeVersion.split('.')[0]) < 22) problems.push(`Node 22 or newer is needed (this is ${nodeVersion}). Install it from ${NODE_URL}.`);
  if (!find(roots)) problems.push(`Claude Code was not found. Install it from ${CLAUDE_URL}, sign in once by running claude, then run this again.`);
  return problems;
}

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

const isOldHost = (u) => { try { return new URL(u).hostname.endsWith('.vercel.app'); } catch { return false; } };

export async function runSetup({ argv, deps }) {
  const { getToken, setToken, readSecret, scanAndReport, install, prereqs, verify = verifyKey, input = process.stdin, defaultServer = DEFAULT_SERVER } = deps;
  const problems = prereqs ? prereqs() : [];
  if (problems.length) throw new Error(problems.join('\n'));
  const args = parseSetupArgs(argv);
  const raw = readRawConfig();
  const cur = loadConfig();
  const had = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const rl = readline.createInterface({ input, output: process.stdout, terminal: false });
  const ask = async (q, def) => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def || '';
  };
  let baseUrl, deviceName, roots;
  let key = null;
  try {
    baseUrl = args.server || (cur.baseUrl && had('baseUrl') ? cur.baseUrl : '') || await ask('Server', defaultServer);
    // An old address left in the config from before Work OS moved: say so, and offer the current one.
    if (!args.server && baseUrl !== defaultServer && isOldHost(baseUrl)) {
      console.log(`This config points at ${baseUrl}, an old address.`);
      if (/^(y|$)/i.test(await ask(`Use ${defaultServer}? (Y/n)`, 'Y'))) baseUrl = defaultServer;
    }
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
    if (replace && !input.isTTY) key = (await rl.question('Device key: ')).trim(); // piped input
    rl.close();
    if (replace && input.isTTY) key = await readSecret();
  } finally { rl.close(); }

  // Check the key before anything is written (a new key is checked as typed, a stored one as stored).
  const token = key || getToken();
  if (!token) throw new Error('no device key given');
  const check = async () => {
    try { return await verify(baseUrl, token); } catch (e) { throw new Error(`could not reach ${baseUrl}: ${String(e.message || e).slice(0, 100)}`); }
  };
  let v = await check();
  // 402 or 404: nothing of Work OS lives at this address any more (the old host). Offer the current one once.
  if ((v.status === 402 || v.status === 404) && baseUrl !== defaultServer) {
    console.log(`${baseUrl} answered HTTP ${v.status}: this config points at an address that no longer serves Work OS.`);
    let yes = true; // piped input cannot answer a second question: take the current address
    if (input.isTTY) {
      const rl2 = readline.createInterface({ input, output: process.stdout, terminal: false });
      try { yes = /^(y|$)/i.test((await rl2.question(`Use ${defaultServer}? (Y/n): `)).trim()); } finally { rl2.close(); }
    }
    if (yes) { baseUrl = defaultServer; v = await check(); }
  }
  if (v.status === 401 || v.status === 403) throw new Error('key refused (the server did not accept this device key; nothing was changed)');
  if (!v.ok) throw new Error(`server answered HTTP ${v.status}; nothing was changed`);
  console.log('key accepted');

  if (key) { setToken(key); console.log('device key stored'); }
  writeConfig(mergeConfig(raw, { baseUrl, deviceName, roots }));
  console.log(`config written: ${configPath()}`);

  const n = await scanAndReport();
  console.log(`${n} folders reported`);
  try { install(); console.log('autostart installed'); }
  catch (e) { console.log(`autostart not set: ${String(e.message || e).split('\n')[0].slice(0, 300)}`); }
  console.log('Done: open a project in Work OS → Sessions to link a folder');
}
