'use client';

import { useEffect, useState } from 'react';
import { Chip, ChipGroup } from '@/components/ui/chip';
import { FILTER_COOKIE, filterCookieValue, type SessionFilter } from '@/lib/session-item';

// Which sessions a Sessions list shows (Om, 21 Nov): by default the viewer's own active ones; "Everyone" adds teammates'
// sessions on shared projects, "Quiet and off" adds quiet and ended ones. Remembered per viewer in a cookie of this browser
// (FILTER_COOKIE), which the page reads on the server so the first paint is already filtered; shared by Today, the Claude page
// and project pages. Filtering: lib/session-item.ts filterSessions.

const EVENT = 'wos-sessions-filter';

/** The viewer's filter, starting from what the server read from the cookie (`initial`); a change is saved and reaches every list on the page. */
export function useSessionFilter(initial: SessionFilter): [SessionFilter, (f: SessionFilter) => void] {
  const [f, setF] = useState<SessionFilter>(initial);
  useEffect(() => {
    const on = (e: Event) => setF((e as CustomEvent<SessionFilter>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const set = (next: SessionFilter) => {
    setF(next);
    document.cookie = `${FILTER_COOKIE}=${filterCookieValue(next)}; path=/; max-age=31536000; samesite=lax`;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  };
  return [f, set];
}

/** The two filter chips. `more`: how many sessions each would add; a chip with nothing to add and not chosen is left out. */
export function SessionFilterChips({ filter, onChange, more, className }: { filter: SessionFilter; onChange: (f: SessionFilter) => void; more: { everyone: number; quiet: number }; className?: string }) {
  const showEveryone = filter.everyone || more.everyone > 0;
  const showQuiet = filter.quiet || more.quiet > 0;
  if (!showEveryone && !showQuiet) return null;
  const count = (n: number) => (n > 0 ? <span className="tabular-nums opacity-70">{n}</span> : null);
  return (
    <ChipGroup scroll label="Show sessions" className={className}>
      {showEveryone && (
        <Chip selected={filter.everyone} onClick={() => onChange({ ...filter, everyone: !filter.everyone })} data-session-filter="everyone">
          Everyone {count(more.everyone)}
        </Chip>
      )}
      {showQuiet && (
        <Chip selected={filter.quiet} onClick={() => onChange({ ...filter, quiet: !filter.quiet })} data-session-filter="quiet">
          Quiet and off {count(more.quiet)}
        </Chip>
      )}
    </ChipGroup>
  );
}
