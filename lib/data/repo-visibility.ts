import 'server-only';
import { scoped, type Scope } from '../scope';
import type { ProjectDoc } from '../db';

// Whether the State's repo copy (WORK-STATE.md) may list Decisions. Decisions can hold business detail, so they stay out
// of a copy committed to a public repo. One anonymous GET per github.com remote asks GitHub whether it is public; the
// answer is kept on the project for 7 days (and cleared when `code` changes, lib/data/projects.ts). Fail closed: no
// remote, a remote on another host, no answer or any public remote means the Decisions are left out. Nothing about the
// project is sent: only owner/name, which is already public if the answer is "public".

const PUBLIC_TTL = 7 * 86_400_000;
const PRIVATE_TTL = 3_600_000;
const UNKNOWN_TTL = 600_000;
const NAME = /^[\w.-]+$/;

type Visibility = 'public' | 'private' | 'unknown';

async function askGithub(remote: string): Promise<Visibility> {
  const [owner, name, ...extra] = remote.split('/');
  if (!owner || !name || extra.length || !NAME.test(owner) || !NAME.test(name)) return 'unknown';
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'work-os' },
    });
    if (res.status === 404) return 'private';
    if (res.status !== 200) return 'unknown';
    const body = (await res.json()) as { private?: unknown };
    return body.private === false ? 'public' : body.private === true ? 'private' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** True when the copy may list Decisions: every remote of the project is known to be private. */
export async function decisionsInCopy(s: Scope, project: ProjectDoc): Promise<boolean> {
  const remotes = (project.code ?? []).filter(l => l.remote);
  if (!remotes.length) return false;
  // A verdict is kept as long as it is safe to: "public" 7 days (a repo rarely goes private), "private" 1 hour (a repo that
  // goes public must not keep its Decisions in the copy for long), "unknown" (null) 10 minutes (no new GitHub call per read).
  if (project.repoPublicAt && project.repoPublic !== undefined) {
    const ttl = project.repoPublic === true ? PUBLIC_TTL : project.repoPublic === false ? PRIVATE_TTL : UNKNOWN_TTL;
    if (Date.now() - project.repoPublicAt.getTime() < ttl) return project.repoPublic === false;
  }
  if (process.env.E2E_NO_NET === '1') return false;
  let verdict: Visibility = 'private';
  for (const l of remotes) {
    const v = l.host && l.host !== 'github.com' ? 'unknown' : await askGithub(l.remote!);
    if (v === 'public') {
      verdict = 'public';
      break;
    }
    if (v === 'unknown') verdict = 'unknown';
  }
  try {
    await (await scoped(s)).projects.updateOne({ _id: project._id }, { $set: { repoPublic: verdict === 'unknown' ? null : verdict === 'public', repoPublicAt: new Date() } });
  } catch {
    // A reader who may not write the project still gets the answer; it is just not kept.
  }
  return verdict === 'private';
}
