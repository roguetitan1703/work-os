'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { removeMailKeyAction, saveMailKeyAction, startMailConnectAction, testMailKeyAction } from './mail-actions';

const btn = 'inline-flex items-center justify-center h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50';
const ghost = cn(btn, 'border border-border bg-card text-foreground hover:bg-muted/60');
const primary = cn(btn, 'bg-foreground text-background hover:bg-foreground/90');

type Link = { prefix: string; email: string; scopes: string[] | null };

/** The result of coming back from Mailloom: a fixed word set by /api/mail/callback (never text from the address). */
function ConnectNotice({ linked }: { linked: boolean }) {
  const flag = useSearchParams().get('mail');
  if (flag === 'linked' && linked) return <p className="text-[13px] text-foreground" role="status" data-mail-notice="linked">Mailloom is connected.</p>;
  if (flag === 'revokefail' && linked) return <p className="text-[13px] text-destructive" role="status" data-mail-notice="revokefail">Connected. The previous key could not be revoked: revoke it in Mailloom › Connections.</p>;
  if (flag === 'denied') return <p className="text-[13px] text-foreground" role="status" data-mail-notice="denied">Not connected: Mailloom was not allowed.</p>;
  if (flag === 'error') return <p className="text-[13px] text-destructive" role="status" data-mail-notice="error">Could not connect Mailloom. Sign in to Work OS, then press Connect again.</p>;
  return null;
}

function ConnectButton({ label, kind }: { label: string; kind: 'primary' | 'ghost' }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className={kind === 'primary' ? primary : ghost}
      disabled={pending}
      data-mail-connect
      onClick={() =>
        start(async () => {
          const r = await startMailConnectAction();
          if (!r.ok) return void toast.error(r.error);
          window.location.assign(r.data.url);
        })
      }
    >
      {label}
    </button>
  );
}

/**
 * Your own Mailloom key. With Connect set up: Connect Mailloom (Mailloom mints the key, it never passes the browser), and
 * the paste box folded behind "Paste a key instead". Linked: mailbox, prefix, scopes, Test, Connect again, Disconnect
 * (revokes the key at Mailloom). The key is never shown again, only its prefix.
 */
export function MailKey({ link, connect }: { link: Link | null; connect: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<string | null>(null);

  if (link) {
    return (
      <div className="mt-2 space-y-2" data-mail-linked>
        {connect && <ConnectNotice linked />}
        <p className="text-[13px] text-foreground" data-mail-mailbox>
          Mailbox <b>{link.email}</b>, key <code>{link.prefix}…</code>
          {link.scopes && <span data-mail-scopes> ({link.scopes.join(', ')})</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={ghost}
            disabled={pending}
            data-mail-test
            onClick={() =>
              start(async () => {
                const r = await testMailKeyAction();
                setResult(r.ok ? `Works: this key opens ${r.data.email} (${r.data.scopes.join(', ')}).` : r.error);
              })
            }
          >
            Test
          </button>
          {connect && <ConnectButton label="Connect again" kind="ghost" />}
          <button
            type="button"
            className={ghost}
            disabled={pending}
            data-mail-remove
            onClick={() =>
              start(async () => {
                const r = await removeMailKeyAction();
                if (!r.ok) return void toast.error(r.error);
                if (r.data.revoked === false) toast.warning('Disconnected here, but Mailloom could not be reached: revoke the key in Mailloom › Connections.');
                setResult(null);
                router.replace('/settings?section=connections');
                router.refresh();
              })
            }
          >
            Disconnect
          </button>
        </div>
        {result && (
          <p className="text-[13px]" role="status" data-mail-result>
            {result}
          </p>
        )}
      </div>
    );
  }
  const form = (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      data-mail-unlinked
      onSubmit={e => {
        e.preventDefault();
        start(async () => {
          const r = await saveMailKeyAction(value);
          if (!r.ok) return void setResult(r.error);
          setValue('');
          setResult(null);
          router.refresh();
        });
      }}
    >
      <label className="sr-only" htmlFor="mail-key">
        Mailloom key
      </label>
      <input
        id="mail-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="mlk_…"
        value={value}
        onChange={e => setValue(e.target.value)}
        className="h-11 md:h-9 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 text-base md:text-sm"
        data-mail-input
      />
      <button type="submit" className={primary} disabled={pending || !value.trim()} data-mail-save>
        Save
      </button>
      {result && (
        <p className="basis-full text-[13px] text-destructive" role="alert" data-mail-result>
          {result}
        </p>
      )}
    </form>
  );
  if (!connect) return form;
  return (
    <div className="mt-2 space-y-2" data-mail-connectable>
      <ConnectNotice linked={false} />
      <ConnectButton label="Connect Mailloom" kind="primary" />
      <details data-mail-paste>
        <summary className="cursor-pointer text-[13px] text-muted-foreground">Paste a key instead</summary>
        {form}
      </details>
    </div>
  );
}
