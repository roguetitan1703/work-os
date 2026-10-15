import type { ToolName } from '@/lib/mcp/docs';

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'chat', label: 'Claude chat' },
  { id: 'discord', label: 'Discord' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'reference', label: 'Reference' },
] as const;
export type TabId = (typeof TABS)[number]['id'];
export const tabFrom = (v: string | undefined): TabId => (TABS.find(t => t.id === v)?.id ?? 'overview');


export const PROJECT_INSTRUCTIONS = `I track all my work in Work OS (connected as a tool). Treat it as the source of truth for what I'm working on.

- When I mention a task, look it up there (refer to tasks by #number).
- When I say I did, finished, started or got blocked on something, update Work OS: log_progress with a short note, complete_task when it's done, or set Blocked with the reason.
- When I mention new work ("I need to…", "remind me to…", "add…"), add it as a task with a sensible project, priority and due date. Ask only if the project is genuinely unclear.
- Always include a short note on writes so the history explains why.
- Never drop or archive tasks without asking me first.`;

export const BRIEF_PROMPT = `Morning brief, Work OS section:
Call the Work OS daily_summary tool once. From it, write:
1. Overdue — each task with how many days late, oldest first.
2. Today — due today plus anything In Progress.
3. Blocked / waiting — with the reason or what it's waiting on.
4. Since yesterday — what got completed and what changed (say when Claude made the change).
5. One line on projects with overdue work.
Keep it short; link each task with its url. If nothing is overdue or due, say so in one line.

Discord section:
Call discord_needs_attention once (default window is since the start of the last workday). List "Flagged for later" first (my bot-tagged notes, with the message I was replying to), then what needs me grouped by channel, unhandled first, each with its jump link. Mention threads I'm in that moved. If it reports warnings (content intent off, channels it can't read, capped), add one line about it.`;

export const GROUPS: { title: string; tools: ToolName[] }[] = [
  { title: 'Overview', tools: ['daily_summary', 'recent_activity'] },
  { title: 'Tasks', tools: ['list_tasks', 'get_task', 'add_task', 'update_task', 'log_progress', 'complete_task', 'add_comment', 'update_checklist'] },
  { title: 'Projects', tools: ['list_projects', 'get_project', 'add_project', 'update_project'] },
  { title: 'Notes', tools: ['write_note', 'read_note', 'list_notes', 'delete_note'] },
  { title: 'Batch & trash', tools: ['apply_changes', 'delete_task', 'restore_task', 'list_trash'] },
  { title: 'Claude Code work list', tools: ['update_claude_items'] },
  { title: 'Discord', tools: ['discord_needs_attention', 'discord_list_channels', 'discord_read_messages', 'discord_message_to_task'] },
];
