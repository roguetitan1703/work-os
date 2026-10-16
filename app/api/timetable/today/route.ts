import { NextResponse } from "next/server";
import { SCHEDULE, getCurrentBlock, getModeForDay } from "@/lib/schedule";

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri";

function weekdayKey(d: Date): Weekday {
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const k = map[d.getDay()];
  if (k === "sun" || k === "sat") return "mon"; // fallback for weekends
  return k;
}

export async function GET() {
  const now = new Date();
  const wk = weekdayKey(now);

  const scheduleToday = SCHEDULE.map((blk) => ({
    ...blk,
    mode: getModeForDay(blk, wk),
  }));

  const currentBlock = getCurrentBlock(now);

  return NextResponse.json({
    date: now.toISOString(),
    weekday: wk,
    schedule: scheduleToday,
    currentBlock: currentBlock,
  });
}
