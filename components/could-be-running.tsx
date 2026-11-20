import { List, Row } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import type { CouldBeRunning as Item } from '@/lib/data/roster';

/** Projects with unblocked Next work and no live session ("Could be running and isn't"): the Claude page and a project page. */
export function CouldBeRunning({ list }: { list: Item[] }) {
  if (!list.length) return null;
  return (
    <div data-could-run>
      <Section label="Could be running and isn't">
        <List>
          {list.map(p => (
            <Row
              key={p.projectId}
              data-could-run-project={p.projectId}
              href={`/projects/${encodeURIComponent(p.projectId)}`}
              title={
                <>
                  <span className="font-medium">{p.projectName}</span>
                  <span className="text-meta text-muted-foreground">{` · ${p.unblocked} unblocked Next line${p.unblocked === 1 ? '' : 's'}, no one on it`}</span>
                </>
              }
              meta={p.first}
            />
          ))}
        </List>
      </Section>
    </div>
  );
}
