import Link from '@/components/intent-link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FolderOpen, ListTodo } from 'lucide-react';
import { getNote, getNoteWithBlocks } from '@/lib/data/notes';
import { fmtAgo } from '@/lib/format';
import { getCaller, requireScope } from '@/lib/caller';
import { getProject } from '@/lib/data/projects';
import { OrdersSwitch } from './orders-switch';
import { ActorName } from '@/components/actor-badge';
import { NoteEditor } from './note-editor';
import { MobileBack } from '@/components/mobile/sub-header';
import { BackLink } from '@/components/back-link';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string; edit?: string }> };

export async function generateMetadata({ params }: Props) {
  const n = await getNote(await requireScope(), (await params).id);
  return { title: n ? `${n.title} · Notes` : 'Note' };
}

export default async function NotePage({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await getNoteWithBlocks(await requireScope(), id);
  if (!r) notFound();
  const { note, blocks } = r;
  // Orders: which layers this person may mark this page as (lib/data/orders.ts setOrders): their own page, their project's page, an owner's organization page.
  const me = await getCaller();
  const proj = note.projectId && !note.taskId && !note.parentId ? await getProject(await requireScope(), note.projectId) : null;
  const ordersOptions: ('person' | 'project' | 'org')[] = [];
  if (me && !note.taskId && !note.parentId) {
    if (note.ownerId === me.userId) ordersOptions.push('person');
    if (proj && proj.ownerId === me.userId) ordersOptions.push('project');
    if (me.role === 'owner') ordersOptions.push('org');
  }
  // Back rule: where you came from, else the note's project (a task note: its task; a sub-page: its parent).
  const parent = note.parentId
    ? { href: `/notes/${note.parentId}`, label: note.parentTitle ?? 'Parent' }
    : note.projectId
      ? { href: `/projects/${note.projectId}`, label: note.projectName ?? 'Project' }
      : note.taskRef
        ? { href: `/tasks/${note.taskRef}`, label: `#${note.taskRef}` }
        : { href: '/notes', label: 'Notes' };

  return (
    <div className="max-w-3xl mx-auto space-y-3 md:space-y-4 pb-24">
      <MobileBack href={parent.href} label={parent.label} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] md:text-xs text-muted-foreground">
        <BackLink href={parent.href} className="hidden md:flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="w-3 h-3" /> {parent.label}
        </BackLink>
        {note.taskRef && (
          <Link href={`/tasks/${note.taskRef}`} className="flex items-center gap-1 min-h-9 md:min-h-0 hover:text-foreground">
            <ListTodo className="w-3 h-3" />#{note.taskRef} {note.taskTitle}
          </Link>
        )}
        {note.projectId && note.projectName && (
          <Link href={`/projects/${note.projectId}`} className="flex items-center gap-1 min-h-9 md:min-h-0 hover:text-foreground">
            <FolderOpen className="w-3 h-3" />
            {note.projectName}
          </Link>
        )}
        <span suppressHydrationWarning>
          Edited {fmtAgo(note.updatedAt)} by <ActorName actor={note.updatedBy} />
        </span>
        {note.archived && <span className="px-1.5 py-px rounded bg-muted">Archived · {note.archivedBecause}</span>}
        {(ordersOptions.length > 0 || note.orders) && <OrdersSwitch noteId={note.id} current={note.orders ?? null} options={ordersOptions} />}
      </div>
      <NoteEditor
        key={note.id}
        note={{ id: note.id, title: note.title, updatedAt: note.updatedAt, isTaskNote: !!note.taskId, ownArchived: note.archivedBecause === 'archived', parentId: note.parentId }}
        blocks={blocks}
        focusTitle={sp.new === '1' || sp.edit === '1'}
      />
    </div>
  );
}
