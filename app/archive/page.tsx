import { readData } from '@/lib/storage';
import { format, parseISO, startOfWeek } from 'date-fns';

function weekLabel(dateStr: string): string {
  try {
    const d = parseISO(dateStr);
    const week = startOfWeek(d, { weekStartsOn: 1 });
    return `Week of ${format(week, 'MMM d, yyyy')}`;
  } catch {
    return 'Unknown week';
  }
}

export default function ArchivePage() {
  const data = readData();

  const done = data.tasks
    .filter(t => t.status === 'Done')
    .sort((a, b) => {
      const da = a.doneDate ?? a.lastTouched;
      const db = b.doneDate ?? b.lastTouched;
      return db.localeCompare(da);
    });

  const grouped: Record<string, typeof done> = {};
  for (const task of done) {
    const key = weekLabel(task.doneDate ?? task.lastTouched);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(task);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Archive</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{done.length} completed tasks</p>
      </div>

      {done.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">No completed tasks yet.</div>
      ) : (
        Object.entries(grouped).map(([week, tasks]) => (
          <section key={week}>
            <h2 className="text-sm font-semibold text-muted-foreground mb-2">{week}</h2>
            <div className="border rounded overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted text-xs text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Task</th>
                    <th className="px-3 py-2 text-left">Mode</th>
                    <th className="px-3 py-2 text-left">Project</th>
                    <th className="px-3 py-2 text-left">Priority</th>
                    <th className="px-3 py-2 text-left">Done</th>
                    <th className="px-3 py-2 text-left">Estimate</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map(task => (
                    <tr key={task.id} className="border-t">
                      <td className="px-3 py-2 font-medium text-foreground">{task.task}</td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">{task.mode}</td>
                      <td className="px-3 py-2 text-muted-foreground">{task.projectClient || '—'}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                          {task.priority}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">
                        {task.doneDate ? format(parseISO(task.doneDate), 'MMM d') : '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{task.estimateMins}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
