// Smoke-test the MCP endpoint the same way claude.ai will call it.
//
//   node scripts/test-mcp.mjs https://your-app.vercel.app/api/mcp/<MCP_TOKEN>
//   node scripts/test-mcp.mjs http://localhost:3000/api/mcp <MCP_TOKEN>      (token as Bearer header)
//   add --write to also create a test task, log progress and complete it.

const [url, token] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const write = process.argv.includes('--write');
if (!url) {
  console.error('usage: node scripts/test-mcp.mjs <mcp-url> [token] [--write]');
  process.exit(1);
}

let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`${method} → ${JSON.stringify(body.error)}`);
  return body.result;
}

async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'work-os-smoke-test', version: '1' },
});
console.log(`✓ initialize: ${init.serverInfo.name} ${init.serverInfo.version} (protocol ${init.protocolVersion})`);

const { tools } = await rpc('tools/list', {});
console.log(`✓ tools/list: ${tools.map(t => t.name).join(', ')}`);

const s = await call('daily_summary');
console.log(`✓ daily_summary ${s.date} (${s.timezone}):`, s.counts);

const list = await call('list_tasks', { limit: 5 });
console.log(`✓ list_tasks: ${list.total} open; top: ${list.tasks.map(t => `#${t.ref} ${t.title}`).join(' | ') || '—'}`);

const projects = await call('list_projects');
console.log(`✓ list_projects: ${projects.length} active`);

if (write) {
  const { created } = await call('add_task', {
    title: 'MCP smoke test (safe to drop)',
    priority: 'P4',
    due: 'tomorrow',
    checklist: ['one', 'two'],
    note: 'Created by scripts/test-mcp.mjs',
  });
  console.log(`✓ add_task → #${created.ref} ${created.url}`);
  await call('log_progress', { task: created.ref, progress: 40, note: 'halfway-ish' });
  await call('update_checklist', { task: created.ref, check: [1] });
  await call('complete_task', { task: created.ref, note: 'smoke test passed' });
  const full = await call('get_task', { task: `#${created.ref}` });
  console.log(`✓ history for #${created.ref}:`);
  for (const a of full.activity.reverse()) console.log(`    ${a.at}  ${a.by.padEnd(6)} ${a.text}`);
  await call('update_task', { task: created.ref, status: 'Dropped', note: 'cleanup after smoke test' });
}

console.log('\nAll good.');
