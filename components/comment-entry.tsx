'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Pencil, Trash2 } from 'lucide-react';
import { deleteCommentAction, editCommentAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** A comment in the history timeline, with hover Edit / Delete (Om can do this on any comment). */
export function CommentEntry({ id, note }: { id: string; note: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(note);
  const [pending, start] = useTransition();

  function save() {
    const v = text.trim();
    if (!v) return void toast.error('Comment is empty; delete it instead.');
    if (v === note) return setEditing(false);
    start(async () => {
      const res = await editCommentAction(id, v);
      if (!res.ok) return void toast.error(res.error);
      setEditing(false);
      toast.success('Comment updated');
      router.refresh();
    });
  }

  function remove() {
    start(async () => {
      const res = await deleteCommentAction(id);
      if (!res.ok) return void toast.error(res.error);
      toast.success('Comment deleted');
      router.refresh();
    });
  }

  if (editing) {
    return (
      <div className="mt-1 space-y-1.5">
        <Textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={Math.min(10, Math.max(2, text.split('\n').length))}
          autoFocus
          className="text-sm"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
            if (e.key === 'Escape') {
              setText(note);
              setEditing(false);
            }
          }}
        />
        <div className="flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setText(note);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button size="xs" disabled={pending || !text.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className={cn('text-sm text-foreground mt-0.5 whitespace-pre-wrap break-words', pending && 'opacity-50')}>{note}</p>
      <div
        className={cn(
          'absolute right-0 top-0 flex items-center gap-0.5 rounded-md bg-background/90 text-[11px] transition-opacity',
          confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        {confirming ? (
          <>
            <span className="text-muted-foreground px-1">Delete?</span>
            <button className="px-1 rounded text-red-600 dark:text-red-400 hover:bg-muted font-medium" disabled={pending} onClick={remove}>
              Yes
            </button>
            <button className="px-1 rounded text-muted-foreground hover:bg-muted" disabled={pending} onClick={() => setConfirming(false)}>
              No
            </button>
          </>
        ) : (
          <>
            <button title="Edit comment" aria-label="Edit comment" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted" onClick={() => setEditing(true)}>
              <Pencil className="w-3 h-3" />
            </button>
            <button
              title="Delete comment"
              aria-label="Delete comment"
              className="p-1 rounded text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-muted"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </>
        )}
      </div>
    </>
  );
}
