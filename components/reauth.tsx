'use client';

import { useCallback, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { confirmPasswordAction } from '@/app/reauth-actions';
import { REAUTH_CODE, REAUTH_MESSAGE } from '@/lib/reauth-shared';

const field =
  'w-full h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold disabled:opacity-50';

/** True for the error a server action or /api/auth gives when the session is not fresh (lib/fresh.ts). */
export const needsReauth = (e: unknown): boolean => {
  if (typeof e === 'string') return e === REAUTH_MESSAGE;
  const o = e as { message?: string; code?: string } | null;
  return o?.code === REAUTH_CODE || o?.message === REAUTH_MESSAGE;
};

/**
 * Asks for the password when making a new credential (passkey, API key, computer) more than 10 minutes after
 * sign-in. `ask()` opens the dialog and resolves true once the password is confirmed, false if cancelled.
 * Render `dialog` once in the component.
 */
export type AskOptions = { text?: string; verb?: string; danger?: boolean };

export function useReauth(): { ask: () => Promise<boolean>; askPassword: (o?: AskOptions) => Promise<string | null>; dialog: React.ReactNode } {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<AskOptions>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = useRef<((pw: string | null) => void) | null>(null);

  const finish = (pw: string | null) => {
    setOpen(false);
    setError(null);
    done.current?.(pw);
    done.current = null;
  };

  // The one password prompt of the app. Resolves with the confirmed password (callers that must pass it on, like the
  // authenticator and password change, use it), or null when cancelled.
  const askPassword = useCallback(
    (o: AskOptions = {}) =>
      new Promise<string | null>(resolve => {
        done.current = resolve;
        setOpts(o);
        setError(null);
        setOpen(true);
      }),
    [],
  );
  const ask = useCallback(async () => (await askPassword()) !== null, [askPassword]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    setBusy(true);
    const r = await confirmPasswordAction(password);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    finish(password);
  }

  const dialog = (
    <Dialog open={open} onOpenChange={o => !o && finish(null)}>
      <DialogContent className="max-w-sm" data-reauth>
        <DialogHeader>
          <DialogTitle>Confirm it is you</DialogTitle>
          <DialogDescription>{opts.text ?? 'Enter your password. New keys, computers and passkeys need a sign-in in the last 10 minutes.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <input name="password" type="password" className={field} placeholder="Password" autoComplete="current-password" required autoFocus aria-label="Password" />
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={`${btn} border border-border`} onClick={() => finish(null)}>
              Cancel
            </button>
            <button type="submit" className={`${btn} ${opts.danger ? 'bg-red-600 text-white' : 'bg-foreground text-background'}`} disabled={busy}>
              {opts.verb ?? 'Confirm'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
  return { ask, askPassword, dialog };
}
