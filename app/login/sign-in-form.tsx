'use client';

import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { authClient, authError } from '@/lib/auth-client';

const field =
  'w-full h-12 rounded-xl border border-input bg-background dark:bg-input/30 px-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = 'w-full h-12 rounded-xl bg-primary text-primary-foreground text-[15px] font-semibold active:opacity-80 hover:bg-primary/90 disabled:opacity-60';
const textBtn = 'underline underline-offset-2 inline-flex items-center min-h-11 text-[13px] text-muted-foreground';

type Step = 'password' | 'code' | 'forgot' | 'sent';

/** Email + password, then the authenticator code when it is on. Passkey button and passkey autofill. Forgot password. */
export function SignInForm({ next, start, resetDone }: { next: string; start: 'password' | 'forgot'; resetDone: boolean }) {
  const [step, setStep] = useState<Step>(start);
  // Fields are read from the form on submit (not React state), so text typed before the page finished loading counts;
  // the buttons stay disabled until then, so the form never posts the old-fashioned way (password in the URL).
  const [ready, setReady] = useState(false);
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  const autofillStarted = useRef(false);

  const done = () => window.location.assign(next);
  const go = (s: Step) => {
    setStep(s);
    setError(null);
  };
  const val = (e: React.FormEvent<HTMLFormElement>, k: string) => String(new FormData(e.currentTarget).get(k) ?? '');

  useEffect(() => {
    const t = setTimeout(async () => {
      setReady(true);
      if (typeof window === 'undefined' || !window.PublicKeyCredential) return;
      setPasskeys(true);
      // Passkeys offered in the email field's autofill where the browser supports it.
      const cma = (PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }).isConditionalMediationAvailable;
      if (!autofillStarted.current && cma && (await cma().catch(() => false))) {
        autofillStarted.current = true;
        const r = await authClient.signIn.passkey({ autoFill: true }).catch(() => null);
        if (r && !r.error) window.location.assign(next);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [next]);

  async function signIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = val(e, 'email').trim();
    const password = val(e, 'password');
    setBusy(true);
    setError(null);
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) return setError(r.error.status === 401 ? 'Wrong email or password.' : authError(r.error));
    if ((r.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return go('code');
    done();
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const c = val(e, 'code').trim();
    setBusy(true);
    setError(null);
    const r = backup ? await authClient.twoFactor.verifyBackupCode({ code: c }) : await authClient.twoFactor.verifyTotp({ code: c });
    setBusy(false);
    if (r.error) return setError(r.error.status === 401 ? 'Wrong code.' : authError(r.error, 'Wrong code.'));
    done();
  }

  async function passkey() {
    setBusy(true);
    setError(null);
    const r = await authClient.signIn.passkey().catch(() => null);
    setBusy(false);
    if (r && !r.error) return done();
    const m = r?.error?.message ?? '';
    if (!/cancel|abort|not allowed/i.test(m)) setError('Passkey sign-in did not work on this device. Use your password.');
  }

  async function forgot(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = val(e, 'email').trim();
    setBusy(true);
    setError(null);
    const r = await authClient.requestPasswordReset({ email, redirectTo: '/login/reset' });
    setBusy(false);
    if (r.error && r.error.status === 429) return setError(authError(r.error));
    setStep('sent');
  }

  if (step === 'forgot' || step === 'sent')
    return (
      <>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reset password</h1>
          <p className="text-[15px] text-muted-foreground mt-1">We will email a reset link to your address. The link works once, for 15 minutes.</p>
        </div>
        {step === 'sent' ? (
          <p role="status" className="text-[15px] text-foreground">
            If there is an account for that address, a reset link is on its way. Check your inbox (and spam).
          </p>
        ) : (
          <form method="post" action="/login" onSubmit={forgot} className="space-y-3">
            <input name="email" type="email" className={field} placeholder="Email" required autoFocus autoComplete="email" aria-label="Email" />
            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <button type="submit" className={primary} disabled={busy || !ready}>
              Email me a reset link
            </button>
          </form>
        )}
        <button type="button" className={textBtn} onClick={() => go('password')}>
          Back to sign in
        </button>
      </>
    );

  if (step === 'code')
    return (
      <>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Work OS</h1>
          <p className="text-[15px] text-muted-foreground mt-1">{backup ? 'Enter one of your backup codes.' : 'Enter the code from your authenticator app.'}</p>
        </div>
        <form method="post" action="/login" onSubmit={verify} className="space-y-3">
          <input
            name="code"
            className={`${field} tracking-widest text-center text-lg`}
            placeholder={backup ? 'Backup code' : '123456'}
            inputMode={backup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            key={backup ? 'backup' : 'app'}
            autoFocus
            required
            maxLength={20}
            aria-label={backup ? 'Backup code' : 'Authenticator code'}
          />
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <button type="submit" className={primary} disabled={busy || !ready}>
            Verify
          </button>
        </form>
        <div className="flex flex-wrap gap-x-4">
          <button
            type="button"
            className={textBtn}
            onClick={() => {
              setBackup(!backup);
              setError(null);
            }}
          >
            {backup ? 'Use the app code' : 'Lost your phone? Use a backup code'}
          </button>
          <button type="button" className={textBtn} onClick={() => go('password')}>
            Start over
          </button>
        </div>
      </>
    );

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold text-foreground">Work OS</h1>
        <p className="text-[15px] text-muted-foreground mt-1">Sign in to continue.</p>
      </div>
      <form method="post" action="/login" onSubmit={signIn} className="space-y-3">
        <input name="email" type="email" className={field} placeholder="Email" required autoFocus autoComplete="username webauthn" aria-label="Email" />
        <input name="password" type="password" className={field} placeholder="Password" required autoComplete="current-password webauthn" aria-label="Password" />
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {!error && resetDone && (
          <p role="status" className="text-sm text-green-700 dark:text-green-400">
            Password changed. Sign in with your new password.
          </p>
        )}
        <button type="submit" className={primary} disabled={busy || !ready}>
          Sign in
        </button>
        <button type="button" className={textBtn} onClick={() => go('forgot')}>
          Forgot password?
        </button>
      </form>
      {passkeys && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            onClick={passkey}
            disabled={busy}
            className="w-full h-12 rounded-xl border border-border bg-background text-[15px] font-medium flex items-center justify-center gap-2 active:bg-muted/60 hover:bg-muted/40 disabled:opacity-60"
          >
            <KeyRound className="w-5 h-5" />
            {busy ? 'Waiting…' : 'Sign in with passkey'}
          </button>
        </div>
      )}
    </>
  );
}
