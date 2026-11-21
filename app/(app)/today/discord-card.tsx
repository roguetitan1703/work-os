'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hideDiscordCardAction } from '../settings/profile-actions';

/**
 * "Connect Discord" on Today: shown while the organization has a Discord server, the deployment can sign people in
 * (lib/discord/connect.ts) and this person has neither connected nor dismissed it. Connect goes to Discord's sign-in;
 * Dismiss hides it for good for this person (Settings › Notifications keeps the button). Looks like the other side cards.
 */
export function DiscordCard({ show, phone }: { show: boolean; phone: boolean }) {
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  if (!show || gone) return null;

  const dismiss = () =>
    start(async () => {
      const r = await hideDiscordCardAction();
      if (!r.ok) return void toast.error(r.error);
      setGone(true);
    });

  return (
    <section data-section="discord" aria-label="Connect Discord" className={cn('border bg-card overflow-hidden', phone ? 'mt-4 rounded-2xl border-border/70' : 'rounded-lg border-border')}>
      <div className={cn('flex items-center gap-3', phone ? 'pl-4 pr-3 py-2.5 min-h-14' : 'px-3 py-2')}>
        <div className="flex-1 min-w-0">
          <h2 className="text-body md:text-meta font-medium text-foreground">Connect Discord</h2>
          <p className="text-meta text-muted-foreground leading-snug">Mark a message with the track emoji and it becomes your task.</p>
        </div>
        <a href="/api/discord/connect" data-discord-card-connect className={cn(buttonVariants({ variant: 'outline', size: 'touch' }), 'shrink-0')}>
          Connect
        </a>
      </div>
      <div className={cn('flex items-center justify-end border-t border-border/60', phone ? 'pr-2 min-h-11' : 'pr-1 min-h-10')}>
        <Button variant="ghost" size="touch" className="px-3 text-muted-foreground" data-discord-card-dismiss disabled={pending} onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}
