import 'server-only';
import { sendDm } from './alerts';
import { discordConfig } from './discord/client';
import { addToInbox, getNotifySettings, pushConfigured, sendPush } from './notify';
import { ownerScopes } from './people';
import { getProfile } from './profile';

/**
 * Alert the owner(s) of the organization (the people who run the server): inbox always; push and Discord DM when that
 * person has them on and set up. Quiet hours are ignored on purpose: this is for time-critical server events (a reel that
 * did or did not go out). A failing channel doesn't block the others. Returns counts and channel names only.
 */
export async function alertOwners(msg: { title: string; body: string; url?: string }): Promise<{ sent: { inbox: number; push: number; discord: number }; errors: string[]; ok: boolean }> {
  const link = msg.url ?? '/notifications';
  const owners = await ownerScopes();
  const sent = { inbox: 0, push: 0, discord: 0 };
  const errors: string[] = [];
  if (!owners.length) errors.push('no owner');
  for (const s of owners) {
    try {
      await addToInbox(s, [{ kind: 'security', title: msg.title, body: msg.body, url: link }]);
      sent.inbox++;
    } catch {
      errors.push('inbox');
    }
    const settings = await getNotifySettings(s).catch(() => null);
    if (settings?.channels.push && pushConfigured()) {
      const r = await sendPush(s, { title: msg.title, body: msg.body, url: link, tag: 'owner-alert' }).catch(() => ({ sent: 0, failed: 1 }));
      if (r.sent > 0) sent.push++;
      else if (r.failed > 0) errors.push('push');
    }
    const profile = await getProfile(s).catch(() => null);
    if (settings?.channels.discord && discordConfig() && profile?.discordId) {
      const abs = link.startsWith('/') ? (process.env.APP_URL ?? '').replace(/\/+$/, '') + link : link;
      try {
        await sendDm(profile.discordId, `**${msg.title}**${msg.body ? `\n${msg.body}` : ''}\n${abs}`);
        sent.discord++;
      } catch {
        errors.push('discord');
      }
    }
  }
  return { sent, errors, ok: sent.inbox + sent.push + sent.discord > 0 };
}
