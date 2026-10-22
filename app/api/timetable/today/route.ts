import { NextResponse } from "next/server";
import { SCHEDULE, getCurrentBlock, getModeForDay } from "@/lib/schedule";
import { callerFromRequest } from "@/lib/caller";
import { isOperator } from "@/lib/operator";

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri";

function weekdayKey(d: Date): Weekday {
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
  const k = map[d.getDay()];
  if (k === "sun" || k === "sat") return "mon"; // fallback for weekends
  return k;
}

export async function GET(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date();
  const wk = weekdayKey(now);
  // The built-in schedule is Om's own week: until each person has their own (phase 3), only the operator gets it.
  if (!isOperator(caller)) return NextResponse.json({ date: now.toISOString(), weekday: wk, schedule: [], currentBlock: null });

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
