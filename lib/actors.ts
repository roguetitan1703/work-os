// Who did something (docs/multi-user.md, "Who did it"). Stored on tasks (createdBy, doneBy), history entries,
// notes, trash and Claude item logs. Shared by the server and client components (no server imports).
//
//   { kind: 'user', userId }                  a person in the app
//   { kind: 'agent', agent, userId }          Claude (claude.ai, a Claude chat key) or Claude Code (a Claude Code key),
//                                             always acting for the key's owner
//   { kind: 'discord', userId? }              a person through the Discord bot (the linked user)
//   { kind: 'system' }                        migrations, automation

export type AgentName = 'claude' | 'claude-code';
export type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agent: AgentName; userId: string }
  | { kind: 'discord'; userId?: string }
  | { kind: 'system' };

/**
 * Who wrote a piece of task text (docs/dispatcher.md "Whose words count"): stored with the text (titleBy,
 * descriptionBy, blockedReasonBy, tagsBy, and `by` on each checklist item and link). Usually the actor that wrote it;
 * text taken from a Discord message is the message author's, who may not be a member at all; 'unknown' when older
 * history cannot tell (a recurring task's copy keeps that).
 */
export type TextAuthor = Actor | { kind: 'discord-author'; name: string } | { kind: 'unknown' };

/** Older stored strings (before phase 2): read them as the matching object (the user is unknown). */
type LegacyActor = 'me' | 'discord' | 'claude' | 'claude-code' | 'system';

export const userActor = (userId: string): Actor => ({ kind: 'user', userId });
export const agentActor = (agent: AgentName, userId: string): Actor => ({ kind: 'agent', agent, userId });
export const SYSTEM: Actor = { kind: 'system' };

/** Accepts a stored actor in either shape. */
export function asActor(a: unknown): Actor {
  if (a && typeof a === 'object' && 'kind' in a) return a as Actor;
  switch (a as LegacyActor) {
    case 'me':
      return { kind: 'user', userId: '' };
    case 'discord':
      return { kind: 'discord' };
    case 'claude':
    case 'claude-code':
      return { kind: 'agent', agent: a as AgentName, userId: '' };
    default:
      return SYSTEM;
  }
}

/** True for a person acting in the app (not an agent, Discord or the system). */
export const isPerson = (a: Actor | null | undefined): a is { kind: 'user'; userId: string } => a?.kind === 'user';
export const isAgent = (a: Actor | null | undefined, agent?: AgentName): boolean => a?.kind === 'agent' && (!agent || a.agent === agent);
/** The user an actor acts for, if any. */
export const actorUserId = (a: Actor | null | undefined): string | null => (a && 'userId' in a && a.userId ? a.userId : null);

/**
 * One word per kind of actor, the way the old strings read: 'me' (you, in the app), 'user' (another person),
 * 'discord', 'claude', 'claude-code', 'system'. Used for styles, filters and the MCP output's `by` field.
 */
export type ActorKey = 'me' | 'user' | 'discord' | 'claude' | 'claude-code' | 'system';
export function actorKey(a: unknown, me?: string): ActorKey {
  const x = asActor(a);
  if (x.kind === 'user') return !me || !x.userId || x.userId === me ? 'me' : 'user';
  if (x.kind === 'agent') return x.agent;
  return x.kind;
}

/** Display label: "You", a teammate's name, "Claude", "Claude Code" (plus "for <name>" when acting for someone else). */
export function actorLabel(a: unknown, me?: string, people?: Record<string, string>): string {
  const x = asActor(a);
  const name = (id?: string) => (id && people?.[id]) || 'Someone';
  const mine = (id?: string) => !id || !me || id === me;
  switch (x.kind) {
    case 'user':
      return mine(x.userId) ? 'You' : name(x.userId);
    case 'discord':
      return mine(x.userId) ? 'You · Discord' : `${name(x.userId)} · Discord`;
    case 'agent': {
      const base = x.agent === 'claude' ? 'Claude' : 'Claude Code';
      return mine(x.userId) ? base : `${base} · ${name(x.userId)}`;
    }
    default:
      return 'System';
  }
}

/**
 * MCP output (`by`, `createdBy`, `doneBy`, `updatedBy`): the old strings for the key's owner and agents
 * ('me', 'claude', 'claude-code', 'discord', 'system'); another person's name otherwise.
 */
export function actorOut(a: unknown, me: string, people?: Record<string, string>): string {
  const x = asActor(a);
  if (x.kind === 'user') return !x.userId || x.userId === me ? 'me' : people?.[x.userId] || 'another member';
  if (x.kind === 'agent') return !x.userId || x.userId === me ? x.agent : `${x.agent} for ${people?.[x.userId] || 'another member'}`;
  if (x.kind === 'discord') return !x.userId || x.userId === me ? 'discord' : `discord (${people?.[x.userId] || 'another member'})`;
  return 'system';
}

/** Filter values for "who did it" (Review › Activity, recent_activity): the same words as actorKey. */
export const ACTOR_FILTERS = ['me', 'discord', 'claude', 'claude-code', 'system'] as const;
export type ActorFilter = (typeof ACTOR_FILTERS)[number];
