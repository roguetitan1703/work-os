import { NextResponse } from "next/server";
import { callerFromRequest } from "@/lib/caller";
import { clockInTz } from "@/lib/dates";
import { currentBlock, weekdayKey } from "@/lib/schedule";
import { getSchedule } from "@/lib/user-schedule";

// The caller's own schedule for today, in their timezone (weekends use Monday's, as before). Empty without one.
export async function GET(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = new Date();
  const wk = weekdayKey(clockInTz(now, caller.tz).weekday) ?? "mon";
  const { blocks } = await getSchedule(caller);
  return NextResponse.json({
    date: now.toISOString(),
    timezone: caller.tz,
    weekday: wk,
    schedule: blocks.map(blk => ({ ...blk, mode: blk.modes[wk] })),
    currentBlock: currentBlock(blocks, now, caller.tz)?.block.block ?? null,
  });
}
