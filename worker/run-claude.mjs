// Runs claude inside a Windows Terminal tab: node run-claude.mjs <claudePath> <args...>
// stdio is inherited, no shell. Exits 0 when claude ends (even when Stop killed it) so wt closes the tab.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubEnv, runFilesOf, removeRunConfig } from './dispatch-run.mjs';

const argv = process.argv.slice(2);
const dm = /^--work-os-dispatched=([0-9]{1,9})$/.exec(argv[0] || ''); // a dispatcher-started run: the hooks read this (hook-pre-tool.mjs)
if (dm) argv.shift();
const [claudePath, ...args] = argv;
if (!claudePath) { console.error('usage: run-claude.mjs <claudePath> <args...>'); process.exit(2); }
process.on('SIGINT', () => {}); // Ctrl+C belongs to claude
// H15: a session the person ended (closed its window, or quit it: a clean exit) is not a crash. The worker reads this note when the process
// is gone and reports the session as stopped, so the dispatcher does not start the task again. A crash (a non-zero exit, no close) leaves none.
// Same folder as worker/core.mjs (endedDir). On Windows closing the console window raises SIGHUP here, with a few seconds to answer.
const sidOf = (() => { const i = args.findIndex((a) => a === '--session-id' || a === '--resume'); return /^[0-9a-f-]{36}$/i.test(args[i + 1] || '') ? args[i + 1].toLowerCase() : null; })();
function markEnded(why) {
  try {
    if (!sidOf) return;
    const dir = path.join(os.tmpdir(), 'work-os-ended');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sidOf), why);
  } catch {}
}
try { if (sidOf) fs.rmSync(path.join(os.tmpdir(), 'work-os-ended', sidOf), { force: true }); } catch {} // a note from an earlier run of this session is stale
// A dispatched run never sees its person's own Work OS credential (dispatch-run.mjs): WORK_OS_KEY and any variable holding a Work OS
// credential are dropped (the tab's environment may come from an already running Terminal; its --settings file blanks the same in the
// person's settings env block), and its own files (the MCP config with the run key, the settings) are deleted when claude ends.
const runFiles = dm ? runFilesOf(args) : [];
const cleanup = () => { for (const f of runFiles) removeRunConfig(f); };
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { markEnded('window closed'); cleanup(); process.exit(0); });
const env = dm ? scrubEnv(process.env) : { ...process.env };
delete env.WORK_OS_DISPATCHED; // never inherited from the terminal; only the worker's job sets it
if (dm) env.WORK_OS_DISPATCHED = dm[1];
const child = spawn(claudePath, args, { stdio: 'inherit', shell: false, env });
child.once('error', (e) => { console.error('could not start claude: ' + e.message); cleanup(); process.exit(1); });
child.once('exit', (code) => { if (code === 0) markEnded('clean exit'); cleanup(); process.exit(0); });
