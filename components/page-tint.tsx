'use client';

import { useEffect, useState } from 'react';
import { currentBlock } from '@/lib/schedule';
import { useApp, useModes } from '@/components/app-context';

/** Desktop background tint in the colour of the person's current block (none without a schedule). */
export function PageTint() {
  const [color, setColor] = useState<{ hex: string; light: string } | null>(null);
  const { plan, tz } = useApp();
  const { color: colorFor } = useModes();

  useEffect(() => {
    function update() {
      const live = plan ? currentBlock(plan.blocks, new Date(), tz) : null;
      if (!live) {
        setColor(null);
        return;
      }
      const c = colorFor(live.block.modes[live.weekday]);
      setColor({ hex: c.hex, light: c.light });
    }
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [plan, tz, colorFor]);

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
