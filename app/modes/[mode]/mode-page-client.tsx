'use client';

import { useState } from 'react';
import { Task, Mode } from '@/lib/types';
import { ModeConfig } from '@/lib/modes';
import { TaskTable } from '@/components/task-table';
import { TaskForm } from '@/components/task-form';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

type FilterTab = 'Active' | 'All' | 'Done';

type Props = {
  modeName: string;
  modeConfig: ModeConfig;
  initialTasks: Task[];
};

export function ModePageClient({ modeName, modeConfig, initialTasks }: Props) {
  const [filter, setFilter] = useState<FilterTab>('Active');
  const [addOpen, setAddOpen] = useState(false);

  const filtered = initialTasks.filter(t => {
    if (filter === 'Active') return t.status !== 'Done' && t.status !== 'Dropped';
    if (filter === 'Done') return t.status === 'Done';
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Mode header — uses hex+18 so it works on both light and dark */}
      <div
        className="rounded-xl p-5 border"
        style={{
          backgroundColor: modeConfig.hex + '18',
          borderColor: modeConfig.hex + '40',
        }}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: modeConfig.hex }} />
              <h1 className="text-xl font-bold" style={{ color: modeConfig.hex }}>
                {modeName}
              </h1>
            </div>
            <p className="text-sm text-foreground/70 max-w-2xl">{modeConfig.description}</p>
          </div>
          <div className="text-right shrink-0 ml-4">
            <div className="text-xs text-muted-foreground">RGB</div>
            <div className="font-mono text-sm" style={{ color: modeConfig.hex }}>
              RGB({modeConfig.rgb})
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {(['Active', 'All', 'Done'] as FilterTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                filter === tab
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="w-3.5 h-3.5" />
          Add task
        </Button>
      </div>

      <TaskTable tasks={filtered} />

      {addOpen && (
        <TaskForm
          open={addOpen}
          onClose={() => setAddOpen(false)}
          defaultMode={modeName as Mode}
        />
      )}
    </div>
  );
}
