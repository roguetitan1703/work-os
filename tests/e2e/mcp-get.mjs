// /api/mcp offers no standalone SSE stream (stateless, JSON responses), so GET and DELETE answer 405 + Allow: POST and an MCP
// client stops asking. Before the fix GET opened a stream that closed at once and clients reconnected ~1/s forever.
//   - GET (Accept: text/event-stream) -> 405 + Allow: POST + a JSON-RPC error body, closed at once, for any credential sent
//   - POST without a credential still gets the 401 + WWW-Authenticate challenge (OAuth discovery depends on it)
//   - the real SDK client (connect, list tools, idle 10 s) makes at most 1 GET
// Seed profile: none.
import { B, MCP, check, finish, mkKey } from './lib.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sse = { accept: 'text/event-stream', 'mcp-protocol-version': '2025-06-18' };
try {
  const kCode = await mkKey({ agent: 'claude-code', name: 'get probe' });
  for (const [label, key] of [['chat key', MCP], ['claude-code key', kCode], ['a bad key', 'wos_notakey0000000000']]) {
    for (const method of ['GET', 'DELETE']) {
      const t0 = Date.now();
      const r = await fetch(B + '/api/mcp', { method, headers: { ...sse, ...(key ? { authorization: `Bearer ${key}` } : {}) } });
      const body = await Promise.race([r.text(), sleep(5000).then(() => '<<still open after 5s>>')]);
      const ms = Date.now() - t0;
      console.log(`  ${label} ${method}: status ${r.status}, content-type ${r.headers.get('content-type')}, body closed after ${ms} ms`);
      check(`${label}: ${method} -> 405`, r.status === 405, r.status);
      check(`${label}: ${method} Allow: POST`, r.headers.get('allow') === 'POST', r.headers.get('allow'));
      check(`${label}: ${method} JSON-RPC error body, closed at once`, /"jsonrpc":"2.0"/.test(body) && /"error"/.test(body) && ms < 3000, body.slice(0, 120));
    }
  }
  const nc = await fetch(B + '/api/mcp', { method: 'GET', headers: sse });
  check('GET with no credential at all: 401 + WWW-Authenticate challenge (discovery)', nc.status === 401 && /resource_metadata=/.test(nc.headers.get('www-authenticate') || ''), nc.status);
  const u = await fetch(B + '/api/mcp/' + MCP, { method: 'GET', headers: sse });
  check('key in the URL: GET -> 405 too', u.status === 405, u.status);
  const p = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('POST without a credential: 401 + WWW-Authenticate challenge', p.status === 401 && /resource_metadata=/.test(p.headers.get('www-authenticate') || ''), `${p.status} ${p.headers.get('www-authenticate')}`);
  const p2 = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${kCode}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('POST with a key still works', p2.status === 200, p2.status);

  // The real client: how many GETs does it send in 10 s?
  const seen = [];
  const client = new Client({ name: 'get-probe', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(B + '/api/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${kCode}` } },
    fetch: (url, init) => { seen.push(init?.method || 'GET'); return fetch(url, init); },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  await sleep(10_000);
  const gets = seen.filter(m => m === 'GET').length;
  console.log(`  SDK client: ${seen.length} requests in ~10 s (${seen.join(',')}), GETs ${gets}`);
  check('SDK client lists tools', tools.tools.length > 0, tools.tools.length);
  check('SDK client idle 10 s sends at most 1 GET', gets <= 1, `${gets} GETs`);
  await transport.close().catch(() => {});
} catch (e) {
  check('suite ran without an error', false, e?.stack || String(e));
}
await finish();
