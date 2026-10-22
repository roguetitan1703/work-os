import type { Metadata } from 'next';
import { ResetForm } from './reset-form';

// Opened from the reset email: Better Auth's /api/auth/reset-password/<token> checks the token and redirects here with
// ?token=… (or ?error=INVALID_TOKEN). proxy.ts lets exactly /login/reset through; the token is checked again on submit.

type Props = { searchParams: Promise<{ token?: string; error?: string }> };

// The token is in the URL: never send it on as a Referer.
export const metadata: Metadata = { title: 'Reset password · Work OS', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ResetPage({ searchParams }: Props) {
  const { token: rawToken, error } = await searchParams;
  const token = !error && typeof rawToken === 'string' ? rawToken.slice(0, 200) : '';
  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm">
        <ResetForm token={token} />
      </div>
    </div>
  );
}
