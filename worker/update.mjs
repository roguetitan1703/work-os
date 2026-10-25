// Tells the person when Work OS serves a newer worker than the one running. It never downloads or changes code by
// itself: code from the server is never run without a person pasting the install command again (docs/launcher.md).
import { bundleId, checkBaseUrl } from './config.mjs';

const EVERY_MS = 6 * 3600_000;

// Returns { current, latest } when a downloaded bundle is older than the server's, else null (repo run, same, or unreachable).
export async function checkForUpdate({ baseUrl, fetchImpl = fetch, current = bundleId() }) {
  if (!current) return null;
  try {
    const res = await fetchImpl(checkBaseUrl(baseUrl) + '/worker/latest.json', { signal: AbortSignal.timeout(20000) });
    if (res.status !== 200) return null;
    const j = await res.json();
    if (typeof j.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(j.sha256) || j.sha256 === current) return null;
    return { current, latest: j.sha256, version: String(j.version ?? '').slice(0, 20) };
  } catch { return null; }
}

export function startUpdateCheck({ getBaseUrl, log, fetchImpl = fetch, current = bundleId(), every = EVERY_MS }) {
  if (!current) return null;
  let told = null;
  const once = async () => {
    const u = await checkForUpdate({ baseUrl: getBaseUrl(), fetchImpl, current });
    if (u && u.latest !== told) {
      told = u.latest;
      log(`a newer worker is available (${u.version || u.latest.slice(0, 12)}); to update, run the install command shown on Work OS under Claude, Setup, Computers again`);
    }
  };
  once();
  const t = setInterval(once, every);
  t.unref?.();
  return t;
}
