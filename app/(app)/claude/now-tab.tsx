'use client';

import { useState } from 'react';
import Link from '@/components/intent-link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Section } from '@/components/ui/section';
import { SessionList } from '@/components/session-row';
import { SessionFilterChips, useSessionFilter } from '@/components/session-filter';
import { CouldBeRunning } from '@/components/could-be-running';
import type { ReopenPrompt } from '@/lib/data/launcher';
import type { Roster } from '@/lib/data/roster';
import { filterSessions, type SessionFilter, type SessionsView } from '@/lib/session-item';
import type { ClaudeTasks } from '@/lib/data/dispatcher';
import { write } from './auto-refresh';
import { dispatcherSettingsAction } from './dispatcher-actions';
import { ClaudeTasksSection } from './claude-tasks';
import { ReopenBanner } from './reopen-banner';
import type { Need } from '@/lib/data/needs';

type Props = {
  view: SessionsView;
  /** The viewer's Sessions filter, from its cookie (components/session-filter.tsx). */
  filter: SessionFilter;
  tz: string;
  openId?: string;
  couldBeRunning: Roster['couldBeRunning'];
  machines: Roster['machines'];
  hasComputers: boolean;
  claudeTasks: ClaudeTasks;
  reopen?: ReopenPrompt[];
  /** Open Needs to the viewer by asking session id: a waiting row's Answer opens its Need in place. */
  asks?: Record<string, Need>;
};

/**
 * The Claude page's Sessions tab: one list of every session the person may see (their own computers' and the roster's,
 * merged in lib/session-item.ts), live first; then what finished today; Claude's tasks; older ended sessions folded.
 */
export function SessionsTab({ view, filter: initialFilter, tz, openId, couldBeRunning, machines, hasComputers, claudeTasks, reopen = [], asks }: Props) {
  const [filter, setFilter] = useSessionFilter(initialFilter);
  const { live, finished, earlier, counts, more } = filterSessions(view, filter, openId);
  const summary = [counts.working && `${counts.working} working`, counts.waiting && `${counts.waiting} waiting`].filter(Boolean).join(' · ');
  return (
    <div className="space-y-5" data-section="workers">
      <SetupBanner hasComputers={hasComputers} enabled={claudeTasks.settings.enabled} hasNote={!!claudeTasks.settings.boilerplateNoteId} />
      <ReopenBanner prompts={reopen} />
      <CouldBeRunning list={couldBeRunning} />
      <div data-section="sessions">
        <Section label={summary ? `Sessions · ${summary}` : 'Sessions'} count={live.length}>
          <SessionFilterChips filter={filter} onChange={setFilter} more={more} className="px-1 mb-2" />
          {live.length ? (
            <SessionList items={live} tz={tz} where="claude" asks={asks} openId={openId} data-workers-list />
          ) : (
            <div data-workers-empty>
              {more.everyone || more.quiet ? (
                <EmptyState title="None of your sessions is active" hint="Everyone shows your teammates' sessions; Quiet and off shows the ones that are doing nothing or have ended." />
              ) : (
                <EmptyState
                  title="No session is running"
                  hint="A Claude Code session with the Work OS hooks shows up here while it works: yours and your teammates' on shared projects."
                />
              )}
            </div>
          )}
        </Section>
      </div>
      {finished.length > 0 && (
        <div data-section="finished">
          <Section label="Finished today" count={finished.length}>
            <SessionList items={finished} tz={tz} where="claude" openId={openId} />
          </Section>
        </div>
      )}
      <ClaudeTasksSection data={claudeTasks} />
      {earlier.length > 0 && (
        <div data-section="earlier">
          <Section label="Earlier" count={earlier.length} fold defaultOpen={false}>
            <SessionList items={earlier} tz={tz} where="claude" openId={openId} />
          </Section>
        </div>
      )}
      {machines.length > 0 && (
        <p className="px-1 text-meta text-muted-foreground" data-heavy-slots>
          Heavy slots: {machines.map(m => `${m.machine} ${m.held} of ${m.cap}`).join(', ')}
        </p>
      )}
    </div>
  );
}

// ── One banner for the state of Claude ──────────────────────────────────────

const banner = 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-amber-500/10 text-amber-800 dark:text-amber-300 px-3 py-1.5 text-body md:text-meta';

/** No computer: set up. A computer but Claude is switched off: switch it on (turning it on needs the note every session reads first, which is picked in Set up). Ready: nothing. */
function SetupBanner({ hasComputers, enabled, hasNote }: { hasComputers: boolean; enabled: boolean; hasNote: boolean }) {
  const [busy, setBusy] = useState(false);
  if (hasComputers && enabled) return null;
  const go = (text: string, attr: Record<string, string>) => (
    <Link href="/claude?tab=setup" replace className="h-11 md:h-9 px-4 rounded-pill text-meta font-semibold inline-flex items-center bg-foreground text-background" {...attr}>
      {text}
    </Link>
  );
  if (!hasComputers)
    return (
      <p className={banner} data-claude-banner="no-computer">
        <span className="min-w-0 flex-1">Claude has no PC to work on.</span>
        {go('Set up Claude', {})}
      </p>
    );
  if (!hasNote)
    return (
      <p className={banner} data-claude-banner="off">
        <span className="min-w-0 flex-1">Claude will not start tasks yet.</span>
        {go('Switch on', { 'data-claude-switch-on': '' })}
      </p>
    );
  const switchOn = async () => {
    setBusy(true);
    try {
      const r = await write(() => dispatcherSettingsAction({ enabled: true }));
      if (!r.ok) return void toast.error(r.error);
      toast('Claude will start the tasks you give it');
    } catch {
      toast.error('Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className={banner} data-claude-banner="off">
      <span className="min-w-0 flex-1">Claude will not start tasks yet.</span>
      <Button size="touch" className="rounded-pill bg-foreground text-background" disabled={busy} onClick={switchOn} data-claude-switch-on>
        Switch on
      </Button>
    </p>
  );
}

/** "2m ago" style, short. */
export function agoShort(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
