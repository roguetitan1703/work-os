import { readData } from '@/lib/storage';
import { differenceInDays, parseISO, format } from 'date-fns';

export default function HiddenPage() {
  const data = readData();
  const today = new Date();

  const staleTasks = data.tasks
    .filter(t => {
      if (t.status === 'Done' || t.status === 'Dropped') return false;
      const days = differenceInDays(today, parseISO(t.lastTouched));
      return days > 7;
    })
    .sort((a, b) => {
      const da = differenceInDays(today, parseISO(a.lastTouched));
      const db = differenceInDays(today, parseISO(b.lastTouched));
      return db - da;
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Hidden Work</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Tasks not touched in more than 7 days</p>
      </div>

      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300">
        Review every Sunday. Either re-prioritize, schedule, or drop.
      </div>

      {staleTasks.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center">
          Nothing hidden — all active tasks touched within the last 7 days.
        </div>
      ) : (
        <div className="border rounded overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs text-muted-foreground uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Mode</th>
                <th className="px-3 py-2 text-left">Task</th>
                <th className="px-3 py-2 text-left">Project</th>
                <th className="px-3 py-2 text-left">Priority</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Last Touched</th>
                <th className="px-3 py-2 text-left">Days Stale</th>
              </tr>
            </thead>
            <tbody>
              {staleTasks.map(task => {
                const days = differenceInDays(today, parseISO(task.lastTouched));
                return (
                  <tr key={task.id} className="border-t">
                    <td className="px-3 py-2 text-muted-foreground text-xs">{task.mode}</td>
                    <td className="px-3 py-2 font-medium text-foreground">{task.task}</td>
                    <td className="px-3 py-2 text-muted-foreground">{task.projectClient || '—'}</td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                        {task.priority}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{task.status}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {format(parseISO(task.lastTouched), 'MMM d, yyyy')}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-semibold ${
                        days > 30
                          ? 'text-red-600 dark:text-red-400'
                          : days > 14
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-muted-foreground'
                      }`}>
                        {days}d
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
