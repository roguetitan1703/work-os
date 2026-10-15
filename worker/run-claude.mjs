// Runs claude inside a Windows Terminal tab: node run-claude.mjs <claudePath> <args...>
// stdio is inherited, no shell. Exits 0 when claude ends (even when Stop killed it) so wt closes the tab.
import { spawn } from 'node:child_process';

const [claudePath, ...args] = process.argv.slice(2);
if (!claudePath) { console.error('usage: run-claude.mjs <claudePath> <args...>'); process.exit(2); }
process.on('SIGINT', () => {}); // Ctrl+C belongs to claude
const child = spawn(claudePath, args, { stdio: 'inherit', shell: false });
child.once('error', (e) => { console.error('could not start claude: ' + e.message); process.exit(1); });
child.once('exit', () => process.exit(0));
