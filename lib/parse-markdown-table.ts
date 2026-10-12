import type { Mode, Priority, Status } from './types';
import { MODE_NAMES } from './modes';

export type ParsedTaskInput = {
  title: string;
  mode: Mode | null;
  project: string | null;
  priority: Priority;
  estimateMins: number | null;
  due?: string;
  status: Status;
  description: string;
};

export function parseMarkdownTable(input: string): { tasks: ParsedTaskInput[]; errors: string[] } {
  const errors: string[] = [];
  const tasks: ParsedTaskInput[] = [];

  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) {
    errors.push('Need at least header, separator, and one row.');
    return { tasks, errors };
  }

  const headerIdx = lines.findIndex(l => /\|\s*(task|title)\s*\|/i.test(l));
  if (headerIdx === -1) {
    errors.push('Could not find a header row with a Task column.');
    return { tasks, errors };
  }

  const headerCols = lines[headerIdx]
    .split('|')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean);

  const colIndex = (name: string) => headerCols.findIndex(c => c.includes(name.toLowerCase()));
  const modeCol = colIndex('mode');
  const taskCol = headerCols.findIndex(c => c === 'task' || c === 'title');
  const projectCol = colIndex('project');
  const priorityCol = colIndex('priority');
  const estimateCol = colIndex('estimate');
  const dueCol = colIndex('due');
  const statusCol = colIndex('status');
  const notesCol = colIndex('notes');

  const dataStart = headerIdx + 2;

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;

    const cells = line.split('|').map(c => c.trim()).slice(1, -1);
    if (cells.length === 0 || !cells.some(Boolean)) continue;

    const get = (idx: number) => idx >= 0 && idx < cells.length ? cells[idx] : '';

    const rawMode = get(modeCol);
    const rawTask = get(taskCol);

    if (!rawTask) {
      errors.push(`Row ${i - dataStart + 1}: missing task name`);
      continue;
    }

    const matchedMode = MODE_NAMES.find(m => m.toLowerCase() === rawMode.toLowerCase()) ?? null;
    if (rawMode && !matchedMode) {
      errors.push(`Row ${i - dataStart + 1}: invalid mode "${rawMode}". Must be one of: ${MODE_NAMES.join(', ')}`);
      continue;
    }

    const rawPriority = get(priorityCol).toUpperCase();
    const priority = ['P1', 'P2', 'P3', 'P4'].includes(rawPriority) ? rawPriority : 'P2';

    const rawStatus = get(statusCol);
    const matchedStatus = ['Not Started', 'In Progress', 'Blocked', 'Done', 'Dropped'].find(
      s => s.toLowerCase() === rawStatus.toLowerCase()
    ) ?? 'Not Started';

    const rawEstimate = parseInt(get(estimateCol).replace(/\D/g, ''), 10);
    const estimateMins = isNaN(rawEstimate) ? null : rawEstimate;

    const rawDue = get(dueCol);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : undefined;

    tasks.push({
      title: rawTask,
      mode: matchedMode as Mode | null,
      project: get(projectCol) || null,
      priority: priority as Priority,
      estimateMins,
      due,
      status: matchedStatus as Status,
      description: get(notesCol),
    });
  }

  return { tasks, errors };
}
