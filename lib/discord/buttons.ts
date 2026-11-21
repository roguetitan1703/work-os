import 'server-only';
import { roleOf } from '../caller';
import { completeTask, trashTask, updateTask } from '../data/tasks';
import { memberNames } from '../people';
import { discordUser } from '../profile';
import { orgWithSetting, orgWide, scoped, type Scope } from '../scope';
import type { Actor } from '../actors';
import type { TaskDoc } from '../db';
import { errorText, EPHEMERAL, type Interaction } from './interaction';
import { editReply, mdLink, plainName, recordedComponents } from './recorded';

// The buttons under the bot's "Recorded #N" reply (plan v4 section 4): Undo, Done and the select For ▾. A press is an interaction
// from Discord (signature checked by the route); the pressing person is the Work OS person their Discord account is linked to,
// or only a Discord id (the poster may Undo without being linked). The task is found by its number among the tasks the bot
// recorded, and every change runs in the task owner's scope with the actor { kind: 'discord', userId? }.
//   Undo: the poster, the person who reacted, the people on it, and the organization's owners; it goes to the trash.
//   Done: the people on it and the owners.
//   For:  any linked member who can read the task; sets who the task is for (a task with no project is private to one person and cannot be given away).

export const RECORDED_PRESS = /^wo:(undo|done|for):(\d{1,9})$/;

const ephemeral = (content: string) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
/** Answers a press by replacing the message the button is on (type 7). */
const update = (content: string, components: unknown[]) => ({ type: 7, data: { content, components, allowed_mentions: { parse: [] }, flags: 1 << 2 } });

const taskUrl = (baseUrl: string, ref: number) => `${baseUrl}/tasks/${ref}`;
export const doneText = (ref: number, baseUrl: string): string => (baseUrl ? `Done ${mdLink(`#${ref}`, taskUrl(baseUrl, ref))}` : `Done #${ref}`);

/** A task the bot recorded, by its number (a trashed one is not found). */
async function recordedTask(orgId: string, ref: number): Promise<TaskDoc | null> {
  return (await (await orgWide(orgId)).tasks.findOne({ ref, 'source.kind': 'discord', 'source.tracked': { $in: ['issue', 'emoji'] } })) ?? null;
}

const peopleOn = (t: TaskDoc): string[] => t.assigneeIds ?? [];

export async function handleRecordedPress(i: Interaction, baseUrl: string): Promise<unknown> {
  const m = RECORDED_PRESS.exec(i.data?.custom_id ?? '');
  const guildId = i.guild_id;
  const discordId = i.member?.user?.id;
  if (!m || !guildId || !discordId) return ephemeral('Not available.');
  const orgId = await orgWithSetting('discord', { guildId });
  if (!orgId) return ephemeral('Not available.');
  const ref = Number(m[2]);
  const me = await discordUser(guildId, discordId);
  // Someone not linked cannot choose who it is for, whatever the task is.
  if (m[1] === 'for' && !me) return ephemeral('Connect Discord in Work OS first (Settings › Notifications).');
  const t = await recordedTask(orgId, ref);
  const notThere = () => ephemeral(`#${ref} not found. It may have been removed.`);
  if (!t || t.source?.kind !== 'discord') return notThere();
  const src = t.source;
  // Owners, the reactor and For need the task to be one this person can read through their own door (a private project's task is not theirs to change).
  const sees = !!me && !!(await (await scoped(me)).tasks.findOne({ _id: t._id }, { projection: { _id: 1 } }));
  const owner = sees && me ? (await roleOf(me.userId, orgId)) === 'owner' : false;
  const onIt = !!me && peopleOn(t).includes(me.userId);
  const reactor = sees && !!me && src.reactorId === me.userId;
  const poster = src.authorId === discordId;
  // A task this person may not read (and did not post) answers exactly as one that is not there: no way to find out which numbers exist.
  if (!sees && !poster) return notThere();
  const actor: Actor = { kind: 'discord', ...(me ? { userId: me.userId } : {}) };
  const taskOwner: Scope = { userId: t.ownerId, orgId };
  const refuse = () => ephemeral(`Only the people on #${ref} can do that.`);
  try {
    if (m[1] === 'undo') {
      if (!(poster || reactor || onIt || owner)) return refuse();
      await trashTask(taskOwner, ref, actor, { reason: 'Undone in Discord' });
      return update(`Removed #${ref}`, []);
    }
    if (m[1] === 'done') {
      if (!(onIt || owner)) return refuse();
      await completeTask(taskOwner, ref, undefined, actor);
      return update(doneText(ref, baseUrl), []);
    }
    // For ▾
    if (!me || !sees) return refuse();
    const pick = i.data?.values?.[0];
    if (!pick || !/^[\w-]{1,100}$/.test(pick)) return ephemeral('Unknown choice.');
    const names = await memberNames(orgId);
    if (!names[pick]) return ephemeral('That person is not in this organization.');
    // A task that is private to one person (no project, or a private project) cannot be given to someone else; naming that person again changes nothing.
    if (t.visibility === 'private' && pick !== t.ownerId) return ephemeral(`#${ref} is private to one person, so it cannot be given to someone else. Put it in a shared project in Work OS first.`);
    if (!(peopleOn(t).length === 1 && peopleOn(t)[0] === pick)) await updateTask(taskOwner, ref, { assignees: [pick] }, actor);
    const project = t.projectId ? await (await orgWide(orgId)).projects.findOne({ _id: t.projectId }, { projection: { name: 1 } }) : null;
    const where = project ? plainName(project.name) : '';
    const content = `Recorded ${mdLink(`#${ref}`, taskUrl(baseUrl, ref))} · ${plainName(names[pick])}${where ? ` · ${where}` : ''}`;
    return update(content, await recordedComponents(orgId, ref));
  } catch (e) {
    return ephemeral(errorText(e));
  }
}

/** A task the bot recorded was completed anywhere (the app, an agent, the button): the bot's reply says Done. Best effort, never throws. */
export async function settleDone(t: Pick<TaskDoc, 'ref' | 'source'>): Promise<void> {
  try {
    const src = t.source;
    if (!src || src.kind !== 'discord' || !src.replyId || !src.replyChannelId) return;
    await editReply(src.replyChannelId, src.replyId, doneText(t.ref, (process.env.APP_URL ?? '').replace(/\/+$/, '')), []);
  } catch (e) {
    console.error('[discord] done reply failed:', e instanceof Error ? e.message : e);
  }
}
