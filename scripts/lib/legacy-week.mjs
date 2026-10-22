// The timetable, routine, review questions and help that were built into Work OS before docs/multi-user.md phase 3
// made them each person's own data. scripts/migrate-phase3.mjs copies them to the first organization's owner, whose
// they were. Generated from lib/schedule.ts, lib/modes.ts (modes and block colours), lib/ritual-mode-map.ts, components/fiverr-ritual-card.tsx,
// the review page and app/(app)/settings/help.tsx as they were at commit aef0056.

export const LEGACY_TIMEZONE = 'Asia/Kolkata';

/** The organization's eight modes, with their original descriptions. */
export const LEGACY_MODES = [
  {
    "name": "Code & Dev",
    "hex": "#3882F6",
    "description": "Writing code, fixing bugs, deployments, technical scoping, architecture decisions, technical R&D where the output runs. Whoever it's for. If fingers are on a keyboard producing executable artifacts, it goes here.",
    "light": "#DBEAFE"
  },
  {
    "name": "Client Delivery",
    "hex": "#22C55E",
    "description": "Async client-facing work for external paying clients. Proposals, scoping docs, milestone communication, status updates, handover prep, replies on existing client threads. NOT Fiverr brief-applying. NOT live meetings.",
    "light": "#DCFCE7"
  },
  {
    "name": "Team Direction",
    "hex": "#A855F7",
    "description": "Reviewing what the team made and assigning next tasks. Marketing intern outputs, content calendar approval, design review, intern project oversight, written feedback.",
    "light": "#F3E8FF"
  },
  {
    "name": "Outreach & Sales",
    "hex": "#EF4444",
    "description": "Direct prospecting and conversion. Cold outreach, lead replies (non-Fiverr), referral asks, existing-client expansion conversations, pitching new business.",
    "light": "#FEE2E2"
  },
  {
    "name": "Growth",
    "hex": "#EC4899",
    "description": "Agency-level growth. IDEX portal applications, partnership development, agency positioning bets, structural growth moves. Compounds the business but isn't a sales pitch.",
    "light": "#FCE7F3"
  },
  {
    "name": "Research & Planning",
    "hex": "#06B6D4",
    "description": "Non-urgent strategic work. Content posting research, portfolio templates, marketing orchestration, hiring plans, agency positioning, BS R&D. Output is a decision or plan, not running code.",
    "light": "#CFFAFE"
  },
  {
    "name": "Founder Decisions",
    "hex": "#F59E0B",
    "description": "Internal partner discussions, prep, follow-up. Strategy sessions with the business partner, decisions that can't be made alone, finalizing direction together.",
    "light": "#FEF3C7"
  },
  {
    "name": "Business Admin",
    "hex": "#FB923C",
    "description": "Small but important. Invoice generation, expense reconciliation, paying bills, hiring docs, contract drafts, OS upgrades, backfilling project data.",
    "light": "#FFEDD5"
  }
];

export const LEGACY_BLOCKS = [
  {
    "start": "10:00",
    "end": "10:20",
    "block": "Morning Setup",
    "duration": "20 min",
    "modes": {
      "mon": "Setup/Close",
      "tue": "Setup/Close",
      "wed": "Setup/Close",
      "thu": "Setup/Close",
      "fri": "Setup/Close"
    },
    "notes": "Open TODAY tab. Read the schedule. Pick 3 P1s. Update Last Touched. Start the day clean."
  },
  {
    "start": "10:20",
    "end": "11:50",
    "block": "Morning Anchor",
    "duration": "90 min",
    "modes": {
      "mon": "Code & Dev",
      "tue": "Code & Dev",
      "wed": "Code & Dev",
      "thu": "Code & Dev",
      "fri": "Code & Dev"
    },
    "notes": "Sacred deep work. Hardest code, deployments, bug fixes, architecture, technical R&D."
  },
  {
    "start": "11:50",
    "end": "12:35",
    "block": "Fiverr Ritual",
    "duration": "45 min",
    "modes": {
      "mon": "Outreach & Sales",
      "tue": "Outreach & Sales",
      "wed": "Outreach & Sales",
      "thu": "Outreach & Sales",
      "fri": "Outreach & Sales"
    },
    "notes": "Fiverr brief-applying, Fiverr lead replies, platform presence, inbound handling."
  },
  {
    "start": "12:35",
    "end": "12:45",
    "block": "Buffer",
    "duration": "10 min",
    "modes": {
      "mon": "Personal",
      "tue": "Personal",
      "wed": "Personal",
      "thu": "Personal",
      "fri": "Personal"
    },
    "notes": "Stand up. Water. Reset. No scrolling."
  },
  {
    "start": "12:45",
    "end": "13:05",
    "block": "Meeting Prep / Founder Decisions Prep",
    "duration": "20 min",
    "modes": {
      "mon": "Founder Decisions",
      "tue": "Founder Decisions",
      "wed": "Founder Decisions",
      "thu": "Founder Decisions",
      "fri": "Founder Decisions"
    },
    "notes": "Prep for client calls or partner discussion. Review notes, open docs, decide what must be resolved today."
  },
  {
    "start": "13:05",
    "end": "15:05",
    "block": "Meetings Window / Founder Decisions",
    "duration": "2 hr (HARD CAP)",
    "modes": {
      "mon": "Founder Decisions",
      "tue": "Founder Decisions",
      "wed": "Founder Decisions",
      "thu": "Founder Decisions",
      "fri": "Founder Decisions"
    },
    "notes": "Client meetings, discovery calls, handovers, and partner decisions. If no meeting, use this for founder decisions with your partner."
  },
  {
    "start": "15:05",
    "end": "16:05",
    "block": "Lunch + Movement",
    "duration": "60 min",
    "modes": {
      "mon": "Personal",
      "tue": "Personal",
      "wed": "Personal",
      "thu": "Personal",
      "fri": "Personal"
    },
    "notes": "Eat properly. Walk 20 min minimum. Non-negotiable."
  },
  {
    "start": "16:05",
    "end": "17:05",
    "block": "Team Direction Block",
    "duration": "60 min",
    "modes": {
      "mon": "Team Direction",
      "tue": "Team Direction",
      "wed": "Team Direction",
      "thu": "Team Direction",
      "fri": "Team Direction"
    },
    "notes": "Review intern work, portfolio drafts, content plans, design requests, and assign next tasks."
  },
  {
    "start": "17:05",
    "end": "17:15",
    "block": "Buffer",
    "duration": "10 min",
    "modes": {
      "mon": "Personal",
      "tue": "Personal",
      "wed": "Personal",
      "thu": "Personal",
      "fri": "Personal"
    },
    "notes": "Mode reset. Tea, water, no inputs."
  },
  {
    "start": "17:15",
    "end": "18:45",
    "block": "Client Delivery Block",
    "duration": "90 min",
    "modes": {
      "mon": "Client Delivery",
      "tue": "Client Delivery",
      "wed": "Client Delivery",
      "thu": "Client Delivery",
      "fri": "Client Delivery"
    },
    "notes": "Proposals, scoping docs, status updates, handover prep, replies on active client threads."
  },
  {
    "start": "18:45",
    "end": "19:45",
    "block": "Growth / R&P Block",
    "duration": "60 min",
    "modes": {
      "mon": "Growth",
      "tue": "Research & Planning",
      "wed": "Growth",
      "thu": "Research & Planning",
      "fri": "Growth"
    },
    "notes": "IDEX portals, partnership work, positioning, content systems, portfolio templates, strategic R&D."
  },
  {
    "start": "19:45",
    "end": "20:00",
    "block": "Snack + Decompress",
    "duration": "15 min",
    "modes": {
      "mon": "Personal",
      "tue": "Personal",
      "wed": "Personal",
      "thu": "Personal",
      "fri": "Personal"
    },
    "notes": "Break from screens. Keep it light."
  },
  {
    "start": "20:00",
    "end": "21:00",
    "block": "Outreach & Sales",
    "duration": "60 min",
    "modes": {
      "mon": "Outreach & Sales",
      "tue": "Outreach & Sales",
      "wed": "Outreach & Sales",
      "thu": "Outreach & Sales",
      "fri": "Outreach & Sales"
    },
    "notes": "Cold outreach, lead follow-up, discovery-call booking, referrals, expansion selling, non-Fiverr lead conversion."
  },
  {
    "start": "21:00",
    "end": "22:30",
    "block": "Late-Night Build",
    "duration": "90 min",
    "modes": {
      "mon": "Code & Dev",
      "tue": "Code & Dev",
      "wed": "Code & Dev",
      "thu": "Code & Dev",
      "fri": "Code & Dev"
    },
    "notes": "Quiet deep work. Code, fixes, deployments, scripts, technical execution, high-focus R&D."
  },
  {
    "start": "22:30",
    "end": "22:45",
    "block": "Comms 2",
    "duration": "15 min",
    "modes": {
      "mon": "Client Delivery",
      "tue": "Client Delivery",
      "wed": "Founder Decisions",
      "thu": "Client Delivery",
      "fri": "Client Delivery"
    },
    "notes": "Close loops, send quick replies, confirm tomorrow's questions. Wednesday: mid-week founder check."
  },
  {
    "start": "23:05",
    "end": "00:00",
    "block": "Dinner",
    "duration": "55 min",
    "modes": {
      "mon": "Personal",
      "tue": "Personal",
      "wed": "Personal",
      "thu": "Personal",
      "fri": "Personal"
    },
    "notes": "Eat properly. No work."
  },
  {
    "start": "00:00",
    "end": "00:15",
    "block": "Day Close",
    "duration": "15 min",
    "modes": {
      "mon": "Setup/Close",
      "tue": "Setup/Close",
      "wed": "Setup/Close",
      "thu": "Setup/Close",
      "fri": "Setup/Close"
    },
    "notes": "Mark done, update Last Touched, log expenses/admin items, generate invoices, set tomorrow's 3 P1s."
  }
];

/** Colours of block names that are not modes. */
export const LEGACY_COLORS = {
  'Fiverr Ritual': '#FACC15',
  Meetings: '#0891B2',
  Personal: '#84CC16',
  'Setup/Close': '#6B7280',
  Buffer: '#9CA3AF',
};

/** Block names whose time goes to a mode's tasks ('' = none). */
export const LEGACY_TASK_MODES = {
  'Setup/Close': 'Business Admin',
  'Fiverr Ritual': 'Client Delivery',
  Meetings: 'Client Delivery',
  Buffer: '',
  Personal: '',
};

export const LEGACY_ROUTINE = {
  name: 'Fiverr Ritual',
  start: '11:50',
  end: '12:35',
  color: '#FACC15',
  countLabel: 'Bids placed',
  question: 'Did you do the Fiverr ritual today?',
  placeholder: 'e.g. applied to 3 web dev gigs',
};

export const LEGACY_REVIEW = [
  { key: 'shipped', label: 'Shipped', kind: 'text' },
  { key: 'slipped', label: 'Slipped', kind: 'text' },
  { key: 'toDrop', label: 'To drop', kind: 'text' },
  { key: 'brokenDays', label: 'Broken days', kind: 'number' },
  { key: 'extensionTokensUsed', label: 'Extension tokens used', kind: 'number' },
  { key: 'adjustments', label: 'Adjustments for next week', kind: 'text' },
];

export const LEGACY_HELP = [
  {
    title: 'Core principles',
    hint: 'Four rules',
    items: [
      { title: 'Lost time stays lost.', text: "Don't try to compress 3 blocks into 2 to make up. Just continue from wherever you are." },
      { title: 'Extension token.', text: 'Once per week you may extend a block by 30 min max. Use it on Code & Dev or Client Delivery only. Log it in Weekly Review.' },
      { title: 'Phone after 21:00.', text: 'No doom-scroll during work blocks. Phone lives face-down until 21:00.' },
      { title: 'Max 3 P1s per day.', text: 'If you have more than 3, downgrade. P1 means "must ship today or the business is hurt."' },
    ],
  },
  {
    title: 'Failure modes',
    hint: 'Meeting overrun, slept late, sick day',
    items: [
      { title: 'Meeting overrun', text: 'End the call. Hard stop. If the other party isn\'t done: "I need to wrap, let\'s continue async or schedule a follow-up." The meeting cap is 2 hours. A 3rd meeting moves to tomorrow.' },
      { title: 'Slept late', text: "Start at whatever time you wake up. Begin with Morning Setup regardless of clock. Skip no block, just compress duration proportionally if needed. Don't skip Fiverr Ritual." },
      { title: "Block runs hot (deep flow, can't stop)", text: 'Use your extension token (once per week, 30 min max). If already used: stop at the block end. Log the overflow task as a P1 for tomorrow.' },
      { title: 'P0 emergency', text: 'Declare it. Drop into Code & Dev mode regardless of schedule block. Work until resolved. Then resume from wherever the clock says you are. Log in Weekly Review.' },
      { title: 'Sick day', text: "Don't try to work. Rest. Mark the day broken. If 2+ sick days in a week, update the review and adjust the coming week's P1s accordingly." },
    ],
  },
  {
    title: 'Broken day thresholds',
    hint: '1, 2, 3+ broken days a week',
    items: [
      { title: '1 broken day', text: 'Normal. Log it, move on.' },
      { title: '2 broken days', text: 'Investigate. What broke? Fix the environment, not your willpower.' },
      { title: '3+ broken days', text: 'System failure. Do a full weekly review. Restructure blocks before next Monday.' },
    ],
  },
];
