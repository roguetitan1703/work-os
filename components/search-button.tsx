'use client';

import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openSearch } from '@/components/global-search';
import type { Kind } from '@/lib/search/match';
import { cn } from '@/lib/utils';

/** A list's search: opens the global search with that kind chosen (the lists keep their other filters, not a text box). */
export function SearchButton({ kind, label, className, ...rest }: { kind: Kind; label: string; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Button variant="outline" size="lg" onClick={() => openSearch(kind)} className={cn('h-9 text-sm font-normal text-muted-foreground', className)} {...rest}>
      <Search /> {label}
    </Button>
  );
}
