import Link from 'next/link';
import { Bot, CheckCircle2, MessageSquare, Pencil, Plus, RotateCcw, TrendingUp, ArrowRightLeft, ListChecks, Archive } from 'lucide-react';
import { describeActivity, ACTOR_LABEL } from '@/lib/activity-text';
import { ACTOR_STYLE, fmtDateTime } from '@/lib/format';
import type { Activity, ActivityType } from '@/lib/types';
import { cn } from '@/lib/utils';

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
};

export function ActorBadge({ actor }: { actor: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-medium', ACTOR_STYLE[actor])}>
      {actor === 'claude' && <Bot className="w-2.5 h-2.5" />}
      {ACTOR_LABEL[actor] ?? actor}
    </span>
  );
}

export function ActivityTimeline({ items, showTask = false, empty = 'No history yet.' }: { items: Activity[]; showTask?: boolean; empty?: string }) {
  if (!items.length) return <p className="text-xs text-muted-foreground py-2">{empty}</p>;
  return (
    <ol className="relative space-y-3 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-border">
      {items.map(a => {
        const Icon = ICONS[a.type] ?? Pencil;
        return (
          <li key={a.id} className="relative pl-6">
            <span
              className={cn(
                'absolute left-0 top-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background ring-1 ring-border',
                a.type === 'completed' && 'text-green-500',
                a.type === 'progress' && 'text-blue-500',
              )}
            >
              <Icon className="w-2.5 h-2.5" />
            </span>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
              <ActorBadge actor={a.actor} />
              <time dateTime={a.at}>{fmtDateTime(a.at)}</time>
              {showTask && (
                <Link href={`/tasks/${a.taskRef}`} className="text-foreground hover:underline truncate max-w-[320px]">
                  #{a.taskRef} {a.taskTitle}
                </Link>
              )}
            </div>
            <p className="text-sm text-foreground mt-0.5 whitespace-pre-wrap break-words">{describeActivity(a)}</p>
          </li>
        );
      })}
    </ol>
  );
}
