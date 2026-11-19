import Link from '@/components/intent-link';
import {
  CheckCircle2,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  TrendingUp,
  ArrowRightLeft,
  ListChecks,
  Archive,
  Trash2,
  ArchiveRestore,
  Target,
  ListPlus,
  CheckCheck,
  Clock,
  Gavel,
  FilePlus,
  FileText,
  Mail,
  CircleHelp,
  Reply,
  Undo2,
  FolderPlus,
  Eye,
  ShieldCheck,
  LogOut,
} from 'lucide-react';
import { WHAT_LABEL, activityHref, describeActivity, whatOf } from '@/lib/activity-text';
import { fmtDateTime } from '@/lib/format';
import { ActorBadge } from './actor-badge';
import type { Activity, ActivityType } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CommentEntry } from './comment-entry';

const ICONS: Record<ActivityType, React.ComponentType<{ className?: string }>> = {
  created: Plus,
  status: ArrowRightLeft,
  completed: CheckCircle2,
  reopened: RotateCcw,
  progress: TrendingUp,
  edit: Pencil,
  comment: MessageSquare,
  checklist: ListChecks,
  archived: Archive,
  unarchived: Archive,
  trashed: Trash2,
  restored: ArchiveRestore,
  state_now: Target,
  next_added: ListPlus,
  next_done: CheckCheck,
  later_added: Clock,
  decision: Gavel,
  note_created: FilePlus,
  note_edited: FileText,
  message_sent: Mail,
  need_asked: CircleHelp,
  need_answered: Reply,
  need_withdrawn: Undo2,
  project_created: FolderPlus,
  project_renamed: Pencil,
  visibility_changed: Eye,
  production: ShieldCheck,
  session_ended: LogOut,
};

/** What a row links to in a feed with `showTask`: the task (#12 Title), or the project and what changed there (Work OS · State). */
function SubjectLink({ a }: { a: Activity }) {
  const href = activityHref(a);
  const what = whatOf(a);
  const label = a.taskRef
    ? `#${a.taskRef} ${a.taskTitle ?? ''}${what === 'tasks' ? '' : ` · ${WHAT_LABEL[what]}`}`
    : [a.projectName, what === 'needs' && a.subject?.ref ? `Need #${a.subject.ref}` : WHAT_LABEL[what]].filter(Boolean).join(' · ');
  const cls = 'text-foreground truncate max-w-[320px]';
  return href ? (
    <Link href={href} className={cn(cls, 'hover:underline')} data-activity-subject={what}>
      {label}
    </Link>
  ) : (
    <span className={cls} data-activity-subject={what}>
      {label}
    </span>
  );
}

export function ActivityTimeline({
  items,
  showTask = false,
  editable = false,
  empty = 'No history yet.',
}: {
  items: Activity[];
  /** Name what each row is about: its task, or its project and what changed there (State, a note, a message, a Need). */
  showTask?: boolean;
  /** show hover Edit / Delete on comments */
  editable?: boolean;
  empty?: string;
}) {
  if (!items.length) return <p className="text-xs text-muted-foreground py-2">{empty}</p>;
  return (
    <ol className="relative space-y-3 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-border">
      {items.map(a => {
        const Icon = ICONS[a.type] ?? Pencil;
        const editableComment = editable && a.type === 'comment' && !!a.note && !a.subject;
        return (
          <li key={a.id} className={cn('relative pl-6', editableComment && 'group')} data-activity-type={a.type}>
            <span
              className={cn(
                'absolute left-0 top-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background ring-1 ring-border',
                (a.type === 'completed' || a.type === 'next_done') && 'text-green-500',
                a.type === 'progress' && 'text-blue-500',
              )}
            >
              <Icon className="w-2.5 h-2.5" />
            </span>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
              <ActorBadge actor={a.actor} />
              <time dateTime={a.at}>{fmtDateTime(a.at)}</time>
              {(a.session || a.repo) && (
                <span className="font-mono text-[10px] text-muted-foreground/70 truncate max-w-[200px]" title={[a.repo && `repo ${a.repo}`, a.session && `session ${a.session}`].filter(Boolean).join(' · ')}>
                  {[a.repo, a.session?.slice(0, 8)].filter(Boolean).join(' · ')}
                </span>
              )}
              {showTask && <SubjectLink a={a} />}
            </div>
            {editableComment ? (
              <CommentEntry key={a.note} id={a.id} note={a.note!} />
            ) : (
              <p className="text-sm text-foreground mt-0.5 whitespace-pre-wrap break-words">{describeActivity(a)}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
