'use client';

import dynamic from 'next/dynamic';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Check, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { NoteBlock } from '@/lib/notes-schema';
import { deleteNoteAction, restoreNoteAction, saveNoteAction } from '../actions';
import type { SaveState } from './block-editor';

// The block editor touches the DOM on load, so it only renders in the browser.
const BlockEditor = dynamic(() => import('./block-editor').then(m => m.BlockEditor), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-lg bg-muted/40" />,
});

type NoteProps = { id: string; title: string; updatedAt: string; isTaskNote: boolean; ownArchived: boolean; parentId: string | null };

export function NoteEditor({ note, blocks, focusTitle }: { note: NoteProps; blocks: NoteBlock[]; focusTitle: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState(note.title === 'Untitled' && focusTitle ? '' : note.title);
  const [state, setState] = useState<SaveState>('saved');
  const [, start] = useTransition();

  const remove = () =>
    start(async () => {
      if (!confirm('Delete this page (and its sub-pages)? It can be restored for 30 days.')) return;
      const r = await deleteNoteAction(note.id);
      if ('error' in r) return void toast.error(r.error);
      toast('Page deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            const u = await restoreNoteAction(note.id);
            if ('error' in u) toast.error(u.error);
            else router.push(`/notes/${note.id}`);
          },
        },
      });
      router.push(note.parentId ? `/notes/${note.parentId}` : '/notes');
    });

  const toggleArchive = () =>
    start(async () => {
      const r = await saveNoteAction(note.id, { archived: !note.ownArchived });
      if ('error' in r) toast.error(r.error);
      else router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap md:flex-nowrap items-start gap-x-3 gap-y-1">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          autoFocus={focusTitle}
          placeholder="Untitled"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (document.querySelector('.wo-editor [contenteditable=true]') as HTMLElement | null)?.focus();
            }
          }}
          className="basis-full md:basis-0 flex-1 min-w-0 bg-transparent text-[28px] md:text-4xl font-bold tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
        />
        <div className="flex items-center gap-1 md:pt-3 shrink-0 w-full md:w-auto justify-end">
          <SaveBadge state={state} />
          {!note.isTaskNote && !note.parentId && (
            <button onClick={toggleArchive} title={note.ownArchived ? 'Unarchive' : 'Archive'} className="h-11 w-11 md:h-8 md:w-8 inline-flex items-center justify-center rounded-xl md:rounded-md text-muted-foreground hover:bg-muted active:bg-muted">
              {note.ownArchived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
            </button>
          )}
          <button onClick={remove} title="Delete" className="h-11 w-11 md:h-8 md:w-8 inline-flex items-center justify-center rounded-xl md:rounded-md text-muted-foreground hover:bg-muted hover:text-red-600 active:bg-muted">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <BlockEditor noteId={note.id} initialBlocks={blocks} updatedAt={note.updatedAt} title={title} onState={setState} />
    </div>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  return (
    <span className={cn('mr-auto md:mr-1 inline-flex items-center gap-1 text-sm md:text-xs', state === 'error' ? 'text-red-600' : 'text-muted-foreground')}>
      {state === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
      {state === 'saved' && <Check className="w-3 h-3" />}
      {state === 'saving' ? 'Saving' : state === 'dirty' ? 'Editing' : state === 'error' ? 'Not saved' : 'Saved'}
    </span>
  );
}
