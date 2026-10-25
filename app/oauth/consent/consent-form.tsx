'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ConsentView } from '@/lib/oauth';

const btn = 'w-full h-12 rounded-xl text-[15px] font-semibold disabled:opacity-60';

/** Where Better Auth may send the browser after Allow or Deny: the app's own address, https or loopback. Anything else is not followed. */
function safeTarget(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return u.toString();
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.toString();
  } catch {
    // fall through
  }
  return null;
}

export function ConsentForm({ view, person }: { view: Extract<ConsentView, { ok: true }>; person: { name: string; email: string } }) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean) {
    setBusy(accept ? 'allow' : 'deny');
    setError(null);
    try {
      const res = await fetch('/api/auth/oauth2/consent', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ accept, oauth_query: view.oauthQuery }),
      });
      const data = (await res.json().catch(() => null)) as { url?: string; redirect?: boolean; message?: string; error_description?: string } | null;
      const target = res.ok ? safeTarget(data?.url) : null;
      if (target) return void window.location.assign(target);
      setError(data?.error_description || data?.message || 'That did not work. Go back to the app and start connecting again.');
    } catch {
      setError('Could not reach Work OS. Try again.');
    }
    setBusy(null);
  }

  const isClaudeApp = view.agent === 'claude';
  return (
    <>
      <div className="flex items-start gap-3">
        <ShieldCheck className="w-6 h-6 text-muted-foreground shrink-0 mt-0.5" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground leading-snug">
            <span data-consent-client className="break-words">{view.clientName}</span> wants to access your Work OS
          </h1>
          <p className="text-[15px] text-muted-foreground mt-1">
            as <b className="text-foreground">{person.name}</b> ({person.email}) in <b className="text-foreground" data-consent-org>{view.orgName}</b>.
          </p>
        </div>
      </div>

      <ul className="text-[14px] text-foreground/90 space-y-1.5 list-disc pl-5">
        <li>It can read and change what you can: tasks, projects, notes, and your Claude queue. Everything it changes is recorded as Claude, under your name.</li>
        <li>It cannot manage members, keys or settings, and it never sees your password.</li>
        {!isClaudeApp && <li>It works under the stricter Claude Code limits: a cap on calls and deletions, and a notice to a task&apos;s owner when it changes their task.</li>}
        {view.offline && <li>It stays connected until you revoke it in Settings › Connections.</li>}
      </ul>

      <div className="rounded-xl border border-border/70 bg-muted/40 px-3.5 py-3 text-[13px] text-muted-foreground space-y-1">
        <p>
          <b className="text-foreground">Not verified.</b> The name above is what the app calls itself; anyone can pick any name.
        </p>
        <p>
          After you allow, you are sent to <b className="text-foreground break-all" data-consent-host>{view.redirectHost}</b>.
          {view.loopbackOnly && ' That is a program on this computer (a command-line or desktop app). Allow it only if you just started it yourself.'}
        </p>
        {view.lookalike && (
          <p data-consent-lookalike className="text-red-700 dark:text-red-300 font-medium">
            Warning: this app calls itself &quot;{view.clientName}&quot; but it is not Claude&apos;s own connector (claude.ai). Deny it unless you know where it comes from.
          </p>
        )}
        <p>Only allow this if you started connecting it just now.</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <button type="button" data-consent="deny" className={`${btn} border border-border bg-background text-foreground active:bg-muted/60 hover:bg-muted/40`} disabled={busy !== null} onClick={() => answer(false)}>
          {busy === 'deny' ? 'Denying…' : 'Deny'}
        </button>
        <button type="button" data-consent="allow" className={`${btn} bg-primary text-primary-foreground active:opacity-80 hover:bg-primary/90`} disabled={busy !== null} onClick={() => answer(true)}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </button>
      </div>
    </>
  );
}
