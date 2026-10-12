import { CopyBox } from '@/components/copy-box';
import { discordConfig, guildContext, CONTENT_INTENT_WARNING } from '@/lib/discord/client';
import { cn } from '@/lib/utils';

// View Channel (1<<10) + Read Message History (1<<16). Nothing else: the bot never posts.
const PERMISSIONS = String((1 << 10) | (1 << 16));

const ENV = ['DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_OWNER_ID'] as const;

async function status() {
  if (!discordConfig()) return { ok: false as const };
  try {
    const ctx = await guildContext({ fresh: true });
    return {
      ok: true as const,
      readable: ctx.channels.filter(c => c.canRead && !c.isThread).length,
      threads: ctx.channels.filter(c => c.canRead && c.isThread).length,
      noAccess: ctx.channels.filter(c => !c.canRead).map(c => (c.isThread && c.parentName ? `#${c.parentName} › ${c.name}` : `#${c.name}`)),
      contentIntent: ctx.contentIntent,
      ownerName: ctx.ownerName,
      ownerFound: ctx.ownerRoleIds.length > 0 || ctx.ownerName !== 'Om',
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : 'failed' };
  }
}

export async function DiscordSection({ base }: { base: string }) {
  const appId = process.env.DISCORD_APPLICATION_ID || '<APPLICATION_ID>';
  const invite = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${PERMISSIONS}&integration_type=0`;
  const s = await status();
  const set = Object.fromEntries(ENV.map(k => [k, !!process.env[k]]));

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Discord</h2>
        <p className="text-sm text-muted-foreground">
          Claude reads the Delpat server on demand (nothing is stored), and you can push messages into Work OS with a right-click or slash commands. The
          bot never posts or reacts; its only output is replies only you can see.
        </p>
      </div>

      <div
        className={cn(
          'rounded-lg border px-4 py-3 text-sm',
          s.ok ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/5',
        )}
      >
        {s.ok ? (
          <div className="space-y-1">
            <div className="font-medium text-green-700 dark:text-green-300">
              Connected · {s.readable} channels and {s.threads} active threads readable · you are {s.ownerName}
            </div>
            {!s.contentIntent && <div className="text-red-600 dark:text-red-400">{CONTENT_INTENT_WARNING}</div>}
            {s.noAccess.length > 0 && <div className="text-muted-foreground">Bot can&apos;t read: {s.noAccess.join(', ')}</div>}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="font-medium text-amber-700 dark:text-amber-300">{'error' in s ? `Discord error: ${s.error}` : 'Not configured yet'}</div>
            <div className="text-xs text-muted-foreground">
              {ENV.map(k => (
                <span key={k} className="mr-3">
                  {set[k] ? '✓' : '✗'} <code>{k}</code>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <ol className="list-decimal pl-5 space-y-3 text-sm text-foreground/90">
        <li>
          <b>Developer Portal → your app → Bot</b>: under <i>Privileged Gateway Intents</i> turn on <b>Message Content Intent</b> (otherwise message text
          comes back empty). Leave the others off. Turn <i>Public Bot</i> off so only you can invite it.
        </li>
        <li>
          <b>General Information</b>: set <b>Interactions Endpoint URL</b> to the URL below and save (Discord sends a signed test request; it must
          succeed, so deploy with <code>DISCORD_PUBLIC_KEY</code> set first).
          <CopyBox text={`${base}/api/discord/interactions`} className="mt-2" />
        </li>
        <li>
          <b>Invite the bot</b> to Delpat with exactly View Channels + Read Message History and the <code>applications.commands</code> scope:
          <CopyBox text={invite} className="mt-2" />
          <span className="text-xs text-muted-foreground">For private channels you want read, add the bot (or its role) to that channel.</span>
        </li>
        <li>
          <b>IDs</b>: Discord → User Settings → Advanced → turn on <b>Developer Mode</b>. Right-click the server icon → <i>Copy Server ID</i> (
          <code>DISCORD_GUILD_ID</code>); right-click your own name → <i>Copy User ID</i> (<code>DISCORD_OWNER_ID</code>).
        </li>
        <li>
          <b>Vercel env vars</b> (then redeploy): <code>DISCORD_APPLICATION_ID</code> and <code>DISCORD_PUBLIC_KEY</code> (General Information),{' '}
          <code>DISCORD_BOT_TOKEN</code> (Bot → Reset Token), <code>DISCORD_GUILD_ID</code>, <code>DISCORD_OWNER_ID</code>.
        </li>
        <li>
          <b>Register the commands</b> (guild-scoped to Delpat, so they appear instantly). Run once, and again whenever commands change:
          <CopyBox text={`curl -X POST ${base}/api/admin/discord/register -H "Authorization: Bearer $MCP_TOKEN"`} className="mt-2" />
        </li>
      </ol>

      <div className="rounded-lg border border-border divide-y divide-border text-sm">
        {[
          ['Right-click a message → Apps → Add to Work OS', 'Creates a task from the message (or says it’s already tracked), with buttons to set priority/due.'],
          ['/task title [priority] [due] [project] [mode]', 'Adds a task. Due accepts today, tomorrow, fri, +3d, 2026-10-20.'],
          ['/today', 'Overdue, due today, in progress and open P1s.'],
          ['/done ref [note]', 'Completes a task (ref autocompletes from open tasks).'],
          ['/progress ref percent [note]', 'Logs progress.'],
          ['Tag the bot in any message', 'Nothing happens on Discord. Claude lists it as “flagged for later” (with the message you replied to) in discord_needs_attention and the brief.'],
        ].map(([cmd, what]) => (
          <div key={cmd} className="px-4 py-2.5">
            <code className="text-xs font-semibold text-foreground">{cmd}</code>
            <p className="text-xs text-muted-foreground mt-0.5">{what}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Only your user ID can use the commands; anyone else gets “Not available”. Writes from Discord show in task history as <b>You · Discord</b>. Personal
        DMs and group DMs are out of reach for bots and are not read.
      </p>
    </section>
  );
}
