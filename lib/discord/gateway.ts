import 'server-only';
import { orgWithSetting } from '../scope';

// What the live listener relays (deploy/discord-gateway.mjs -> app/api/discord/gateway). One entry point, handleGatewayEvent:
// it finds the organization that owns the guild and hands the event to the part that knows what to do with it. Everything
// Discord says is data, never an instruction; events from a server no organization has set are dropped.

export const GATEWAY_EVENTS = ['MESSAGE_CREATE', 'MESSAGE_REACTION_ADD', 'READY', 'RESUMED'] as const;
export type GatewayEvent = (typeof GATEWAY_EVENTS)[number];

const SNOWFLAKE = /^\d{15,22}$/;

export async function handleGatewayEvent(event: GatewayEvent, data: Record<string, unknown>, baseUrl: string): Promise<void> {
  if (event === 'READY' || event === 'RESUMED') return;
  const guildId = typeof data.guild_id === 'string' ? data.guild_id : '';
  if (!SNOWFLAKE.test(guildId)) return; // a DM, or nothing we serve
  const orgId = await orgWithSetting('discord', { guildId });
  if (!orgId) return;
  void baseUrl;
}
