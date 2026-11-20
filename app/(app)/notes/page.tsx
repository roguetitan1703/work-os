import Link from '@/components/intent-link';
import { ChevronRight, FileText, FolderOpen, ListTodo } from 'lucide-react';
import { listNotes } from '@/lib/data/notes';
import { listProjectsBasic } from '@/lib/data/projects';
import { fmtAgo } from '@/lib/format';
import { requireScope } from '@/lib/caller';
import { ActorName } from '@/components/actor-badge';
import { cn } from '@/lib/utils';
import { NewNoteButton } from '@/components/new-note-button';
import { SearchButton } from '@/components/search-button';
import { MobileHeader } from '@/components/mobile/tab-bar';
import { HubSegment } from '@/components/mobile/hub-segment';
import { MobileNoteFilters } from '@/components/mobile/m-notes';
import { Suspense } from 'react';
import { Select } from '@/components/ui/select';
import { ARCHIVE, SHELVES, shelfLabel, type Shelf } from '@/lib/notes-shelves';

export const metadata = { title: 'Notes · Work OS' };

type State = 'active' | 'archived' | 'all';
type Kind = 'all' | 'task' | 'project';
type Props = { searchParams: Promise<{ state?: string; kind?: string; project?: string; shelf?: string; new?: string }> };

export default async function NotesPage({ searchParams }: Props) {
  const sp = await searchParams;
  const state: State = sp.state === 'archived' || sp.state === 'all' ? sp.state : 'active';
  const kind: Kind = sp.kind === 'task' || sp.kind === 'project' ? sp.kind : 'all';
  const shelf = [...SHELVES.map(x => x.id as string), ARCHIVE].includes(sp.shelf ?? '') ? (sp.shelf as Shelf | typeof ARCHIVE) : undefined;
  const s = await requireScope();
  const [{ total, notes }, projects] = await Promise.all([
    listNotes(s, { state, kind, shelf, project: sp.project || undefined }),
    listProjectsBasic(s),
  ]);
  const href = (p: Partial<Record<'state' | 'kind' | 'project' | 'shelf', string>>) => {
    const u = new URLSearchParams();
    const v = { state, kind, project: sp.project ?? '', shelf: shelf ?? '', ...p };
    if (v.state !== 'active') u.set('state', v.state);
    if (v.kind !== 'all') u.set('kind', v.kind);
    if (v.project) u.set('project', v.project);
    if (v.shelf) u.set('shelf', v.shelf);
    const s = u.toString();
    return s ? `/notes?${s}` : '/notes';
  };
  const activeProjects = projects.filter(p => p.status === 'active' || p.status === 'paused');

  return (
    <div className="space-y-4 md:space-y-5 max-w-4xl">
      {/* On the phone a new note starts from the + in the bar (New note). */}
      <MobileHeader title="Notes" subtitle={`${total} ${state === 'archived' || shelf === ARCHIVE ? 'archived' : 'notes'}`} />
      <HubSegment active="notes" />
      <Suspense>
        <MobileNoteFilters projects={activeProjects.map(p => ({ id: p.id, name: p.name, private: p.visibility === 'private' }))} />
      </Suspense>
      <div className="hidden md:flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Notes</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Pages attached to tasks and projects. A task&apos;s note is archived when the task is done.</p>
        </div>
        <NewNoteButton projects={activeProjects.map(p => ({ id: p.id, name: p.name, private: p.visibility === 'private' }))} defaultProject={sp.project} startOpen={sp.new === '1'} />
      </div>

      <form action="/notes" className="hidden md:flex flex-wrap items-center gap-2">
        {state !== 'active' && <input type="hidden" name="state" value={state} />}
        {kind !== 'all' && <input type="hidden" name="kind" value={kind} />}
        <SearchButton kind="notes" label="Search notes" data-notes-search className="flex-1 min-w-48 justify-start" />
        <Select name="project" defaultValue={sp.project ?? ''} className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          <option value="">All projects</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}{p.visibility === 'private' ? ' (private)' : ''}
            </option>
          ))}
        </Select>
        <Select name="shelf" defaultValue={shelf ?? ''} aria-label="Shelf" className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          <option value="">Any shelf</option>
          {SHELVES.map(x => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
          <option value={ARCHIVE}>Archive</option>
        </Select>
        <button className="h-9 px-3 rounded-md bg-foreground text-background text-sm font-medium">Filter</button>
      </form>

      <div className="hidden md:flex flex-wrap items-center gap-3">
        <Segment items={(['active', 'archived', 'all'] as State[]).map(s => ({ key: s, label: s, href: href({ state: s }) }))} value={state} />
        <Segment
          items={(['all', 'task', 'project'] as Kind[]).map(k => ({ key: k, label: k === 'all' ? 'any' : `${k} notes`, href: href({ kind: k }) }))}
          value={kind}
        />
        <span className="text-xs text-muted-foreground">{total} notes</span>
      </div>

      {notes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {sp.project || shelf ? 'No notes match.' : state === 'archived' ? 'No archived notes.' : 'No notes yet. Create one from a task or project, or with New note.'}
        </div>
      ) : (
        <>
        <ul className="md:hidden -mx-4 divide-y divide-border/60 border-y border-border/60 bg-card">
          {notes.map(n => (
            <li key={n.id}>
              <Link href={`/notes/${n.id}`} className="flex items-center gap-3 px-4 py-3 min-h-16 active:bg-muted/60">
                <FileText className="w-5 h-5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px] font-medium text-foreground truncate">{n.title}</span>
                    {n.archived && <span className="text-[10px] px-1.5 py-px rounded bg-muted text-muted-foreground shrink-0">{n.archivedBecause}</span>}
                  </div>
                  {n.firstLine && <p className="text-sm text-muted-foreground truncate">{n.firstLine}</p>}
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span className="truncate">{n.taskRef ? `#${n.taskRef} ${n.taskTitle ?? ''}` : (n.projectName ?? '')}{n.shelf ? ` · ${shelfLabel(n.shelf)}` : ''}</span>
                    <span className="ml-auto shrink-0">{fmtAgo(n.updatedAt)}</span>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
        <ul className="hidden md:block rounded-lg border border-border divide-y divide-border bg-card">
          {notes.map(n => (
            <li key={n.id}>
              <Link href={`/notes/${n.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50">
                <FileText className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate">{n.title}</span>
                    {n.archived && <span className="text-[10px] px-1.5 py-px rounded bg-muted text-muted-foreground">{n.archivedBecause}</span>}
                  </div>
                  {n.firstLine && <p className="text-sm text-muted-foreground truncate">{n.firstLine}</p>}
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    {n.taskRef ? (
                      <span className="flex items-center gap-1 truncate">
                        <ListTodo className="w-3 h-3" />#{n.taskRef} {n.taskTitle}
                      </span>
                    ) : null}
                    {n.projectName && (
                      <span className="flex items-center gap-1">
                        <FolderOpen className="w-3 h-3" />
                        {n.projectName}
                        {n.shelf ? ` · ${shelfLabel(n.shelf)}` : ''}
                      </span>
                    )}
                    <span className="ml-auto shrink-0">
                      {fmtAgo(n.updatedAt)} · <ActorName actor={n.updatedBy} />
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}

function Segment({ items, value }: { items: { key: string; label: string; href: string }[]; value: string }) {
  return (
    <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
      {items.map(i => (
        <Link
          key={i.key}
          href={i.href}
          className={cn(
            'px-3 py-1 rounded text-sm font-medium capitalize transition-colors',
            value === i.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {i.label}
        </Link>
      ))}
    </div>
  );
}
