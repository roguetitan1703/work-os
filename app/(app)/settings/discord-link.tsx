'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { CopyBox } from '@/components/copy-box';
import { discordLinkCodeAction, saveDiscordServerAction, unlinkDiscordAction } from './profile-actions';

const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold border border-border disabled:opacity-50';

/** Link your own Discord account: make a code here, run /link <code> on the server (the signed command proves the account). */
export function DiscordLink({ linked, serverReady }: { linked: boolean; serverReady: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);

  if (linked) {
    return (
      <div className="flex flex-wrap items-center gap-3" data-discord-linked>
        <p className="text-sm">Your Discord account is linked. Commands on the server act as you, and alert DMs come to you.</p>
        <button
          type="button"
          className={btn}
          disabled={pending}
          data-discord-unlink
          onClick={() =>
            start(async () => {
              const r = await unlinkDiscordAction();
              if (!r.ok) return void toast.error(r.error);
              setCode(null);
              router.refresh();
            })
          }
        >
          Unlink
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-discord-unlinked>
      <p className="text-sm">
        Your Discord account is not linked. Make a code, then run the command below on the organization&apos;s Discord server. Until then commands there say
        &ldquo;not linked&rdquo; and alerts don&apos;t go to Discord.
      </p>
      {code ? (
        <div className="space-y-1">
          <CopyBox text={`/link ${code.code}`} />
          <p className="text-xs text-muted-foreground">Works once, until {new Date(code.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
        </div>
      ) : (
        <button
          type="button"
          className={btn}
          disabled={pending || !serverReady}
          data-discord-link-code
          onClick={() =>
            start(async () => {
              const r = await discordLinkCodeAction();
              if (!r.ok) return void toast.error(r.error);
              setCode(r.data);
            })
          }
        >
          Make a link code
        </button>
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
        className="h-11 md:h-9 w-56 rounded-md border border-border bg-background px-3 text-sm"
      />
      <button type="submit" className={btn} disabled={pending || value.trim() === (guildId ?? '')}>
        Save
      </button>
    </form>
  );
}
