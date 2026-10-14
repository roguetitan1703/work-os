import { CopyBox } from '@/components/copy-box';
import { discordConfig, guildContext, CONTENT_INTENT_WARNING } from '@/lib/discord/client';
import { Card, Disclosure, Section, StatusLine } from './ui';
import { BlockedChannels } from './blocked-channels';

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
      layout: ctx.layout,
      blockedCount: ctx.blocked.size,
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
    <div className="space-y-5">
      <Section title="Status">
        <Card>
          {s.ok ? (
            <StatusLine level={s.contentIntent ? 'ok' : 'warn'} title={`Connected · ${s.readable} channels and ${s.threads} active threads readable`}>
              <p>You are {s.ownerName}. {s.blockedCount ? `${s.blockedCount} channels blocked as sensitive.` : 'No channels blocked as sensitive yet.'}</p>
              {!s.contentIntent && <p className="text-red-600 dark:text-red-400">{CONTENT_INTENT_WARNING}</p>}
              {s.noAccess.length > 0 && <p>Bot can&apos;t read: {s.noAccess.join(', ')}</p>}
            </StatusLine>
          ) : (
            <StatusLine level={'error' in s ? 'error' : 'off'} title={'error' in s ? `Problem: ${s.error}` : 'Not set up'}>
              <p>
                {ENV.map(k => (
                  <span key={k} className="mr-3 inline-block">
                    {set[k] ? '✓' : '✗'} <code>{k}</code>
                  </span>
                ))}
              </p>
            </StatusLine>
          )}
        </Card>
      </Section>

      {s.ok && (
        <Section title="Sensitive channels: never read">
          <p className="px-1 mb-2 text-[13px] text-muted-foreground">
            Tick channels that hold passwords, credentials or anything Claude shouldn&apos;t see. They&apos;re dropped before any read: not listed, not scanned, and links or
            right-clicks into them are refused. For a hard guarantee, also deny the bot&apos;s role <b>View Channel</b> in each of them (Edit Channel → Permissions).
          </p>
          <BlockedChannels layout={s.layout} />
        </Section>
      )}

      <Section title="Setup and use">
        <div className="space-y-3">
          <Disclosure title="Setup and registration" hint="Developer Portal, invite, env vars, commands" open={!s.ok}>
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
          </Disclosure>
          <Disclosure title="Commands" hint="Right-click, slash commands, tagging the bot">
            <div className="-mx-4 -my-4 divide-y divide-border/60 text-sm">
              {[
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
              Only your user ID can use the commands; anyone else gets “Not available”. Writes from Discord show in task history as <b>You · Discord</b>. Personal DMs and group
              DMs are out of reach for bots and are not read.
            </p>
          </Disclosure>
        </div>
      </Section>
    </div>
  );
}
