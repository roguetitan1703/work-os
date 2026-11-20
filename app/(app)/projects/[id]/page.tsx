import { notFound } from 'next/navigation';
import { redirect } from 'next/navigation';
import { SHELVES } from '@/lib/notes-shelves';
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
import { oldItems } from '@/lib/data/claude-items';
import { projectLauncher, reopenPrompts } from '@/lib/data/launcher';
import { turboInfo } from '@/lib/data/turbo';
import { OldClaudeItems } from './old-claude-items';
import { CodeLocations } from './code-locations';
import { ProductionSetting } from './production-setting';
import { getProduction } from '@/lib/data/production';
import { getNudges } from '@/lib/data/nudges';
import { NudgesSetting } from './nudges-setting';
import { FolderLinks } from './folders';
import { ProjectDetails } from './project-header';
import { ProjectTop } from './project-top';
import { projectNeeds, withNeedWaits } from '@/lib/data/needs';
import { asksBySession, withAskerSessions } from '@/lib/data/need-sessions';
import { NeedsTab } from '@/components/needs';
import { StateCard } from './state-card';
import { PurposeHeader } from '@/components/purpose-header';
import { CouldBeRunning } from '@/components/could-be-running';
import { SessionList } from '@/components/session-row';
import { List, Row } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { ReopenBanner } from '../../claude/reopen-banner';
import { claudeOverview } from '@/lib/data/claude-overview';
import { mergeSessions } from '@/lib/session-item';
import { nextServing, placeOf } from '@/lib/data/purpose';
import { PlacesProvider } from '@/components/task-place';
import { projectRoster, withLaneMarks } from '@/lib/data/roster';
import { archivedOut, stateOfProject, stateOut } from '@/lib/data/states';
import { memberNames } from '@/lib/people';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'needs', label: 'Needs' },
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
  // The sessions are on Overview (an old ?tab=claude lands there); old Claude items (?claude=C12) sit in Info.
  const tab: TabId = TABS.find(t => t.id === sp.tab)?.id ?? (sp.claude ? 'info' : 'overview');
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const tabHref = (t: TabId) => `${base}?tab=${t}`;

  const [open, done, activity, notes, oldClaudeItems, launcher, reopen, stateDoc, names, needsRaw, computers] = await Promise.all([
    listTasks(sc, { project: project.id, open: true }),
    listTasks(sc, { project: project.id, status: ['Done', 'Dropped'], sort: 'done', limit: 30 }),
    listActivity(sc, { project: project.id, limit: 40 }),
    listNotes(sc, { project: project.id, state: 'all' }),
    oldItems(sc, project.id),
    projectLauncher(me, project.id),
    reopenPrompts(me),
    stateOfProject(sc, project.id),
    memberNames(me.orgId),
    projectNeeds(sc, project.id),
    claudeOverview(me, { card: true }).catch(() => null),
  ]);
  const [projectWorkers, needs] = await Promise.all([
    projectRoster(sc, { id: project.id, name: project.name, status: project.status }, stateDoc, names, open),
    withAskerSessions(sc, needsRaw),
  ]);
  // The sessions on this project, the same rows as the Claude page (lib/session-item.ts): live first, then those that ended today.
  // eslint-disable-next-line react-hooks/purity -- a server render runs once per request
  const sessions = mergeSessions(projectWorkers.workers, computers?.sessions ?? [], { tz: me.tz, now: Date.now(), projectId: project.id });
  const serves = Object.fromEntries(
    [...sessions.live, ...sessions.finished].flatMap(i => {
      const line = i.doing?.ref ? nextServing(i.doing.ref, stateDoc) : null;
      return line ? [[i.id, line]] : [];
    }),
  );
  const openNeeds = needs.filter(n => n.status === 'open');
  const stateView = stateDoc ? await withLaneMarks(sc, project.id, stateDoc, await withNeedWaits(sc, project.id, stateOut(stateDoc, me.userId, names, { decisions: 'all', parked: true }), names)) : null;
  const needsOpenForMe = needs.filter(n => n.status === 'open' && n.to === me.userId).length;
  const turbo = await turboInfo(me, project.id, launcher);
  // A project's notes sit on shelves (lib/notes-shelves.ts); task notes, sub-pages and archived notes sit elsewhere.
  const projectNotes = notes.notes.filter(n => !n.taskId && !n.parentId && !n.archived);
  const otherNotes = notes.notes.length - projectNotes.length;
  const shelves = SHELVES.map(sh => ({ ...sh, notes: projectNotes.filter(n => n.shelf === sh.id) })).filter(sh => sh.notes.length);
  const overviewFirst = [...projectNotes].sort((a, b) => Number(b.shelf === 'overview') - Number(a.shelf === 'overview'));
  const s = project.stats;
  const repos = project.code ?? [];
  const folders = launcher.folders.filter(f => !f.missing);

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
        {/* Now (the goal) is the purpose header above the tabs; then who works on it, what waits on a person, the rest of the State. */}
        <ReopenBanner prompts={reopen} onlyDevices={folders.map(f => f.deviceId)} />
        {sessions.live.length > 0 ? (
          <div data-card="workers">
            <Section label="Working on it" count={sessions.live.length}>
              <SessionList items={sessions.live} tz={me.tz} where="project" serves={serves} asks={asksBySession(needs, me.userId)} />
            </Section>
          </div>
        ) : projectWorkers.couldBeRunning ? (
          <CouldBeRunning list={[projectWorkers.couldBeRunning]} />
        ) : (
          <List data-card="no-sessions">
            <Row title={<span className="text-muted-foreground">No session is working on it</span>} />
          </List>
        )}
        {sessions.finished.length > 0 && (
          <div data-card="finished">
            <Section label="Finished today" count={sessions.finished.length} fold defaultOpen={sessions.live.length === 0}>
              <SessionList items={sessions.finished} tz={me.tz} where="project" serves={serves} />
            </Section>
          </div>
        )}
        {openNeeds.length > 0 && (
          <div data-card="needs">
            <Section label="Needs" count={openNeeds.length} seeAll={tabHref('needs')}>
              <List>
                {openNeeds.slice(0, 3).map(n => (
                  <Row
                    key={n.id}
                    data-need-row={n.ref}
                    href={tabHref('needs')}
                    title={
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate">{n.ask}</span>
                        <StatusBadge status={n.kind} />
                      </span>
                    }
                    meta={[n.to === me.userId ? 'For you' : `For ${names[n.to] ?? 'a member'}`, n.session ? `${n.session.label}: ${n.session.word}` : '', n.taskRef ? `on #${n.taskRef}` : ''].filter(Boolean).join(' · ')}
                  />
                ))}
              </List>
            </Section>
          </div>
        )}
        <StateCard projectId={project.id} initial={stateView} archived={stateDoc ? archivedOut(stateDoc, names) : []} />
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
          {projectNotes.length > 0 && <div className="border-t border-border/60">{noteList(overviewFirst.slice(0, 3), true)}</div>}
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

  const places = Object.fromEntries([...open, ...done].flatMap(t => { const p = placeOf(t.ref, stateDoc); return p ? [[t.id, p]] : []; }));
  return (
    <PlacesProvider places={places}>
    <div className="max-w-6xl space-y-3 min-w-0">
      <h1 className="sr-only">{project.name}</h1>
      <ProjectTop project={project} tab={tab} />
      <PurposeHeader projectId={project.id} initial={stateView} description={project.description?.trim() || undefined} />

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
              'inline-flex items-center justify-center h-11 md:h-9 px-0.5 md:px-5 rounded-xl text-[13px] tracking-tight md:tracking-normal md:text-sm font-medium whitespace-nowrap',
              t.id === tab ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground active:bg-background/60 hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'needs' && needsOpenForMe > 0 && <span aria-label={`${needsOpenForMe} Needs you`} className="ml-1 w-2 h-2 rounded-full bg-amber-500" />}
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

      {tab === 'needs' && <NeedsTab needs={needs} />}

      {tab === 'notes' && (
        <section className="space-y-2 max-w-3xl" data-view="notes">
          <div className="flex items-center justify-between">
            <h2 className={`${H2} px-1 md:px-0`}>Notes · {projectNotes.length}</h2>
            {newNote}
          </div>
          {projectNotes.length ? (
            shelves.map(sh => (
              <div key={sh.id} className="space-y-1.5 pt-1" data-shelf={sh.id}>
                <h3 className={`${H2} px-1 md:px-0 text-[12px] md:text-[11px]`}>
                  {sh.label} · {sh.notes.length}
                </h3>
                <div className={CARD}>{noteList(sh.notes)}</div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground px-1">No project notes. Ideas, client terms and things to raise later go here.</p>
          )}
          {otherNotes > 0 && (
            <Link href={`/notes?project=${project.id}&state=all`} className="flex items-center min-h-11 md:min-h-0 px-1 md:px-0 text-sm md:text-xs text-muted-foreground hover:text-foreground">
              + {otherNotes} task, sub-page or archived notes →
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
              <ProductionSetting projectId={project.id} initial={await getProduction(sc, project.id)} />
              <NudgesSetting projectId={project.id} initial={await getNudges(sc, project.id)} />
              <div className="space-y-1.5" data-part="folders">
                <h3 className="text-[13px] md:text-xs font-semibold text-foreground px-1 md:px-0">Folders on your computers</h3>
                <p className="text-[13px] md:text-xs text-muted-foreground px-1 md:px-0">Where this project lives on each of your computers. Claude opens its sessions in these folders. Only you see your computers.</p>
                <FolderLinks projectId={project.id} folders={launcher.folders} suggestions={launcher.suggestions} devices={launcher.devices} turbo={turbo} />
              </div>
            </section>
            <OldClaudeItems items={oldClaudeItems} openRef={Number(sp.claude?.replace(/^C/i, '')) || undefined} />
          </div>
          <section className="space-y-2 min-w-0">
            <h2 className={`${H2} px-1 md:px-0`}>Activity</h2>
            <ActivityTimeline items={activity} showTask />
          </section>
        </div>
      )}
    </div>
    </PlacesProvider>
  );
}
