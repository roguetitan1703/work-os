'use client';

import { Bot, SquareTerminal } from 'lucide-react';
import { actorKey, actorLabel, type Actor } from '@/lib/actors';
import { ACTOR_STYLE } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useApp } from './app-context';

/** Who did it, as the viewer reads it: "You", a teammate's name, "Claude · Ana" (lib/actors.ts). */
export function ActorName({ actor }: { actor: Actor | string }) {
  const { me, people } = useApp();
  return <>{actorLabel(actor, me, people)}</>;
}

export function ActorBadge({ actor }: { actor: Actor | string }) {
  const { me, people } = useApp();
  const key = actorKey(actor, me);
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-medium', ACTOR_STYLE[key])}>
      {key === 'claude' && <Bot className="w-2.5 h-2.5" />}
      {key === 'claude-code' && <SquareTerminal className="w-2.5 h-2.5" />}
      {actorLabel(actor, me, people)}
    </span>
  );
}

/** A member by id: "you" for the viewer, else their name. */
export function PersonName({ userId, you = 'you' }: { userId: string; you?: string }) {
  const { me, people } = useApp();
  return <>{userId === me ? you : people[userId] || 'a teammate'}</>;
}
