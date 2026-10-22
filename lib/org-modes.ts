import 'server-only';
import { z } from 'zod';
import { DEFAULT_MODES, findMode, isHex, type ModeDef } from './modes';
import { InputError } from './data/errors';
import { getOrgSetting, setOrgSetting, type Scope } from './scope';

// The organization's modes of work (`modes:<orgId>`). An organization that never saved a list has DEFAULT_MODES
// (the seed). Task modes must be one of the list (canonicalMode); old tasks keep whatever they had.

const ModeDefSchema = z.object({
  name: z.string().trim().min(1).max(40),
  hex: z.string().refine(isHex, 'a colour like #3882F6'),
  description: z.string().trim().max(500).default(''),
  light: z.string().refine(isHex).optional(),
});
export const ModeListSchema = z
  .array(ModeDefSchema)
  .min(1)
  .max(20)
  .refine(l => new Set(l.map(m => m.name.toLowerCase())).size === l.length, 'Mode names must differ');

const TTL_MS = 60_000;
// On globalThis: route handlers, pages and actions can each load their own copy of this module, and a save in one
// must clear what the others read.
const g = globalThis as unknown as { __workosModes?: Map<string, { at: number; list: ModeDef[] }> };
const cache = (g.__workosModes ??= new Map());

/** The organization's modes (cached a minute per process). */
export async function getOrgModes(orgId: string): Promise<ModeDef[]> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  const d = await getOrgSetting(orgId, 'modes');
  const parsed = ModeListSchema.safeParse(d?.modes);
  const list = parsed.success ? parsed.data : DEFAULT_MODES;
  if (cache.size > 500) cache.clear();
  cache.set(orgId, { at: Date.now(), list });
  return list;
}

export async function setOrgModes(orgId: string, list: unknown): Promise<ModeDef[]> {
  const modes = ModeListSchema.parse(list);
  await setOrgSetting(orgId, 'modes', { modes, updatedAt: new Date() });
  cache.delete(orgId);
  return modes;
}

/** A task's mode as stored: the organization's spelling of it, null to clear; unknown names are refused. */
export async function canonicalMode(s: Scope, mode: string | null | undefined): Promise<string | null | undefined> {
  if (mode === undefined || mode === null) return mode;
  if (!mode.trim()) return null;
  const modes = await getOrgModes(s.orgId);
  const m = findMode(modes, mode);
  if (!m) throw new InputError(`Unknown mode "${mode.slice(0, 40)}". Modes: ${modes.map(x => x.name).join(', ')}`);
  return m.name;
}
