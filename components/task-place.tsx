'use client';

import { createContext, useContext } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type PlaceOut = { kind: 'now' | 'next' | 'later'; label: string };
const Places = createContext<Record<string, PlaceOut>>({});

/** A page gives its task rows where each task sits in its project's State (taskId to place); rows outside one show no chip. */
export function PlacesProvider({ places, children }: { places: Record<string, PlaceOut>; children: React.ReactNode }) {
  return <Places.Provider value={places}>{children}</Places.Provider>;
}

/** "Now", "Next 2" or "Later" on a task row. Now takes the accent; Next and Later stay muted. Nothing when the task is in none. */
export function PlaceChip({ place, className }: { place: PlaceOut | null | undefined; className?: string }) {
  if (!place) return null;
  return (
    <Badge
      variant="secondary"
      data-place-chip={place.kind}
      title={place.kind === 'now' ? "This is the project's Now" : place.kind === 'next' ? `On the project's ${place.label} line` : "On the project's Later list"}
      className={cn('h-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]', place.kind === 'now' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground', className)}
    >
      {place.label}
    </Badge>
  );
}

export function TaskPlaceChip({ taskId, className }: { taskId: string; className?: string }) {
  return <PlaceChip place={useContext(Places)[taskId]} className={className} />;
}
