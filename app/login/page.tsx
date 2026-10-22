import { SignInForm } from './sign-in-form';

type Props = { searchParams: Promise<{ next?: string; step?: string; reset?: string }> };

export const metadata = { title: 'Sign in · Work OS' };

/** Only a path on this site: never `//host` or `/\host` (open redirect). */
function safeNext(next: unknown): string {
  const s = typeof next === 'string' ? next : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/today';
}

// Sign-in (docs/auth.md): email and password, then a code when the authenticator app is on; passkeys; forgot password.
// All of it is Better Auth from the browser (lib/auth-client.ts). proxy.ts lets exactly /login through.
export default async function LoginPage({ searchParams }: Props) {
  const { next, step, reset } = await searchParams;
  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm">
        <SignInForm next={safeNext(next)} start={step === 'forgot' ? 'forgot' : 'password'} resetDone={reset === 'done'} />
      </div>
    </div>
  );
}
