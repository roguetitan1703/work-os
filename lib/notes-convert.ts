import 'server-only';
import type { ServerBlockNoteEditor } from '@blocknote/server-util';
import type { NoteBlock, NotePartialBlock, NoteSchema } from './notes-schema';

// Server-side conversion between note blocks (source of truth) and markdown (what Claude reads
// and writes). Links Claude writes to /tasks/<ref> or /projects/<id> become mentions.

type AnyBlock = NoteBlock | NotePartialBlock;
type Inline = { type: string; text?: string; href?: string; content?: Inline[]; props?: Record<string, unknown>; styles?: Record<string, unknown> };

// Loaded lazily: BlockNote (and its jsdom) only load when a note is actually converted, so
// a problem there can never take down unrelated routes such as the MCP endpoint.
type Editor = ServerBlockNoteEditor<NoteSchema['blockSchema'], NoteSchema['inlineContentSchema'], NoteSchema['styleSchema']>;
const g = globalThis as unknown as { __workosNoteEditor?: Promise<Editor> };

function editor(): Promise<Editor> {
  g.__workosNoteEditor ??= (async () => {
    const [{ ServerBlockNoteEditor }, { noteSchema }] = await Promise.all([import('@blocknote/server-util'), import('./notes-schema')]);
    return ServerBlockNoteEditor.create({ schema: noteSchema }) as unknown as Editor;
  })().catch(err => {
    g.__workosNoteEditor = undefined;
    throw err;
  });
  return g.__workosNoteEditor;
}

/** For the health check: converts a tiny document and reports any error. */
export async function converterCheck(): Promise<string> {
  try {
    const b = await markdownToBlocks('# ok');
    return b.length === 1 ? 'ok' : `unexpected: ${b.length} blocks`;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : String(e);
  }
}

const MENTION_HREF = /^(?:https?:\/\/[^/]+)?\/(tasks|projects)\/([^/?#\s]+)\/?$/;

/** Turn markdown links to tasks/projects into mention inline content (recursively). */
function linkToMentions<T>(blocks: T[]): T[] {
  const fix = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    return (content as Inline[]).map(ic => {
      if (ic.type === 'link' && ic.href) {
        const m = ic.href.match(MENTION_HREF);
        if (m) {
          const label = (ic.content ?? []).map(c => c.text ?? '').join('') || (m[1] === 'tasks' ? `#${m[2]}` : m[2]);
          return { type: 'mention', props: { kind: m[1] === 'tasks' ? 'task' : 'project', target: decodeURIComponent(m[2]), label } };
        }
      }
      return ic;
    });
  };
  return blocks.map(b => {
    const x = b as unknown as { content?: unknown; children?: unknown[] };
    return { ...b, content: fix(x.content), ...(x.children?.length ? { children: linkToMentions(x.children) } : {}) } as T;
  });
}

export async function markdownToBlocks(md: string): Promise<NoteBlock[]> {
  if (!md.trim()) return [];
  return linkToMentions(await (await editor()).tryParseMarkdownToBlocks(md)) as NoteBlock[];
}

export async function blocksToMarkdown(blocks: AnyBlock[]): Promise<string> {
  if (!blocks.length) return '';
  return (await (await editor()).blocksToMarkdownLossy(blocks as NotePartialBlock[])).trim();
}

/** Top-level blocks with their ids and markdown (children are included in their parent's markdown). */
export async function blockOutline(blocks: NoteBlock[]): Promise<{ id: string; type: string; markdown: string }[]> {
  const out = [];
  for (const b of blocks) out.push({ id: b.id, type: b.type, markdown: await blocksToMarkdown([b]) });
  return out;
}

/** Plain text of a block tree (for search and first-line previews). */
export function plainText(blocks: AnyBlock[]): string {
  const parts: string[] = [];
  const walk = (bs: AnyBlock[]) => {
    for (const b of bs) {
      const x = b as unknown as { content?: unknown; children?: AnyBlock[]; props?: Record<string, unknown>; type: string };
      if (Array.isArray(x.content)) parts.push((x.content as Inline[]).map(ic => ic.text ?? (ic.content ?? []).map(c => c.text ?? '').join('') ?? String(ic.props?.label ?? '')).join(''));
      else if (typeof x.content === 'string') parts.push(x.content);
      if (x.type === 'page') parts.push(String(x.props?.title ?? ''));
      if (x.children?.length) walk(x.children);
    }
  };
  walk(blocks);
  return parts.filter(Boolean).join('\n');
}

// ── Block surgery for Claude's per-block edits ──────────────────────────────

type Loc = { list: NoteBlock[]; index: number };

export function findBlock(blocks: NoteBlock[], id: string): Loc | null {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === id) return { list: blocks, index: i };
    const kids = blocks[i].children as NoteBlock[] | undefined;
    if (kids?.length) {
      const r = findBlock(kids, id);
      if (r) return r;
    }
  }
  return null;
}

/** Deep clone so edits never mutate the stored array in place. */
export function cloneBlocks(blocks: NoteBlock[]): NoteBlock[] {
  return JSON.parse(JSON.stringify(blocks ?? []));
}
