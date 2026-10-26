"use client";

import { useSyncExternalStore } from "react";
import { currentBlock } from "@/lib/schedule";
import { useApp, useModes } from "@/components/app-context";
import { useTheme } from "next-themes";

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

/** The desktop bar at the bottom: the person's current block in their own timezone. Nothing without a schedule. */
export function CurrentBlockBar() {
  const now = useSyncExternalStore(subscribeMinute, getNow, () => null);
  const { theme } = useTheme();
  const { plan, tz } = useApp();
  const { color } = useModes();

  if (!plan) return null;
  if (!now) {
    return (
      <div data-block-bar className="hidden md:flex fixed bottom-0 left-0 right-0 h-10 bg-gray-100 dark:bg-black border-t border-gray-200 dark:border-gray-700 items-center px-4 text-xs text-gray-400 dark:text-gray-500 z-50">
        Loading…
      </div>
    );
  }

  const live = currentBlock(plan.blocks, now, tz);
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz });

  if (!live) {
    return (
      <div data-block-bar className="hidden md:flex fixed bottom-0 left-0 right-0 h-10 bg-gray-100 dark:bg-black border-t border-gray-200 dark:border-gray-700 items-center px-4 gap-4 text-xs text-gray-500 dark:text-gray-400 z-50">
        <span className="font-mono">{timeStr}</span>
        <span>Off-schedule</span>
      </div>
    );
  }

  const modeName = live.block.modes[live.weekday];
  const c = color(modeName);

  return (
    <div
      data-block-bar
      className="hidden md:flex fixed bottom-0 left-0 right-0 h-10 border-t items-center px-4 gap-4 text-xs font-medium z-50"
      style={{
        backgroundColor: theme === "dark" ? "black" : c.light,
        borderColor: c.hex + "40",
        color: theme === "dark" ? "white" : c.hex,
      }}
    >
      <span className="font-mono">{timeStr}</span>
      <span className="font-semibold">{live.block.block}</span>
      <span>·</span>
      <span>{modeName}</span>
    </div>
  );
}
