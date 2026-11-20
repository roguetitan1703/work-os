import 'server-only';
import { scoped, type Scope } from '../scope';
import { NotFoundError } from './errors';

// Context warning (note 3e92845ac0): a project setting, 150 or 200 (k tokens), unset = off. When set, the pre-tool hook tells an agent of this
// project when its own context passes the line (worker/hook-context.mjs; the hook reads the agent's transcript, no server call). The brief
// carries the number; the app sets it (the server action only: no MCP tool and no project patch takes it).

export const CONTEXT_WARN_LINES = [150, 200] as const;
export type ContextWarn = (typeof CONTEXT_WARN_LINES)[number];

export async function getContextWarn(s: Scope, projectId: string): Promise<ContextWarn | null> {
  const p = await (await scoped(s)).projects.findOne({ _id: projectId }, { projection: { contextWarn: 1 } });
  if (!p) throw new NotFoundError('Project not found');
  return p.contextWarn === 150 || p.contextWarn === 200 ? p.contextWarn : null;
}

/** The brief's field for the hook: the line in k tokens, or null when off. */
export async function contextWarnForBrief(s: Scope, projectId: string): Promise<ContextWarn | null> {
  const p = await (await scoped(s)).projects.findOne({ _id: projectId }, { projection: { contextWarn: 1 } });
  return p && (p.contextWarn === 150 || p.contextWarn === 200) ? p.contextWarn : null;
}

/** The app's setting: 150, 200 or null (off, the field is removed). Anything else is off. */
export async function setContextWarn(s: Scope, projectId: string, line: number | null): Promise<ContextWarn | null> {
  const v: ContextWarn | null = line === 150 || line === 200 ? line : null;
  const r = await (await scoped(s)).projects.updateOne({ _id: projectId }, v ? { $set: { contextWarn: v, updatedAt: new Date() } } : { $unset: { contextWarn: '' }, $set: { updatedAt: new Date() } });
  if (!r.matchedCount) throw new NotFoundError('Project not found');
  return v;
}
