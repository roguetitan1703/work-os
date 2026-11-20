// Probe with a REAL Claude Code (not in the default list: it needs `claude` signed in and spends a few model calls).
//   E2E_MCP_TRACE=1 E2E_LOGS=<dir> E2E_EXTRA='claude-relist|probe-claude-relist.mjs|none|plain' tests/e2e/run.sh claude-relist
// Claude Code connects while list_notes is hidden (E2E_HIDDEN_TOOL_FILE), calls list_projects; the probe then shows the tool
// (the server "gained" it) and Claude Code calls start_work. Its answer carries notifications/tools/list_changed
// (app/api/mcp/[[...key]]/route.ts): Claude Code must read tools/list again and be able to call list_notes. The server's
// trace lines (E2E_MCP_TRACE) are the evidence. Claude Code runs with --strict-mcp-config, only project settings (none: no
// hooks of this PC), in a temp folder, against the throwaway server with a test key. Seed profile: none.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { B, MCP, check, finish, mkKey } from './lib.mjs';
import { must } from './flow-lib.mjs';

const HIDE = process.env.E2E_HIDDEN_TOOL_FILE;
const LOG = process.env.E2E_SERVER_LOG;
const NEW = 'list_notes';
const P = 'RL Probe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const traceSince = from => fs.readFileSync(LOG, 'utf8').slice(from).split('\n').filter(l => l.includes('[mcp trace] claude-code'));

let dir = '';
try {
  check('run with E2E_MCP_TRACE=1 through run.sh', !!HIDE && !!LOG && process.env.E2E_MCP_TRACE === '1');
  const cc = await mkKey({ agent: 'claude-code', name: 'RL probe cc' });
  await must(MCP, 'add_project', { name: P, visibility: 'org' });
  dir = fs.mkdtempSync(path.join(path.dirname(HIDE), 'claude-'));
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { 'work-os': { type: 'http', url: B + '/api/mcp', headers: { Authorization: `Bearer ${cc}` } } } }));
  fs.writeFileSync(HIDE, NEW);
  const from = fs.readFileSync(LOG, 'utf8').length;
  const prompt = [
    'You are testing an MCP server named work-os. Do these steps in order, one tool call at a time, and nothing else:',
    '1) Call the work-os tool list_projects.',
    `2) Call the work-os tool start_work with project "${P}" and session "rlc1".`,
    `3) Call the work-os tool list_notes with project "${P}".`,
    'If after step 2 you have no list_notes tool (look with tool search too, if you have it), reply exactly NO_LIST_NOTES and stop.',
    'Otherwise reply DONE and how many notes list_notes returned.',
  ].join('\n');
  const args = ['-p', prompt, '--strict-mcp-config', '--mcp-config', cfg, '--setting-sources', 'project', '--allowedTools', 'mcp__work-os', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'sonnet'];
  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: dir, env: { ...process.env, WORK_OS_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (err += d));
  const exited = new Promise(r => child.on('close', code => r(code)));
  // Show the tool once Claude Code made its first call (it connected and listed tools while the tool was hidden).
  let shown = false;
  const t0 = Date.now();
  let code = null;
  const kill = setTimeout(() => child.kill(), 300_000);
  for (;;) {
    if (!shown && traceSince(from).some(l => l.includes('tools/call list_projects'))) {
      fs.rmSync(HIDE, { force: true });
      shown = true;
      console.log(`  shown ${NEW} after ${Date.now() - t0} ms`);
    }
    const done = await Promise.race([exited, sleep(100).then(() => undefined)]);
    if (done !== undefined) { code = done; break; }
  }
  clearTimeout(kill);
  const trace = traceSince(from);
  console.log('  server trace (claude-code requests, in order):');
  for (const l of trace) console.log('    ' + l.replace(/^.*\[mcp trace\] /, ''));
  const events = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  const uses = events.flatMap(e => (e.type === 'assistant' ? (e.message?.content ?? []).filter(c => c.type === 'tool_use').map(c => c.name) : []));
  const results = events.flatMap(e => (e.type === 'user' ? (e.message?.content ?? []).filter(c => c.type === 'tool_result') : []));
  const final = events.find(e => e.type === 'result');
  console.log(`  claude exit ${code}; version ${init?.claude_code_version ?? '?'}; tool calls: ${uses.join(', ')}`);
  console.log(`  init tools with ${NEW}: ${init?.tools?.includes(`mcp__work-os__${NEW}`)}; mcp servers: ${JSON.stringify(init?.mcp_servers)}`);
  console.log(`  final: ${String(final?.result ?? err.slice(0, 300)).slice(0, 300)}`);
  const idx = re => trace.findIndex(l => re.test(l));
  const iSw = idx(/tools\/call start_work -> sse\+list_changed/);
  const iList = trace.findIndex((l, i) => i > iSw && /tools\/list/.test(l));
  const iNew = trace.findIndex((l, i) => i > iSw && l.includes(`tools/call ${NEW}`));
  check('Claude Code connected and listed tools while the tool was hidden', idx(/tools\/list/) >= 0 && idx(/tools\/list/) < iSw && shown);
  check(`its first tool list had no ${NEW}`, !init?.tools?.includes(`mcp__work-os__${NEW}`), JSON.stringify(init?.tools?.filter(t => t.startsWith('mcp__work-os')).length));
  check('start_work was answered as SSE with list_changed', iSw >= 0, trace.join(' | '));
  check('Claude Code read tools/list again after start_work', iList > iSw, trace.join(' | '));
  check(`Claude Code then called ${NEW}`, iNew > iList && uses.includes(`mcp__work-os__${NEW}`), uses.join(','));
  const newResult = results.find(r => r.tool_use_id === events.flatMap(e => (e.type === 'assistant' ? e.message?.content ?? [] : [])).find(c => c.type === 'tool_use' && c.name === `mcp__work-os__${NEW}`)?.id);
  check(`${NEW} answered without an error`, !!newResult && !newResult.is_error, JSON.stringify(newResult)?.slice(0, 200));
} catch (e) {
  check('probe ran without an error', false, e?.stack || String(e));
} finally {
  if (HIDE) fs.rmSync(HIDE, { force: true });
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
await finish();
