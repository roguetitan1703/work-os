'use client';

import { BottomSheet } from '@/components/mobile/sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/** Bottom sheet on phones (data-sheet), centred dialog on desktop (BottomSheet alone is md:hidden). */
export function ResponsiveSheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const phone = usePhone();
  if (phone) return <BottomSheet title={title} onClose={onClose}>{children}</BottomSheet>;
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className={`${wide ? 'sm:max-w-lg' : 'sm:max-w-md'} max-h-[85dvh] overflow-y-auto block`}>
        <DialogTitle>{title}</DialogTitle>
        <div className="pt-3">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm sheet/dialog that names the thing and has a verb button (never a native confirm()). */
export function ConfirmSheet({ title, message, verb, danger, pending, onConfirm, onClose }: { title: string; message: React.ReactNode; verb: string; danger?: boolean; pending?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ResponsiveSheet title={title} onClose={onClose}>
      <div className="space-y-4 pt-1 pb-2">
        <p className="text-[16px] md:text-sm text-foreground">{message}</p>
        <div className="flex gap-2">
          <button type="button" className="h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-medium border border-border text-foreground disabled:opacity-50" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={`h-11 md:h-9 px-4 flex-1 rounded-full text-sm font-semibold disabled:opacity-50 ${danger ? 'bg-red-600 text-white' : 'bg-foreground text-background'}`} onClick={onConfirm} disabled={pending} data-confirm>
            {verb}
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
