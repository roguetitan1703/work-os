'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { createProjectAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FullSheet } from '@/components/mobile/full-sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { delpatOsStatusAction } from './delpat-os-actions';
import { DelpatOsPicker } from './delpat-os-picker';
import { SharingChoice, SHARING_HELP, type Sharing } from './sharing-choice';

export function NewProjectButton() {
  const router = useRouter();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Sharing>('org');
  const [pending, start] = useTransition();
  // "From Delpat OS" shows only where this Work OS has it set up (asked when the dialog opens).
  const [delpat, setDelpat] = useState<{ enabled: boolean; linked: boolean }>({ enabled: false, linked: false });
  const [mode, setMode] = useState<'new' | 'delpat'>('new');
  useEffect(() => {
    if (!open) return;
    void delpatOsStatusAction().then(r => r.ok && setDelpat({ enabled: r.data.enabled, linked: r.data.linked }));
  }, [open]);
  const openIt = () => {
    setMode('new');
    setOpen(true);
  };
  const imported = (id: string) => {
    setOpen(false);
    router.push(`/projects/${id}`);
  };
  const modeTabs = delpat.enabled && (
    <div className="flex gap-1 rounded-full bg-muted p-1 text-sm" role="tablist" data-new-project-mode>
      {(['new', 'delpat'] as const).map(m => (
        <button key={m} type="button" role="tab" aria-selected={mode === m} data-mode={m} onClick={() => setMode(m)} className={`flex-1 h-9 rounded-full font-medium ${mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>
          {m === 'new' ? 'Create new' : 'From Delpat OS'}
        </button>
      ))}
    </div>
  );
  const picker = <DelpatOsPicker linked={delpat.linked} onImported={imported} onClose={() => setOpen(false)} />;

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!name.trim()) return;
    start(async () => {
      const res = await createProjectAction({ name, client, description, visibility });
      if (!res.ok) return void toast.error(res.error);
      if (!res.data.created) toast.info(`"${res.data.project.name}" already exists`);
      setOpen(false);
      router.push(`/projects/${res.data.project.id}`);
    });
  }

  const fieldCls = 'h-12 text-[16px]';
  return (
    <>
      <button
        onClick={openIt}
        aria-label="New project"
        className="md:hidden w-11 h-11 rounded-full bg-foreground text-background flex items-center justify-center active:scale-95 transition-transform"
      >
        <Plus className="w-5 h-5" strokeWidth={2.4} />
      </button>
      <Button size="sm" className="hidden md:inline-flex gap-1.5" onClick={openIt}>
        <Plus className="w-3.5 h-3.5" /> New project
      </Button>
      {phone ? (
        open && (
          <FullSheet
            title="New project"
            onClose={() => setOpen(false)}
            footer={mode === 'delpat' ? undefined : (
              <button
                onClick={() => submit()}
                disabled={pending || !name.trim()}
                className="w-full h-12 rounded-2xl bg-foreground text-background text-base font-semibold disabled:opacity-40 active:scale-[0.98] transition-transform"
              >
                Create project
              </button>
            )}
          >
            {modeTabs}
            {mode === 'delpat' ? picker : (
            <form onSubmit={submit} className="space-y-3">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" required autoFocus className={fieldCls} />
              <Input value={client} onChange={e => setClient(e.target.value)} placeholder="Client (optional)" className={fieldCls} />
              <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What is it, what does done look like?" rows={5} className="text-[16px]" />
              <SharingChoice value={visibility} onChange={setVisibility} />
              <p className="text-xs text-muted-foreground" data-sharing-help>{SHARING_HELP}</p>
            </form>
            )}
          </FullSheet>
        )
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>New project</DialogTitle>
            </DialogHeader>
            {modeTabs}
            {mode === 'delpat' ? picker : (
            <form onSubmit={submit} className="space-y-3">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name" required autoFocus />
              <Input value={client} onChange={e => setClient(e.target.value)} placeholder="Client (optional)" />
              <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What is it, what does done look like?" rows={3} />
              <SharingChoice value={visibility} onChange={setVisibility} />
              <p className="text-xs text-muted-foreground" data-sharing-help>{SHARING_HELP}</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !name.trim()}>
                  Create
                </Button>
              </div>
            </form>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
