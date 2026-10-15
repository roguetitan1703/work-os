'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { ArchiveRestore } from 'lucide-react';
import { setArchivedAction } from '@/app/actions';
import { Button } from '@/components/ui/button';

/** Restore an archived task in one tap; the toast has Undo (archives it again). */
export function UnarchiveButton({ id, taskRef }: { id: string; taskRef: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function set(archived: boolean) {
    start(async () => {
      const res = await setArchivedAction(id, archived);
      if (!res.ok) return void toast.error(res.error);
      if (archived) toast.success(`Archived #${taskRef} again`);
      else toast.success(`Restored #${taskRef}`, { duration: 8000, action: { label: 'Undo', onClick: () => set(true) } });
      router.refresh();
    });
  }

  return (
    <Button size="xs" variant="outline" className="gap-1 shrink-0 max-md:h-11 max-md:px-4 max-md:text-sm" disabled={pending} onClick={() => set(false)}>
      <ArchiveRestore className="w-3 h-3" /> Restore
    </Button>
  );
}
