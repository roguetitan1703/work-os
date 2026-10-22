// Modes of work (the "type" of a task). Each organization has its own list (lib/org-modes.ts, `modes:<orgId>`); a
// new organization starts with DEFAULT_MODES. This file is pure (browser and server): the list is always passed in.

export type ModeDef = {
  name: string;
  /** '#RRGGBB' */
  hex: string;
  description: string;
  /** Pale background for the block bar; derived from hex when missing. */
  light?: string;
};

export type ModeColor = { hex: string; rgb: string; light: string };

export const DEFAULT_MODES: ModeDef[] = [
  {
    name: 'Code & Dev',
    hex: '#3882F6',
    light: '#DBEAFE',
    description: "Writing code, fixing bugs, deployments, technical scoping, architecture decisions, technical R&D where the output runs. Whoever it's for. If fingers are on a keyboard producing executable artifacts, it goes here.",
  },
  {
    name: 'Client Delivery',
    hex: '#22C55E',
    light: '#DCFCE7',
    description: 'Async client-facing work for external paying clients. Proposals, scoping docs, milestone communication, status updates, handover prep, replies on existing client threads. NOT live meetings.',
  },
  {
    name: 'Team Direction',
    hex: '#A855F7',
    light: '#F3E8FF',
    description: 'Reviewing what the team made and assigning next tasks. Marketing intern outputs, content calendar approval, design review, intern project oversight, written feedback.',
  },
  {
    name: 'Outreach & Sales',
    hex: '#EF4444',
    light: '#FEE2E2',
    description: 'Direct prospecting and conversion. Cold outreach, lead replies, referral asks, existing-client expansion conversations, pitching new business.',
  },
  {
    name: 'Growth',
    hex: '#EC4899',
    light: '#FCE7F3',
    description: "Agency-level growth. IDEX portal applications, partnership development, agency positioning bets, structural growth moves. Compounds the business but isn't a sales pitch.",
  },
  {
    name: 'Research & Planning',
    hex: '#06B6D4',
    light: '#CFFAFE',
    description: 'Non-urgent strategic work. Content posting research, portfolio templates, marketing orchestration, hiring plans, agency positioning, BS R&D. Output is a decision or plan, not running code.',
  },
  {
    name: 'Founder Decisions',
    hex: '#F59E0B',
    light: '#FEF3C7',
    description: "Internal partner discussions, prep, follow-up. Strategy sessions with the business partner, decisions that can't be made alone, finalizing direction together.",
  },
  {
    name: 'Business Admin',
    hex: '#FB923C',
    light: '#FFEDD5',
    description: 'Small but important. Invoice generation, expense reconciliation, paying bills, hiring docs, contract drafts, OS upgrades, backfilling project data.',
  },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX_RE.test(v);

const GREY: ModeColor = { hex: '#6B7280', rgb: '107, 114, 128', light: '#F3F4F6' };

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** A colour as the block bar and chips use it. */
export function colorFromHex(hex: string, light?: string): ModeColor {
  if (!isHex(hex)) return GREY;
  const [r, g, b] = channels(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.82).toString(16).padStart(2, '0');
  return { hex, rgb: `${r}, ${g}, ${b}`, light: isHex(light) ? light : `#${mix(r)}${mix(g)}${mix(b)}`.toUpperCase() };
}

/**
 * The colour for a name shown in the schedule or on a task: an organization mode, else one of the person's own block
 * colours (schedule `colors`, e.g. a routine or a break), else grey.
 */
export function colorOf(name: string | null | undefined, modes: readonly ModeDef[], extra?: Record<string, string>): ModeColor {
  if (!name) return GREY;
  const m = modes.find(x => x.name === name);
  if (m) return colorFromHex(m.hex, m.light);
  const own = extra?.[name];
  return own ? colorFromHex(own) : GREY;
}

/** The mode with this name, ignoring case (exact names only). */
export function findMode(modes: readonly ModeDef[], name: string): ModeDef | undefined {
  const v = name.trim().toLowerCase();
  return modes.find(m => m.name.toLowerCase() === v);
}

export function modeToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function slugToMode(modes: readonly ModeDef[], slug: string): string | undefined {
  return modes.find(m => modeToSlug(m.name) === slug)?.name;
}
