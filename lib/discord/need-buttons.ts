import 'server-only';
import { collections } from '../db';
import { answerNeed } from '../data/needs';
import { plainAlertText } from '../data/dispatcher';
import { isMember } from '../people';
import { getProfile, timezoneOf } from '../profile';
import { runWithRequestContext } from '../request-context';
import type { Interaction } from './commands';

// Answering a Need from the Discord DM it came in (flow DC1). Buttons carry the custom id `wo:need:<need id>:<option id>`
// (the same `wo:` family as the task buttons, so tests/e2e/entry-points.mjs audits it). A DM press has no server and no
// member, only `user`: the route resolves the organization and the person from the Need itself, and the press counts only
// when the addressee's linked Discord account is the one that pressed. The answer is taken once, atomically (answerNeed),
// with via 'discord'. App-only Needs get no buttons, and a press on one (a crafted one) is refused with a link.

export const NEED_BUTTON = /^wo:need:([A-Za-z0-9_-]{6,64}):([A-Za-z0-9_-]{1,32})$/;

/** The action row for a DM: one button per option, the first as the recommendation. */
export function needButtons(needId: string, options: { id: string; label: string }[]): unknown[] {
  return [{ type: 1, components: options.slice(0, 5).map((o, n) => ({ type: 2, style: n === 0 ? 1 : 2, label: plainAlertText(o.label).slice(0, 80), custom_id: `wo:need:${needId}:${o.id}` })) }];
}

const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
const update = (content: string) => ({ type: 7, data: { content, components: [], allowed_mentions: { parse: [] } } });

/** A press on a Need button in a DM: the answer to give the route. Never throws. */
export async function handleNeedPress(i: Interaction, baseUrl: string): Promise<unknown> {
  const pressed = i.user?.id ?? i.member?.user?.id;
  const m = NEED_BUTTON.exec(i.data?.custom_id ?? '');
  if (!pressed || !m) return ephemeral('Unknown action.');
  try {
    const [, id, option] = m;
    // The Need says whose it is and in which organization (the one lookup outside any person's door).
    const doc = await (await collections()).needs.findOne({ _id: id }, { projection: { orgId: 1, to: 1, status: 1, appOnly: 1, ref: 1, options: 1 } }); // scope-ok: a DM press names no organization; it is resolved from the Need and then checked against the addressee's linked account
    const who = doc ? { userId: doc.to, orgId: doc.orgId } : null;
    // Not found, not theirs and not a member read the same: nothing about the Need is said.
    if (!doc || !who || !(await isMember(who.orgId, who.userId)) || (await getProfile(who)).discordId !== pressed) return ephemeral('That Need is not addressed to you.');
    if (doc.status !== 'open') return ephemeral(doc.status === 'answered' ? 'This Need is already answered.' : `This Need was ${doc.status}.`);
    if (doc.appOnly) return ephemeral(`This one is answered in the app only: ${baseUrl}/today#need-${doc.ref}`);
    const opt = doc.options.find(o => o.id === option);
    if (!opt) return ephemeral("That is not one of this Need's options.");
    const tz = await timezoneOf(who);
    await runWithRequestContext({ userId: who.userId, tz }, () => answerNeed(who, id, { option }, 'discord'));
    return update(`Answered: ${opt.label}`);
  } catch (e) {
    return ephemeral(e instanceof Error && /already|was (answered|withdrawn|replaced)/.test(e.message) ? 'This Need is already answered.' : 'Something went wrong. Open Work OS to answer it.');
  }
}
