'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { saveDiscordServerAction, unlinkDiscordAction } from './profile-actions';

/**
 * Connect your own Discord account: one button that signs you in at Discord (lib/discord/connect.ts), no code to copy. Connected: a line
 * and Unlink. `ready` is false while the operator has not set the client secret.
 */
export function DiscordLink({ linked, ready }: { linked: boolean; ready: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (linked) {
    return (
      <div className="flex flex-wrap items-center gap-3" data-discord-linked>
        <p className="text-body md:text-meta">Your Discord account is connected. What you mark or press there is yours, and reel and day-old Need DMs come to you.</p>
        <Button
          variant="outline"
          size="touch"
          disabled={pending}
          data-discord-unlink
          onClick={() =>
            start(async () => {
              const r = await unlinkDiscordAction();
              if (!r.ok) return void toast.error(r.error);
              router.refresh();
            })
          }
        >
          Unlink
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3" data-discord-unlinked>
      <p className="text-body md:text-meta">Connect your Discord account so posts you mark with the track emoji and the buttons under the bot&apos;s replies are yours, and so reel and day-old Need DMs can reach you.</p>
      {ready ? (
        <a href="/api/discord/connect" className={buttonVariants({ size: 'touch' })} data-discord-connect>
          Connect Discord
        </a>
      ) : (
        <p className="text-meta text-muted-foreground" data-discord-not-ready>
          Connecting is not set up yet: the operator of this Work OS adds the Discord client secret.
        </p>
      )}
    </div>
  );
}

/** The operator connects this organization to its Discord server (Developer Mode → right-click the server → Copy Server ID). */
export function DiscordServerForm({ guildId }: { guildId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(guildId ?? '');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-discord-server
      onSubmit={e => {
        e.preventDefault();
        start(async () => {
          const r = await saveDiscordServerAction(value);
          if (!r.ok) return void toast.error(r.error);
          toast.success(value.trim() ? 'Discord server saved' : 'Discord server removed');
          router.refresh();
        });
      }}
    >
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        inputMode="numeric"
        placeholder="Server ID"
        aria-label="Discord server ID"
        className="h-11 md:h-9 w-56 rounded-md border border-border bg-background px-3 text-body md:text-meta"
      />
      <Button type="submit" variant="outline" size="touch" disabled={pending || value.trim() === (guildId ?? '')}>
        Save
      </Button>
    </form>
  );
}
