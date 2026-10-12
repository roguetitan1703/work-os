export type ScheduleBlock = {
  start: string;
  end: string;
  block: string;
  duration: string;
  modes: {
    mon: string;
    tue: string;
    wed: string;
    thu: string;
    fri: string;
  };
  notes: string;
};

export const SCHEDULE: ScheduleBlock[] = [
  {
    start: "10:00",
    end: "10:20",
    block: "Morning Setup",
    duration: "20 min",
    modes: {
      mon: "Setup/Close",
      tue: "Setup/Close",
      wed: "Setup/Close",
      thu: "Setup/Close",
      fri: "Setup/Close",
    },
    notes:
      "Open TODAY tab. Read the schedule. Pick 3 P1s. Update Last Touched. Start the day clean.",
  },
  {
    start: "10:20",
    end: "11:50",
    block: "Morning Anchor",
    duration: "90 min",
    modes: {
      mon: "Code & Dev",
      tue: "Code & Dev",
      wed: "Code & Dev",
      thu: "Code & Dev",
      fri: "Code & Dev",
    },
    notes:
      "Sacred deep work. Hardest code, deployments, bug fixes, architecture, technical R&D.",
  },
  {
    start: "11:50",
    end: "12:35",
    block: "Fiverr Ritual",
    duration: "45 min",
    modes: {
      mon: "Outreach & Sales",
      tue: "Outreach & Sales",
      wed: "Outreach & Sales",
      thu: "Outreach & Sales",
      fri: "Outreach & Sales",
    },
    notes:
      "Fiverr brief-applying, Fiverr lead replies, platform presence, inbound handling.",
  },
  {
    start: "12:35",
    end: "12:45",
    block: "Buffer",
    duration: "10 min",
    modes: {
      mon: "Personal",
      tue: "Personal",
      wed: "Personal",
      thu: "Personal",
      fri: "Personal",
    },
    notes: "Stand up. Water. Reset. No scrolling.",
  },
  {
    start: "12:45",
    end: "13:05",
    block: "Meeting Prep / Founder Decisions Prep",
    duration: "20 min",
    modes: {
      mon: "Founder Decisions",
      tue: "Founder Decisions",
      wed: "Founder Decisions",
      thu: "Founder Decisions",
      fri: "Founder Decisions",
    },
    notes:
      "Prep for client calls or partner discussion. Review notes, open docs, decide what must be resolved today.",
  },
  {
    start: "13:05",
    end: "15:05",
    block: "Meetings Window / Founder Decisions",
    duration: "2 hr (HARD CAP)",
    modes: {
      mon: "Founder Decisions",
      tue: "Founder Decisions",
      wed: "Founder Decisions",
      thu: "Founder Decisions",
      fri: "Founder Decisions",
    },
    notes:
      "Client meetings, discovery calls, handovers, and partner decisions. If no meeting, use this for founder decisions with your partner.",
  },
  {
    start: "15:05",
    end: "16:05",
    block: "Lunch + Movement",
    duration: "60 min",
    modes: {
      mon: "Personal",
      tue: "Personal",
      wed: "Personal",
      thu: "Personal",
      fri: "Personal",
    },
    notes: "Eat properly. Walk 20 min minimum. Non-negotiable.",
  },
  {
    start: "16:05",
    end: "17:05",
    block: "Team Direction Block",
    duration: "60 min",
    modes: {
      mon: "Team Direction",
      tue: "Team Direction",
      wed: "Team Direction",
      thu: "Team Direction",
      fri: "Team Direction",
    },
    notes:
      "Review intern work, portfolio drafts, content plans, design requests, and assign next tasks.",
  },
  {
    start: "17:05",
    end: "17:15",
    block: "Buffer",
    duration: "10 min",
    modes: {
      mon: "Personal",
      tue: "Personal",
      wed: "Personal",
      thu: "Personal",
      fri: "Personal",
    },
    notes: "Mode reset. Tea, water, no inputs.",
  },
  {
    start: "17:15",
    end: "18:45",
    block: "Client Delivery Block",
    duration: "90 min",
    modes: {
      mon: "Client Delivery",
      tue: "Client Delivery",
      wed: "Client Delivery",
      thu: "Client Delivery",
      fri: "Client Delivery",
    },
    notes:
      "Proposals, scoping docs, status updates, handover prep, replies on active client threads.",
  },
  {
    start: "18:45",
    end: "19:45",
    block: "Growth / R&P Block",
    duration: "60 min",
    modes: {
      mon: "Growth",
      tue: "Research & Planning",
      wed: "Growth",
      thu: "Research & Planning",
      fri: "Growth",
    },
    notes:
      "IDEX portals, partnership work, positioning, content systems, portfolio templates, strategic R&D.",
  },
  {
    start: "19:45",
    end: "20:00",
    block: "Snack + Decompress",
    duration: "15 min",
    modes: {
      mon: "Personal",
      tue: "Personal",
      wed: "Personal",
      thu: "Personal",
      fri: "Personal",
    },
    notes: "Break from screens. Keep it light.",
  },
  {
    start: "20:00",
    end: "21:00",
    block: "Outreach & Sales",
    duration: "60 min",
    modes: {
      mon: "Outreach & Sales",
      tue: "Outreach & Sales",
      wed: "Outreach & Sales",
      thu: "Outreach & Sales",
      fri: "Outreach & Sales",
    },
    notes:
      "Cold outreach, lead follow-up, discovery-call booking, referrals, expansion selling, non-Fiverr lead conversion.",
  },
  {
    start: "21:00",
    end: "22:30",
    block: "Late-Night Build",
    duration: "90 min",
    modes: {
      mon: "Code & Dev",
      tue: "Code & Dev",
      wed: "Code & Dev",
      thu: "Code & Dev",
      fri: "Code & Dev",
    },
    notes:
      "Quiet deep work. Code, fixes, deployments, scripts, technical execution, high-focus R&D.",
  },
  {
    start: "22:30",
    end: "22:45",
    block: "Comms 2",
    duration: "15 min",
    modes: {
      mon: "Client Delivery",
      tue: "Client Delivery",
      wed: "Founder Decisions",
      thu: "Client Delivery",
      fri: "Client Delivery",
    },
    notes:
      "Close loops, send quick replies, confirm tomorrow's questions. Wednesday: mid-week founder check.",
  },
  {
    start: "23:05",
    end: "00:00",
    block: "Dinner",
    duration: "55 min",
    modes: {
      mon: "Personal",
      tue: "Personal",
      wed: "Personal",
      thu: "Personal",
      fri: "Personal",
    },
    notes: "Eat properly. No work.",
  },
  {
    start: "00:00",
    end: "00:15",
    block: "Day Close",
    duration: "15 min",
    modes: {
      mon: "Setup/Close",
      tue: "Setup/Close",
      wed: "Setup/Close",
      thu: "Setup/Close",
      fri: "Setup/Close",
    },
    notes:
      "Mark done, update Last Touched, log expenses/admin items, generate invoices, set tomorrow's 3 P1s.",
  },
];

export function getCurrentBlock(
  now: Date = new Date(),
  allowWeekend = false,
): ScheduleBlock | null {
  const day = now.getDay();

  if (!allowWeekend && (day === 0 || day === 6)) return null;

  let dayKey = (["", "mon", "tue", "wed", "thu", "fri"] as const)[day];

  if (!dayKey && allowWeekend) {
    // map weekend → weekday schedule
    dayKey = "mon"; // or "fri" depending on your preference
  }

  if (!dayKey) return null;

  const minutesNow = now.getHours() * 60 + now.getMinutes();

  for (const blk of SCHEDULE) {
    const [sh, sm] = blk.start.split(":").map(Number);
    const [eh, em] = blk.end.split(":").map(Number);
    const startMin = sh * 60 + sm;
    let endMin = eh * 60 + em;

    if (endMin <= startMin) endMin += 24 * 60;

    let nowAdjusted = minutesNow;
    if (startMin > 23 * 60 && minutesNow < 6 * 60) {
      nowAdjusted += 24 * 60;
    }

    if (nowAdjusted >= startMin && nowAdjusted < endMin) {
      return blk;
    }
  }

  return null;
}

export function getModeForDay(
  blk: ScheduleBlock,
  weekday: "mon" | "tue" | "wed" | "thu" | "fri",
): string {
  return blk.modes[weekday];
}
