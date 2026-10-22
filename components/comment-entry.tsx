'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { deleteCommentAction, editCommentAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { BottomSheet } from '@/components/mobile/sheet';

/** A comment in the history timeline, with hover Edit / Delete (the signed-in person can do this on any comment). */
export function CommentEntry({ id, note }: { id: string; note: string }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sheet, setSheet] = useState<'menu' | 'delete' | null>(null);
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
    });
  }

  function remove() {
    start(async () => {
      const res = await deleteCommentAction(id);
      if (!res.ok) return void toast.error(res.error);
      toast.success('Comment deleted');
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
          className="text-[16px] md:text-sm"
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
            className="max-md:h-11 max-md:px-4 max-md:text-sm"
            disabled={pending}
            onClick={() => {
              setText(note);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button size="xs" className="max-md:h-11 max-md:px-4 max-md:text-sm" disabled={pending || !text.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <p className={cn('text-sm text-foreground mt-0.5 whitespace-pre-wrap break-words pr-8 md:pr-0', pending && 'opacity-50')}>{note}</p>
      <button type="button" aria-label="Comment actions" onClick={() => setSheet('menu')} className="md:hidden absolute -right-2 -top-2.5 w-11 h-11 flex items-center justify-center rounded-full text-muted-foreground active:bg-muted">
        <MoreHorizontal className="w-5 h-5" />
      </button>
      {sheet && (
        <BottomSheet title={sheet === 'menu' ? 'Comment' : 'Delete this comment?'} onClose={() => setSheet(null)}>
          {sheet === 'menu' ? (
            <div className="space-y-1 pt-1">
              <p className="text-sm text-muted-foreground line-clamp-3 pb-2 break-words">{note}</p>
              <button type="button" onClick={() => (setSheet(null), setEditing(true))} className="w-full h-12 px-3 rounded-xl flex items-center gap-3 text-[16px] active:bg-muted">
                <Pencil className="w-5 h-5" /> Edit
              </button>
              <button type="button" onClick={() => setSheet('delete')} className="w-full h-12 px-3 rounded-xl flex items-center gap-3 text-[16px] text-red-600 dark:text-red-400 active:bg-muted">
                <Trash2 className="w-5 h-5" /> Delete
              </button>
            </div>
          ) : (
            <div className="space-y-3 pt-1">
              <p className="text-sm text-muted-foreground">This removes the comment from the history.</p>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setSheet(null)} className="h-12 rounded-2xl border border-border text-[16px] font-medium active:bg-muted">
                  Cancel
                </button>
                <button type="button" disabled={pending} onClick={() => (setSheet(null), remove())} className="h-12 rounded-2xl bg-red-600 text-white text-[16px] font-semibold disabled:opacity-50">
                  Delete
                </button>
              </div>
            </div>
          )}
        </BottomSheet>
      )}
      <div
        className={cn(
          'absolute right-0 top-0 hidden md:flex items-center gap-0.5 rounded-md bg-background/90 text-[11px] transition-opacity',
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
