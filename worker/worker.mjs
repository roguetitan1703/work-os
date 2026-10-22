#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, saveState, configPath, checkBaseUrl } from './config.mjs';
import { getToken, setToken, readSecretFromStdin } from './secret.mjs';
import { makeApi } from './api.mjs';
import { createCore, VERSION } from './core.mjs';
import { createLoop } from './loop.mjs';
import { launch, listProcesses, killPid, resolveClaude } from './launch.mjs';
import { scanRoots, publicFolder } from './scan.mjs';
import { install, uninstall } from './install.mjs';
import { runSetup } from './setup.mjs';
import { collectActivity } from './activity.mjs';
import { connectPush } from './push.mjs';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function run() {
  const state = loadState();
  const api = makeApi(loadConfig, getToken);
  let claudePath = resolveClaude(loadConfig().roots);
  if (!claudePath) log('warning: claude not found outside the allowed roots; will look again at the next start');
  // Not found at startup (e.g. PATH not ready at logon): look again on each start/resume until found.
  const launcher = (a) => {
    if (!claudePath) claudePath = resolveClaude(loadConfig().roots);
    return launch({ ...a, claudePath, mcpConfig: loadConfig().mcpConfig || null });
  };
  const onlyRoots = () => { const c = loadConfig(); return c.sessionsInRootsOnly ? c.roots : null; };
  const core = createCore({ getConfig: loadConfig, state, save: () => saveState(state), api, launcher, listProcesses, killPid, log, activity: (ids) => collectActivity({ listProcesses, workOsIds: ids, withSessions: true, onlyRoots: onlyRoots() }) });
  let loop = null;
  const push = connectPush({ getCfg: loadConfig, getToken, onWake: () => loop?.wake(), onUp: (up) => { log(up ? 'push connected' : 'push disconnected'); loop?.wake(); }, log });
  loop = createLoop({ core, getConfig: loadConfig, state, log, pushUp: () => push.up });
  log(`work-os-worker ${VERSION} started`);
  await loop.run();
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

async function scanAndSend() {
  const cfg = loadConfig();
  const state = loadState();
  const found = scanRoots({ roots: cfg.roots, maxDepth: cfg.maxDepth, knownIds: state.ids });
  checkBaseUrl(cfg.baseUrl);
  const api = makeApi(loadConfig, getToken);
  await api.postFolders(found.map(publicFolder));
  state.ids = {}; state.folders = {};
  for (const f of found) { state.ids[f.path] = f.id; state.folders[f.id] = f.path; }
  state.lastScan = Date.now();
  saveState(state);
  return found.length;
}

const cmd = process.argv[2] || 'run';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (cmd === 'run') await run();
    else if (cmd === 'set-token') { setToken(await readSecretFromStdin()); console.log('device key stored'); }
    else if (cmd === 'install') { install(); console.log('autostart installed'); }
    else if (cmd === 'uninstall') { uninstall(); console.log('autostart removed'); }
    else if (cmd === 'status') status();
    else if (cmd === 'activity') {
      const c = loadConfig();
      const r = await collectActivity({ listProcesses, withSessions: true, onlyRoots: c.sessionsInRootsOnly ? c.roots : null });
      console.log(JSON.stringify(r.counts, null, 2));
      console.log(`listed sessions: ${r.list.length}, running: ${r.list.filter((s) => s.running).length}, with a real title: ${r.list.filter((s) => s.title !== s.folder).length}, subagents working: ${r.list.reduce((n, s) => n + s.subagentsActive, 0)}`);
      if (process.argv.includes('--titles')) console.log(JSON.stringify(r.list, null, 2));
      else console.log('(add --titles to print the list on your own console)');
      console.log('(read-only, nothing sent)');
    }
    else if (cmd === 'setup') await runSetup({ argv: process.argv.slice(3), deps: { getToken, setToken, readSecret: readSecretFromStdin, scanAndReport: scanAndSend, install } });
    else if (cmd === 'scan') {
      if (process.argv.includes('--dry')) {
        const cfg = loadConfig();
        const found = scanRoots({ roots: cfg.roots, maxDepth: cfg.maxDepth, knownIds: loadState().ids });
        console.log(JSON.stringify(found.map(publicFolder), null, 2));
        console.log(`${found.length} folders (dry run, nothing sent)`);
      } else console.log(`sent ${await scanAndSend()} folders`);
    } else { console.error('usage: node worker.mjs [run|setup|set-token|install|uninstall|status|scan [--dry]|activity]'); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
  if (cmd !== 'run') process.exit(0);
}
