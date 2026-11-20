import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function configDir() {
  if (process.env.WORK_OS_WORKER_DIR) return process.env.WORK_OS_WORKER_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'work-os-worker');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'work-os-worker');
  return path.join(os.homedir(), '.config', 'work-os-worker');
}
export const configPath = (dir = configDir()) => path.join(dir, 'config.json');
export const statePath = () => path.join(configDir(), 'state.json');

const DEFAULTS = { baseUrl: '', deviceName: os.hostname(), roots: [], enabled: true, allowPrompts: true, allowClone: true, scanEveryMinutes: 15, maxDepth: 6 };

/** `dir`: the worker's config folder (default configDir(); the hook passes the one it was installed into). */
export function loadConfig(dir) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configPath(dir), 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...c };
  cfg.roots = Array.isArray(cfg.roots) ? cfg.roots.filter((r) => typeof r === 'string' && r) : [];
  return cfg;
}

// Which downloaded bundle this code was unpacked from (first 12 hex of its sha256), or null when run from the repo.
export function bundleId(dir = path.dirname(fileURLToPath(import.meta.url))) {
  try { const s = fs.readFileSync(path.join(dir, 'BUNDLE'), 'utf8').trim(); return /^[0-9a-f]{64}$/.test(s) ? s : null; } catch { return null; }
}

/** The version of the downloaded release this code was unpacked from (worker/RELEASE, written by the loader), or null (repo run, or a bundle from before 0.5.0). */
export function releaseVersion(dir = path.dirname(fileURLToPath(import.meta.url))) {
  try { const s = fs.readFileSync(path.join(dir, 'RELEASE'), 'utf8').trim(); return /^\d{1,9}(\.\d{1,9}){0,3}$/.test(s) ? s : null; } catch { return null; }
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
