'use client';

import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

/** The Advanced fold at the bottom of Set up. Closed by default; "Choose it" in step 3 opens it (event wos:open-advanced). */
export function AdvancedFold({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const open = () => {
      const d = ref.current;
      if (!d) return;
      d.open = true;
      d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    window.addEventListener('wos:open-advanced', open);
    return () => window.removeEventListener('wos:open-advanced', open);
  }, []);
  return (
    <details ref={ref} id="advanced" data-advanced className="group rounded-2xl bg-card border border-border/70 overflow-hidden min-w-0">
      <summary className="flex items-center gap-3 px-4 min-h-14 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden active:bg-muted/60">
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-medium text-foreground">Advanced</span>
          <span className="block text-[13px] text-muted-foreground leading-snug truncate">Access keys, standing instructions, what a PC can do, prompts, tools</span>
        </span>
        <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180 shrink-0" />
      </summary>
      <div className="border-t border-border/60 px-4 py-4 space-y-5 min-w-0">{children}</div>
    </details>
  );
}
