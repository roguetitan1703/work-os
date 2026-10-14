'use client';

import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';
import { passkeyLoginAction, passkeyOptionsAction } from './actions';

/** "Sign in with passkey" button, plus passkey suggestions in the password field's autofill where supported. */
export function PasskeySignIn({ next, autofill }: { next: string; autofill: boolean }) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(useAutofill: boolean) {
    if (!useAutofill) {
      setBusy(true);
      setError(null);
    }
    try {
      const opts = await passkeyOptionsAction();
      if (!opts.ok) {
        if (!useAutofill) setError(opts.error);
        return;
      }
      const response = await startAuthentication({ optionsJSON: opts.data, useBrowserAutofill: useAutofill });
      setBusy(true);
      const r = await passkeyLoginAction(response, next);
      if (r.ok) {
        window.location.assign(r.data);
        return;
      }
      setError(r.error);
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      // AbortError: autofill prompt replaced by the button. NotAllowedError: user cancelled.
      if (!useAutofill && name !== 'AbortError' && name !== 'NotAllowedError') setError('Passkey sign-in did not work on this device. Use your password.');
    }
    setBusy(false);
  }

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (!browserSupportsWebAuthn()) return;
      setSupported(true);
      if (autofill && (await browserSupportsWebAuthnAutofill()) && alive) void run(true);
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
      WebAuthnAbortService.cancelCeremony();
    };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!supported) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <button
        type="button"
        onClick={() => run(false)}
        disabled={busy}
        className="w-full h-12 rounded-xl border border-border bg-background text-[15px] font-medium flex items-center justify-center gap-2 active:bg-muted/60 hover:bg-muted/40 disabled:opacity-60"
      >
        <KeyRound className="w-5 h-5" />
        {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
