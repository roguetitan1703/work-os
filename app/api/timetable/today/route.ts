import { NextResponse } from "next/server";
import { SCHEDULE, getCurrentBlock, getModeForDay } from "@/lib/schedule";

function weekdayKey(d: Date) {
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const k = map[d.getDay()];
  if (["mon", "tue", "wed", "thu", "fri"].includes(k)) return k as any;
  return "mon" as any; // fallback for weekends
}

export async function GET() {
  const now = new Date();
  const wk = weekdayKey(now);

  const scheduleToday = SCHEDULE.map((blk) => ({
    ...blk,
    mode: getModeForDay(blk as any, wk),
  }));

  const currentBlock = getCurrentBlock(now);

  return NextResponse.json({
    date: now.toISOString(),
    weekday: wk,
    schedule: scheduleToday,
    currentBlock: currentBlock,
  });
}
