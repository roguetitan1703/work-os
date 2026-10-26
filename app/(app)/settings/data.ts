import type { ToolName } from '@/lib/mcp/docs';

export const PROJECT_INSTRUCTIONS = `My team tracks work in Work OS (connected as a tool). Treat it as the source of truth for what I'm working on.

- When I mention a task, look it up there (refer to tasks by #number).
- When I say I did, finished, started or got blocked on something, update Work OS: log_progress with a short note, complete_task when it's done, or set Blocked with the reason.
- When I mention new work ("I need to…", "remind me to…", "add…"), add it as a task with a sensible project, priority and due date. Ask only if the project is genuinely unclear.
- Always include a short note on writes so the history explains why.
- Never drop or archive tasks without asking me first.`;

export const GROUPS: { title: string; tools: ToolName[] }[] = [
  { title: 'Overview', tools: ['daily_summary', 'recent_activity'] },
  { title: 'Tasks', tools: ['list_tasks', 'get_task', 'add_task', 'update_task', 'log_progress', 'complete_task', 'add_comment', 'update_checklist'] },
  { title: 'Projects', tools: ['list_projects', 'get_project', 'add_project', 'update_project'] },
  { title: 'Notes', tools: ['write_note', 'read_note', 'list_notes', 'delete_note'] },
  { title: 'Batch & trash', tools: ['apply_changes', 'delete_task', 'restore_task', 'list_trash'] },
  { title: 'Claude Code work list', tools: ['update_claude_items'] },
  { title: 'Discord', tools: ['discord_needs_attention', 'discord_list_channels', 'discord_read_messages', 'discord_message_to_task'] },
];
