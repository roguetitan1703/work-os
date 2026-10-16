'use client';

import { fmtAgo } from '@/lib/format';

/** Relative time ("3 minutes ago") in its own text node: the server and the browser can be a minute apart, so the mismatch is ignored here and nowhere else. */
export function Ago({ iso, prefix = '' }: { iso: string; prefix?: string }) {
  return <span suppressHydrationWarning>{`${prefix}${fmtAgo(iso)}`}</span>;
}
