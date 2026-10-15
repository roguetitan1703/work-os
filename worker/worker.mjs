#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, saveState, configPath, checkBaseUrl } from './config.mjs';
import { getToken, setToken, readSecretFromStdin } from './secret.mjs';
import { makeApi } from './api.mjs';
import { createCore, VERSION } from './core.mjs';
import { launch, listProcesses, killPid, resolveClaude } from './launch.mjs';
import { scanRoots, publicFolder } from './scan.mjs';
import { install, uninstall } from './install.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function run() {
  const state = loadState();
  const api = makeApi(loadConfig, getToken);
  const claudePath = resolveClaude(loadConfig().roots);
  if (!claudePath) log('warning: claude not found outside the allowed roots; start/resume jobs will fail');
  const core = createCore({ getConfig: loadConfig, state, save: () => saveState(state), api, launcher: (a) => launch({ ...a, claudePath }), listProcesses, killPid, log });
  let delay = 10;
  let failing = 0;
  log(`work-os-worker ${VERSION} started`);
  for (;;) {
    const cfg = loadConfig(); // re-read each cycle so enabled:false takes effect without a restart
    if (cfg.enabled === false) { await sleep(30000); continue; }
    try {
      if (!state.lastScan || Date.now() - state.lastScan > cfg.scanEveryMinutes * 60000) await core.scanAndReport();
      const r = await core.pollOnce();
      delay = r.pollSeconds;
      failing = 0;
    } catch (e) {
      failing++;
      delay = Math.min(60, 10 * 2 ** Math.min(failing, 3));
      log(`error: ${String(e.message || e).slice(0, 200)}`); // messages never include the token or remotes
    }
    await sleep(delay * 1000);
  }
}

function status() {
  const cfg = loadConfig();
  const state = loadState();
  console.log('config file:', configPath());
  console.log(JSON.stringify(cfg, null, 2));
  console.log('device key set:', getToken() ? 'yes' : 'no');
  console.log('last scan:', state.lastScan ? new Date(state.lastScan).toISOString() : 'never');
  console.log('last poll:', state.lastPoll ? new Date(state.lastPoll).toISOString() : 'never');
  const s = Object.entries(state.sessions);
  console.log(`tracked sessions: ${s.length}`);
  for (const [id, v] of s) console.log(`  ${id}  ${v.state}  ${v.folderId}`);
}

const cmd = process.argv[2] || 'run';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (cmd === 'run') await run();
    else if (cmd === 'set-token') { setToken(await readSecretFromStdin()); console.log('device key stored'); }
    else if (cmd === 'install') { install(); console.log('autostart installed'); }
    else if (cmd === 'uninstall') { uninstall(); console.log('autostart removed'); }
    else if (cmd === 'status') status();
    else if (cmd === 'scan') {
      const cfg = loadConfig();
      const state = loadState();
      const found = scanRoots({ roots: cfg.roots, maxDepth: cfg.maxDepth, knownIds: state.ids });
      if (process.argv.includes('--dry')) {
        console.log(JSON.stringify(found.map(publicFolder), null, 2));
        console.log(`${found.length} folders (dry run, nothing sent)`);
      } else {
        checkBaseUrl(cfg.baseUrl);
        const api = makeApi(loadConfig, getToken);
        await api.postFolders(found.map(publicFolder));
        state.ids = {}; state.folders = {};
        for (const f of found) { state.ids[f.path] = f.id; state.folders[f.id] = f.path; }
        state.lastScan = Date.now();
        saveState(state);
        console.log(`sent ${found.length} folders`);
      }
    } else { console.error('usage: node worker.mjs [run|set-token|install|uninstall|status|scan [--dry]]'); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
  if (cmd !== 'run') process.exit(0);
}
