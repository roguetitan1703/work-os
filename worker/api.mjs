import { checkBaseUrl } from './config.mjs';

export function makeApi(getCfg, getToken) {
  async function req(method, p, body) {
    const token = getToken();
    if (!token) throw new Error('no device key set (run: node worker.mjs set-token)');
    const base = checkBaseUrl(getCfg().baseUrl);
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(`HTTP ${res.status}${data && data.error ? ': ' + String(data.error).slice(0, 100) : ''}`);
    return data;
  }
  return {
    postFolders: (folders) => req('POST', '/api/worker/folders', { folders }),
    getJobs: () => req('GET', '/api/worker/jobs'),
    postStatus: (body) => req('POST', '/api/worker/status', body),
  };
}
