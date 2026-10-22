import type { Metadata } from 'next';
import Link from '@/components/intent-link';
import { getCaller } from '@/lib/caller';
import { MIN_PASSWORD } from '@/lib/auth-server';
import { viewInvitation } from '@/lib/members';
import { acceptNewAction, acceptSignedInAction } from '../actions';

// Opened from an invitation email (lib/members.ts). Public page; the secret `t` in the link is checked here and
// again by the actions.

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string; error?: string }> };

// The secret is in the URL: never send it on as a Referer.
export const metadata: Metadata = { title: 'Join · Work OS', referrer: 'no-referrer', robots: { index: false, follow: false } };

const field =
  'w-full h-12 rounded-xl border border-input bg-background dark:bg-input/30 px-3.5 text-base text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const primary = 'w-full h-12 rounded-xl bg-primary text-primary-foreground text-[15px] font-semibold active:opacity-80 hover:bg-primary/90 flex items-center justify-center';

export default async function AcceptInvitationPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { t: rawT, error } = await searchParams;
  const t = typeof rawT === 'string' ? rawT.slice(0, 100) : '';
  const view = await viewInvitation(id, t).catch(() => null);
  const caller = view?.accountExists ? await getCaller() : null;
  const here = `/accept-invitation/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`;

  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm" data-invite={view ? (view.accountExists ? 'existing' : 'new') : 'invalid'}>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{view ? `Join ${view.orgName}` : 'Invitation'}</h1>
          <p className="text-[15px] text-muted-foreground mt-1">
            {view ? `You were invited as ${view.role}, as ${view.email}.` : 'This invitation link is invalid, expired or already used. Ask for a new one.'}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error.slice(0, 200)}
          </p>
        )}

        {view && !view.accountExists && (
          <form action={acceptNewAction} className="space-y-3">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="t" value={t} />
            <input type="text" name="username" value={view.email} autoComplete="username" readOnly hidden />
            <input name="name" className={field} placeholder="Your name" required maxLength={80} autoComplete="name" aria-label="Your name" autoFocus />
            <input name="password" type="password" className={field} placeholder={`Password (${MIN_PASSWORD}+ characters)`} required minLength={MIN_PASSWORD} maxLength={256} autoComplete="new-password" aria-label="Password" />
            <input name="again" type="password" className={field} placeholder="Password again" required minLength={MIN_PASSWORD} maxLength={256} autoComplete="new-password" aria-label="Password again" />
            <button type="submit" className={primary}>
              Join
            </button>
          </form>
        )}

        {view && view.accountExists && caller && caller.email.toLowerCase() === view.email.toLowerCase() && (
          <form action={acceptSignedInAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="t" value={t} />
            <button type="submit" className={primary}>
              Join {view.orgName}
            </button>
          </form>
        )}

        {view && view.accountExists && !(caller && caller.email.toLowerCase() === view.email.toLowerCase()) && (
          <Link href={`/login?next=${encodeURIComponent(here)}`} className={primary}>
            Sign in as {view.email} to accept
          </Link>
        )}

        <p className="text-[13px] text-muted-foreground">
          <Link href="/login" className="underline underline-offset-2 inline-flex items-center min-h-11">
            Go to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
