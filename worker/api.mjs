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
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}${data && data.error ? ': ' + String(data.error).slice(0, 100) : ''}`), { status: res.status });
    return data;
  }
  return {
    postFolders: (folders) => req('POST', '/api/worker/folders', { folders }),
    getJobs: () => req('GET', '/api/worker/jobs'),
    postStatus: (body) => req('POST', '/api/worker/status', body),
    // A dispatched run's own Work OS key (dispatch-run.mjs runFor): { key, expiresAt }. Never logged.
    runKey: (sessionId) => req('POST', '/api/worker/run-key', { sessionId }),
    // Reopen all: the same for up to 20 sessions in one request ({ runs: [...] }).
    runKeys: (sessionIds) => req('POST', '/api/worker/run-key', { sessionIds }),
    // Open in VS Code: is it a dispatched run? ({ dispatched }); mints nothing.
    runCheck: (sessionId) => req('POST', '/api/worker/run-key', { sessionId, check: true }),
    // A launch failed after its key was issued: the key dies and the row goes back.
    runRelease: (sessionId, key) => req('POST', '/api/worker/run-key', { sessionId, release: key }),
  };
}
