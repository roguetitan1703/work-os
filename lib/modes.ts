export const MODES = [
  {
    name: 'Code & Dev',
    hex: '#3882F6',
    rgb: '56, 130, 246',
    light: '#DBEAFE',
    description: "Writing code, fixing bugs, deployments, technical scoping, architecture decisions, technical R&D where the output runs. Whoever it's for. If fingers are on a keyboard producing executable artifacts, it goes here.",
  },
  {
    name: 'Client Delivery',
    hex: '#22C55E',
    rgb: '34, 197, 94',
    light: '#DCFCE7',
    description: "Async client-facing work for external paying clients. Proposals, scoping docs, milestone communication, status updates, handover prep, replies on existing client threads. NOT Fiverr brief-applying. NOT live meetings.",
  },
  {
    name: 'Team Direction',
    hex: '#A855F7',
    rgb: '168, 85, 247',
    light: '#F3E8FF',
    description: "Reviewing what the team made and assigning next tasks. Marketing intern outputs, content calendar approval, design review, intern project oversight, written feedback.",
  },
  {
    name: 'Outreach & Sales',
    hex: '#EF4444',
    rgb: '239, 68, 68',
    light: '#FEE2E2',
    description: "Direct prospecting and conversion. Cold outreach, lead replies (non-Fiverr), referral asks, existing-client expansion conversations, pitching new business.",
  },
  {
    name: 'Growth',
    hex: '#EC4899',
    rgb: '236, 72, 153',
    light: '#FCE7F3',
    description: "Agency-level growth. IDEX portal applications, partnership development, agency positioning bets, structural growth moves. Compounds the business but isn't a sales pitch.",
  },
  {
    name: 'Research & Planning',
    hex: '#06B6D4',
    rgb: '6, 182, 212',
    light: '#CFFAFE',
    description: "Non-urgent strategic work. Content posting research, portfolio templates, marketing orchestration, hiring plans, agency positioning, BS R&D. Output is a decision or plan, not running code.",
  },
  {
    name: 'Founder Decisions',
    hex: '#F59E0B',
    rgb: '245, 158, 11',
    light: '#FEF3C7',
    description: "Internal partner discussions, prep, follow-up. Strategy sessions with the business partner, decisions that can't be made alone, finalizing direction together.",
  },
  {
    name: 'Business Admin',
    hex: '#FB923C',
    rgb: '251, 146, 60',
    light: '#FFEDD5',
    description: "Small but important. Invoice generation, expense reconciliation, paying bills, hiring docs, contract drafts, OS upgrades, backfilling project data.",
  },
] as const;

export type ModeConfig = (typeof MODES)[number];

export const MODE_NAMES = MODES.map(m => m.name) as unknown as string[];

export function getModeConfig(name: string): ModeConfig | undefined {
  return MODES.find(m => m.name === name) as ModeConfig | undefined;
}

export function modeToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function slugToMode(slug: string): string | undefined {
  return MODES.find(m => modeToSlug(m.name) === slug)?.name;
}

export const RITUAL_BLOCKS = {
  'Fiverr Ritual': { hex: '#FACC15', rgb: '250, 204, 21', light: '#FEF9C3' },
  'Meetings':      { hex: '#0891B2', rgb: '8, 145, 178',  light: '#CFFAFE' },
  'Personal':      { hex: '#84CC16', rgb: '132, 204, 22', light: '#ECFCCB' },
  'Setup/Close':   { hex: '#6B7280', rgb: '107, 114, 128', light: '#F3F4F6' },
  'Buffer':        { hex: '#9CA3AF', rgb: '156, 163, 175', light: '#F9FAFB' },
} as const;

export function getBlockColor(name: string): { hex: string; rgb: string; light: string } {
  const mode = MODES.find(m => m.name === name);
  if (mode) return { hex: mode.hex, rgb: mode.rgb, light: mode.light };
  const ritual = RITUAL_BLOCKS[name as keyof typeof RITUAL_BLOCKS];
  if (ritual) return ritual;
  return { hex: '#6B7280', rgb: '107, 114, 128', light: '#F3F4F6' };
}
