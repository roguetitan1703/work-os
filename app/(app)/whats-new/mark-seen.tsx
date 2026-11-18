'use client';

import { useEffect } from 'react';
import { markWhatsNewSeenAction } from './actions';

/** Opening What's new marks every entry seen (the nav dot and Today's card go), like opening the Inbox marks it read. */
export function MarkSeen() {
  useEffect(() => {
    const t = setTimeout(() => void markWhatsNewSeenAction().catch(() => null), 1500);
    return () => clearTimeout(t);
  }, []);
  return null;
}
