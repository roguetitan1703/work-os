import type { Activity, FieldChange } from './types';

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

export function describeActivity(a: Pick<Activity, 'type' | 'changes' | 'note'>): string {
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
