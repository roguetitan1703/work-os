import 'server-only';
import { collections } from '../db';
import { scoped } from '../scope';
import { answerNeed } from '../data/needs';
import { neutralAlertText, plainAlertText } from '../data/dispatcher';
import { isMember } from '../people';
import { getProfile, timezoneOf } from '../profile';
import { runWithRequestContext } from '../request-context';
import { orgGuildId } from './client';
import type { Interaction } from './commands';

// Answering a Need from the Discord DM it came in (flow DC1). Buttons carry the custom id `wo:need:<need id>:<option id>`
// (the same `wo:` family as the task buttons, so tests/e2e/entry-points.mjs audits it). A DM press has no server and no
// member, only `user`: the route resolves the organization and the person from the Need itself, and the press counts only
// when the addressee's linked Discord account is the one that pressed, in an organization that has a Discord server. The
// Need is then read again through the addressee's own door (a person who lost access to the project, or left, reads as
// "not addressed to you"). The answer is taken once, atomically (answerNeed), with via 'discord'. App-only Needs and review
// Needs get no buttons (Discord may steer, never release: accepting a review marks the task Done), and a press on one
// (a crafted one) is refused with a link.

export const NEED_BUTTON = /^wo:need:([A-Za-z0-9_-]{6,64}):([A-Za-z0-9_-]{1,32})$/;

/** The action row for a DM: one button per option, the first as the recommendation. Button labels are plain text. */
export function needButtons(needId: string, options: { id: string; label: string }[]): unknown[] {
  return [{ type: 1, components: options.slice(0, 5).map((o, n) => ({ type: 2, style: n === 0 ? 1 : 2, label: neutralAlertText(o.label).slice(0, 80), custom_id: `wo:need:${needId}:${o.id}` })) }];
}

const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
const update = (content: string) => ({ type: 7, data: { content, components: [], allowed_mentions: { parse: [] } } });

/** A press on a Need button in a DM: the answer to give the route. Never throws. */
export async function handleNeedPress(i: Interaction, baseUrl: string): Promise<unknown> {
  // Only a bot DM: a user, no server, no member.
  const pressed = i.guild_id || i.member ? undefined : i.user?.id;
  const m = NEED_BUTTON.exec(i.data?.custom_id ?? '');
  if (!pressed || !m) return ephemeral('Unknown action.');
  try {
    const [, id, option] = m;
    // The Need says whose it is and in which organization (the one lookup outside any person's door).
    const doc = await (await collections()).needs.findOne({ _id: id }, { projection: { orgId: 1, to: 1 } }); // scope-ok: a DM press names no organization; it is resolved from the Need and then checked against the addressee's linked account
    const who = doc ? { userId: doc.to, orgId: doc.orgId } : null;
    const notYours = ephemeral('That Need is not addressed to you.');
    // Not found, not theirs, not a member, no Discord server for the organization and no longer readable all read the same.
    if (!who || !(await isMember(who.orgId, who.userId)) || (await getProfile(who)).discordId !== pressed || !(await orgGuildId(who.orgId))) return notYours;
    const need = await (await scoped(who)).needs.findOne({ _id: id, to: who.userId });
    if (!need) return notYours;
    if (need.status !== 'open') return ephemeral(need.status === 'answered' ? 'This Need is already answered.' : `This Need was ${need.status}.`);
    if (need.kind === 'review') return ephemeral(`A review is answered in the app, where you can look at the work first: ${baseUrl}/today#need-${need.ref}`);
    if (need.appOnly) return ephemeral(`This one is answered in the app only: ${baseUrl}/today#need-${need.ref}`);
    const opt = need.options.find(o => o.id === option);
    if (!opt) return ephemeral("That is not one of this Need's options.");
    const tz = await timezoneOf(who);
    await runWithRequestContext({ userId: who.userId, tz }, () => answerNeed(who, id, { option }, 'discord'));
    return update(`Answered: ${plainAlertText(opt.label)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/already answered/.test(msg)) return ephemeral('This Need is already answered.');
    const closed = /was (withdrawn|replaced)/.exec(msg);
    if (closed) return ephemeral(`This Need was ${closed[1]}.`);
    if (/already (withdrawn|replaced|closed)/.test(msg)) return ephemeral('This Need is no longer open.');
    return ephemeral('Something went wrong. Open Work OS to answer it.');
  }
}
