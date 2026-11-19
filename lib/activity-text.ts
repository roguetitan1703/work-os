import type { Activity, ActivityWhat, FieldChange, SubjectKind } from './types';

// Human-readable lines for activity entries. Shared by the UI timeline and the MCP tools.

function fmt(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const LABELS: Record<string, string> = {
  estimateMins: 'estimate',
  blockedReason: 'blocked reason',
  dependsOn: 'dependencies',
  parent: 'subtask of',
};

function change(field: string, c: FieldChange): string {
  const label = LABELS[field] ?? field;
  if (field === 'progress') return `progress ${fmt(c.from)}% → ${fmt(c.to)}%`;
  if (field === 'description') return 'description edited';
  if (field === 'checklist') return 'checklist edited';
  if (field === 'blockedReason' && !c.to) return 'blocked reason cleared';
  if (field === 'blockedReason') return `blocked: ${fmt(c.to)}`;
  return `${label} ${fmt(c.from)} → ${fmt(c.to)}`;
}

/** The What filter's names (Review › Activity, recent_activity `what`). */
export const WHAT_LABEL: Record<ActivityWhat, string> = { tasks: 'Tasks', state: 'State', notes: 'Notes', messages: 'Messages', needs: 'Needs', projects: 'Projects' };
const KIND_WHAT: Record<SubjectKind, ActivityWhat> = { task: 'tasks', state: 'state', note: 'notes', message: 'messages', need: 'needs', project: 'projects' };

/** What a row is about: tasks for task rows (older ones carry no subject). */
export const whatOf = (a: Pick<Activity, 'subject'>): ActivityWhat => KIND_WHAT[a.subject?.kind ?? 'task'] ?? 'tasks';

/** Where a row links to in the app: the task, the note, or the project's tab that shows it. */
export function activityHref(a: Pick<Activity, 'subject' | 'taskRef' | 'projectId'>): string | null {
  const p = (tab?: string) => (a.projectId ? `/projects/${encodeURIComponent(a.projectId)}${tab ? `?tab=${tab}` : ''}` : null);
  switch (a.subject?.kind) {
    case 'note':
      return `/notes/${encodeURIComponent(a.subject.id)}`;
    case 'message':
      return p('inbox');
    case 'need':
      return p('needs');
    case 'state':
    case 'project':
      return p();
    default:
      return a.taskRef ? `/tasks/${a.taskRef}` : null;
  }
}

/**
 * A row about something other than a task (State, a note, a message, a Need, a project), in words; null for a task row.
 * Only the subject's own text is shown: a message's body and a Need's answer text are never in a row.
 */
export function describeChange(a: Pick<Activity, 'type' | 'changes' | 'note' | 'subject'>): string | null {
  const t = a.subject?.title ?? '';
  const n = a.note ?? '';
  const need = `Need${a.subject?.ref ? ` #${a.subject.ref}` : ''}`;
  const c = a.changes ?? {};
  switch (a.type) {
    // (Rows converted from the State's log may have no text left: the line was done or dropped before the feed had it.)
    case 'state_now':
      return n ? `Now: ${n}` : 'Now changed';
    case 'next_added':
      return n ? `Next + ${n}` : 'Next line added';
    case 'next_done':
      return n ? `Next done: ${n}` : 'Next line done';
    case 'later_added':
      return n ? `Later + ${n}` : 'Later line added';
    case 'decision':
      return n ? `Decision: ${n}` : 'Decision recorded';
    case 'note_created':
      return `Created note "${t}"`;
    case 'note_edited':
      return `Edited note "${t}"`;
    case 'orders_changed':
      return `Orders "${t}" ${n || 'changed'}`;
    case 'session_ended':
      return `Session ended: ${n || 'none'}`;
    case 'message_sent':
      return `Sent a message${t ? ` (${t})` : ''}`;
    case 'need_asked':
      return `${need} asked: "${t}"`;
    case 'need_answered':
      return `${need} answered: ${n || 'answered'}`;
    case 'need_withdrawn':
      return `${need} withdrawn`;
    case 'project_created':
      return `Created project "${t}"`;
    case 'project_renamed':
      return `Renamed project "${fmt(c.name?.from)}" → "${fmt(c.name?.to)}"`;
    case 'visibility_changed':
      return `Who sees it: ${fmt(c.visibility?.from)} → ${fmt(c.visibility?.to)}`;
    default:
      return null;
  }
}

export function describeActivity(a: Pick<Activity, 'type' | 'changes' | 'note'> & Partial<Pick<Activity, 'subject'>>): string {
  const other = describeChange(a);
  if (other !== null) return other;
  const parts: string[] = [];
  const changes = a.changes ?? {};
  switch (a.type) {
    case 'created':
      parts.push('created');
      break;
    case 'completed':
      parts.push('completed');
      break;
    case 'reopened':
      parts.push(`reopened (${fmt(changes.status?.from)} → ${fmt(changes.status?.to)})`);
      break;
    case 'archived':
      parts.push('archived');
      break;
    case 'unarchived':
      parts.push('restored from archive');
      break;
    case 'trashed':
      parts.push('moved to trash');
      break;
    case 'restored':
      parts.push('restored from trash');
      break;
    case 'comment':
      break;
    case 'checklist':
      parts.push('checklist');
      break;
    case 'status':
      if (changes.status) parts.push(`status ${fmt(changes.status.from)} → ${fmt(changes.status.to)}`);
      break;
  }
  for (const [k, c] of Object.entries(changes)) {
    if (k === 'status' && a.type !== 'progress' && a.type !== 'edit') continue;
    if (k === 'progress' && a.type === 'completed') continue;
    parts.push(change(k, c));
  }
  const head = parts.join('; ');
  if (a.note) return head ? `${head}: ${a.note}` : a.note;
  return head || a.type;
}
