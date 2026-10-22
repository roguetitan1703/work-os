import { notFound } from 'next/navigation';
import Link from '@/components/intent-link';
import { getTaskDetail, listTrash, type TrashItem } from '@/lib/data/tasks';
import { requireScope } from '@/lib/caller';
import { ActorName } from '@/components/actor-badge';
import { fmtAgo, fmtDate } from '@/lib/format';
import { RestoreTrashButton } from '@/components/trash-controls';
import { Trash2 } from 'lucide-react';
import { ActivityTimeline } from '@/components/activity-timeline';
import { TaskDetailClient } from './task-detail-client';
import { FileText } from 'lucide-react';
import { noteIndex } from '@/lib/data/notes';
import { NewNoteButton } from '@/components/new-note-button';
import { MobileTaskDetail } from '@/components/mobile/m-task-detail';

type Props = { params: Promise<{ id: string }> };

export default async function TaskPage({ params }: Props) {
  const { id } = await params;
  const key = decodeURIComponent(id);
  const s = await requireScope();
  const detail = await getTaskDetail(s, key, { activityLimit: 200 });
  if (!detail) {
    const m = key.trim().match(/^#?(\d{1,7})$/);
    const trashed = m ? (await listTrash(s)).find(t => t.ref === Number(m[1])) : undefined;
    if (!trashed) notFound();
    return <TrashedTask item={trashed} />;
  }
  const { task, project, activity, dependencies, dependents } = detail;
  const note = (await noteIndex(s, { taskIds: [task.id] })).byTask.get(task.id);

  const dep = (t: { id: string; ref: number; title: string; status: typeof task.status }) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status });
  return (
    <>
    <div className="md:hidden">
      <MobileTaskDetail
        task={task}
        activity={activity}
        note={note ? { id: note.id, title: note.title, firstLine: note.firstLine } : null}
        dependencies={dependencies.map(dep)}
        dependents={dependents.map(dep)}
      />
    </div>
    <div className="hidden md:grid grid-cols-1 lg:grid-cols-[minmax(0,_1.6fr)_minmax(0,_1fr)] gap-6 items-start max-w-6xl">
      <TaskDetailClient task={task} projectName={project?.name ?? null} dependencies={dependencies} dependents={dependents} />
      <aside className="space-y-3 lg:sticky lg:top-0">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Note</h2>
        {note ? (
          <Link href={`/notes/${note.id}`} className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 hover:bg-muted/50">
            <FileText className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{note.title}</div>
              <div className="text-xs text-muted-foreground truncate" suppressHydrationWarning>
                {note.firstLine || 'Empty page'} · {fmtAgo(note.updatedAt)}
              </div>
            </div>
          </Link>
        ) : (
          <NewNoteButton task={task.ref} label="Add a note" className="w-full justify-center border-dashed text-muted-foreground" />
        )}
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-2">History</h2>
        <ActivityTimeline items={activity} editable />
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
    </>
  );
}

function TrashedTask({ item }: { item: TrashItem }) {
  return (
    <div className="max-w-xl rounded-lg border border-border bg-card p-6 space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Trash2 className="w-3.5 h-3.5" />
        <span>This task is in the trash</span>
      </div>
      <h1 className="text-xl font-bold text-foreground">
        <span className="font-mono text-muted-foreground font-normal">#{item.ref}</span> {item.title}
      </h1>
      <p className="text-sm text-muted-foreground">
        Deleted {fmtAgo(item.deletedAt)} by <ActorName actor={item.deletedBy} />
        {item.reason && <> &middot; &ldquo;{item.reason}&rdquo;</>}. It will be deleted for good on {fmtDate(item.purgeOn, 'MMM d, yyyy')}.
      </p>
      <div className="flex items-center gap-2 pt-1">
        <RestoreTrashButton taskRef={item.ref} size="sm" />
        <Link href="/review?view=trash" className="text-xs text-muted-foreground hover:text-foreground underline">
          Open trash
        </Link>
      </div>
    </div>
  );
}
