'use client';

import { CouldBeRunning } from '@/components/could-be-running';
import { SessionFilterChips, useSessionFilter } from '@/components/session-filter';
import { SessionList } from '@/components/session-row';
import { List, Row } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import type { CouldBeRunning as CouldBeRunningRow } from '@/lib/data/roster';
import type { Need } from '@/lib/data/needs';
import { filterSessions, type SessionFilter, type SessionsView } from '@/lib/session-item';

/** A project page's sessions (Overview): the live ones through the viewer's filter (components/session-filter.tsx), then those that finished today. */
export function ProjectSessions({ view, filter: initialFilter, tz, serves, asks, couldBeRunning }: { view: SessionsView; filter: SessionFilter; tz: string; serves: Record<string, string>; asks: Record<string, Need>; couldBeRunning: CouldBeRunningRow | null }) {
  const [filter, setFilter] = useSessionFilter(initialFilter);
  const { live, finished, more } = filterSessions(view, filter);
  const chips = <SessionFilterChips filter={filter} onChange={setFilter} more={more} className="px-1 mb-2" />;
  return (
    <>
      {live.length > 0 ? (
        <div data-card="workers">
          <Section label="Working on it" count={live.length}>
            {chips}
            <SessionList items={live} tz={tz} where="project" serves={serves} asks={asks} />
          </Section>
        </div>
      ) : more.everyone || more.quiet ? (
        <div data-card="no-sessions">
          {chips}
          <List>
            <Row title={<span className="text-muted-foreground">None of your sessions is active on it</span>} />
          </List>
        </div>
      ) : couldBeRunning ? (
        <CouldBeRunning list={[couldBeRunning]} />
      ) : (
        <List data-card="no-sessions">
          <Row title={<span className="text-muted-foreground">No session is working on it</span>} />
        </List>
      )}
      {finished.length > 0 && (
        <div data-card="finished">
          <Section label="Finished today" count={finished.length} fold defaultOpen={live.length === 0}>
            <SessionList items={finished} tz={tz} where="project" serves={serves} />
          </Section>
        </div>
      )}
    </>
  );
}
