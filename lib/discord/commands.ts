import 'server-only';
import { ZodError } from 'zod';
import { InputError, NotFoundError } from '../data/errors';
import { completeTask, createTask, getTask, listTasks, logProgress, updateTask } from '../data/tasks';
import { listProjectsBasic, projectNameMap } from '../data/projects';
import { addDays, resolveDate, todayStr } from '../dates';
import { fmtDate } from '../format';
import { parseRepeat } from '../quick-parse';
import { PRIORITIES, type Mode, type Priority, type Task } from '../types';
import { API_BASE, BlockedChannelError, DiscordError, NotVisibleError, assertNotBlocked, findChannel, guildContext, type ChannelInfo, type DiscordLink, type RawMessage } from './client';
import { finishDiscordLink } from '../profile';
import { taskFromMessage } from './to-task';
import type { Scope } from '../scope';
import type { Actor } from '../actors';

// Slash commands, the "Add to Work OS" message command and their component/modal follow-ups.
// The route verifies the signature, finds the organization that owns the server and the Work OS person who linked the
// Discord account that sent it (lib/profile.ts discordUser: everything here acts as them, actor kind 'discord'), then
// calls handleInteraction(): it returns the
// immediate response (deferred, modal, or autocomplete choices) plus optional deferred work whose
// result is written into the original response with editOriginal().

// ── Interaction shapes (subset) ─────────────────────────────────────────────

export type InteractionOption = { name: string; type: number; value?: string | number | boolean; focused?: boolean; options?: InteractionOption[] };
type ModalRow = { type: number; custom_id?: string; value?: string; components?: ModalRow[]; component?: ModalRow };

export type Interaction = {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string; name?: string };
  member?: { user?: { id: string } };
  user?: { id: string };
  message?: { id: string; content: string };
  data?: {
    name?: string;
    type?: number;
    target_id?: string;
    options?: InteractionOption[];
    resolved?: { messages?: Record<string, RawMessage> };
    custom_id?: string;
    component_type?: number;
    values?: string[];
    components?: ModalRow[];
  };
};

export const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3, AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;
export const EPHEMERAL = 64;

export type ReplyBody = { content: string; components?: unknown[] };
export type InteractionPlan = { response: unknown; work?: () => Promise<ReplyBody> };

// ── Command definitions (registered per guild) ──────────────────────────────

const REPEAT_CHOICES = [
  { label: 'Every day', value: 'day' },
  { label: 'Every weekday', value: 'weekday' },
  { label: 'Every week', value: 'week' },
  { label: 'Every 2 weeks', value: '2w' },
  { label: 'Every month', value: 'month' },
];
const STRING = 3;
const INTEGER = 4;
const GUILD_ONLY = { contexts: [0], integration_types: [0] };

const refOption = { type: STRING, name: 'ref', description: 'Task (#12 or search by title)', required: true, autocomplete: true };

/** /link <code>: the one command that works before an account is linked (Settings › Connections makes the code). */
const LINK_COMMAND = {
  type: 1,
  name: 'link',
  description: 'Link your Discord account to Work OS (get a code in Settings › Connections)',
  ...GUILD_ONLY,
  options: [{ type: STRING, name: 'code', description: 'The code from Settings', required: true, min_length: 6, max_length: 12 }],
};

/** The commands for one organization's server; the mode choices are its modes (Discord allows 25). */
export const commandsFor = (modes: readonly string[]) => [
  LINK_COMMAND,
  {
    type: 1,
    name: 'task',
    description: 'Add a task to Work OS',
    ...GUILD_ONLY,
    options: [
      { type: STRING, name: 'title', description: 'What needs doing', required: true, max_length: 300 },
      { type: STRING, name: 'priority', description: 'Priority (default P2)', choices: PRIORITIES.map(p => ({ name: p, value: p })) },
      { type: STRING, name: 'due', description: 'today, tomorrow, fri, +3d or YYYY-MM-DD', max_length: 40 },
      { type: STRING, name: 'repeat', description: 'Repeat after completion', choices: REPEAT_CHOICES.map(r => ({ name: r.label, value: r.value })) },
      { type: STRING, name: 'project', description: 'Project', autocomplete: true, max_length: 120 },
      { type: STRING, name: 'mode', description: 'Work mode', ...(modes.length ? { choices: modes.slice(0, 25).map(m => ({ name: m.slice(0, 100), value: m.slice(0, 100) })) } : { max_length: 40 }) },
    ],
  },
  { type: 1, name: 'today', description: 'Overdue, due today, in progress and open P1s', ...GUILD_ONLY },
  {
    type: 1,
    name: 'done',
    description: 'Mark a task done',
    ...GUILD_ONLY,
    options: [refOption, { type: STRING, name: 'note', description: 'Completion note', max_length: 1000 }],
  },
  {
    type: 1,
    name: 'progress',
    description: 'Log progress on a task',
    ...GUILD_ONLY,
    options: [
      refOption,
      { type: INTEGER, name: 'percent', description: '0–100', required: true, min_value: 0, max_value: 100 },
      { type: STRING, name: 'note', description: 'Progress note', max_length: 1000 },
    ],
  },
  { type: 3, name: 'Add to Work OS', ...GUILD_ONLY },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const ephemeral = (content: string) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

function opt(i: Interaction, name: string): string | number | boolean | undefined {
  return i.data?.options?.find(o => o.name === name)?.value;
}
function optStr(i: Interaction, name: string): string | undefined {
  const v = opt(i, name);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Link text can't contain brackets; the url in <> suppresses the embed preview. */
function link(text: string, url: string): string {
  return `[${text.replace(/\[/g, '(').replace(/\]/g, ')')}](<${url}>)`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function errorText(err: unknown): string {
  if (err instanceof ZodError) return 'Invalid input: ' + err.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
  if (err instanceof InputError || err instanceof NotFoundError || err instanceof DiscordError || err instanceof BlockedChannelError || err instanceof NotVisibleError) return err.message;
  console.error('[discord] interaction failed:', err instanceof Error ? `${err.name}: ${err.message}` : err);
  return 'Something went wrong. Check the server logs.';
}

/** s: the Work OS person the command acts for; link: their Discord in the organization (what they can see there). */
type Ctx = { baseUrl: string; s: Scope; link: DiscordLink };
const by = (c: Ctx): Actor => ({ kind: 'discord', userId: c.s.userId });
const taskUrl = (c: Ctx, ref: number) => `${c.baseUrl}/tasks/${ref}`;

async function projectName(c: Ctx, t: Task): Promise<string | null> {
  if (!t.projectId) return null;
  return (await projectNameMap(c.s)).get(t.projectId) ?? null;
}

// ── "Add to Work OS" message rendering + components ─────────────────────────

const ADDED_RE = /^Added \[#\d+\]\(<?[^)]*>?\): (.*) \([^()]*, P[1-4]\)(?: · .*)?$/;

async function renderAdded(c: Ctx, t: Task): Promise<ReplyBody> {
  const project = (await projectName(c, t)) ?? 'no project';
  const due = t.due ? ` · due ${fmtDate(t.due)}` : '';
  const content = clip(`Added ${link(`#${t.ref}`, taskUrl(c, t.ref))}: ${t.title} (${project}, ${t.priority})${due}`, 2000);
  const ref = t.ref;
  return {
    content,
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `wo:pri:${ref}`,
            placeholder: 'Priority',
            options: PRIORITIES.map(p => ({ label: p, value: p, default: p === t.priority })),
          },
        ],
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Due today', custom_id: `wo:due:${ref}:today` },
          { type: 2, style: 2, label: 'Due tomorrow', custom_id: `wo:due:${ref}:tomorrow` },
          { type: 2, style: 2, label: 'No due date', custom_id: `wo:due:${ref}:none` },
          { type: 2, style: 1, label: 'Edit title', custom_id: `wo:edit:${ref}` },
        ],
      },
    ],
  };
}

/** The title shown in an "Added …" message (the modal must open instantly, so no DB read). */
export function titleFromContent(content: string | undefined): string {
  const m = (content ?? '').split('\n')[0].match(ADDED_RE);
  return m ? m[1] : '';
}

function findModalValue(rows: ModalRow[] | undefined, id: string): string | undefined {
  for (const r of rows ?? []) {
    if (r.custom_id === id && typeof r.value === 'string') return r.value;
    const inner = findModalValue([...(r.components ?? []), ...(r.component ? [r.component] : [])], id);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

// ── Command handlers ────────────────────────────────────────────────────────

async function addFromMessage(i: Interaction, c: Ctx): Promise<ReplyBody> {
  const target = i.data?.target_id ? i.data.resolved?.messages?.[i.data.target_id] : undefined;
  if (!target) return { content: 'Could not read that message.' };
  const ctx = await guildContext(c.link);
  await assertNotBlocked(ctx, target.channel_id);
  const channel: ChannelInfo | undefined = findChannel(ctx, target.channel_id);
  const { task, existing } = await taskFromMessage(
    c.s,
    target,
    { guildId: i.guild_id!, channel, channelName: channel ? undefined : i.channel?.name },
    by(c),
  );
  if (existing) return { content: clip(`Already tracked as ${link(`#${task.ref}`, taskUrl(c, task.ref))}: ${task.title}`, 2000) };
  return renderAdded(c, task);
}

async function addTask(i: Interaction, c: Ctx): Promise<ReplyBody> {
  const title = optStr(i, 'title') ?? '';
  const dueRaw = optStr(i, 'due');
  const due = dueRaw ? resolveDate(dueRaw) : null;
  if (due === undefined) return { content: `Couldn't read the due date "${clip(dueRaw!, 40)}". Try today, tomorrow, fri, +3d or 2026-10-20.` };
  const mode = optStr(i, 'mode') as Mode | undefined;
  const t = await createTask(
    c.s,
    {
      title,
      priority: (optStr(i, 'priority') as Priority | undefined) ?? 'P2',
      due,
      project: optStr(i, 'project') ?? null,
      mode: mode ?? null,
      recurrence: parseRepeat(optStr(i, 'repeat') ?? '') ?? null,
    },
    by(c),
    { note: 'via Discord' },
  );
  const project = await projectName(c, t);
  const extra = [t.priority, t.due ? `due ${fmtDate(t.due)}` : '', project ?? ''].filter(Boolean).join(' · ');
  return { content: clip(`Added ${link(`#${t.ref}`, taskUrl(c, t.ref))}: ${t.title} (${extra})`, 2000) };
}

async function today(c: Ctx): Promise<ReplyBody> {
  const [overdue, dueToday, inProgress, p1, names] = await Promise.all([
    listTasks(c.s, { due: 'overdue', sort: 'due' }),
    listTasks(c.s, { due: 'today', open: true }),
    listTasks(c.s, { status: ['In Progress'] }),
    listTasks(c.s, { open: true, priority: ['P1'], sort: 'due' }),
    projectNameMap(c.s),
  ]);
  const seen = new Set<string>();
  const sections: [string, Task[]][] = [
    ['Overdue', overdue],
    ['Due today', dueToday],
    ['In progress', inProgress],
    ['Open P1s', p1],
  ];
  const line = (t: Task) =>
    [`\`#${t.ref}\` ${link(clip(t.title, 90), taskUrl(c, t.ref))}`, t.due ? `due ${fmtDate(t.due)}` : '', t.projectId ? (names.get(t.projectId) ?? '') : '']
      .filter(Boolean)
      .join(' · ');

  const entries: { header?: string; text: string }[] = [];
  for (const [name, tasks] of sections) {
    const fresh = tasks.filter(t => !seen.has(t.id));
    fresh.forEach(t => seen.add(t.id));
    fresh.forEach((t, idx) => entries.push({ header: idx === 0 ? `**${name}** (${fresh.length})` : undefined, text: line(t) }));
  }
  if (!entries.length) return { content: `Nothing overdue, due today, in progress or P1 for ${fmtDate(todayStr(), 'EEE MMM d')}.` };

  const LIMIT = 2000 - 24; // room for the "…and N more" footer
  let out = '';
  let shown = 0;
  for (const e of entries) {
    const chunk = (e.header ? (out ? '\n\n' : '') + e.header + '\n' : '\n') + e.text;
    if ((out + chunk).length > LIMIT) break;
    out += chunk;
    shown++;
  }
  const more = entries.length - shown;
  return { content: (out.replace(/^\n+/, '') + (more ? `\n…and ${more} more` : '')).slice(0, 2000) };
}

async function done(i: Interaction, c: Ctx): Promise<ReplyBody> {
  const t = await completeTask(c.s, optStr(i, 'ref') ?? '', optStr(i, 'note'), by(c));
  const next = t.nextRef ? ` · next is ${link(`#${t.nextRef}`, taskUrl(c, t.nextRef))}` : '';
  return { content: clip(`Done ${link(`#${t.ref}`, taskUrl(c, t.ref))}: ${t.title}${next}`, 2000) };
}

async function progress(i: Interaction, c: Ctx): Promise<ReplyBody> {
  const pct = Number(opt(i, 'percent'));
  const t = await logProgress(c.s, optStr(i, 'ref') ?? '', pct, optStr(i, 'note'), by(c));
  return { content: `${link(`#${t.ref}`, taskUrl(c, t.ref))} → ${t.progress}%` };
}

// ── Autocomplete ────────────────────────────────────────────────────────────

type Choice = { name: string; value: string };

async function autocompleteChoices(i: Interaction, c: Ctx): Promise<Choice[]> {
  const focused = i.data?.options?.find(o => o.focused);
  if (!focused) return [];
  const typed = String(focused.value ?? '').trim().toLowerCase();

  if (focused.name === 'project') {
    const projects = (await listProjectsBasic(c.s)).filter(p => p.status === 'active' || p.status === 'paused');
    return projects
      .filter(p => !typed || p.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map(p => ({ name: clip(p.name, 100), value: p.name.slice(0, 100) }));
  }

  if (focused.name === 'ref') {
    const [tasks, names] = await Promise.all([listTasks(c.s, { open: true, sort: 'updated' }), projectNameMap(c.s)]);
    const q = typed.replace(/^#/, '');
    const hits = q ? tasks.filter(t => String(t.ref).startsWith(q) || t.title.toLowerCase().includes(q)) : tasks;
    return hits.slice(0, 25).map(t => {
      const p = t.projectId ? names.get(t.projectId) : null;
      return { name: clip(`#${t.ref} ${t.title}${p ? ` (${p})` : ''}`, 100), value: String(t.ref) };
    });
  }
  return [];
}

async function autocomplete(i: Interaction, c: Ctx): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Choice[]>(r => (timer = setTimeout(() => r([]), 2500)));
  const choices = await Promise.race([autocompleteChoices(i, c).catch(() => [] as Choice[]), timeout]).finally(() => clearTimeout(timer));
  return { type: 8, data: { choices } };
}

// ── Components + modal ──────────────────────────────────────────────────────

async function component(i: Interaction, c: Ctx, id: string): Promise<ReplyBody> {
  const [, kind, ref, arg] = id.split(':');
  let t: Task;
  if (kind === 'pri') {
    const p = i.data?.values?.[0] as Priority | undefined;
    if (!p || !PRIORITIES.includes(p)) return { content: 'Unknown priority.' };
    t = await updateTask(c.s, ref, { priority: p }, by(c), { note: 'via Discord' });
  } else if (kind === 'due') {
    const today = todayStr();
    const due = arg === 'today' ? today : arg === 'tomorrow' ? addDays(today, 1) : null;
    t = await updateTask(c.s, ref, { due }, by(c), { note: 'via Discord' });
  } else if (kind === 'editmodal') {
    const title = findModalValue(i.data?.components, 'title')?.trim();
    if (!title) {
      const cur = await getTask(c.s, ref);
      if (!cur) throw new NotFoundError(`Task #${ref} not found`);
      t = cur;
    } else {
      t = await updateTask(c.s, ref, { title }, by(c), { note: 'via Discord' });
    }
  } else {
    return { content: 'Unknown action.' };
  }
  return renderAdded(c, t);
}

function editModal(i: Interaction, ref: string): unknown {
  const current = titleFromContent(i.message?.content).slice(0, 300);
  return {
    type: 9,
    data: {
      custom_id: `wo:editmodal:${ref}`,
      title: `Edit #${ref}`.slice(0, 45),
      components: [
        {
          type: 1,
          components: [
            { type: 4, custom_id: 'title', style: 1, label: 'Title', min_length: 1, max_length: 300, required: true, ...(current ? { value: current } : {}) },
          ],
        },
      ],
    },
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const DEFER_EPHEMERAL = { type: 5, data: { flags: EPHEMERAL } };
const DEFER_UPDATE = { type: 6 };

/** The server and linked-person checks happen in the route; this only routes and plans the response. */
export function handleInteraction(i: Interaction, c: Ctx): InteractionPlan | Promise<InteractionPlan> {
  switch (i.type) {
    case InteractionType.AUTOCOMPLETE:
      return autocomplete(i, c).then(response => ({ response }));

    case InteractionType.COMMAND: {
      const name = i.data?.name;
      const run =
        name === 'Add to Work OS'
          ? () => addFromMessage(i, c)
          : name === 'task'
            ? () => addTask(i, c)
            : name === 'today'
              ? () => today(c)
              : name === 'done'
                ? () => done(i, c)
                : name === 'progress'
                  ? () => progress(i, c)
                  : null;
      if (!run) return { response: ephemeral('Unknown command.') };
      return { response: DEFER_EPHEMERAL, work: run };
    }

    case InteractionType.COMPONENT:
    case InteractionType.MODAL_SUBMIT: {
      const id = i.data?.custom_id ?? '';
      const m = id.match(/^wo:(pri|due|edit|editmodal):(\d+)(?::(today|tomorrow|none))?$/);
      if (!m) return { response: ephemeral('Unknown action.') };
      if (m[1] === 'edit') return { response: editModal(i, m[2]) };
      return { response: DEFER_UPDATE, work: () => component(i, c, id) };
    }
  }
  return { response: ephemeral('Unsupported interaction.') };
}

export function notAvailable(i: Interaction, why = 'Not available.'): unknown {
  return i.type === InteractionType.AUTOCOMPLETE ? { type: 8, data: { choices: [] } } : ephemeral(why);
}

export const NOT_LINKED = 'Your Discord account is not linked to Work OS here. In Work OS, open Settings › Connections, make a link code and run /link with it.';

/** /link <code> on a server: links the sender's Discord account to whoever made the code (lib/profile.ts). */
export async function linkAccount(i: Interaction): Promise<unknown> {
  const discordId = i.member?.user?.id;
  const code = optStr(i, 'code') ?? '';
  if (!i.guild_id || !discordId) return ephemeral("Run /link on the organization's Discord server.");
  const s = await finishDiscordLink(i.guild_id, discordId, code).catch(e => {
    console.error('[discord] link failed:', e instanceof Error ? e.name : e);
    return null;
  });
  return ephemeral(s ? 'Linked. Work OS commands here now act as you, and your alerts can come here as DMs.' : 'That code is unknown or expired. Make a new one in Work OS: Settings › Connections.');
}

/** Replace the deferred response. The interaction token authorises this; no bot token needed. */
export async function editOriginal(appId: string, token: string, body: ReplyBody): Promise<void> {
  const res = await fetch(`${API_BASE}/webhooks/${appId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: clip(body.content, 2000), components: body.components ?? [], allowed_mentions: { parse: [] } }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const msg = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? res.statusText;
    console.error(`[discord] edit original failed: ${res.status} ${msg}`);
  }
}
