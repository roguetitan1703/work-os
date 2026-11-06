'use client';

import { useState } from 'react';

/**
 * Local state for an editable field that follows the server: when the page refreshes with a new value (a teammate's
 * or Claude's change, components/live-refresh.tsx), the field takes it, unless the person has changed the field
 * since the last value came in (their unsaved edit wins until they save or undo it).
 */
export function useSynced<T>(server: T): [T, (v: T) => void] {
  const [value, setValue] = useState(server);
  const [prev, setPrev] = useState(server);
  if (!Object.is(server, prev)) {
    setPrev(server);
    if (Object.is(value, prev)) setValue(server);
  }
  return [value, setValue];
}
