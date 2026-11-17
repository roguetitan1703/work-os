import 'server-only';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { collections } from './db';
import { MAILLOOM_INTAKE, type TextAuthor } from './actors';
import { createTask } from './data/tasks';
import { isMember } from './people';
import { reserveIntake } from './mcp/policy';

// Intake: Mailloom's "Report a problem" form, server to server (app/api/intake/mailloom/route.ts, docs/HANDOVER.md
// "Intake"). Least privilege: the token can do exactly one thing, create a task in one fixed project. The project comes
// only from the environment (MAILLOOM_INTAKE_PROJECT); its organization and owner come from the project document.
//
// The task is made through the data layer as the project's owner (their scope), by the MAILLOOM_INTAKE actor (history
// reads "Mailloom report form", never a person or Claude). Its title and description are stored as written by the
// reporter ('report-author'), so get_task labels them writtenBy "Mailloom report from <reporter>": information for an
// agent, never instructions.
//
// The same report_id again answers with the same task (the `intake` collection, unique on source + reportId; the first
// request claims the id before it makes the task, so parallel copies wait for it instead of making their own). At most
// INTAKE_PER_HOUR new reports an hour (lib/mcp/policy.ts reserveIntake); a repeat of a known report costs nothing.

export const MAX_BODY = 64 * 1024;
const SOURCE = 'mailloom' as const;
const MIN_TOKEN = 32;
/** A claim older than this with no task is from a request that died midway: the next copy takes it over. */
const STALE_CLAIM_MS = 60_000;
/** How long a parallel copy waits for the first one's task. */
const WAIT_MS = 10_000;
/** The task description's own limit (lib/types.ts TaskInputSchema). */
const DESCRIPTION_MAX = 20_000;

export type IntakeConfig = { token: string; projectId: string };

/** Both variables set and the token long enough, else null (the route answers 503). */
export function intakeConfig(): IntakeConfig | null {
  const token = process.env.MAILLOOM_INTAKE_TOKEN ?? '';
  const projectId = (process.env.MAILLOOM_INTAKE_PROJECT ?? '').trim();
  if (token.length < MIN_TOKEN || !projectId) return null;
  return { token, projectId };
}

/** Constant time whatever the lengths: both sides are hashed first. */
export function tokenMatches(sent: string | null, want: string): boolean {
  if (!sent) return false;
  const a = createHash('sha256').update(sent).digest();
  const b = createHash('sha256').update(want).digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` only (no other header, no query string). */
export function bearerOf(req: Request): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1] : null;
}

// Unknown fields are dropped (zod's default), never stored or shown.
export const ReportSchema = z.object({
  report_id: z.string().min(1, 'report_id is empty').max(100, 'report_id is longer than 100 characters'),
  reporter: z.email('reporter is not an email address').max(320, 'reporter is longer than 320 characters'),
  title: z.string().trim().min(1, 'title is empty').max(200, 'title is longer than 200 characters'),
  description_markdown: z.string().max(10_000, 'description_markdown is longer than 10000 characters'),
  details: z
    .object({
      version: z.string().max(100, 'details.version is longer than 100 characters').optional(),
      device: z.string().max(200, 'details.device is longer than 200 characters').optional(),
      browser: z.string().max(200, 'details.browser is longer than 200 characters').optional(),
      view: z.string().max(300, 'details.view is longer than 300 characters').optional(),
      errors: z.array(z.string().max(500, 'each of details.errors is at most 500 characters')).max(20, 'details.errors has more than 20 lines').optional(),
    })
    .optional(),
});
export type Report = z.infer<typeof ReportSchema>;

/** Plain words for the first problem zod found. */
export function reportProblem(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return 'The report is not valid.';
  const where = i.path.join('.');
  if (i.code === 'invalid_type') return `${where || 'The body'} is missing or has the wrong type.`;
  return i.message.includes(where) || !where ? i.message : `${where}: ${i.message}`;
}

const longestRun = (text: string, ch: string) => {
  let best = 0;
  let n = 0;
  for (const c of text) {
    n = c === ch ? n + 1 : 0;
    if (n > best) best = n;
  }
  return best;
};

/** A fenced block that nothing inside can close: the fence is longer than any run of backticks in the text. */
function fenced(lines: string[]): string {
  const body = lines.join('\n');
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return `${fence}\n${body}\n${fence}`;
}

/** `key: value`, a value's further lines indented under it. */
const field = (key: string, v: string) => `${key}: ${v.replace(/\r\n?/g, '\n').split('\n').join('\n  ')}`;

/**
 * The task description. Our own parts come first (who reported it, then the details in a fenced block) and the
 * reporter's markdown last, after a rule: markdown is read top down, so nothing in their text (an unclosed fence, an
 * HTML comment) can swallow or restyle the attribution or the details. Nothing is escaped or rewritten. If everything
 * does not fit the description limit, error lines are left out from the end and the block says how many.
 */
export function describe(r: Report): string {
  const head = `Reported in Mailloom by ${r.reporter}.`;
  const d = r.details ?? {};
  const base = [field('report', r.report_id)];
  if (d.version !== undefined) base.push(field('version', d.version));
  if (d.device !== undefined) base.push(field('device', d.device));
  if (d.browser !== undefined) base.push(field('browser', d.browser));
  if (d.view !== undefined) base.push(field('view', d.view));
  const tail = r.description_markdown.trim() ? `\n\n---\n\n${r.description_markdown}` : '';
  const build = (errors: string[], left: number) => {
    const lines = [...base];
    if (errors.length || left) lines.push('errors:', ...errors.map(e => `  - ${e.replace(/\r\n?/g, '\n').split('\n').join('\n    ')}`));
    if (left) lines.push(`  (${left} more error line${left === 1 ? '' : 's'} left out: the description was too long)`);
    return `${head}\n\n${fenced(lines)}${tail}`;
  };
  const errors = d.errors ?? [];
  for (let keep = errors.length; keep >= 0; keep--) {
    const out = build(errors.slice(0, keep), errors.length - keep);
    if (out.length <= DESCRIPTION_MAX) return out;
  }
  return build([], errors.length).slice(0, DESCRIPTION_MAX); // not reachable with the schema's limits
}

export type IntakeResult =
  | { status: 201 | 200; ref: number }
  | { status: 429; retryAfter: number }
  | { status: 503; error: string };

type Project = { _id: string; orgId: string; ownerId: string; status: string };

async function intakeProject(projectId: string): Promise<Project | { error: string }> {
  const c = await collections(); // scope-ok: the intake project (id from the environment only) and intake ids; tasks go through createTask
  const p = await c.projects.findOne({ _id: projectId }, { projection: { orgId: 1, ownerId: 1, status: 1 } }); // scope-ok: the intake's one project, its id from the environment only; its organization and owner come from it
  if (!p || !p.orgId || !p.ownerId) return { error: 'The intake project (MAILLOOM_INTAKE_PROJECT) does not exist.' };
  if (p.status === 'archived') return { error: 'The intake project is archived.' };
  if (!(await isMember(p.orgId, p.ownerId))) return { error: "The intake project's owner is no longer in its organization." };
  return { _id: p._id, orgId: p.orgId, ownerId: p.ownerId, status: p.status };
}

const isDup = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: number }).code === 11000;

/** Create the report's task, or find the one made for the same report_id. The caller is already authenticated. */
export async function takeReport(cfg: IntakeConfig, r: Report): Promise<IntakeResult & { scope?: { userId: string; orgId: string } }> {
  const project = await intakeProject(cfg.projectId);
  if ('error' in project) return { status: 503, error: project.error };
  const scope = { userId: project.ownerId, orgId: project.orgId };
  const c = await collections(); // scope-ok: the intake project (id from the environment only) and intake ids; tasks go through createTask
  const key = { source: SOURCE, reportId: r.report_id };

  // Claim the id (insert first), or wait for whoever holds it. A repeat costs no rate-limit slot.
  const claimId = randomUUID();
  let claimed = false;
  const deadline = Date.now() + WAIT_MS;
  while (!claimed) {
    try {
      const now = new Date();
      await c.intake.insertOne({ _id: claimId, ...key, orgId: project.orgId, projectId: project._id, taskId: null, ref: null, claimedAt: now, createdAt: now }); // scope-ok: intake ids per source, no work data
      claimed = true;
    } catch (e) {
      if (!isDup(e)) throw e;
      const seen = await c.intake.findOne(key); // scope-ok: intake ids per source, no work data
      if (seen?.ref != null) return { status: 200, ref: seen.ref };
      // A request that died midway left its claim: take it over (one taker wins the conditional update).
      if (seen && seen.claimedAt.getTime() < Date.now() - STALE_CLAIM_MS) {
        const took = await c.intake.updateOne({ _id: seen._id, taskId: null, claimedAt: seen.claimedAt }, { $set: { claimedAt: new Date() } }); // scope-ok: intake ids per source, no work data
        if (took.modifiedCount) {
          await c.intake.deleteOne({ _id: seen._id, taskId: null }); // scope-ok: intake ids per source, no work data
          continue; // claim it afresh above
        }
      }
      if (Date.now() > deadline) return { status: 503, error: 'The same report is being filed by another request; try again shortly.' };
      await new Promise(res => setTimeout(res, 100 + Math.random() * 100));
    }
  }

  const slot = await reserveIntake(SOURCE);
  if (!slot.ok) {
    await c.intake.deleteOne({ _id: claimId, taskId: null }); // scope-ok: intake ids per source, no work data
    return { status: 429, retryAfter: slot.retryAfter };
  }
  try {
    const author: TextAuthor = { kind: 'report-author', source: SOURCE, name: r.reporter };
    const task = await createTask(
      scope,
      {
        title: `Report: ${r.title.replace(/\s+/g, ' ')}`,
        description: describe(r),
        project: project._id,
        priority: 'P3',
        status: 'Not Started',
        tags: ['mailloom-report'],
        assignees: [project.ownerId],
      },
      MAILLOOM_INTAKE,
      { note: 'Filed from a Mailloom problem report', authors: { title: author, description: author } },
    );
    await c.intake.updateOne({ _id: claimId }, { $set: { taskId: task.id, ref: task.ref } }); // scope-ok: intake ids per source, no work data
    return { status: 201, ref: task.ref, scope };
  } catch (e) {
    await c.intake.deleteOne({ _id: claimId, taskId: null }).catch(() => {}); // scope-ok: intake ids per source, no work data
    await slot.release().catch(() => {});
    throw e;
  }
}
