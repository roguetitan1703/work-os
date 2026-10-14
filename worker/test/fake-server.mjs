import http from 'node:http';

export const TEST_TOKEN = 'wkr_' + 'A'.repeat(43);

// Minimal fake of the three /api/worker endpoints from docs/launcher.md.
export async function startFakeServer() {
  const s = { folders: null, links: [], jobs: [], statuses: [], badAuth: 0, enabled: true };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) { s.badAuth++; return send(401, { error: 'unauthorized' }); }
      const data = body ? JSON.parse(body) : null;
      if (req.method === 'POST' && req.url === '/api/worker/folders') {
        s.folders = data.folders;
        return send(200, { ok: true, known: data.folders.length, missing: 0 });
      }
      if (req.method === 'GET' && req.url === '/api/worker/jobs') {
        const jobs = s.jobs; s.jobs = []; // handed out once
        return send(200, { enabled: s.enabled, pollSeconds: 10, links: s.links, jobs });
      }
      if (req.method === 'POST' && req.url === '/api/worker/status') {
        s.statuses.push(data);
        return send(200, { ok: true });
      }
      send(400, { error: 'bad request' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}`;
  s.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return s;
}
