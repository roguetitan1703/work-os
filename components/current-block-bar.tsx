"use client";

import { useSyncExternalStore } from "react";
import { getCurrentBlock } from "@/lib/schedule";
import { getBlockColor } from "@/lib/modes";
import { useTheme } from "next-themes";

function getWeekday(date: Date): "mon" | "tue" | "wed" | "thu" | "fri" | null {
  const keys = [null, "mon", "tue", "wed", "thu", "fri", null] as const;
  return keys[date.getDay()] ?? null;
}

// Ticks once a minute; null on the server and first render so markup matches hydration.
function subscribeMinute(cb: () => void) {
  const id = setInterval(cb, 60_000);
  return () => clearInterval(id);
}
// Snapshot must be stable between ticks, so cache the Date per minute.
let cached: { minute: number; date: Date } | null = null;
function getNow(): Date {
  const minute = Math.floor(Date.now() / 60_000);
  if (!cached || cached.minute !== minute) cached = { minute, date: new Date() };
  return cached.date;
}

export function CurrentBlockBar() {
  const now = useSyncExternalStore(subscribeMinute, getNow, () => null);
  const { theme } = useTheme();

  if (!now) {
    return (
      <div className="hidden md:flex fixed bottom-0 left-0 right-0 h-10 bg-gray-100 dark:bg-black border-t border-gray-200 dark:border-gray-700 items-center px-4 text-xs text-gray-400 dark:text-gray-500 z-50">
        Loading…
      </div>
    );
  }

  const block = getCurrentBlock(now);
  const weekday = getWeekday(now);
  const timeStr = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (!block || !weekday) {
    return (
      <div className="hidden md:flex fixed bottom-0 left-0 right-0 h-10 bg-gray-100 dark:bg-black border-t border-gray-200 dark:border-gray-700 items-center px-4 gap-4 text-xs text-gray-500 dark:text-gray-400 z-50">
        <span className="font-mono">{timeStr}</span>
        <span>Off-schedule</span>
      </div>
    );
  }

  const modeName = block.modes[weekday];
  const color = getBlockColor(modeName);

  return (
    <div
      className="hidden md:flex fixed bottom-0 left-0 right-0 h-10 border-t items-center px-4 gap-4 text-xs font-medium z-50"
      style={{
        backgroundColor: theme === "dark" ? "black" : color.light,
        borderColor: color.hex + "40",
        color: theme === "dark" ? "white" : color.hex,
      }}
    >
      <span className="font-mono">{timeStr}</span>
      <span className="font-semibold">{block.block}</span>
      <span>·</span>
      <span>{modeName}</span>
      <span>·</span>
      <span className="font-mono">RGB({color.rgb})</span>
    </div>
  );
}
