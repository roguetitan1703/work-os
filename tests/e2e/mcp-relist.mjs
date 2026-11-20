// A Claude Code session reads the tool list once, when it connects (app/api/mcp/[[...key]]/route.ts). The server declares
// tools.listChanged and answers a Claude Code client's start_work and get_state as a short SSE stream: a
// notifications/tools/list_changed first, then the result, so the client reads tools/list again. Everything else stays JSON.
//   - initialize: capabilities.tools.listChanged
//   - a session that connected before a tool existed (E2E_HIDDEN_TOOL_FILE hides it) calls start_work: the notification comes
//     before the result, the client re-lists, and the new tool can be called
//   - start_work again (after a compaction) and get_state: the same
//   - a plain tools/call of another tool: JSON, as before
//   - a client that ignores the notification (SDK client without a handler, raw fetch): still gets the result
//   - the claude.ai connector (chat key, claude.ai OAuth): JSON; Claude Code over OAuth: the stream
//   - the Work OS hook (X-Work-OS-Hook), callers without Mcp-Protocol-Version (installed hooks, raw scripts) and clients
//     whose User-Agent is not Claude Code's (other apps and scripts on a Claude Code key or OAuth client): JSON
//   - parallel start_works all answer, and pooled servers keep working after a stream
// Seed profile: none.
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { B, MCP, ME, check, finish, mkKey, rawDb } from './lib.mjs';
import { mkOAuth, must } from './flow-lib.mjs';

const HIDE = process.env.E2E_HIDDEN_TOOL_FILE;
const NEW = 'list_notes';
const P = 'RL Alpha';
const hide = name => fs.writeFileSync(HIDE, name);
const show = () => fs.rmSync(HIDE, { force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SSE = 'text/event-stream';
/** What Claude Code sends (claude-code/2.1.327 (claude-desktop, agent-sdk/0.3.325) on this PC, 20 Nov). */
const CC_UA = 'claude-code/2.1.327 (cli)';
const JSONT = 'application/json';

/** A client like Claude Code: on list_changed it reads tools/list again (unless relist is false). Logs each POST and its answer type. */
async function session(key, { relist = true, ua = CC_UA } = {}) {
  const log = [];
  const client = new Client({ name: 'relist-probe', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(B + '/api/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${key}`, ...(ua ? { 'user-agent': ua } : {}) } },
    fetch: async (url, init) => {
      let body = null;
      try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { /* not JSON */ }
      const r = await fetch(url, init);
      log.push({ method: init?.method ?? 'GET', rpc: body?.method, tool: body?.params?.name, type: (r.headers.get('content-type') || '').split(';')[0] });
      return r;
    },
  });
  const s = { client, transport, log, tools: [], notes: [], pending: 0 };
  if (relist) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      s.notes.push({ duringCall: s.pending > 0 });
      s.tools = (await client.listTools()).tools.map(t => t.name);
    });
  }
  await client.connect(transport);
  s.tools = (await client.listTools()).tools.map(t => t.name);
  s.call = async (name, args = {}) => {
    s.pending++;
    try { return await client.callTool({ name, arguments: args }); } finally { s.pending--; }
  };
  return s;
}
const textOf = r => r?.content?.[0]?.text ?? '';
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(50); return fn(); };
const lastPost = (s, rpc, tool) => s.log.findLastIndex(l => l.method === 'POST' && l.rpc === rpc && (!tool || l.tool === tool));

/** One raw POST: the answer type and every JSON-RPC message in it (SSE data lines in order, or the one JSON body). */
let rid = 0;
async function raw(key, name, args = {}, headers = {}) {
  const id = ++rid;
  const r = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': JSONT, accept: `${JSONT}, ${SSE}`, authorization: `Bearer ${key}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await r.text();
  const type = (r.headers.get('content-type') || '').split(';')[0];
  let msgs = [];
  try { msgs = type === SSE ? text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))) : [JSON.parse(text)]; } catch { /* unreadable */ }
  const result = msgs.find(m => m.id === id);
  return { status: r.status, type, msgs, id, result, text: result?.result?.content?.[0]?.text ?? '' };
}
const PV = { 'mcp-protocol-version': '2025-06-18', 'user-agent': CC_UA };
const isListChanged = m => m?.method === 'notifications/tools/list_changed' && m.id === undefined;

/** An OAuth token from a client that is not claude.ai's (so the route treats it as Claude Code). */
async function mkCodeOAuth() {
  const clientId = 'rloauth' + randomBytes(5).toString('hex');
  const tok = randomBytes(24).toString('base64url');
  const now = new Date();
  await rawDb.collection('oauthClient').insertOne({ clientId, name: 'Claude Code (test)', redirectUris: ['http://localhost:47111/callback'], disabled: false, scopes: ['workos', 'offline_access'], grantTypes: ['authorization_code', 'refresh_token'], tokenEndpointAuthMethod: 'none', createdAt: now, updatedAt: now });
  await rawDb.collection('oauthAccessToken').insertOne({ token: createHash('sha256').update(tok, 'utf8').digest('base64url'), clientId, userId: ME.userId, referenceId: ME.orgId, scopes: ['workos'], resources: [`${B}/api/mcp`], createdAt: now, expiresAt: new Date(Date.now() + 3_600_000), revoked: null });
  return 'wosat_' + tok;
}

const sessions = [];
try {
  check('the e2e server has the hidden-tool switch (E2E_HIDDEN_TOOL_FILE)', !!HIDE, 'run through tests/e2e/run.sh');
  const cc = await mkKey({ agent: 'claude-code', name: 'RL cc' });
  await must(MCP, 'add_project', { name: P, visibility: 'org' });

  // ---- 1. a session that connected before the tool existed ----
  hide(NEW);
  const a = await session(cc);
  sessions.push(a);
  check('1: initialize says tools.listChanged', a.client.getServerCapabilities()?.tools?.listChanged === true, JSON.stringify(a.client.getServerCapabilities()?.tools));
  check(`1: connected while ${NEW} is hidden: its list has no ${NEW}`, a.tools.length > 10 && !a.tools.includes(NEW), a.tools.length);
  const before = await a.call(NEW, {}).catch(e => ({ isError: true, content: [{ text: String(e?.message || e) }] }));
  check(`1: calling ${NEW} then is refused`, before.isError === true, textOf(before).slice(0, 120));
  show(); // the server now has the tool; the session's list does not
  const l0 = a.log.length;
  const sw = await a.call('start_work', { project: P, session: 'rlA1' });
  const sj = JSON.parse(textOf(sw) || 'null');
  check('1: start_work answers its brief', !sw.isError && sj?.project?.name === P, textOf(sw).slice(0, 200));
  const swPost = lastPost(a, 'tools/call', 'start_work');
  check('1: start_work is answered as SSE', a.log[swPost]?.type === SSE, JSON.stringify(a.log[swPost]));
  check('1: the list_changed notification came before the result', a.notes.length === 1 && a.notes[0].duringCall === true, JSON.stringify(a.notes));
  await until(() => a.tools.includes(NEW));
  const relisted = a.log.slice(l0).some((l, i) => l0 + i > swPost && l.rpc === 'tools/list');
  check('1: the client read tools/list again after start_work', relisted, JSON.stringify(a.log.slice(l0)));
  check(`1: its list now has ${NEW}`, a.tools.includes(NEW), a.tools.length);
  const after = await a.call(NEW, {});
  check(`1: and ${NEW} can be called`, !after.isError && /notes/.test(textOf(after)), textOf(after).slice(0, 160));

  // ---- 2. start_work again (after a compaction), get_state ----
  const again = await a.call('start_work', { project: P, session: 'rlA1' });
  check('2: start_work again (after a compaction): answered, a second notification before the result', !again.isError && a.notes.length === 2 && a.notes[1].duringCall && a.log[lastPost(a, 'tools/call', 'start_work')]?.type === SSE, JSON.stringify(a.notes));
  const gs = await a.call('get_state', { project: P });
  check('2: get_state: answered as SSE with the notification first', !gs.isError && JSON.parse(textOf(gs))?.project === P && a.notes.length === 3 && a.notes[2].duringCall && a.log[lastPost(a, 'tools/call', 'get_state')]?.type === SSE, textOf(gs).slice(0, 160));

  // ---- 3. a plain tools/call of another tool stays JSON ----
  const lp = await a.call('list_projects', {});
  check('3: list_projects from the same client: one JSON answer, no notification', !lp.isError && a.log[lastPost(a, 'tools/call', 'list_projects')]?.type === JSONT && a.notes.length === 3, JSON.stringify(a.log[lastPost(a, 'tools/call', 'list_projects')]));
  const tl = a.log.filter(l => l.rpc === 'tools/list' || l.rpc === 'initialize');
  check('3: initialize and tools/list are JSON', tl.length >= 2 && tl.every(l => l.type === JSONT), JSON.stringify(tl));
  const rp = await raw(cc, 'list_projects', {}, PV);
  check('3: list_projects raw with Mcp-Protocol-Version: JSON, one message', rp.status === 200 && rp.type === JSONT && rp.msgs.length === 1 && !!rp.result?.result, `${rp.status} ${rp.type}`);

  // ---- 4. a client that ignores the notification ----
  const b = await session(cc, { relist: false });
  sessions.push(b);
  const bs = await b.call('start_work', { project: P, session: 'rlB1' });
  check('4: an SDK client without a handler still gets the start_work result', !bs.isError && JSON.parse(textOf(bs))?.project?.name === P && b.log[lastPost(b, 'tools/call', 'start_work')]?.type === SSE, textOf(bs).slice(0, 160));
  const rs = await raw(cc, 'start_work', { project: P, session: 'rlR1' }, PV);
  check('4: raw: the stream is the notification, then the result (and nothing else)', rs.status === 200 && rs.type === SSE && rs.msgs.length === 2 && isListChanged(rs.msgs[0]) && rs.msgs[1].id === rs.id && JSON.parse(rs.text)?.project?.name === P, JSON.stringify(rs.msgs.map(m => m.method ?? m.id)));
  const rg = await raw(cc, 'get_state', { project: P }, PV);
  check('4: raw get_state: notification, then the result', rg.type === SSE && rg.msgs.length === 2 && isListChanged(rg.msgs[0]) && JSON.parse(rg.text)?.project === P, JSON.stringify(rg.msgs.map(m => m.method ?? m.id)));
  const re = await raw(cc, 'start_work', { project: 'RL No Such Project', session: 'rlR2' }, PV);
  check('4: start_work for an unknown project comes the same way (notification, then its answer)', re.type === SSE && re.msgs.length === 2 && isListChanged(re.msgs[0]) && !!re.result?.result, re.text.slice(0, 160));

  // ---- 5. the claude.ai connector and OAuth ----
  const chatSw = await raw(MCP, 'start_work', { project: P }, PV);
  check('5: chat key (claude.ai connector) start_work: one JSON answer, as before', chatSw.status === 200 && chatSw.type === JSONT && chatSw.msgs.length === 1 && !!chatSw.result?.result, `${chatSw.type} ${chatSw.text.slice(0, 120)}`);
  const chatGs = await raw(MCP, 'get_state', { project: P }, PV);
  check('5: chat key get_state: JSON', chatGs.type === JSONT && JSON.parse(chatGs.text)?.project === P, chatGs.type);
  const oa = await mkOAuth({ userId: ME.userId, orgId: ME.orgId, name: 'RL claude.ai' });
  const oaSw = await raw(oa, 'start_work', { project: P }, PV);
  check('5: claude.ai OAuth start_work: JSON', oaSw.status === 200 && oaSw.type === JSONT && oaSw.msgs.length === 1 && !!oaSw.result?.result, `${oaSw.status} ${oaSw.type}`);
  const oaS = await session(oa);
  sessions.push(oaS);
  await oaS.call('start_work', { project: P });
  check('5: claude.ai OAuth through the SDK client: no notification, JSON', oaS.notes.length === 0 && oaS.log[lastPost(oaS, 'tools/call', 'start_work')]?.type === JSONT, JSON.stringify(oaS.log.slice(-1)));
  const co = await mkCodeOAuth();
  const coSw = await raw(co, 'start_work', { project: P, session: 'rlO1' }, PV);
  check('5: Claude Code over OAuth: start_work gets the stream', coSw.status === 200 && coSw.type === SSE && isListChanged(coSw.msgs[0]) && JSON.parse(coSw.text)?.project?.name === P, `${coSw.status} ${coSw.type}`);
  const url = await fetch(B + '/api/mcp/' + MCP, { method: 'POST', headers: { 'content-type': JSONT, accept: `${JSONT}, ${SSE}`, ...PV }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_work', arguments: { project: P } } }) });
  check('5: key in the URL (off here): still 401, never a stream', url.status === 401 && !(url.headers.get('content-type') || '').startsWith(SSE), url.status);

  // ---- 6. the Work OS hook and raw callers ----
  const hk = await raw(cc, 'start_work', { project: P, session: 'rlH1' }, { ...PV, 'x-work-os-hook': '3' });
  check('6: the hook (X-Work-OS-Hook) start_work: JSON, so installed hooks read the answer', hk.type === JSONT && hk.msgs.length === 1 && JSON.parse(hk.text)?.project?.name === P, hk.type);
  const np = await raw(cc, 'start_work', { project: P, session: 'rlN1' });
  check('6: no Mcp-Protocol-Version (raw scripts, old hooks): JSON', np.type === JSONT && np.msgs.length === 1 && JSON.parse(np.text)?.project?.name === P, np.type);
  const ua = await raw(cc, 'start_work', { project: P, session: 'rlU1' }, { ...PV, 'user-agent': 'my-script/1.0' });
  check('6: Mcp-Protocol-Version but another User-Agent (another app or script on the key): JSON', ua.type === JSONT && ua.msgs.length === 1 && JSON.parse(ua.text)?.project?.name === P, ua.type);
  const sdk = await session(cc, { ua: null });
  sessions.push(sdk);
  await sdk.call('start_work', { project: P, session: 'rlU2' });
  check('6: the SDK client with its own User-Agent: start_work is JSON, no notification', sdk.notes.length === 0 && sdk.log[lastPost(sdk, 'tools/call', 'start_work')]?.type === JSONT, JSON.stringify(sdk.log.slice(-1)));
  const batch = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'content-type': JSONT, accept: `${JSONT}, ${SSE}`, authorization: `Bearer ${cc}`, ...PV }, body: JSON.stringify([{ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'start_work', arguments: { project: P, session: 'rlBt' } } }]) });
  check('6: a batch is never streamed', (batch.headers.get('content-type') || '').startsWith(JSONT) || batch.status >= 400, `${batch.status} ${batch.headers.get('content-type')}`);
  await batch.text();

  // ---- 7. parallel streams and the pool ----
  const par = await Promise.all([1, 2, 3, 4, 5].map(i => raw(cc, 'start_work', { project: P, session: `rlP${i}` }, PV)));
  check('7: 5 start_works at once: each a stream with the notification, then its own result', par.every(r => r.status === 200 && r.type === SSE && isListChanged(r.msgs[0]) && JSON.parse(r.text)?.project?.name === P), JSON.stringify(par.map(r => `${r.status} ${r.type} ${r.msgs.length}`)));
  const afterPar = await Promise.all([1, 2, 3].map(() => raw(cc, 'list_projects', {}, PV)));
  check('7: pooled servers answer plain calls after the streams', afterPar.every(r => r.status === 200 && r.type === JSONT && !!r.result?.result), JSON.stringify(afterPar.map(r => r.status)));
  // A client that drops the stream before the result: the server is closed, not kept, and the next calls still work.
  const ac = new AbortController();
  const drop = fetch(B + '/api/mcp', { method: 'POST', signal: ac.signal, headers: { 'content-type': JSONT, accept: `${JSONT}, ${SSE}`, authorization: `Bearer ${cc}`, ...PV }, body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'get_state', arguments: { project: P } } }) }).then(r => r.body?.getReader().read()).catch(() => null);
  await sleep(5);
  ac.abort();
  await drop;
  await sleep(300);
  const afterDrop = await raw(cc, 'start_work', { project: P, session: 'rlD1' }, PV);
  check('7: after a dropped stream the next start_work still answers', afterDrop.type === SSE && JSON.parse(afterDrop.text)?.project?.name === P, afterDrop.text.slice(0, 120));
} catch (e) {
  check('suite ran without an error', false, e?.stack || String(e));
} finally {
  show();
  for (const s of sessions) await s.transport.close().catch(() => {});
}
await finish();
