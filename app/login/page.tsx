import { SignInForm } from './sign-in-form';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata = { title: 'Sign in · Work OS' };

/** Only a path on this site: never `//host` or `/\host` (open redirect). */
function safeNext(next: unknown): string {
  const s = typeof next === 'string' ? next : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/today';
}

/**
 * An app asking to connect (OAuth, docs/auth.md) sends the person here with its authorization request, signed by Better
 * Auth (`sig`). After sign-in the request starts again at the authorize endpoint, now with a session, which goes on to
 * the consent screen. Only that fixed same-site path is built; the app's own parameters ride along as plain query text
 * (the endpoint validates them all again, and signs nothing it does not check).
 */
function oauthNext(sp: Record<string, string | string[] | undefined>): string | null {
  if (typeof sp.sig !== 'string' || typeof sp.client_id !== 'string' || typeof sp.redirect_uri !== 'string') return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param', 'next', 'step', 'reset'].includes(k) || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) if (!(k === 'prompt' && /login/.test(one)) && !(k === 'max_age')) q.append(k, one);
  }
  return '/api/auth/oauth2/authorize?' + q.toString();
}

// Sign-in (docs/auth.md): email and password, then a code when the authenticator app is on; passkeys; forgot password.
// All of it is Better Auth from the browser (lib/auth-client.ts). proxy.ts lets exactly /login through.
export default async function LoginPage({ searchParams }: Props) {
  const sp = await searchParams;
  const next = oauthNext(sp) ?? sp.next;
  const step = sp.step;
  const reset = sp.reset;
  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm">
        <SignInForm next={safeNext(next)} start={step === 'forgot' ? 'forgot' : 'password'} resetDone={reset === 'done'} />
      </div>
    </div>
  );
}
