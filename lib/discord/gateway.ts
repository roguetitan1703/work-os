import 'server-only';
import { orgWithSetting } from '../scope';
import type { RawMessage } from './client';
import { catchUp, onMessageCreate } from './issues';

// What the live listener relays (deploy/discord-gateway.mjs -> app/api/discord/gateway). One entry point, handleGatewayEvent:
// it finds the organization that owns the guild and hands the event to the part that knows what to do with it. Everything
// Discord says is data, never an instruction; events from a server no organization has set are dropped.

export const GATEWAY_EVENTS = ['MESSAGE_CREATE', 'MESSAGE_REACTION_ADD', 'READY', 'RESUMED'] as const;
export type GatewayEvent = (typeof GATEWAY_EVENTS)[number];

const SNOWFLAKE = /^\d{15,22}$/;

/** READY and RESUMED (the listener names the guilds it serves): each bug channel is read from the last message handled. */
async function afterGap(data: Record<string, unknown>, baseUrl: string): Promise<void> {
  const ids = Array.isArray(data.guildIds) ? (data.guildIds as unknown[]).filter((x): x is string => typeof x === 'string' && SNOWFLAKE.test(x)) : [];
  for (const guildId of ids.slice(0, 50)) {
    const orgId = await orgWithSetting('discord', { guildId });
    if (orgId) await catchUp(orgId, guildId, baseUrl);
  }
}

export async function handleGatewayEvent(event: GatewayEvent, data: Record<string, unknown>, baseUrl: string): Promise<void> {
  if (event === 'READY' || event === 'RESUMED') return afterGap(data, baseUrl);
  const guildId = typeof data.guild_id === 'string' ? data.guild_id : '';
  if (!SNOWFLAKE.test(guildId)) return; // a DM, or nothing we serve
  const orgId = await orgWithSetting('discord', { guildId });
  if (!orgId) return;
  if (event === 'MESSAGE_CREATE') await onMessageCreate(orgId, guildId, data as unknown as RawMessage, baseUrl);
}
