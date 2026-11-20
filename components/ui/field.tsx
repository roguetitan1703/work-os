'use client';

import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Label above a control, with an optional hint or error under it. The control comes from a function so it gets the id. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: (id: string) => React.ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cn('space-y-1.5 min-w-0', className)}>
      <label htmlFor={id} className="block text-meta font-medium text-foreground">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-meta text-destructive">{error}</p> : hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Text input with its add button on the right. Enter adds; the text clears after the add. */
export function InlineAdd({ placeholder, onAdd, addLabel = 'Add', pending, className }: { placeholder: string; onAdd: (text: string) => void | Promise<void>; addLabel?: string; pending?: boolean; className?: string }) {
  const [text, setText] = useState('');
  const submit = async () => {
    const t = text.trim();
    if (!t || pending) return;
    await onAdd(t);
    setText('');
  };
  return (
    <form
      className={cn('flex items-center gap-2 min-w-0', className)}
      onSubmit={e => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input value={text} onChange={e => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="h-11 md:h-9 rounded-control" />
      <Button type="submit" variant="secondary" size="touch" disabled={!text.trim() || pending} aria-label={addLabel}>
        <Plus aria-hidden />
        <span className="hidden md:inline">{addLabel}</span>
      </Button>
    </form>
  );
}
