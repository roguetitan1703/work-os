import fs from 'node:fs';
import path from 'node:path';
import { insideRoot } from './validate.mjs';
import { canon } from './trust.mjs';

// Hand-added folders (config "folders"): offered for linking even without git or a project file.
// A folder must exist, be inside a root and be within maxDepth of it, or the scan would never reach it.
export function addFolder(raw, dir, { roots, maxDepth }) {
  let real;
  try { real = fs.realpathSync(path.resolve(dir)); } catch { throw new Error(`folder not found: ${dir}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`not a folder: ${dir}`);
  if (!insideRoot(real, roots)) throw new Error(`not inside your roots (${roots.join(', ') || 'none set'}); add a root with setup first`);
  const depth = Math.min(...roots.map((r) => { try { const rel = path.relative(fs.realpathSync(r), real); return rel.startsWith('..') || path.isAbsolute(rel) ? Infinity : rel ? rel.split(path.sep).length : 0; } catch { return Infinity; } }));
  if (depth > maxDepth) throw new Error(`folder is ${depth} levels below its root; raise maxDepth (now ${maxDepth}) in the config first`);
  const folders = Array.isArray(raw.folders) ? raw.folders.filter((f) => typeof f === 'string') : [];
  if (folders.some((f) => { try { return canon(fs.realpathSync(f)) === canon(real); } catch { return false; } })) return { config: { ...raw, folders }, real, added: false };
  return { config: { ...raw, folders: [...folders, real] }, real, added: true };
}

export function removeFolder(raw, dir) {
  const want = canon(path.resolve(dir));
  const folders = Array.isArray(raw.folders) ? raw.folders.filter((f) => typeof f === 'string') : [];
  const keep = folders.filter((f) => canon(path.resolve(f)) !== want && (() => { try { return canon(fs.realpathSync(f)) !== want; } catch { return true; } })());
  return { config: { ...raw, folders: keep }, removed: keep.length !== folders.length };
}
