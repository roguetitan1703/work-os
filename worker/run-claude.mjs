// Runs claude inside a Windows Terminal tab: node run-claude.mjs <claudePath> <args...>
// stdio is inherited, no shell. Exits 0 when claude ends (even when Stop killed it) so wt closes the tab.
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const dm = /^--work-os-dispatched=([0-9]{1,9})$/.exec(argv[0] || ''); // a dispatcher-started run: the hooks read this (hook-pre-tool.mjs)
if (dm) argv.shift();
const [claudePath, ...args] = argv;
if (!claudePath) { console.error('usage: run-claude.mjs <claudePath> <args...>'); process.exit(2); }
process.on('SIGINT', () => {}); // Ctrl+C belongs to claude
const env = { ...process.env };
delete env.WORK_OS_DISPATCHED; // never inherited from the terminal; only the worker's job sets it
if (dm) env.WORK_OS_DISPATCHED = dm[1];
const child = spawn(claudePath, args, { stdio: 'inherit', shell: false, env });
child.once('error', (e) => { console.error('could not start claude: ' + e.message); process.exit(1); });
child.once('exit', () => process.exit(0));
