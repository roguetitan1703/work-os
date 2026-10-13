'use client';

import { useEffect, useState } from 'react';
import { getCurrentBlock } from '@/lib/schedule';
import { getBlockColor } from '@/lib/modes';

function getWeekday(date: Date): 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | null {
  const keys = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null] as const;
  return keys[date.getDay()] ?? null;
}

export function PageTint() {
  const [color, setColor] = useState<{ hex: string; light: string } | null>(null);

  useEffect(() => {
    function update() {
      const now = new Date();
      const block = getCurrentBlock(now);
      const weekday = getWeekday(now);
      if (!block || !weekday) {
        setColor(null);
        return;
      }
      const modeName = block.modes[weekday];
      const c = getBlockColor(modeName);
      setColor({ hex: c.hex, light: c.light });
    }
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!color) return null;

  return (
    <div
      className="hidden md:block pointer-events-none fixed inset-0 z-0 transition-colors duration-1000"
      style={{
        background: `linear-gradient(135deg, ${color.light}60 0%, transparent 40%)`,
        borderLeft: `3px solid ${color.hex}40`,
      }}
      aria-hidden
    />
  );
}
