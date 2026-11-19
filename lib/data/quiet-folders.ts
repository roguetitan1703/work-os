import 'server-only';
import { getUserSetting, setUserSetting, type Scope } from '../scope';
import { InputError } from './errors';
import { cleanMachine, normalizePath, within } from './code-locations';

// "Not Work OS" folders (H13, docs/flows/agent-system.md section 16.13): per person, a folder on a computer a Claude Code
// session there should never ask about. Kept on the server as settings doc `quietFolders:<userId>`; at most MAX, the oldest
// dropped. A quiet folder covers its subfolders. It is consulted only when no folder is linked, so it can never silence a
// filed folder. Undo: Claude › Setup › Computers, "Not Work OS folders", Remove.

export const MAX_QUIET_FOLDERS = 200;
export type QuietFolder = { machine: string; path: string; at: string };

async function items(s: Scope): Promise<{ machine: string; path: string; at: Date }[]> {
  const d = await getUserSetting(s, 'quietFolders');
  return Array.isArray(d?.items) ? d.items : [];
}

function clean(machine: string | null | undefined, path: string | null | undefined): { machine: string; path: string } {
  const m = cleanMachine(machine);
  const p = normalizePath(path);
  if (!m) throw new InputError('Say which computer: pass machine');
  if (!p || p.length > 500) throw new InputError('Give the absolute path of the folder');
  return { machine: m, path: p };
}

/** Whether the folder (or a folder above it) is marked not Work OS on that computer by this person. */
export async function quietFolder(s: Scope, machine: string | null | undefined, path: string | null | undefined): Promise<boolean> {
  const m = cleanMachine(machine);
  const p = normalizePath(path);
  if (!m || !p) return false;
  return (await items(s)).some(i => i.machine === m && within(p, i.path));
}

export async function addQuietFolder(s: Scope, machine: string | null | undefined, path: string | null | undefined): Promise<void> {
  const k = clean(machine, path);
  const cur = (await items(s)).filter(i => !(i.machine === k.machine && i.path === k.path));
  const next = [...cur, { ...k, at: new Date() }].slice(-MAX_QUIET_FOLDERS);
  await setUserSetting(s, 'quietFolders', { items: next, updatedAt: new Date() });
}

export async function removeQuietFolder(s: Scope, machine: string, path: string): Promise<void> {
  const k = clean(machine, path);
  const cur = await items(s);
  const next = cur.filter(i => !(i.machine === k.machine && i.path === k.path));
  if (next.length !== cur.length) await setUserSetting(s, 'quietFolders', { items: next, updatedAt: new Date() });
}

export async function listQuietFolders(s: Scope): Promise<QuietFolder[]> {
  return (await items(s)).map(i => ({ machine: i.machine, path: i.path, at: new Date(i.at).toISOString() })).sort((a, b) => a.path.localeCompare(b.path));
}
