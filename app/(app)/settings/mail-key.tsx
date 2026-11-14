'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { removeMailKeyAction, saveMailKeyAction, testMailKeyAction } from './mail-actions';

const btn = 'inline-flex items-center justify-center h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50';
const ghost = cn(btn, 'border border-border bg-card text-foreground hover:bg-muted/60');

/** Your own Mailloom key: paste, Test (asks Mailloom who it is), Remove. The key is never shown again, only its prefix. */
export function MailKey({ link }: { link: { prefix: string; email: string } | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<string | null>(null);

  if (link) {
    return (
      <div className="mt-2 space-y-2" data-mail-linked>
        <p className="text-[13px] text-foreground" data-mail-mailbox>
          Mailbox <b>{link.email}</b>, key <code>{link.prefix}…</code>
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={ghost}
            disabled={pending}
            data-mail-test
            onClick={() =>
              start(async () => {
                const r = await testMailKeyAction();
                setResult(r.ok ? `Works: this key opens ${r.data.email} (${r.data.scopes.join(', ')}).` : r.error);
              })
            }
          >
            Test
          </button>
          <button
            type="button"
            className={ghost}
            disabled={pending}
            data-mail-remove
            onClick={() =>
              start(async () => {
                const r = await removeMailKeyAction();
                if (!r.ok) return void toast.error(r.error);
                setResult(null);
                router.refresh();
              })
            }
          >
            Remove
          </button>
        </div>
        {result && (
          <p className="text-[13px]" role="status" data-mail-result>
            {result}
          </p>
        )}
      </div>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      data-mail-unlinked
      onSubmit={e => {
        e.preventDefault();
        start(async () => {
          const r = await saveMailKeyAction(value);
          if (!r.ok) return void setResult(r.error);
          setValue('');
          setResult(null);
          router.refresh();
        });
      }}
    >
      <label className="sr-only" htmlFor="mail-key">
        Mailloom key
      </label>
      <input
        id="mail-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="mlk_…"
        value={value}
        onChange={e => setValue(e.target.value)}
        className="h-11 md:h-9 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-base md:text-sm"
        data-mail-input
      />
      <button type="submit" className={cn(btn, 'bg-foreground text-background hover:bg-foreground/90')} disabled={pending || !value.trim()} data-mail-save>
        Save
      </button>
      {result && (
        <p className="basis-full text-[13px] text-destructive" role="alert" data-mail-result>
          {result}
        </p>
      )}
    </form>
  );
}
