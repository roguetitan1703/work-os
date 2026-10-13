'use client';

import { useEffect } from 'react';
import { markAllReadAction } from '../settings/actions';

/** Opening the inbox marks everything read (after it has been shown as new once). */
export function MarkRead() {
  useEffect(() => {
    const t = setTimeout(() => void markAllReadAction(), 1500);
    return () => clearTimeout(t);
  }, []);
  return null;
}
