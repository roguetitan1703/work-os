import { CopyBox } from '@/components/copy-box';
import type { Caller } from '@/lib/caller';
import { discordConfig, guildContext, orgGuildId, CONTENT_INTENT_WARNING } from '@/lib/discord/client';
import { isOperator } from '@/lib/operator';
import { getProfile } from '@/lib/profile';
import { Card, Disclosure, Section, StatusLine } from './ui';
import { BlockedChannels } from './blocked-channels';
import { DiscordLink, DiscordServerForm } from './discord-link';

// View Channel (1<<10) + Read Message History (1<<16). Nothing else: the bot never posts.
const PERMISSIONS = String((1 << 10) | (1 << 16));

// One bot for the whole deployment; each organization's server and each person's account are set in the app.
const ENV = ['DISCORD_APPLICATION_ID', 'DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN'] as const;

async function status(caller: Caller) {
  if (!discordConfig()) return { ok: false as const };
  const guildId = await orgGuildId(caller.orgId);
  if (!guildId) return { ok: false as const, noServer: true as const };
  const { discordId } = await getProfile(caller);
  try {
    const ctx = await guildContext({ orgId: caller.orgId, guildId, discordId }, { fresh: true });
    return {
      ok: true as const,
      linked: !!discordId,
      readable: ctx.channels.filter(c => c.canRead && !c.isThread).length,
      threads: ctx.channels.filter(c => c.canRead && c.isThread).length,
      noAccess: ctx.channels.filter(c => !c.canRead).map(c => (c.isThread && c.parentName ? `#${c.parentName} › ${c.name}` : `#${c.name}`)),
      contentIntent: ctx.contentIntent,
      ownerName: ctx.ownerName,
      inServer: ctx.ownerRoleIds.length > 0 || ctx.ownerAdmin || ctx.visible.size > 0,
      // Only what this person's Discord account can see (blocking applies to the whole organization).
      layout: ctx.layout.filter(r => ctx.visible.has(r.id)),
      blockedCount: ctx.blocked.size,
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : 'failed' };
  }
}

export async function DiscordSection({ base, caller }: { base: string; caller: Caller }) {
  const appId = process.env.DISCORD_APPLICATION_ID || '<APPLICATION_ID>';
  const invite = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${PERMISSIONS}&integration_type=0`;
  const [s, guildId] = await Promise.all([status(caller), orgGuildId(caller.orgId)]);
  const set = Object.fromEntries(ENV.map(k => [k, !!process.env[k]]));
  const operator = isOperator(caller);
  const manages = caller.role === 'owner' || caller.role === 'admin';

  return (
    <div className="space-y-5">
      <Section title="Status">
        <Card>
          {s.ok ? (
            <StatusLine
              level={s.contentIntent && s.linked ? 'ok' : 'warn'}
              title={s.linked ? `Connected · ${s.readable} channels and ${s.threads} active threads readable` : 'Server connected · your account is not linked'}
            >
              {s.linked && (
                <p>
                  You are {s.ownerName}{s.inServer ? '' : ' (not found on the server)'}. Work OS shows you only the channels your Discord account can see.{' '}
                  {s.blockedCount ? `${s.blockedCount} channels blocked as sensitive.` : 'No channels blocked as sensitive yet.'}
                </p>
              )}
              {!s.contentIntent && <p className="text-red-600 dark:text-red-400">{CONTENT_INTENT_WARNING}</p>}
              {s.linked && s.noAccess.length > 0 && <p>Bot can&apos;t read: {s.noAccess.join(', ')}</p>}
            </StatusLine>
          ) : (
            <StatusLine
              level={'error' in s ? 'error' : 'off'}
              title={'error' in s ? `Problem: ${s.error}` : 'noServer' in s ? 'No Discord server connected to this organization' : 'Not set up'}
            >
              {!('noServer' in s) && (
                <p>
                  {ENV.map(k => (
                    <span key={k} className="mr-3 inline-block">
                      {set[k] ? '✓' : '✗'} <code>{k}</code>
                    </span>
                  ))}
                </p>
              )}
              {'noServer' in s && !operator && <p>The operator of this Work OS connects the organization&apos;s server.</p>}
            </StatusLine>
          )}
        </Card>
      </Section>

      {discordConfig() && guildId && (
        <Section title="Your Discord account">
          <Card>
            <DiscordLink linked={s.ok && s.linked} serverReady />
          </Card>
        </Section>
      )}

      {operator && discordConfig() && (
        <Section title="Organization's Discord server">
          <Card>
            <p className="text-[13px] text-muted-foreground mb-2">
              Only you, the operator, see this. One server per organization; commands registered there act for whoever linked their account.
            </p>
            <DiscordServerForm guildId={guildId} />
          </Card>
        </Section>
      )}

      {s.ok && s.linked && manages && (
        <Section title="Sensitive channels: never read">
          <p className="px-1 mb-2 text-[13px] text-muted-foreground">
            For everyone in the organization. Tick channels that hold passwords, credentials or anything Claude shouldn&apos;t see. They&apos;re dropped before any read: not
            listed, not scanned, and links or right-clicks into them are refused. For a hard guarantee, also deny the bot&apos;s role <b>View Channel</b> in each of them
            (Edit Channel → Permissions).
          </p>
          <BlockedChannels layout={s.layout} />
        </Section>
      )}

      <Section title="Setup and use">
        <div className="space-y-3">
          {operator && (
            <Disclosure title="Setup and registration" hint="Developer Portal, invite, env vars, server, commands" open={!s.ok}>
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
                  <b>Invite the bot</b> to the organization&apos;s server with exactly View Channels + Read Message History and the <code>applications.commands</code> scope:
                  <CopyBox text={invite} className="mt-2" />
                  <span className="text-xs text-muted-foreground">For private channels you want read, add the bot (or its role) to that channel.</span>
                </li>
                <li>
                  <b>Env vars</b> (then redeploy): <code>DISCORD_APPLICATION_ID</code> and <code>DISCORD_PUBLIC_KEY</code> (General Information),{' '}
                  <code>DISCORD_BOT_TOKEN</code> (Bot → Reset Token).
                </li>
                <li>
                  <b>Server</b>: Discord → User Settings → Advanced → turn on <b>Developer Mode</b>, right-click the server icon → <i>Copy Server ID</i>, and save it
                  above.
                </li>
                <li>
                  <b>Register the commands</b> in this organization&apos;s server (they appear instantly). Run once, and again whenever commands or the organization&apos;s
                  modes change:
                  <CopyBox text={`curl -X POST "${base}/api/admin/discord/register?org=${caller.orgId}" -H "Authorization: Bearer <your key>"`} className="mt-2" />
                </li>
                <li>Each person then links their own account in <b>Your Discord account</b> above.</li>
              </ol>
            </Disclosure>
          )}
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
      </Section>
    </div>
  );
}
