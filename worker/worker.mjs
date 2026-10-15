#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, saveState, configPath, checkBaseUrl } from './config.mjs';
import { getToken, setToken, readSecretFromStdin } from './secret.mjs';
import { makeApi } from './api.mjs';
import { createCore, VERSION } from './core.mjs';
import { launch, listProcesses, killPid, resolveClaude } from './launch.mjs';
import { scanRoots, publicFolder } from './scan.mjs';
import { install, uninstall } from './install.mjs';
import { runSetup } from './setup.mjs';
import { collectActivity } from './activity.mjs';
import { addFolder, removeFolder } from './folders.mjs';
import { readRawConfig, writeConfig } from './setup.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function run() {
  const state = loadState();
  const api = makeApi(loadConfig, getToken);
  let claudePath = resolveClaude(loadConfig().roots);
  if (!claudePath) log('warning: claude not found outside the allowed roots; will look again at the next start');
  // Not found at startup (e.g. PATH not ready at logon): look again on each start/resume until found.
  const launcher = (a) => {
    if (!claudePath) claudePath = resolveClaude(loadConfig().roots);
    return launch({ ...a, claudePath });
  };
  const core = createCore({ getConfig: loadConfig, state, save: () => saveState(state), api, launcher, listProcesses, killPid, log, activity: (ids) => collectActivity({ listProcesses, workOsIds: ids, withSessions: true }) });
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

async function scanAndSend() {
  const cfg = loadConfig();
  const state = loadState();
  const found = scanRoots({ roots: cfg.roots, maxDepth: cfg.maxDepth, knownIds: state.ids, extraFolders: cfg.folders });
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
      const r = await collectActivity({ listProcesses, withSessions: true });
      console.log(JSON.stringify(r.counts, null, 2));
      console.log(`listed sessions: ${r.list.length}, running: ${r.list.filter((s) => s.running).length}, with a real title: ${r.list.filter((s) => s.title !== s.folder).length}, subagents working: ${r.list.reduce((n, s) => n + s.subagentsActive, 0)}`);
      if (process.argv.includes('--titles')) console.log(JSON.stringify(r.list, null, 2));
      else console.log('(add --titles to print the list on your own console)');
      console.log('(read-only, nothing sent)');
    }
    else if (cmd === 'setup') await runSetup({ argv: process.argv.slice(3), deps: { getToken, setToken, readSecret: readSecretFromStdin, scanAndReport: scanAndSend, install } });
    else if (cmd === 'add-folder' || cmd === 'remove-folder') {
      const dir = process.argv[3];
      if (!dir) throw new Error(`usage: node worker.mjs ${cmd} "<folder path>"`);
      const cfg = loadConfig();
      if (cmd === 'add-folder') {
        const r = addFolder(readRawConfig(), dir, cfg);
        writeConfig(r.config);
        console.log(r.added ? `added ${r.real}` : `already added: ${r.real}`);
      } else {
        const r = removeFolder(readRawConfig(), dir);
        writeConfig(r.config);
        console.log(r.removed ? `removed ${dir}` : `was not in the list: ${dir}`);
      }
      console.log(`sent ${await scanAndSend()} folders; link it to a project in Work OS`);
    }
    else if (cmd === 'scan') {
      if (process.argv.includes('--dry')) {
        const cfg = loadConfig();
        const found = scanRoots({ roots: cfg.roots, maxDepth: cfg.maxDepth, knownIds: loadState().ids, extraFolders: cfg.folders });
        console.log(JSON.stringify(found.map(publicFolder), null, 2));
        console.log(`${found.length} folders (dry run, nothing sent)`);
      } else console.log(`sent ${await scanAndSend()} folders`);
    } else { console.error('usage: node worker.mjs [run|setup|set-token|install|uninstall|status|scan [--dry]|activity|add-folder <path>|remove-folder <path>]'); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
  if (cmd !== 'run') process.exit(0);
}
