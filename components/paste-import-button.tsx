'use client';

import { useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasteImportDialog } from '@/components/paste-import';

export function PasteImportButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <ClipboardPaste className="w-3.5 h-3.5" />
        Paste Import
      </Button>
      <PasteImportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
