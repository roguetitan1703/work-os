import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { getProfile, linkDiscordAccount } from '../profile';
import { setUserSetting, takeUserSetting, type Scope } from '../scope';
import { API_BASE, api, discordConfig, DiscordError, orgGuildId } from './client';

// Connect Discord (plan v4 section 5): a person links their Discord account by signing in at Discord (OAuth2, scope `identify`),
// never by typing a code. Discord's own sign-in proves which account it is; the bot then checks the account is on the
// organization's server. The state that goes out is random, stored hashed on the person's profile for 10 minutes and used up
// once (the callback takes it atomically, and only the same signed-in person can finish it).
//   GET /api/discord/connect            starts: redirects to Discord
//   GET /api/discord/connect/callback   Discord sends the person back here with ?code&state
// Needs DISCORD_APPLICATION_ID (the client id), DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, and the callback URL added under
// OAuth2 > Redirects in the Developer Portal.

const STATE_TTL_MS = 10 * 60_000;
const hashState = (state: string) => createHash('sha256').update(`discord-connect:${state}`).digest('hex');

export type ConnectOutcome = 'linked' | 'failed' | 'notready' | 'notserver' | 'notmember';

/** Is the deployment ready for people to connect (the client secret is set besides the bot)? */
export function connectReady(): boolean {
  const c = discordConfig();
  return !!(c && c.appId && process.env.DISCORD_CLIENT_SECRET?.trim());
}

export const callbackUrl = (baseUrl: string) => `${baseUrl}/api/discord/connect/callback`;

/** Discord's authorize page lives next to its API (the e2e tests point DISCORD_API_BASE at a fake). */
const authorizeBase = () => API_BASE.replace(/\/api(?:\/v\d+)?$/, '') + '/oauth2/authorize';

/** Starts a connect: where to send the person (Discord's authorize page), or why not. */
export async function startConnect(s: Scope, baseUrl: string): Promise<{ url: string } | { outcome: ConnectOutcome }> {
  const cfg = discordConfig();
  if (!cfg || !connectReady()) return { outcome: 'notready' };
  if (!(await orgGuildId(s.orgId))) return { outcome: 'notserver' };
  const state = randomBytes(24).toString('base64url');
  await setUserSetting(s, 'profile', { discordConnect: { hash: hashState(state), expiresAt: new Date(Date.now() + STATE_TTL_MS) } });
  const q = new URLSearchParams({ client_id: cfg.appId, response_type: 'code', scope: 'identify', redirect_uri: callbackUrl(baseUrl), state });
  return { url: `${authorizeBase()}?${q}` };
}

type TokenReply = { access_token?: string };
type DiscordMe = { id?: string; bot?: boolean };

/** Finishes a connect for the signed-in person: the code Discord gave, the state we sent. */
export async function finishConnect(s: Scope, code: string, state: string, baseUrl: string): Promise<ConnectOutcome> {
  const cfg = discordConfig();
  const secret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!cfg || !cfg.appId || !secret) return 'notready';
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(code) || !/^[A-Za-z0-9_-]{16,64}$/.test(state)) return 'failed';
  // Used up in the same step it is found, and only by the person it was made for.
  const owner = await takeUserSetting(s.orgId, 'profile', { 'discordConnect.hash': hashState(state), 'discordConnect.expiresAt': { $gt: new Date() } }, { discordConnect: null });
  if (!owner || owner !== s.userId) return 'failed';
  const guildId = await orgGuildId(s.orgId);
  if (!guildId) return 'notserver';
  try {
    const tokenRes = await fetch(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DiscordBot (https://github.com/roguetitan1703/work-os, 1.0)' },
      body: new URLSearchParams({ client_id: cfg.appId, client_secret: secret, grant_type: 'authorization_code', code, redirect_uri: callbackUrl(baseUrl) }),
      cache: 'no-store',
    });
    if (!tokenRes.ok) return 'failed';
    const token = ((await tokenRes.json().catch(() => null)) as TokenReply | null)?.access_token;
    if (!token) return 'failed';
    const meRes = await fetch(`${API_BASE}/users/@me`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'DiscordBot (https://github.com/roguetitan1703/work-os, 1.0)' }, cache: 'no-store' });
    const me = meRes.ok ? ((await meRes.json().catch(() => null)) as DiscordMe | null) : null;
    if (!me?.id || me.bot || !/^\d{15,22}$/.test(me.id)) return 'failed';
    // The account must be on this organization's server (the bot looks; a 404 means not a member).
    try {
      await api(`/guilds/${guildId}/members/${me.id}`);
    } catch (e) {
      if (e instanceof DiscordError && e.status === 404) return 'notmember';
      throw e;
    }
    await linkDiscordAccount(s, me.id);
    return 'linked';
  } catch (e) {
    console.error('[discord] connect failed:', e instanceof DiscordError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : e);
    return 'failed';
  }
}

/** Should Today show the Connect Discord card: the organization has a server, people can sign in, and this person has not connected or dismissed it. */
export async function showConnectCard(s: Scope): Promise<boolean> {
  if (!connectReady() || !(await orgGuildId(s.orgId))) return false;
  const p = await getProfile(s);
  return !p.discordId && !p.discordCardHidden;
}
