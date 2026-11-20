import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Icon-only button: 44px touch target on phones, 36px from md. `label` is required (aria-label and tooltip). */
export function IconButton({ label, children, className, variant = 'ghost', ...rest }: { label: string } & Omit<React.ComponentProps<typeof Button>, 'size' | 'aria-label'>) {
  return (
    <Button variant={variant} size="icon-touch" aria-label={label} title={label} className={cn('text-muted-foreground hover:text-foreground', className)} {...rest}>
      {children}
    </Button>
  );
}
