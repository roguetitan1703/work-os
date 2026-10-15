import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
  if (process.env.WORK_OS_WORKER_DIR) return process.env.WORK_OS_WORKER_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'work-os-worker');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'work-os-worker');
  return path.join(os.homedir(), '.config', 'work-os-worker');
}
export const configPath = () => path.join(configDir(), 'config.json');
export const statePath = () => path.join(configDir(), 'state.json');

const DEFAULTS = { baseUrl: '', deviceName: os.hostname(), roots: [], enabled: true, allowPrompts: true, scanEveryMinutes: 15, maxDepth: 6 };

export function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...c };
  cfg.roots = Array.isArray(cfg.roots) ? cfg.roots.filter((r) => typeof r === 'string' && r) : [];
  return cfg;
}

export function checkBaseUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error('baseUrl is not a valid URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('baseUrl must be https (http only for localhost)');
  return url.origin;
}

export function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch {}
  return { ids: {}, folders: {}, sessions: {}, markers: {}, doneJobs: [], lastPoll: null, lastScan: null, ...s };
}
export function saveState(state) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}
