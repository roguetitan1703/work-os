'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authClient, authError } from '@/lib/auth-client';

const MIN = 10;
const field =
  'w-full h-12 rounded-xl border border-input bg-background dark:bg-input/30 px-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = 'w-full h-12 rounded-xl bg-primary text-primary-foreground text-[15px] font-semibold active:opacity-80 hover:bg-primary/90 disabled:opacity-60 flex items-center justify-center';
const textLink = 'underline underline-offset-2 inline-flex items-center min-h-11 text-[13px] text-muted-foreground';

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(!token);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN) return setError(`Use at least ${MIN} characters.`);
    if (password !== again) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    const r = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (r.error) {
      if (/token/i.test(r.error.message ?? '')) return setBad(true);
      return setError(authError(r.error));
    }
    window.location.assign('/login?reset=done');
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold text-foreground">New password</h1>
        <p className="text-[15px] text-muted-foreground mt-1">
          {bad ? 'This reset link is invalid, expired or already used.' : 'Choose a new password. Every signed-in device will be signed out.'}
        </p>
      </div>
      {bad ? (
        <Link href="/login?step=forgot" className={primary}>
          Ask for a new link
        </Link>
      ) : (
        <form method="post" action="/login/reset" onSubmit={submit} className="space-y-3">
          <input type="password" className={field} placeholder={`New password (${MIN}+ characters)`} value={password} onChange={e => setPassword(e.target.value)} autoFocus required minLength={MIN} maxLength={256} autoComplete="new-password" aria-label="New password" />
          <input type="password" className={field} placeholder="New password again" value={again} onChange={e => setAgain(e.target.value)} required minLength={MIN} maxLength={256} autoComplete="new-password" aria-label="New password again" />
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <button type="submit" className={primary} disabled={busy || !ready}>
            Set new password
          </button>
        </form>
      )}
      <Link href="/login" className={textLink}>
        Back to sign in
      </Link>
    </>
  );
}
