'use client';

import '@blocknote/mantine/style.css';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { upload } from '@vercel/blob/client';
import { BlockNoteView } from '@blocknote/mantine';
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote, type DefaultReactSuggestionItem } from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { FileText, FolderOpen, ListTodo } from 'lucide-react';
import { toast } from 'sonner';
import { noteSchema, type NoteBlock } from '@/lib/notes-schema';
import { createSubPageAction, saveNoteAction, searchMentionsAction } from '../actions';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const AUTOSAVE_MS = 1000;

/** Upload to the private Blob store; the editor gets an app URL that streams it to logged-in users. */
async function uploadFile(file: File): Promise<string> {
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const blob = await upload(`notes/${safe}`, file, { access: 'private', handleUploadUrl: '/api/notes/upload' });
  return `/api/notes/file?p=${encodeURIComponent(blob.pathname)}`;
}

export function BlockEditor({
  noteId,
  initialBlocks,
  updatedAt,
  title,
  onState,
}: {
  noteId: string;
  initialBlocks: NoteBlock[];
  /** Version the editor started from; saves are refused if the note changed since. */
  updatedAt: string;
  title: string;
  onState: (s: SaveState) => void;
}) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const editor = useCreateBlockNote({
    schema: noteSchema,
    initialContent: initialBlocks.length ? initialBlocks : undefined,
    uploadFile: async (file: File) => {
      try {
        return await uploadFile(file);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed');
        throw e;
      }
    },
  });

  // ── Autosave ──
  // Refs, not state: edits made while a save is in flight are compared against what was
  // actually sent, so nothing typed during a save is lost.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef(title);
  const savedTitle = useRef(title);
  // Baseline is the editor's own (normalised) document, so opening a page never counts as a change.
  const lastSaved = useRef<string | null>(null);
  const version = useRef(updatedAt);
  const conflicted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => {
    lastSaved.current ??= JSON.stringify(editor.document);
  }, [editor]);

  const save = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (conflicted.current) return;
    if (inFlight.current) await inFlight.current;
    const blocks = editor.document;
    const json = JSON.stringify(blocks);
    const t = titleRef.current.trim() || 'Untitled';
    const titleChanged = t !== (savedTitle.current.trim() || 'Untitled');
    if (json === lastSaved.current && !titleChanged) return onState('saved');
    onState('saving');
    const run = (async () => {
      const r = await saveNoteAction(noteId, {
        ...(json !== lastSaved.current ? { blocks: blocks as unknown[] } : {}),
        ...(titleChanged ? { title: t } : {}),
        expectUpdatedAt: version.current,
      });
      if ('error' in r) {
        onState('error');
        if ('conflict' in r && r.conflict) {
          conflicted.current = true;
          toast.warning('This page was changed elsewhere (maybe by Claude). Loading the latest version; copy anything you need first.', {
            duration: 10000,
            action: { label: 'Reload now', onClick: () => window.location.reload() },
          });
          setTimeout(() => window.location.reload(), 10000);
        } else toast.error(r.error);
        return;
      }
      version.current = r.updatedAt;
      lastSaved.current = json;
      savedTitle.current = t;
      const dirty = JSON.stringify(editor.document) !== json || (titleRef.current.trim() || 'Untitled') !== t;
      onState(dirty ? 'dirty' : 'saved');
    })();
    inFlight.current = run;
    await run;
    inFlight.current = null;
  }, [editor, noteId, onState]);

  const schedule = useCallback(() => {
    onState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  }, [onState, save]);

  // Title edits come from the page header.
  useEffect(() => {
    if (title === titleRef.current) return;
    titleRef.current = title;
    schedule();
  }, [title, schedule]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    const flush = () => {
      if (timer.current) void save(); // only when an edit is still waiting to be saved
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [save]);

  // ── / menu: defaults + Sub-page ──
  const slashItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const subPage: DefaultReactSuggestionItem = {
        title: 'Sub-page',
        subtext: 'A page inside this note',
        aliases: ['page', 'subpage', 'child'],
        group: 'Basic blocks',
        icon: <FileText size={18} />,
        onItemClick: async () => {
          const r = await createSubPageAction(noteId);
          if ('error' in r) return void toast.error(r.error);
          const at = editor.getTextCursorPosition().block;
          editor.insertBlocks([{ type: 'page', props: { noteId: r.id, title: r.title } }], at, 'after');
          if (!at.content || (Array.isArray(at.content) && at.content.length === 0)) editor.removeBlocks([at]);
          await save();
          router.push(`/notes/${r.id}?new=1`);
        },
      };
      // Put Sub-page at the end of the "Basic blocks" group (a group must be contiguous).
      const items = getDefaultReactSlashMenuItems(editor);
      let at = items.length;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].group === subPage.group) {
          at = i + 1;
          break;
        }
      }
      items.splice(at, 0, subPage);
      return filterSuggestionItems(items, query);
    },
    [editor, noteId, router, save],
  );

  // ── @ menu: tasks and projects ──
  const mentionItems = useCallback(
    async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const found = await searchMentionsAction(query);
      return found.map(m => ({
        title: m.label,
        subtext: m.hint,
        icon: m.kind === 'task' ? <ListTodo size={16} /> : <FolderOpen size={16} />,
        onItemClick: () => {
          editor.insertInlineContent([{ type: 'mention', props: { kind: m.kind, target: m.target, label: m.label } }, ' ']);
        },
      }));
    },
    [editor],
  );

  // Clicking a mention or sub-page link navigates (like Notion) instead of placing the cursor.
  const onClick = useMemo(
    () => (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a.wo-mention, a.wo-page-link') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute('href');
      if (href) router.push(href);
    },
    [router],
  );

  return (
    <div onClickCapture={onClick} className="wo-editor -mx-12">
      <BlockNoteView editor={editor} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} slashMenu={false} onChange={schedule}>
        <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
        <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
      </BlockNoteView>
    </div>
  );
}
