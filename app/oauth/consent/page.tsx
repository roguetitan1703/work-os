import { redirect } from 'next/navigation';
import { getCaller } from '@/lib/caller';
import { consentView } from '@/lib/oauth';
import { ConsentForm } from './consent-form';

export const metadata = { title: 'Connect an app · Work OS' };
export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// The consent screen of the OAuth sign-in (docs/auth.md "Connecting Claude with OAuth"): Better Auth sends a signed-in
// person here when an app asks to connect. Not public (proxy.ts sends the signed-out to /login first). Never framed
// (frame-ancestors 'none' in the page CSP). The page only shows the request; Allow and Deny go to Better Auth, which
// checks the signature and the person's session again.
export default async function ConsentPage({ searchParams }: Props) {
  const sp = await searchParams;
  const caller = await getCaller();
  if (!caller) redirect('/login');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  const view = await consentView(q, caller);
  return (
    <div className="min-h-full w-full flex items-center justify-center px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-md rounded-2xl bg-card border border-border/70 p-6 space-y-5 shadow-sm" data-oauth-consent>
        {view.ok ? (
          <ConsentForm view={view} person={{ name: caller.name, email: caller.email }} />
        ) : (
          <div className="space-y-3">
            <h1 className="text-xl font-bold text-foreground">This request can&apos;t be used</h1>
            <p className="text-[15px] text-muted-foreground">It has expired or was changed. Go back to the app (Claude) and start connecting again.</p>
          </div>
        )}
      </div>
    </div>
  );
}
