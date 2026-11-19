import 'server-only';
import type { ServerBlockNoteEditor } from '@blocknote/server-util';
import type { NoteBlock, NotePartialBlock, NoteSchema } from './notes-schema';
import { locateExact, locateFolded } from './notes-match';

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

// ── In-place text edits (H14 step 2) ────────────────────────────────────────

type Run = { list: Inline[]; index: number; text: string; editable: boolean; link?: { node: Inline; parent: Inline[] } };

/**
 * The text segments of a block with inline content, in order: `text` runs and the `text` runs inside a `link`. A mention
 * counts as one U+FFFC character (it never matches a find, and is never edited). Blocks without inline content (tables,
 * code, page) have none.
 */
export function inlineRuns(block: AnyBlock): Run[] | null {
  const x = block as unknown as { type: string; content?: unknown };
  if (!Array.isArray(x.content) || x.type === 'codeBlock') return null;
  const runs: Run[] = [];
  const walk = (list: Inline[], link?: Run['link']) => {
    list.forEach((ic, index) => {
      if (ic.type === 'text') runs.push({ list, index, text: ic.text ?? '', editable: true, ...(link ? { link } : {}) });
      else if (ic.type === 'link' && Array.isArray(ic.content)) walk(ic.content, { node: ic, parent: list });
      else runs.push({ list, index, text: '\uFFFC', editable: false });
    });
  };
  walk(x.content as Inline[]);
  return runs;
}

/**
 * Finds `find` in the plain text of the page's blocks (exact first, then folded through quotes, dashes and spaces) and,
 * when it occurs exactly once inside ordinary text runs of one block, `apply()` rewrites just those runs: the first touched
 * run gets the new text with its styles, later touched runs are trimmed, everything else (other runs, mentions, colours,
 * the block's id and props) stays. `count` is the number of hits across the page; a hit that touches a mention is
 * not editable in place (count 0), so the caller takes the markdown path.
 */
export function editInPlace(blocks: NoteBlock[], find: string, replace: string): { count: number; apply?: () => void } {
  // `runs` is empty for text that is counted but never edited here (code blocks, table cells): a find that also occurs there
  // is not unique, as in the markdown path.
  const texts: { runs: Run[]; text: string }[] = [];
  const raw = (c: unknown): string => (Array.isArray(c) ? (c as Inline[]).map(ic => ic.text ?? raw(ic.content)).join('') : '');
  const walk = (bs: AnyBlock[]) => {
    for (const b of bs) {
      const runs = inlineRuns(b);
      if (runs?.length) texts.push({ runs, text: runs.map(r => r.text).join('') });
      else {
        const c = (b as unknown as { content?: unknown }).content;
        if (Array.isArray(c)) texts.push({ runs: [], text: raw(c) });
        else if (c && typeof c === 'object') for (const row of (c as { rows?: { cells?: unknown[] }[] }).rows ?? []) for (const cell of row.cells ?? []) texts.push({ runs: [], text: raw((cell as { content?: unknown })?.content ?? cell) });
      }
      const kids = (b as unknown as { children?: AnyBlock[] }).children;
      if (kids?.length) walk(kids);
    }
  };
  walk(blocks);
  let per = texts.map(t => locateExact(t.text, find));
  if (!per.some(h => h.length)) per = texts.map(t => locateFolded(t.text, find));
  const count = per.reduce((n, h) => n + h.length, 0);
  if (count !== 1) return { count };
  const i = per.findIndex(h => h.length);
  const hit = per[i][0];
  const { runs } = texts[i];
  if (!runs.length) return { count: 0 };
  const touched: { run: Run; from: number; to: number }[] = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    if (end > hit.start && at < hit.end) touched.push({ run, from: Math.max(hit.start, at) - at, to: Math.min(hit.end, end) - at });
    at = end;
  }
  if (!touched.length || touched.some(t => !t.run.editable)) return { count: 0 };
  return {
    count,
    apply: () => {
      touched.forEach((t, k) => {
        const node = t.run.list[t.run.index];
        const text = node.text ?? '';
        node.text = k === 0 ? text.slice(0, t.from) + replace + (touched.length === 1 ? text.slice(t.to) : '') : text.slice(t.to);
      });
      // Drop runs the edit left empty (highest index first so earlier ones keep their place).
      for (const t of [...touched].reverse()) {
        if (t.run.list[t.run.index].text ?? '') continue;
        t.run.list.splice(t.run.index, 1);
        // A link left with no text goes too (no empty link).
        const l = t.run.link;
        if (l && !t.run.list.length) {
          const at = l.parent.indexOf(l.node);
          if (at >= 0) l.parent.splice(at, 1);
        }
      }
    },
  };
}
