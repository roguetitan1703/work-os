import Link from 'next/link';
import { cookies } from 'next/headers';
import { loginAction, secondFactorAction } from './actions';
import { PasskeySignIn } from './passkey-signin';
import { PENDING_2FA_COOKIE, verifyPending2faValue } from '@/lib/auth';

type Props = { searchParams: Promise<{ error?: string; next?: string; step?: string }> };

export const metadata = { title: 'Sign in · Work OS' };

const ERRORS: Record<string, string> = {
  config: 'Auth is not configured on the server.',
  locked: 'Too many failed attempts. Try again in 15 minutes, or sign in with a passkey.',
  expired: 'That took too long. Enter your password again.',
  code: 'Wrong code. Use the 6-digit code from your authenticator app, or a recovery code.',
  '1': 'Wrong password.',
};

const field =
  'w-full h-12 rounded-xl border border-input bg-background dark:bg-input/30 px-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = 'w-full h-12 rounded-xl bg-primary text-primary-foreground text-[15px] font-semibold active:opacity-80 hover:bg-primary/90';

export default async function LoginPage({ searchParams }: Props) {
  const { error, next: rawNext, step } = await searchParams;
  const next = rawNext ?? '/today';
  const twoFactor = step === '2fa' && (await verifyPending2faValue((await cookies()).get(PENDING_2FA_COOKIE)?.value));
  const message = error ? (ERRORS[error] ?? ERRORS['1']) : step === '2fa' && !twoFactor ? ERRORS.expired : null;

  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Work OS</h1>
          <p className="text-[15px] text-muted-foreground mt-1">
            {twoFactor ? 'Enter the code from your authenticator app.' : 'Sign in to continue.'}
          </p>
        </div>

        {twoFactor ? (
          <form action={secondFactorAction} className="space-y-3">
            <input type="hidden" name="next" value={next} />
            <input
              name="code"
              className={`${field} tracking-widest text-center text-lg`}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={20}
              aria-label="Authenticator code or recovery code"
            />
            {message && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{message}</p>}
            <button type="submit" className={primary}>
              Verify
            </button>
            <p className="text-[13px] text-muted-foreground">
              Lost your phone? Enter one of your recovery codes instead.{' '}
              <Link href={`/login?next=${encodeURIComponent(next)}`} className="underline underline-offset-2 inline-block py-2">
                Start over
              </Link>
            </p>
          </form>
        ) : (
          <form action={loginAction} className="space-y-3">
            <input type="hidden" name="next" value={next} />
            <input
              name="password"
              type="password"
              className={field}
              placeholder="Password"
              autoFocus
              required
              autoComplete="current-password webauthn"
              aria-label="Password"
            />
            {message && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{message}</p>}
            <button type="submit" className={primary}>
              Sign in
            </button>
          </form>
        )}

        {error !== 'config' && <PasskeySignIn next={next} autofill={!twoFactor} />}
      </div>
    </div>
  );
}
