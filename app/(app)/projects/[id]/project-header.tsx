'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { projectSharingImpactAction, updateProjectAction } from '@/app/actions';
import { useApp } from '@/components/app-context';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { SharingChoice, SHARING_HELP, type Sharing } from '../sharing-choice';
import { PROJECT_STATUSES, type Project, type ProjectInput } from '@/lib/types';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useSynced } from '@/components/use-synced';

const field =
  'w-full min-w-0 h-11 md:h-9 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Info tab: the details form (name, client, status, Description). */
export function ProjectDetails({ project, isOwner }: { project: Project; isOwner: boolean }) {
  const router = useRouter();
  const [name, setName] = useSynced(project.name);
  const [client, setClient] = useSynced(project.client);
  const [description, setDescription] = useSynced(project.description);
  const [status, setStatus] = useSynced(project.status);
  const [, start] = useTransition();
  const { people, account } = useApp();
  // A change that cuts people off waits for a confirm: what it is, and who loses what.
  const [cutting, setCutting] = useState<{ impact: { assignees: string[]; commenters: string[]; claude: string[]; waiting: string[] }; patch: Partial<ProjectInput>; done: string } | null>(null);
  // Shared: with everyone, or with the people ticked (the owner is always on the list).
  const [choosing, setChoosing] = useState(project.visibility === 'members');
  const savedList = project.sharedWith ?? [project.ownerId];
  const [picked, setPicked] = useState<string[]>(savedList);
  const listChanged = project.visibility !== 'members' || picked.length !== savedList.length || picked.some(u => !savedList.includes(u));
  const nameOf = (u: string) => people[u] ?? 'A former member';
  const members = [project.ownerId, ...Object.keys(people).filter(u => u !== project.ownerId).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))];
  for (const u of savedList) if (!members.includes(u)) members.push(u);

  function save(patch: Partial<ProjectInput>, done = 'Saved') {
    start(async () => {
      const res = await updateProjectAction(project.id, patch);
      if (res.ok) {
        toast.success(done);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  /** Saves a change of who sees it; asks first when someone would lose access (keep: who still sees it). */
  function share(patch: Partial<ProjectInput>, done: string, keep: string[] | null) {
    if (keep === null) return save(patch, done);
    start(async () => {
      const r = await projectSharingImpactAction(project.id, keep);
      if (!r.ok) return void toast.error(r.error);
      if (r.data.assignees.length || r.data.commenters.length || r.data.claude.length || r.data.waiting.length) setCutting({ impact: r.data, patch, done });
      else save(patch, done);
    });
  }
  const who =
    project.visibility === 'private'
      ? `Only ${nameOf(project.ownerId)}`
      : project.visibility === 'members'
        ? savedList.map(u => (u === project.ownerId ? `${nameOf(u)} (owner)` : nameOf(u))).join(', ')
        : `Everyone in ${account.org || 'the organization'}`;

  return (
    <section className="space-y-2" data-section="details">
      <h2 className="text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 md:px-0">Details</h2>
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card p-3 space-y-3">
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Name</span>
          <input className={field} value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== project.name && save({ name: name.trim() })} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Client</span>
          <input className={field} value={client} placeholder="None" onChange={e => setClient(e.target.value)} onBlur={() => client !== project.client && save({ client })} />
        </label>
        <div className="space-y-1">
          <div className="text-sm text-muted-foreground">Status</div>
          <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Project status">
            {PROJECT_STATUSES.map(s => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                onClick={() => {
                  if (status === s) return;
                  setStatus(s);
                  save({ status: s });
                }}
                className={cn('h-11 md:h-9 rounded-lg text-sm font-medium capitalize', status === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-sm text-muted-foreground">Description</span>
          <Textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            onBlur={() => description !== project.description && save({ description })}
            placeholder="Scope, links, anything to remember…"
            rows={4}
            className="text-[16px] md:text-sm"
          />
        </label>
        <div className="space-y-2" data-section="sharing">
          <div className="text-sm text-muted-foreground">Who sees it</div>
          <SharingChoice
            value={project.visibility === 'private' ? 'private' : 'org'}
            disabled={!isOwner}
            onChange={(v: Sharing) => {
              if (v === 'org') {
                setChoosing(false);
                return save({ visibility: 'org' }, 'Shared with everyone');
              }
              share({ visibility: 'private' }, 'Now private', []);
            }}
          />
          {project.visibility !== 'private' && (
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-label="Shared with" data-audience-choice>
              {([['everyone', 'Everyone'], ['people', 'Choose people']] as const).map(([v, label]) => {
                const on = v === 'people' ? choosing : !choosing;
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={!isOwner}
                    data-audience={v}
                    onClick={() => {
                      if (on) return;
                      if (v === 'people') {
                        setPicked(savedList);
                        return setChoosing(true);
                      }
                      setChoosing(false);
                      if (project.visibility === 'members') save({ visibility: 'org' }, 'Shared with everyone');
                    }}
                    className={cn('h-11 md:h-9 rounded-lg text-sm font-medium disabled:opacity-60', on ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground')}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {project.visibility !== 'private' && choosing && isOwner && (
            <div className="rounded-xl border border-border/70 divide-y divide-border/60" data-people-picker>
              {members.map(u => {
                const owner = u === project.ownerId;
                return (
                  <label key={u} className="flex items-center gap-3 px-3 min-h-11 md:min-h-9 text-sm" data-person={u}>
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={owner || picked.includes(u)}
                      disabled={owner}
                      onChange={e => setPicked(p => (e.target.checked ? [...p, u] : p.filter(x => x !== u)))}
                    />
                    <span className="flex-1 min-w-0 truncate">{nameOf(u)}</span>
                    {owner && <span className="text-xs text-muted-foreground">Owner</span>}
                  </label>
                );
              })}
              {listChanged && (
                <div className="p-2 flex justify-end">
                  <button
                    type="button"
                    data-save-people
                    className="h-11 md:h-9 px-4 rounded-full bg-foreground text-background text-sm font-semibold"
                    onClick={() => {
                      const list = [project.ownerId, ...picked.filter(u => u !== project.ownerId)];
                      share({ visibility: 'members', sharedWith: list }, `Shared with ${list.length} ${list.length === 1 ? 'person' : 'people'}`, list);
                    }}
                  >
                    Save who sees it
                  </button>
                </div>
              )}
            </div>
          )}
          <p className="text-sm text-foreground" data-access>
            <span className="text-muted-foreground">Has access: </span>
            {who}
          </p>
          <p className="text-xs text-muted-foreground">{isOwner ? SHARING_HELP : `Only ${people[project.ownerId] ?? 'the owner'} can change this. ${SHARING_HELP}`}</p>
        </div>
      </div>
      {cutting && (
        <ConfirmSheet
          title={cutting.patch.visibility === 'private' ? 'Make this project private' : 'Change who sees this project'}
          danger
          verb={cutting.patch.visibility === 'private' ? 'Make private' : 'Save'}
          message={
            <span data-private-confirm={cutting.patch.visibility === 'private' ? '' : undefined} data-cut-confirm>
              {[...new Set([...cutting.impact.assignees, ...cutting.impact.commenters, ...cutting.impact.claude, ...cutting.impact.waiting])].join(', ')} will lose access to {project.name} and its tasks and notes.
              {cutting.impact.assignees.length > 0 && ` Tasks assigned to ${cutting.impact.assignees.join(', ')} will be unassigned.`}
              {cutting.impact.claude.length > 0 && ` ${cutting.impact.claude.join(', ')}: their Claude task will be stopped.`}
              {cutting.impact.waiting.length > 0 && ` Claude items waiting on ${cutting.impact.waiting.join(', ')} will stop waiting.`}
            </span>
          }
          onClose={() => setCutting(null)}
          onConfirm={() => {
            const c = cutting;
            setCutting(null);
            save(c.patch, c.done);
          }}
        />
      )}
    </section>
  );
}
