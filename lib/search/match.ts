// One search over everything (docs/HANDOVER.md "Search"): the query, the matching rule, the ranking and the hit shape,
// shared by the server providers (lib/search/*.ts) and the browser (components/global-search.tsx, which matches
// Settings and Pages itself). No server imports.
//
// Matching: the query is split into words; every word must match at the start of a word, in any order, with case and
// accents ignored. "#11" is task 11 and nothing else; "N3" is Need 3 and nothing else; a plain number also finds the
// task with that number.
//
// Ranking, best first: exact ref (0); title starts with the query (1); every word in the title (2); some words in the
// title (3); only other fields (4); only a comment (5). Within a tier: open before done or archived, yours first, then
// newest.

export type Kind = 'tasks' | 'projects' | 'notes' | 'sessions' | 'needs' | 'files' | 'settings' | 'pages';
export const KINDS: { key: Kind; label: string; one: string }[] = [
  { key: 'tasks', label: 'Tasks', one: 'Task' },
  { key: 'projects', label: 'Projects', one: 'Project' },
  { key: 'notes', label: 'Notes', one: 'Note' },
  { key: 'sessions', label: 'Sessions', one: 'Session' },
  { key: 'needs', label: 'Needs', one: 'Need' },
  { key: 'files', label: 'Files', one: 'Folder' },
  { key: 'settings', label: 'Settings', one: 'Setting' },
  { key: 'pages', label: 'Pages', one: 'Page' },
];
/** The kinds read on the server. Settings and the app's pages are static lists matched in the browser; the server adds Claude's tools to Pages. */
export const SERVER_KINDS: Kind[] = ['tasks', 'projects', 'notes', 'sessions', 'needs', 'files', 'pages'];
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && KINDS.some(k => k.key === v);

export const MAX_QUERY = 80;
const MAX_WORDS = 8;

export type Tier = 0 | 1 | 2 | 3 | 4 | 5;

/** One result. `title` and `snippet` are shown with the matched words marked; `right` is the project and status. */
export type Hit = {
  kind: Kind;
  id: string;
  title: string;
  /** Second line: what it is and where (a ref, a project, a State part). */
  meta?: string;
  /** A piece of the matched text (a note's body, a description, a comment). */
  snippet?: string;
  /** Right side: project, status. */
  right?: string;
  href: string;
  /** Something to do instead of opening a page (Pages: New task, Start Claude). */
  action?: 'quick-add' | 'start-claude';
  tier: Tier;
  open: boolean;
  mine: boolean;
  /** Last change (ms), for the newest-first order inside a tier. */
  at: number;
};

export type KindResult = { hits: Hit[]; count: number; /** More matched than were read (the count is a floor). */ more?: boolean };
export type SearchResult = { q: string; kinds: Partial<Record<Kind, KindResult>> };

/** Lower case, accents off ("Café" -> "cafe"). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export type Query = {
  /** The text as typed (trimmed, at most MAX_QUERY). */
  q: string;
  /** Folded words. Empty for a ref-only query. */
  words: string[];
  /** "#11" or a plain "11": the task number. */
  taskRef?: number;
  /** "N3": the Need number. */
  needRef?: number;
  /** "#11" or "N3": nothing but that ref is looked for. */
  refOnly: boolean;
};

export function parseQuery(raw: unknown): Query {
  const q = (typeof raw === 'string' ? raw : '').trim().slice(0, MAX_QUERY);
  const hash = /^#(\d{1,9})$/.exec(q);
  if (hash) return { q, words: [], taskRef: Number(hash[1]), refOnly: true };
  const need = /^n(\d{1,9})$/i.exec(q);
  if (need) return { q, words: [], needRef: Number(need[1]), refOnly: true };
  const num = /^\d{1,9}$/.exec(q);
  const words = [...new Set(fold(q).split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS);
  return { q, words, taskRef: num ? Number(q) : undefined, refOnly: false };
}

/** Letters, digits and the marks that combine with them (Devanagari vowel signs): a word start follows none of these. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where `word` (folded) starts a word in `folded` text, or -1. */
export function wordStartAt(folded: string, word: string): number {
  if (!word) return -1;
  let i = folded.indexOf(word);
  while (i !== -1) {
    if (i === 0 || !WORD_CHAR.test(folded[i - 1]) || !WORD_CHAR.test(word[0])) return i;
    i = folded.indexOf(word, i + 1);
  }
  return -1;
}

/** Does every word start a word somewhere in these texts? */
export function matchesAll(texts: (string | null | undefined)[], words: string[]): boolean {
  if (!words.length) return false;
  const f = texts.filter((t): t is string => !!t).map(fold);
  return words.every(w => f.some(t => wordStartAt(t, w) !== -1));
}

/** How many of the words start a word in `text`. */
export function wordsIn(text: string | null | undefined, words: string[]): number {
  if (!text) return 0;
  const f = fold(text);
  return words.filter(w => wordStartAt(f, w) !== -1).length;
}

/** The tier of a hit whose words all matched somewhere (title or other fields). */
export function tierOf(title: string, query: Query): Tier {
  const t = fold(title);
  const whole = query.words.join(' ');
  if (whole && t.startsWith(whole)) return 1;
  const n = wordsIn(title, query.words);
  if (n === query.words.length) return 2;
  return n > 0 ? 3 : 4;
}

/** Best first: tier, open, yours, newest. */
export function compareHits(a: Hit, b: Hit): number {
  return a.tier - b.tier || Number(b.open) - Number(a.open) || Number(b.mine) - Number(a.mine) || b.at - a.at;
}

/** Text split into parts with the matched word starts marked (for bold). Works on the original text, accents kept. */
export function marks(text: string, words: string[]): { text: string; hit: boolean }[] {
  if (!text || !words.length) return [{ text, hit: false }];
  // Fold character by character so offsets map back (NFD can grow a character; fold each one alone).
  const chars = [...text];
  const folded: string[] = chars.map(c => fold(c));
  const flat = folded.join('');
  const startOf: number[] = [];
  let pos = 0;
  for (const f of folded) {
    startOf.push(pos);
    pos += f.length;
  }
  const on = new Array<boolean>(chars.length).fill(false);
  for (const w of words) {
    let i = flat.indexOf(w);
    while (i !== -1) {
      if (i === 0 || !WORD_CHAR.test(flat[i - 1]) || !WORD_CHAR.test(w[0])) {
        for (let k = 0; k < chars.length; k++) if (startOf[k] >= i && startOf[k] < i + w.length) on[k] = true;
      }
      i = flat.indexOf(w, i + 1);
    }
  }
  const out: { text: string; hit: boolean }[] = [];
  chars.forEach((c, k) => {
    const last = out[out.length - 1];
    if (last && last.hit === on[k]) last.text += c;
    else out.push({ text: c, hit: on[k] });
  });
  return out;
}

/** A short piece of `body` around the first matched word (or its start). */
export function excerpt(body: string, words: string[], size = 110): string {
  const flat = body.replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const f = fold(flat);
  const at = words.map(w => wordStartAt(f, w)).filter(i => i >= 0);
  const first = at.length ? Math.min(...at) : 0;
  const from = Math.max(0, first - 30);
  return (from > 0 ? '…' : '') + flat.slice(from, from + size) + (flat.length > from + size ? '…' : '');
}

// ── Database side: a loose pre-filter, the exact rule is applied after (matchesAll) ──

const ACCENTS: Record<string, string> = {
  a: 'aàáâãäåāăą',
  c: 'cçćč',
  d: 'dď',
  e: 'eèéêëēėęě',
  g: 'gğ',
  i: 'iìíîïīį',
  l: 'lł',
  n: 'nñńň',
  o: 'oòóôõöøō',
  r: 'rř',
  s: 'sśšş',
  t: 'tť',
  u: 'uùúûüūů',
  y: 'yýÿ',
  z: 'zźżž',
};

/**
 * A MongoDB regex for one folded word at a word start, with accented letters in either case. Looser than wordStartAt
 * (only ASCII letters and digits count as word characters), so it never drops a hit the exact rule keeps.
 */
export function wordRegex(word: string): RegExp {
  const body = [...word]
    .map(ch => {
      const set = ACCENTS[ch];
      return set ? `[${set}${set.toUpperCase()}]` : escapeRegex(ch);
    })
    .join('');
  return new RegExp(/^[a-z0-9]/.test(word) ? `(?:^|[^a-zA-Z0-9])${body}` : body, 'i');
}

/** Every word in at least one of these fields (a MongoDB filter). */
export function wordsFilter(fields: string[], words: string[]): Record<string, unknown> {
  return { $and: words.map(w => ({ $or: fields.map(f => ({ [f]: wordRegex(w) })) })) };
}
