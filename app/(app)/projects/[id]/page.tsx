import { notFound } from 'next/navigation';
import { redirect } from 'next/navigation';
import { getCaller } from '@/lib/caller';
import Link from '@/components/intent-link';
import { ChevronRight, FileText } from 'lucide-react';
import { getProjectWithStats } from '@/lib/data/projects';
import { listActivity, listTasks } from '@/lib/data/tasks';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskList } from '@/components/task-row';
import { QuickAddBar } from '@/components/quick-add';
import { listNotes } from '@/lib/data/notes';
import { NewNoteButton } from '@/components/new-note-button';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { projectItems } from '@/lib/data/claude-items';
import { projectLauncher, reopenPrompts } from '@/lib/data/launcher';
import { ClaudeItems } from './claude-items';
import { ProjectSessions } from './sessions';
import { CodeLocations } from './code-locations';
import { FolderLinks } from './folders';
import { ProjectDetails } from './project-header';
import { ProjectTop } from './project-top';
import { ClaudeCard } from './claude-card';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'claude', label: 'Claude' },
  { id: 'notes', label: 'Notes' },
  { id: 'info', label: 'Info' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; claude?: string }> };

const H2 = 'text-[13px] md:text-xs font-semibold text-muted-foreground uppercase tracking-wider';
const CARD = 'rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden';

export default async function ProjectPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const me = await getCaller();
  if (!me) redirect('/login');
  const sc = { userId: me.userId, orgId: me.orgId };
  const project = await getProjectWithStats(sc, decodeURIComponent(id));
  if (!project) notFound();
  // Old links (?claude=C12) land on the Claude tab.
  const tab: TabId = TABS.find(t => t.id === sp.tab)?.id ?? (sp.claude ? 'claude' : 'overview');
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const tabHref = (t: TabId) => `${base}?tab=${t}`;

  const [open, done, activity, notes, work, launcher, reopen] = await Promise.all([
    listTasks(sc, { project: project.id, open: true }),
    listTasks(sc, { project: project.id, status: ['Done', 'Dropped'], sort: 'done', limit: 30 }),
    listActivity(sc, { project: project.id, limit: 40 }),
    listNotes(sc, { project: project.id, state: 'all' }),
    projectItems(sc, project.id, { doneLimit: 30 }),
    projectLauncher(me, project.id),
    reopenPrompts(me),
  ]);
  const projectNotes = notes.notes.filter(n => !n.taskId && !n.archived);
  const otherNotes = notes.notes.length - projectNotes.length;
  const s = project.stats;
  const repos = project.code ?? [];
  const folders = launcher.folders.filter(f => !f.missing);

  const openItems = work.items.filter(i => i.state !== 'done' && i.state !== 'dropped');
  const waiting = openItems.filter(i => i.waitingOn === me.userId).map(i => ({ id: i.id, ref: i.ref, title: i.title, question: i.waitingText, updatedAt: i.updatedAt }));
  const queuedItems = openItems.filter(i => i.state === 'queued' && i.kind !== 'idea' && !i.waitingOn);
  const nextItem = work.pickNext ?? queuedItems.find(i => i.next) ?? queuedItems[0] ?? null;
  const running = launcher.sessions.filter(x => x.state === 'running' || x.state === 'starting' || x.state === 'unknown');

  const claudeBlock = (
    <ClaudeItems
      projectId={project.id}
      items={work.items}
      blockers={Object.fromEntries([...work.blockers].map(([k, b]) => [k, { ref: b.ref, title: b.title, state: b.state }]))}
      waiting={work.waiting}
      doneCount={work.doneCount}
      openRef={Number(sp.claude?.replace(/^C/i, '')) || undefined}
    />
  );

  const noteList = (list: typeof projectNotes, dense?: boolean) => (
    <ul className="divide-y divide-border/60 md:divide-border">
      {list.map(n => (
        <li key={n.id}>
          <Link href={`/notes/${n.id}`} className="flex items-center gap-3 md:gap-2 px-4 md:px-3 py-2 min-h-11 md:min-h-9 hover:bg-muted/50 active:bg-muted/60">
            <FileText className="w-4 h-4 md:w-3.5 md:h-3.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[16px] md:text-sm font-medium truncate">{n.title}</div>
              {!dense && (
                <div className="text-sm md:text-xs text-muted-foreground truncate">
                  {n.firstLine || 'Empty'} · {fmtAgo(n.updatedAt)}
                </div>
              )}
            </div>
            <ChevronRight className="md:hidden w-4 h-4 text-muted-foreground/40" />
          </Link>
        </li>
      ))}
    </ul>
  );

  const newNote = <NewNoteButton project={project.id} label="New note" className="h-11 px-4 text-sm rounded-xl md:h-7 md:px-2 md:text-xs md:rounded-md" />;

  const cardHead = (title: string, meta: React.ReactNode, to: TabId, right?: React.ReactNode) => (
    <header className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9">
      <h2 className={H2}>{title}</h2>
      <span className="text-[13px] md:text-xs text-muted-foreground truncate">{meta}</span>
      <span className="ml-auto flex items-center shrink-0">
        {right}
        <Link href={tabHref(to)} replace scroll={false} className="h-11 md:h-9 px-1 inline-flex items-center text-[13px] md:text-xs text-muted-foreground hover:text-foreground">
          See all ›
        </Link>
      </span>
    </header>
  );

  const overview = (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,_1.7fr)_minmax(0,_1fr)] gap-4 lg:gap-6 items-start" data-view="overview">
      <div className="space-y-4 min-w-0">
        <ClaudeCard projectId={project.id} tabHref={tabHref('claude')} waiting={waiting} running={running} next={nextItem ? { ref: nextItem.ref, title: nextItem.title } : null} queued={queuedItems.length} hasComputers={launcher.devices.length > 0} />
        <section className="space-y-1.5" data-card="tasks">
          <div className="flex items-center gap-2 px-1 md:px-0 min-h-11 md:min-h-0 -mb-1 md:mb-0">
            <h2 className={H2}>Tasks</h2>
            <span className="text-[13px] md:text-xs text-muted-foreground">
              {s.open} open
              {s.overdue > 0 && <span className="text-red-600 dark:text-red-400"> · {s.overdue} late</span>}
            </span>
            <Link href={tabHref('tasks')} replace scroll={false} className="ml-auto h-11 md:h-9 px-1 inline-flex items-center text-[13px] md:text-xs text-muted-foreground hover:text-foreground">
              See all ›
            </Link>
          </div>
          <TaskList tasks={open.slice(0, 5)} showProject={false} empty="Nothing open. Tap + Task to add one." />
          {open.length > 5 && (
            <Link href={tabHref('tasks')} replace scroll={false} className="flex items-center min-h-11 md:min-h-8 px-2 text-sm md:text-xs text-muted-foreground hover:text-foreground">
              +{open.length - 5} more ›
            </Link>
          )}
        </section>
      </div>
      <aside className="space-y-4 min-w-0">
        <section className={CARD} data-card="notes">
          {cardHead('Notes', String(projectNotes.length), 'notes')}
          {projectNotes.length > 0 && <div className="border-t border-border/60">{noteList(projectNotes.slice(0, 3), true)}</div>}
          <div className={cn('px-2 md:px-1', projectNotes.length > 0 && 'border-t border-border/60')}>{newNote}</div>
        </section>
        <section className={CARD} data-card="repos">
          <Link href={`${tabHref('info')}#code`} className="flex items-center gap-2 px-4 md:px-3 min-h-11 md:min-h-9 hover:bg-muted/40">
            <h2 className={H2}>Code</h2>
            <span className="text-[15px] md:text-xs text-foreground truncate">
              {repos.length} {repos.length === 1 ? 'repository' : 'repositories'} · {folders.length} {folders.length === 1 ? 'folder' : 'folders'} linked
            </span>
            <ChevronRight className="ml-auto w-4 h-4 text-muted-foreground/60 shrink-0" />
          </Link>
        </section>
        <section className={CARD} data-card="activity">
          {cardHead('Activity', '', 'info')}
          <div className="px-3 pb-2">
            <ActivityTimeline items={activity.slice(0, 3)} showTask />
          </div>
        </section>
      </aside>
    </div>
  );

  return (
    <div className="max-w-6xl space-y-3 min-w-0">
      <h1 className="sr-only">{project.name}</h1>
      <ProjectTop project={project} tab={tab} />

      <nav aria-label="Project sections" className="grid grid-cols-5 gap-0.5 md:inline-flex md:gap-1 rounded-2xl bg-muted/60 p-1 md:max-w-full">
        {TABS.map(t => (
          <Link
            key={t.id}
            href={tabHref(t.id)}
            replace
            scroll={false}
            data-tab={t.id}
            aria-current={t.id === tab ? 'page' : undefined}
            className={cn(
              'inline-flex items-center justify-center h-11 md:h-9 px-1 md:px-5 rounded-xl text-[14px] md:text-sm font-medium whitespace-nowrap',
              t.id === tab ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground active:bg-background/60 hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'claude' && waiting.length > 0 && <span aria-label={`Claude is asking ${waiting.length}`} className="ml-1 w-2 h-2 rounded-full bg-amber-500" />}
          </Link>
        ))}
      </nav>

      {tab === 'overview' && overview}

      {tab === 'tasks' && (
        <div className="space-y-5 max-w-3xl" data-view="tasks">
          <QuickAddBar defaults={{ project: project.name }} className="hidden md:block" />
          <section className="space-y-1.5">
            <h2 className={`${H2} px-1 md:px-0`}>Open · {s.open}</h2>
            <TaskList tasks={open} showProject={false} empty="Nothing open. Tap + Task to add one." />
          </section>
          <section className="space-y-1.5">
            <h2 className={`${H2} px-1 md:px-0`}>Recently finished</h2>
            <TaskList tasks={done} showProject={false} empty="Nothing finished yet." />
          </section>
        </div>
      )}

      {tab === 'claude' && (
        <div className="space-y-5 max-w-3xl" data-view="claude">
          {work.items.length > 0 ? claudeBlock : <p className="text-sm text-muted-foreground px-1">Nothing in the queue. Claude adds items here as it plans work for this project.</p>}
          <ProjectSessions projectId={project.id} {...launcher} reopen={reopen} />
        </div>
      )}

      {tab === 'notes' && (
        <section className="space-y-2 max-w-3xl" data-view="notes">
          <div className="flex items-center justify-between">
            <h2 className={`${H2} px-1 md:px-0`}>Notes · {projectNotes.length}</h2>
            {newNote}
          </div>
          {projectNotes.length ? (
            <div className={CARD}>{noteList(projectNotes)}</div>
          ) : (
            <p className="text-sm text-muted-foreground px-1">No project notes. Ideas, client terms and things to raise later go here.</p>
          )}
          {otherNotes > 0 && (
            <Link href={`/notes?project=${project.id}&state=all`} className="flex items-center min-h-11 md:min-h-0 px-1 md:px-0 text-sm md:text-xs text-muted-foreground hover:text-foreground">
              + {otherNotes} task or archived notes →
            </Link>
          )}
        </section>
      )}

      {tab === 'info' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 items-start" data-view="info">
          <div className="space-y-5 min-w-0">
            <ProjectDetails project={project} isOwner={project.ownerId === me.userId} />
            <section id="code" data-section="code" className="space-y-3 scroll-mt-24">
              <h2 className={`${H2} px-1 md:px-0`}>Code</h2>
              <CodeLocations projectId={project.id} initial={repos} />
              <div className="space-y-1.5" data-part="folders">
                <h3 className="text-[13px] md:text-xs font-semibold text-foreground px-1 md:px-0">Folders on your computers</h3>
                <p className="text-[13px] md:text-xs text-muted-foreground px-1 md:px-0">Where this project lives on each of your computers. Claude opens its sessions in these folders. Only you see your computers.</p>
                <FolderLinks projectId={project.id} folders={launcher.folders} suggestions={launcher.suggestions} devices={launcher.devices} />
              </div>
            </section>
          </div>
          <section className="space-y-2 min-w-0">
            <h2 className={`${H2} px-1 md:px-0`}>Activity</h2>
            <ActivityTimeline items={activity} showTask />
          </section>
        </div>
      )}
    </div>
  );
}
