import type { Caller } from '@/lib/caller';
import { discordConfig, orgGuildId } from '@/lib/discord/client';
import { isOperator } from '@/lib/operator';
import { getProfile } from '@/lib/profile';
import { DiscordLink } from './discord-link';
import { Disclosure } from './ui';

/** Settings › Notifications › Discord: link your own account (the operator connects the server under Server). */
export async function DiscordLinkPanel({ caller }: { caller: Caller }) {
  if (!discordConfig()) return <p className="px-4 py-3 text-sm text-muted-foreground" data-discord-off>Discord is not set up on this Work OS, so there is nothing to link.</p>;
  const guildId = await orgGuildId(caller.orgId);
  if (!guildId)
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground" data-discord-off>
        No Discord server is connected to this organization yet. {isOperator(caller) ? 'Connect it under Settings › Server.' : 'The operator of this Work OS connects it.'}
      </p>
    );
  const { discordId } = await getProfile(caller);
  return (
    <div className="space-y-3">
      <div className="px-4 py-3">
        <DiscordLink linked={!!discordId} serverReady />
      </div>
      <div className="px-4 pb-3">
        <Disclosure title="Commands" hint="Right-click, slash commands, tagging the bot">
          <div className="-mx-4 -my-4 divide-y divide-border/60 text-sm">
            {[
              ['/link code', 'Links your Discord account to Work OS (the code comes from this page).'],
              ['Right-click a message → Apps → Add to Work OS', 'Creates a task from the message (or says it’s already tracked), with buttons to set priority/due.'],
              ['/task title [priority] [due] [project] [mode]', 'Adds a task. Due accepts today, tomorrow, fri, +3d, 2026-10-20.'],
              ['/today', 'Overdue, due today, in progress and open P1s.'],
              ['/done ref [note]', 'Completes a task (ref autocompletes from open tasks).'],
              ['/progress ref percent [note]', 'Logs progress.'],
              ['Tag the bot in any message', 'Nothing happens on Discord. Claude lists it as “flagged for later” (with the message you replied to) in discord_needs_attention and the brief.'],
            ].map(([cmd, what]) => (
              <div key={cmd} className="px-4 py-2.5">
                <code className="text-xs font-semibold text-foreground break-words">{cmd}</code>
                <p className="text-xs text-muted-foreground mt-0.5">{what}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground pt-4">
            Commands act as whoever linked the Discord account that runs them; an account that isn&apos;t linked gets &ldquo;not linked&rdquo;. Writes from Discord show in task
            history as <b>You · Discord</b>. Personal DMs and group DMs are out of reach for bots and are not read.
          </p>
        </Disclosure>
      </div>
    </div>
  );
}
