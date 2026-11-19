// Matching for write_note edits (docs/flows/agent-system.md section 8, H14 step 1): the text an agent copies from
// read_note differs from the stored text only in typography or markdown dress (curly vs straight quotes, dashes, list
// numbers, table padding, hard breaks, escapes). Pure and client-safe: no imports, so node can load it for tests.
//
// Matching folds, replacing doesn't: `locateExact` first; only when nothing matches is `locateFolded` tried, and its hits
// are mapped back to offsets in the original text, so only the matched characters change.

export type Hit = { start: number; end: number };
type Tok = { c: string; s: number; e: number };

const SINGLE_QUOTES = '‘’‚‛′ʼ';
const DOUBLE_QUOTES = '“”„‟″';
const DASHES = '‐‑‒–—―−';
const SPACES = '           ';
const PUNCT = /[!-/:-@[-`{-~]/;

/**
 * The folded text and, per folded character, where it starts (`at`) and ends (`to`) in the original. `lists: false` leaves
 * list markers alone (titles).
 */
export function fold(s: string, opts: { lists?: boolean } = {}): { text: string; at: number[]; to: number[] } {
  const lists = opts.lists !== false;
  // Phase 1: character folds.
  let toks: Tok[] = [];
  let afterBreak = false; // a hard break was just emitted: drop the indentation that follows it
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '\n') { afterBreak = true; continue; }
    if (ch === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { toks.push({ c: s[i + 1], s: i, e: i + 2 }); i++; afterBreak = false; continue; }
    if (ch === '\n') { toks.push({ c: '\n', s: i, e: i + 1 }); continue; }
    if (SPACES.includes(ch) || ch === ' ' || ch === '\t') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || SPACES.includes(s[j]))) j++;
      if (!afterBreak) toks.push({ c: ' ', s: i, e: j });
      i = j - 1;
      continue;
    }
    afterBreak = false;
    if (SINGLE_QUOTES.includes(ch)) toks.push({ c: "'", s: i, e: i + 1 });
    else if (DOUBLE_QUOTES.includes(ch)) toks.push({ c: '"', s: i, e: i + 1 });
    else if (ch === '-' || DASHES.includes(ch)) {
      let j = i + 1;
      while (j < s.length && (s[j] === '-' || DASHES.includes(s[j]))) j++;
      toks.push({ c: '-', s: i, e: j });
      i = j - 1;
    } else if (ch === '…') for (let k = 0; k < 3; k++) toks.push({ c: '.', s: i, e: i + 1 });
    else toks.push({ c: ch, s: i, e: i + 1 });
  }
  // Spaces before a newline go.
  const kept: Tok[] = [];
  for (const t of toks) {
    if (t.c === '\n') while (kept.length && kept[kept.length - 1].c === ' ') kept.pop();
    kept.push(t);
  }
  toks = kept;
  // Phase 2: list markers at a line start ("N. " to "1. ", "- " and "+ " to "* ").
  if (lists) {
    const out: Tok[] = [];
    let i = 0;
    let lineStart = true;
    while (i < toks.length) {
      const t = toks[i];
      if (t.c === '\n') { lineStart = true; out.push(t); i++; continue; }
      if (lineStart && t.c === ' ') { out.push(t); i++; continue; }
      if (lineStart) {
        lineStart = false;
        let j = i;
        while (j < toks.length && /[0-9]/.test(toks[j].c)) j++;
        if (j > i && toks[j]?.c === '.' && toks[j + 1]?.c === ' ') {
          out.push({ c: '1', s: toks[i].s, e: toks[j - 1].e });
          i = j;
          continue;
        }
        if ((t.c === '-' || t.c === '+') && toks[i + 1]?.c === ' ') { out.push({ c: '*', s: t.s, e: t.e }); i++; continue; }
      }
      out.push(t);
      i++;
    }
    toks = out;
  }
  return { text: toks.map(t => t.c).join(''), at: toks.map(t => t.s), to: toks.map(t => t.e) };
}

function all(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** Hits of `needle` as written. */
export function locateExact(hay: string, needle: string): Hit[] {
  return all(hay, needle).map(i => ({ start: i, end: i + needle.length }));
}

/** Hits of `needle` after both are folded, as offsets in the original `hay`. */
export function locateFolded(hay: string, needle: string): Hit[] {
  const n = fold(needle).text.replace(/^[ \n]+|[ \n]+$/g, '');
  if (!n) return [];
  const h = fold(hay);
  return all(h.text, n).map(i => ({ start: h.at[i], end: h.to[i + n.length - 1] }));
}

/** Exact hits; if there are none, folded hits (offsets in the original). */
export function locate(hay: string, needle: string): Hit[] {
  const x = locateExact(hay, needle);
  return x.length ? x : locateFolded(hay, needle);
}

/** True when `s` holds markdown that would change how a block is built; such a replacement takes the markdown path. */
export function hasMarkdown(s: string): boolean {
  return /[\n\r]|\*\*|__|`|~~|\[[^\]]*\]\([^)]*\)|(^|[^*\w])\*[^*\s][^*]*\*|(^|[^_\w])_[^_\s][^_]*_/.test(s);
}

/** The key two note titles are compared by: folded, lower case, whitespace collapsed, trimmed. */
export function titleKey(t: string): string {
  return fold(t, { lists: false }).text.toLowerCase().replace(/\s+/g, ' ').trim();
}
