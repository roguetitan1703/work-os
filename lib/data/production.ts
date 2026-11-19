import { z } from 'zod';
import type { ProjectDoc } from '../db';
import { userActor, type Actor } from '../actors';
import { memberNames } from '../people';
import { scoped, type Scope } from '../scope';
import { normalizeRemote } from './code-locations';
import { InputError, NotFoundError } from './errors';

// Production per project, and the release grant (docs/flows/agent-system.md section 10, "Three blocks only"; H8).
// The Work OS hook refuses an agent's push, tag or release to a project's production, and a production CLI command, unless the
// project's owner answered a release Need (an approve Need asked with release: true). This file holds what "production" means
// for a project, and whether a grant is open. The hook decides locally whether a command is production (worker/hook-release.mjs);
// the server only answers "is there a grant" (app/api/agent/release).
//
// The setting is changed in the app only (setProductionAction): no MCP tool and not updateProject take it, so an agent cannot
// switch its own block off.

export type ProductionConfig = { remotes: string[]; branches: string[]; targets: string[] };
/** What the project page shows and edits: the effective setting, whether it is the default, whether it is off. */
export type ProductionView = ProductionConfig & { off: boolean; isDefault: boolean };

export const PRODUCTION_LIMITS = { remotes: 5, branches: 5, branch: 200, targets: 10 } as const;
export const DEFAULT_PRODUCTION_BRANCHES = ['main', 'master'];
const TARGET = /^[A-Za-z0-9_.-]{1,64}$/;

export const ProductionInputSchema = z
  .object({
    remotes: z.array(z.string().trim().max(300)).max(20),
    branches: z.array(z.string().trim().max(PRODUCTION_LIMITS.branch)).max(20),
    targets: z.array(z.string().trim().max(64)).max(20),
    off: z.boolean().optional(),
  })
  .strict();
export type ProductionInput = z.infer<typeof ProductionInputSchema>;

/** The project's code remotes as owner/name, lowercase, in order, at most 5. */
function codeRemotes(p: Pick<ProjectDoc, 'code'>): string[] {
  const out: string[] = [];
  for (const l of p.code ?? []) {
    const r = l.remote ? normalizeRemote(l.remote) : null;
    if (r && !out.includes(r)) out.push(r);
  }
  return out.slice(0, PRODUCTION_LIMITS.remotes);
}

/** The setting as the page shows it: what is stored, else the default (the code remotes; main and master; no CLI targets). */
export function productionView(p: Pick<ProjectDoc, 'code' | 'production'>): ProductionView {
  if (p.production) return { remotes: p.production.remotes, branches: p.production.branches, targets: p.production.targets, off: p.production.off === true, isDefault: false };
  return { remotes: codeRemotes(p), branches: DEFAULT_PRODUCTION_BRANCHES, targets: [], off: false, isDefault: true };
}

/** What the hook gets in the brief: the effective setting, or null when this project has no production block. */
export function effectiveProduction(p: Pick<ProjectDoc, 'code' | 'production'>): ProductionConfig | null {
  const v = productionView(p);
  if (v.off) return null;
  return { remotes: v.remotes, branches: v.branches, targets: v.targets };
}

/** Validates the page's input: remotes become owner/name, lists are trimmed, de-duplicated and capped. Throws InputError. */
export function cleanProduction(input: unknown): NonNullable<ProjectDoc['production']> {
  const parsed = ProductionInputSchema.safeParse(input);
  if (!parsed.success) throw new InputError('Production takes remotes, branches and targets as lists of text, and a switch for none.');
  const i = parsed.data;
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const remotes = uniq(
    i.remotes.filter(Boolean).map(r => {
      const n = normalizeRemote(r);
      if (!n) throw new InputError(`"${r}" is not a git remote: write owner/repo or its URL.`);
      return n;
    }),
  );
  const branches = uniq(i.branches);
  const targets = uniq(i.targets);
  if (remotes.length > PRODUCTION_LIMITS.remotes) throw new InputError(`At most ${PRODUCTION_LIMITS.remotes} remotes.`);
  if (branches.length > PRODUCTION_LIMITS.branches) throw new InputError(`At most ${PRODUCTION_LIMITS.branches} branches.`);
  if (targets.length > PRODUCTION_LIMITS.targets) throw new InputError(`At most ${PRODUCTION_LIMITS.targets} CLI targets.`);
  for (const b of branches) if (/\s/.test(b)) throw new InputError(`"${b}" is not a branch name.`);
  for (const t of targets) if (!TARGET.test(t)) throw new InputError(`"${t}" is not a CLI target (letters, digits, . _ -).`);
  return { remotes, branches, targets, ...(i.off ? { off: true } : {}) };
}

/** A line for the feed and the page: "main or master on owner/name". */
export function productionSummary(v: ProductionView): string {
  if (v.off) return 'none';
  const b = v.branches.length ? v.branches.join(' or ') : 'no branch';
  const r = v.remotes.length ? v.remotes.join(', ') : 'no remote';
  const t = v.targets.length ? `, CLI targets ${v.targets.join(', ')}` : '';
  return `${b} on ${r}${t}${v.isDefault ? ' (default)' : ''}`;
}

/** The setting of one project the caller can read (the project page). */
export async function getProduction(s: Scope, projectId: string): Promise<ProductionView> {
  const p = await (await scoped(s)).projects.findOne({ _id: projectId }, { projection: { code: 1, production: 1 } });
  if (!p) throw new NotFoundError('Project not found');
  return productionView(p);
}

/**
 * Sets what counts as production (null = back to the default). From the app only (the server action), by anyone who can
 * edit the project's Repository; the change goes in the project's feed.
 */
export async function setProduction(s: Scope, projectId: string, input: unknown | null): Promise<ProductionView> {
  const c = await scoped(s);
  const cur = await c.projects.findOne({ _id: projectId });
  if (!cur) throw new NotFoundError('Project not found');
  const next = input === null ? null : cleanProduction(input);
  const now = new Date();
  await c.projects.updateOne({ _id: projectId }, next ? { $set: { production: next, productionBy: s.userId, updatedAt: now } } : { $unset: { production: '', productionBy: '' }, $set: { updatedAt: now } });
  const after = { ...cur, production: next ?? undefined };
  const view = productionView(after);
  const { logChange } = await import('./tasks');
  await logChange(c, cur, userActor(s.userId), 'production', { subject: { kind: 'project', id: cur._id, title: cur.name }, projectId: cur._id, note: next ? `Production now: ${productionSummary(view)}` : 'Production back to the default' });
  return view;
}

/** The brief's production field for the hook: the effective setting of one project, or null when it has no block. */
export async function productionForBrief(s: Scope, projectId: string): Promise<ProductionConfig | null> {
  const p = await (await scoped(s)).projects.findOne({ _id: projectId }, { projection: { code: 1, production: 1 } });
  return p ? effectiveProduction(p) : null;
}

export const RELEASE_WHAT = ['push', 'tag', 'release', 'cli'] as const;
export type ReleaseWhat = (typeof RELEASE_WHAT)[number];
const WHAT_WORD: Record<ReleaseWhat, string> = { push: 'push', tag: 'tag', release: 'release', cli: 'command' };

/**
 * The hook asks: may this production action go ahead? (POST /api/agent/release, the session token's own project.) Answers
 * { allowed: true, until, need } when a release Need to the owner is answered and its window is open, and then writes one
 * feed row on the project ("Production push (master) under Need #41": what and a name, never a command). Else
 * { allowed: false, open?, owner } (open: the number of a release Need waiting for its answer; owner: their first name).
 */
export async function checkRelease(s: Scope, projectId: string, what: ReleaseWhat, name: string | undefined, actor: Actor): Promise<{ allowed: true; until: string; need: number } | { allowed: false; open?: number; owner: string }> {
  const g = await releaseGrant(s, projectId);
  const c = await scoped(s);
  const p = await c.projects.findOne({ _id: projectId });
  if (!p) throw new NotFoundError('Project not found');
  if (g && 'until' in g) {
    const label = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const { logChange } = await import('./tasks');
    await logChange(c, p, actor, 'production', { subject: { kind: 'project', id: p._id, title: p.name }, projectId: p._id, note: `Production ${WHAT_WORD[what]}${label ? ` (${label})` : ''} under Need #${g.ref}` });
    return { allowed: true, until: g.until.toISOString(), need: g.ref };
  }
  const owner = (await memberNames(s.orgId))[p.ownerId] ?? '';
  return { allowed: false, ...(g && 'open' in g ? { open: g.open } : {}), owner: owner.split(/\s+/)[0] ?? '' };
}

export type ReleaseGrant = { until: Date; ref: number } | { open: number } | null;

/**
 * Is production open on this project? An answered release Need to the project's current owner (Yes or Yes for 24 hours) whose
 * window has not ended: the newest one. Else the number of an open release Need, so the refusal can say "Need #41 is open".
 * Reads through the caller's door; only the owner's answer counts (a Need to anyone else opens nothing).
 */
export async function releaseGrant(s: Scope, projectId: string): Promise<ReleaseGrant> {
  const c = await scoped(s);
  const p = await c.projects.findOne({ _id: projectId }, { projection: { ownerId: 1 } });
  if (!p) return null;
  const now = new Date();
  const [granted] = await c.needs.find({ projectId, release: true, to: p.ownerId, status: 'answered', releaseUntil: { $gt: now } }).sort({ releaseUntil: -1 }).limit(1).toArray();
  if (granted?.releaseUntil) return { until: granted.releaseUntil, ref: granted.ref };
  const [open] = await c.needs.find({ projectId, release: true, to: p.ownerId, status: 'open' }).sort({ createdAt: -1 }).limit(1).toArray();
  return open ? { open: open.ref } : null;
}
