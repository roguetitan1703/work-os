import type { Metadata } from 'next';
import Link from 'next/link';
import { resetPasswordAction } from '../actions';
import { MIN_PASSWORD } from '@/lib/password';
import { resetTokenValid } from '@/lib/password-reset';
import { isTotpEnabled } from '@/lib/totp';
import { uiAuthConfigured } from '@/lib/auth';

// Opened from the reset email. proxy.ts lets exactly /login/reset through;
// the token is checked here (without using it up) and again, atomically, by
// resetPasswordAction.

type Props = { searchParams: Promise<{ token?: string; error?: string }> };

// The token is in the URL: never send it on as a Referer.
export const metadata: Metadata = { title: 'Reset password · Work OS', referrer: 'no-referrer', robots: { index: false, follow: false } };

const ERRORS: Record<string, string> = {
  short: `Use at least ${MIN_PASSWORD} characters.`,
  long: 'That password is too long.',
  mismatch: 'The two passwords do not match.',
  code: 'Wrong code. Use the 6-digit code from your authenticator app, or a recovery code.',
  locked: 'Too many failed attempts. Try again in 15 minutes.',
  failed: 'Something went wrong. Try again.',
};

const field =
  'w-full h-12 rounded-xl border border-input bg-background dark:bg-input/30 px-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = 'w-full h-12 rounded-xl bg-primary text-primary-foreground text-[15px] font-semibold active:opacity-80 hover:bg-primary/90';
const textLink = 'underline underline-offset-2 inline-flex items-center min-h-11';

export default async function ResetPage({ searchParams }: Props) {
  const { token: rawToken, error } = await searchParams;
  const token = typeof rawToken === 'string' ? rawToken.slice(0, 100) : '';
  let valid = false;
  let totp = false;
  if (uiAuthConfigured() && token) {
    try {
      [valid, totp] = await Promise.all([resetTokenValid(token), isTotpEnabled()]);
    } catch (e) {
      console.error('reset page check failed', e);
    }
  }
  const message = error ? (ERRORS[error] ?? ERRORS.failed) : null;

  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-foreground">New password</h1>
          <p className="text-[15px] text-muted-foreground mt-1">
            {valid ? 'Choose a new password. Every signed-in device will be signed out.' : 'This reset link is invalid, expired or already used.'}
          </p>
        </div>

        {valid ? (
          <form action={resetPasswordAction} className="space-y-3">
            <input type="hidden" name="token" value={token} />
            {/* Lets password managers store the new password against the right account. */}
            <input type="text" name="username" value="work-os" autoComplete="username" readOnly hidden />
            <input
              name="password"
              type="password"
              className={field}
              placeholder={`New password (${MIN_PASSWORD}+ characters)`}
              autoFocus
              required
              minLength={MIN_PASSWORD}
              maxLength={256}
              autoComplete="new-password"
              aria-label="New password"
            />
            <input
              name="again"
              type="password"
              className={field}
              placeholder="New password again"
              required
              minLength={MIN_PASSWORD}
              maxLength={256}
              autoComplete="new-password"
              aria-label="New password again"
            />
            {totp && (
              <input
                name="code"
                className={`${field} tracking-widest text-center text-lg`}
                placeholder="Authenticator code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={20}
                aria-label="Authenticator code or recovery code"
              />
            )}
            {message && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {message}
              </p>
            )}
            <button type="submit" className={primary}>
              Set new password
            </button>
            {totp && <p className="text-[13px] text-muted-foreground">Lost your phone? Enter one of your recovery codes instead.</p>}
          </form>
        ) : (
          <Link href="/login?step=forgot" className={`${primary} flex items-center justify-center`}>
            Ask for a new link
          </Link>
        )}

        <p className="text-[13px] text-muted-foreground">
          <Link href="/login" className={textLink}>
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
