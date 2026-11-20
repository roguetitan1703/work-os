import type { Caller } from '@/lib/caller';
import { discordConfig, orgGuildId } from '@/lib/discord/client';
import { connectReady } from '@/lib/discord/connect';
import { isOperator } from '@/lib/operator';
import { getProfile } from '@/lib/profile';
import { DiscordLink } from './discord-link';

/** What the person is told when they come back from Discord (the callback sends one fixed word). */
const RESULTS: Record<string, string> = {
  linked: 'Discord connected.',
  failed: 'Discord did not connect. Try again.',
  notready: 'Connecting is not set up on this Work OS yet.',
  notserver: 'No Discord server is connected to this organization yet.',
  notmember: 'Your Discord account is not on this organization\u2019s server. Join it, then connect again.',
};

/** Settings › Notifications › Discord: connect your own account (the operator connects the server under Server). */
export async function DiscordLinkPanel({ caller, result }: { caller: Caller; result?: string }) {
  if (!discordConfig()) return <p className="px-4 py-3 text-body md:text-meta text-muted-foreground" data-discord-off>Discord is not set up on this Work OS, so there is nothing to connect.</p>;
  const guildId = await orgGuildId(caller.orgId);
  if (!guildId)
    return (
      <p className="px-4 py-3 text-body md:text-meta text-muted-foreground" data-discord-off>
        No Discord server is connected to this organization yet. {isOperator(caller) ? 'Connect it under Settings › Server.' : 'The operator of this Work OS connects it.'}
      </p>
    );
  const { discordId } = await getProfile(caller);
  const note = result && Object.hasOwn(RESULTS, result) ? RESULTS[result] : null;
  return (
    <div className="space-y-3">
      {note && (
        <p className="px-4 pt-3 text-body md:text-meta font-medium" data-discord-result={result} role="status">
          {note}
        </p>
      )}
      <div className="px-4 py-3">
        <DiscordLink linked={!!discordId} ready={connectReady()} />
      </div>
    </div>
  );
}
