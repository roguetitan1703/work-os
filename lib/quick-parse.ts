import { MODES } from './modes';
import type { Mode, Priority, TaskInput } from './types';

// Quick-capture syntax:
//   Fix login bug @grant-leads !1 #bug due:fri start:mon ~45m mode:code
//   @"Grant Leads"  → project with spaces
//   !1 / !p1        → priority      #tag → tag      ~1h30m → estimate
//   due:today|tomorrow|fri|+3d|2026-10-20   start:… same

const MODE_ALIASES: Record<string, Mode> = {
  code: 'Code & Dev',
  dev: 'Code & Dev',
  client: 'Client Delivery',
  delivery: 'Client Delivery',
  team: 'Team Direction',
  outreach: 'Outreach & Sales',
  sales: 'Outreach & Sales',
  growth: 'Growth',
  research: 'Research & Planning',
  planning: 'Research & Planning',
  rnd: 'Research & Planning',
  founder: 'Founder Decisions',
  decisions: 'Founder Decisions',
  admin: 'Business Admin',
  biz: 'Business Admin',
};

export function matchMode(s: string): Mode | undefined {
  const v = s.toLowerCase();
  if (MODE_ALIASES[v]) return MODE_ALIASES[v];
  return MODES.find(m => m.name.toLowerCase().startsWith(v))?.name as Mode | undefined;
}

function parseEstimate(s: string): number | undefined {
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m?)?$/i);
  if (!m || (!m[1] && !m[2])) return undefined;
  return Math.round((m[1] ? parseFloat(m[1]) * 60 : 0) + (m[2] ? parseInt(m[2], 10) : 0));
}

export type QuickParse = TaskInput & { title: string };

export function parseQuickAdd(raw: string, projects: { id: string; name: string }[] = []): QuickParse {
  const out: QuickParse = { title: '' };
  const tags: string[] = [];
  const words: string[] = [];
  const re = /@"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m[1]) {
      out.project = m[1].trim();
      continue;
    }
    const w = m[2];
    const lower = w.toLowerCase();
    if (/^!p?[1-4]$/i.test(w)) out.priority = `P${w.slice(-1)}` as Priority;
    else if (w.length > 1 && w.startsWith('#')) tags.push(w.slice(1));
    else if (w.length > 1 && w.startsWith('@')) {
      const key = w.slice(1);
      const p =
        projects.find(p => p.id === key.toLowerCase()) ??
        projects.find(p => p.name.toLowerCase() === key.toLowerCase()) ??
        projects.find(p => p.name.toLowerCase().replace(/\s+/g, '') === key.toLowerCase().replace(/-/g, ''));
      out.project = p ? p.name : key;
    } else if (lower.startsWith('due:') && w.length > 4) out.due = w.slice(4);
    else if (lower.startsWith('start:') && w.length > 6) out.start = w.slice(6);
    else if (lower.startsWith('mode:') && matchMode(w.slice(5))) out.mode = matchMode(w.slice(5));
    else if (w.startsWith('~') && parseEstimate(w.slice(1)) !== undefined) out.estimateMins = parseEstimate(w.slice(1));
    else words.push(w);
  }
  if (tags.length) out.tags = tags;
  out.title = words.join(' ').trim();
  return out;
}
