import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTaskDetail } from '@/lib/data/tasks';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskDetailClient } from './task-detail-client';

type Props = { params: Promise<{ id: string }> };

export default async function TaskPage({ params }: Props) {
  const { id } = await params;
  const detail = await getTaskDetail(decodeURIComponent(id), { activityLimit: 200 });
  if (!detail) notFound();
  const { task, project, activity, dependencies, dependents } = detail;

  return (
    <div className="grid grid-cols-[minmax(0,_1.6fr)_minmax(0,_1fr)] gap-6 items-start max-w-6xl">
      <TaskDetailClient task={task} projectName={project?.name ?? null} dependencies={dependencies} dependents={dependents} />
      <aside className="space-y-3 lg:sticky lg:top-0">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">History</h2>
        <ActivityTimeline items={activity} />
        {project && (
          <p className="text-xs text-muted-foreground pt-2">
            Part of{' '}
            <Link href={`/projects/${project.id}`} className="underline">
              {project.name}
            </Link>
          </p>
        )}
      </aside>
    </div>
  );
}
