// A dispatched run's credentials (docs/ops/dispatcher.md "Run keys"). The dispatcher starts Claude Code on a task whose text can come
// from a teammate, so the run never gets its person's own Work OS credential:
//   - the worker asks the server for a run key (wdr_, POST /api/worker/run-key) just before a dispatched start or resume
//     (runFor), and refuses to start one without it;
//   - Claude Code runs with --strict-mcp-config and the run's own MCP config file (writeRunFiles) holding Work OS with that key
//     only, plus the person's other user MCP servers (any that point at Work OS or carry a Work OS credential are left out);
//   - and with --settings <file> that blank WORK_OS_KEY (and any variable holding a Work OS credential) in the person's settings
//     env block, which Claude Code would otherwise put in every command's environment;
//   - the wrapper (run-claude.mjs) drops the same variables from claude's own environment (scrubEnv);
//   - both files are deleted when claude exits (run-claude.mjs), and the worker sweeps any left by a crash (sweepRunConfigs).
// Node built-ins only (shipped in the worker bundle). Never prints a key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUN_DIR_NAME = 'work-os-run';
export const runDir = (base = os.tmpdir()) => path.join(base, RUN_DIR_NAME);
const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^run-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.settings)?\.json$/;
export const RUN_KEY_RE = /^wdr_[A-Za-z0-9_-]{43}$/;
/** A Work OS credential anywhere in a text: a Claude Code key, an OAuth token, a device key, a session token or a run key. */
const SECRET = /(?<![A-Za-z0-9])(?:wos|wosat|wkr|wst|wdr)_[A-Za-z0-9_-]{8,}/;
/** Variables that are removed from a dispatched run's environment whatever they hold. */
export const SCRUB_NAMES = ['WORK_OS_KEY'];

export const runConfigPath = (sessionId, dir = runDir()) => path.join(dir, `run-${String(sessionId).toLowerCase()}.json`);
export const runSettingsPath = (sessionId, dir = runDir()) => path.join(dir, `run-${String(sessionId).toLowerCase()}.settings.json`);

/** A copy of env without WORK_OS_KEY and without any variable whose value is a Work OS credential. */
export function scrubEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (SCRUB_NAMES.includes(k.toUpperCase()) || SECRET.test(String(out[k] ?? ''))) delete out[k];
  return out;
}

/**
 * The run's settings: a settings env block (the person's ~/.claude/settings.json, or the folder's .claude/settings.json and
 * .claude/settings.local.json) can set WORK_OS_KEY for every command Claude Code runs, so that name, and any name that holds a Work
 * OS credential in one of them, is set to empty for this run (--settings outranks all three).
 */
export function runSettings(home = os.homedir(), folder = null) {
  const env = Object.fromEntries(SCRUB_NAMES.map((k) => [k, '']));
  const files = [path.join(home, '.claude', 'settings.json'), ...(folder ? [path.join(folder, '.claude', 'settings.json'), path.join(folder, '.claude', 'settings.local.json')] : [])];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries((s && s.env) || {})) if (SECRET.test(String(v ?? ''))) env[k] = '';
    } catch {}
  }
  return { env };
}

/** The person's user-scope MCP servers (~/.claude.json mcpServers) other than Work OS: none named work-os, none on the Work OS host, none carrying a Work OS credential. */
export function otherServers(baseUrl, home = os.homedir()) {
  let host = '';
  try { host = new URL(baseUrl).host.toLowerCase(); } catch {}
  let all = {};
  try { all = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers || {}; } catch { return {}; }
  const out = {};
  for (const [name, cfg] of Object.entries(all)) {
    if (!cfg || typeof cfg !== 'object' || /^work-?os$/i.test(name)) continue;
    let h = '';
    try { h = cfg.url ? new URL(cfg.url).host.toLowerCase() : ''; } catch {}
    if ((h && h === host) || SECRET.test(JSON.stringify(cfg))) continue;
    out[name] = cfg;
  }
  return out;
}

/**
 * Writes the run's two files, readable by this user only: the MCP config (Work OS with the run key, plus otherServers) and the
 * settings (runSettings, for the run's folder). Returns their paths.
 */
export function writeRunFiles({ sessionId, baseUrl, key, dir = runDir(), home = os.homedir(), folder = null }) {
  if (!SID.test(String(sessionId || ''))) throw new Error('bad session id');
  if (!RUN_KEY_RE.test(String(key || ''))) throw new Error('bad run key');
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('bad base url');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mcpConfig = runConfigPath(sessionId, dir);
  const settings = runSettingsPath(sessionId, dir);
  const mcpServers = { ...otherServers(base, home), 'work-os': { type: 'http', url: base + '/api/mcp', headers: { Authorization: `Bearer ${key}` } } };
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers }, null, 1), { mode: 0o600 });
  fs.writeFileSync(settings, JSON.stringify(runSettings(home, folder), null, 1), { mode: 0o600 });
  return { mcpConfig, settings };
}

/** Deletes a run file: only a file named run-<session id>[.settings].json in a work-os-run folder (whatever path a command line held). */
export function removeRunConfig(file) {
  try {
    const f = path.resolve(String(file || ''));
    if (!FILE.test(path.basename(f)) || path.basename(path.dirname(f)) !== RUN_DIR_NAME) return false;
    fs.rmSync(f, { force: true });
    return true;
  } catch { return false; }
}

/**
 * Deletes the run files of sessions not in `keep` (a Set of session ids that still run): what a crash or a killed wrapper left.
 * A file younger than minAgeMs stays (a run being started right now is not in `keep` yet).
 */
export function sweepRunConfigs(keep, dir = runDir(), { minAgeMs = 120_000, now = Date.now() } = {}) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    const m = FILE.exec(f);
    if (!m || keep.has(m[1].toLowerCase())) continue;
    try { if (now - fs.statSync(path.join(dir, f)).mtimeMs < minAgeMs) continue; } catch { continue; }
    if (removeRunConfig(path.join(dir, f))) n++;
  }
  return n;
}

/**
 * The run key for a dispatched start or resume, from the server (api.runKey: POST /api/worker/run-key with the device key), or
 * null for a run that is not dispatched. Throws when a dispatched run cannot get one: it is then not started.
 */
export async function runFor(a, api) {
  if (a && a.run && RUN_KEY_RE.test(String(a.run.key || ''))) return { key: a.run.key }; // already asked (a reopen: askRun)
  if (!Number.isInteger(a && a.dispatched)) return null;
  let r;
  try { r = await askRun(api, a.sessionId); } catch (e) { throw new Error('no run key for this dispatched run, not started (' + String((e && e.message) || e).slice(0, 160) + ')'); }
  if (!r) throw new Error('no run key: the server does not know this as a dispatched run, not started');
  return { key: r.key };
}

/**
 * Asks the server whether `sessionId` is a dispatched run of this computer (POST /api/worker/run-key): { ref, key } for one (a fresh
 * run key; the server also moves an ended row back to starting), null for a session that is not one. Throws when it cannot tell (no
 * answer, a refusal, an answer of another shape): the caller then never opens it as an ordinary session.
 */
export async function askRun(api, sessionId) {
  if (!SID.test(String(sessionId || ''))) throw new Error('bad session id');
  if (!api || typeof api.runKey !== 'function') throw new Error('cannot ask the server whether this is a dispatched run');
  let r;
  try { r = await api.runKey(String(sessionId).toLowerCase()); } catch (e) { throw new Error('could not check whether this is a dispatched run (' + String((e && e.message) || e).slice(0, 120) + ')'); }
  if (r && r.dispatched === false && !('key' in r)) return null;
  if (r && RUN_KEY_RE.test(String(r.key || '')) && Number.isInteger(r.ref) && r.ref > 0) return { ref: r.ref, key: r.key };
  throw new Error('could not check whether this is a dispatched run (unexpected answer)');
}

/** One answer of the batched run-key call: { ref, key }, null (not a dispatched run), or { error } (refused or unreadable). */
function runAnswer(r) {
  if (r && r.dispatched === false && !('key' in r)) return null;
  if (r && RUN_KEY_RE.test(String(r.key || '')) && Number.isInteger(r.ref) && r.ref > 0) return { ref: r.ref, key: r.key };
  if (r && typeof r.refused === 'string') return { error: r.refused.slice(0, 120) };
  return { error: 'could not check whether this is a dispatched run (unexpected answer)' };
}

/**
 * askRun for several sessions in one request (Reopen all: up to 20, one device rate-limit hit): a Map of session id (lower case) to
 * { ref, key }, null or { error }; a session missing from the answer is { error }. Throws when the request fails, with `busy` set
 * when the server said too many requests (try again in a minute; nothing is refused).
 */
export async function askRuns(api, sessionIds) {
  const ids = [...new Set(sessionIds.map((s) => String(s || '').toLowerCase()))];
  if (!ids.length) return new Map();
  if (!ids.every((s) => SID.test(s))) throw new Error('bad session id');
  if (!api || typeof api.runKeys !== 'function') throw new Error('cannot ask the server whether these are dispatched runs');
  let r;
  try { r = await api.runKeys(ids); } catch (e) {
    const busy = !!e && e.status === 429;
    throw Object.assign(new Error(busy ? 'the server is busy, try Reopen all again in a minute' : 'could not check whether these are dispatched runs (' + String((e && e.message) || e).slice(0, 120) + ')'), { busy });
  }
  const runs = r && Array.isArray(r.runs) ? r.runs : [];
  const out = new Map();
  for (const sid of ids) {
    const a = runs.find((x) => x && typeof x.sessionId === 'string' && x.sessionId.toLowerCase() === sid);
    out.set(sid, a ? runAnswer(a) : { error: 'could not check whether this is a dispatched run (no answer)' });
  }
  return out;
}

/** Open in VS Code: true when the server knows `sessionId` as a dispatched run. Throws when it cannot say. Mints nothing. */
export async function isRun(api, sessionId) {
  if (!SID.test(String(sessionId || ''))) throw new Error('bad session id');
  if (!api || typeof api.runCheck !== 'function') throw new Error('cannot ask the server whether this is a dispatched run');
  let r;
  try { r = await api.runCheck(String(sessionId).toLowerCase()); } catch (e) { throw new Error('could not check whether this is a dispatched run (' + String((e && e.message) || e).slice(0, 120) + ')'); }
  if (r && typeof r.dispatched === 'boolean') return r.dispatched;
  throw new Error('could not check whether this is a dispatched run (unexpected answer)');
}

/** A launch failed after `key` was issued: the server ends the key and puts the row back. Best effort (a key nobody holds also dies at its TTL). */
export async function releaseRun(api, sessionId, key) {
  try {
    if (api && typeof api.runRelease === 'function' && RUN_KEY_RE.test(String(key || ''))) return !!(await api.runRelease(String(sessionId).toLowerCase(), key))?.released;
  } catch {}
  return false;
}

/** The run files a claude command line names (after --mcp-config and --settings), when they are ours. */
export function runFilesOf(args) {
  const out = [];
  for (const flag of ['--mcp-config', '--settings']) {
    const i = args.indexOf(flag);
    const f = i >= 0 ? args[i + 1] : null;
    if (f && FILE.test(path.basename(f)) && path.basename(path.dirname(f)) === RUN_DIR_NAME) out.push(f);
  }
  return out;
}
