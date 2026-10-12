// Import the old local data/tasks.json into the deployed app's MongoDB, over HTTPS.
// The app does the work (lib/legacy-import.ts), so no database credentials are needed here.
//
//   node scripts/migrate-from-json.mjs https://<app>.vercel.app <MCP_TOKEN> --dry-run
//   node scripts/migrate-from-json.mjs https://<app>.vercel.app <MCP_TOKEN>
//   (optional 3rd arg: path to tasks.json, default data/tasks.json)
//
// Safe to re-run: existing tasks are never overwritten, refs are kept.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
const [base, token, file = path.join(process.cwd(), 'data', 'tasks.json')] = args;
if (!base || !token) {
  console.error('usage: node scripts/migrate-from-json.mjs <app-url> <MCP_TOKEN> [tasks.json] [--dry-run]');
  process.exit(1);
}

const body = fs.readFileSync(file, 'utf-8');
const url = `${base.replace(/\/+$/, '')}/api/admin/import${dryRun ? '?dryRun=1' : ''}`;
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body,
});
const text = await res.text();
let r;
try {
  r = JSON.parse(text);
} catch {
  console.error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
if (!res.ok && res.status !== 207) {
  console.error(`HTTP ${res.status}:`, r);
  process.exit(1);
}

console.log(`Source: ${r.source.tasks} tasks, ${r.source.reviews} reviews, ${r.source.ritualLogs} ritual logs`);
console.log(`Projects: ${r.projects.length} (${r.projects.filter(p => p.isNew).length} new)`);
for (const p of r.projects) console.log(`  ${p.id.padEnd(28)} ${p.name} (${p.tasks} tasks)${p.isNew ? '' : '  [exists]'}`);
console.log(`Tasks: ${r.tasks.total} (${r.tasks.new} new, ${r.tasks.alreadyInDb} already in DB)`);
console.log(`Activity entries: ${r.activityEntries}`);
if (r.dryRun) {
  console.log('\nDry run: nothing written.');
} else {
  const v = r.verified;
  console.log(`\nVerified ${v.tasks}/${r.source.tasks} tasks, ${v.reviews}/${r.source.reviews} reviews, ${v.ritualLogs}/${r.source.ritualLogs} ritual logs.`);
}
if (r.problems.length) {
  console.error('PROBLEMS:\n  ' + r.problems.join('\n  '));
  process.exitCode = 1;
} else if (!r.dryRun) {
  console.log('OK: every source record is in MongoDB.');
}
