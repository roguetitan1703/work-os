import { Task } from './types';
import { MODE_NAMES } from './modes';

export type ParsedTaskInput = Omit<Task, 'id' | 'addedOn' | 'lastTouched'>;

export function parseMarkdownTable(input: string): { tasks: ParsedTaskInput[]; errors: string[] } {
  const errors: string[] = [];
  const tasks: ParsedTaskInput[] = [];

  const lines = input.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) {
    errors.push('Need at least header, separator, and one row.');
    return { tasks, errors };
  }

  const headerIdx = lines.findIndex(l => /\|\s*mode\s*\|/i.test(l) && /\|\s*task\s*\|/i.test(l));
  if (headerIdx === -1) {
    errors.push('Could not find header row with Mode and Task columns.');
    return { tasks, errors };
  }

  const headerCols = lines[headerIdx]
    .split('|')
    .map(c => c.trim().toLowerCase())
    .filter(Boolean);

  const colIndex = (name: string) => headerCols.findIndex(c => c.includes(name.toLowerCase()));
  const modeCol = colIndex('mode');
  const taskCol = colIndex('task');
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

    const matchedMode = MODE_NAMES.find(m => m.toLowerCase() === rawMode.toLowerCase());
    if (!matchedMode) {
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
    const estimateMins = isNaN(rawEstimate) ? 30 : rawEstimate;

    const rawDue = get(dueCol);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : undefined;

    tasks.push({
      task: rawTask,
      mode: matchedMode as any,
      projectClient: get(projectCol),
      priority: priority as any,
      estimateMins,
      due,
      status: matchedStatus as any,
      notes: get(notesCol),
    });
  }

  return { tasks, errors };
}
