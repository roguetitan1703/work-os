'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { removeMailKeyAction, saveMailKeyAction, startMailConnectAction, testMailKeyAction } from './mail-actions';

// The Mail row looks like every other Connections row: one line of detail, the status, and ONE button on the right
// (Connect, Manage or Add key). Everything else (Test, Connect again, Disconnect, the paste box) sits in a dialog.
const btn = 'inline-flex items-center justify-center h-11 md:h-9 px-4 rounded-lg text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50';
const ghost = cn(btn, 'border border-border bg-card text-foreground hover:bg-muted/60');
const primary = cn(btn, 'bg-foreground text-background hover:bg-foreground/90');

type Link = { prefix: string; email: string; scopes: string[] | null };

/** The result of coming back from Mailloom: a fixed word set by /api/mail/callback (never text from the address). */
export function MailNotice({ linked }: { linked: boolean }) {
  const flag = useSearchParams().get('mail');
  if (flag === 'linked' && linked) return <p className="mt-1 text-[13px] text-foreground" role="status" data-mail-notice="linked">Mailloom is connected.</p>;
  if (flag === 'revokefail' && linked) return <p className="mt-1 text-[13px] text-destructive" role="status" data-mail-notice="revokefail">Connected. The previous key could not be revoked: revoke it in Mailloom › Connections.</p>;
  if (flag === 'denied') return <p className="mt-1 text-[13px] text-foreground" role="status" data-mail-notice="denied">Not connected: Mailloom was not allowed.</p>;
  if (flag === 'error') return <p className="mt-1 text-[13px] text-destructive" role="status" data-mail-notice="error">Could not connect Mailloom. Sign in to Work OS, then press Connect again.</p>;
  return null;
}

/** Connect Mailloom: Mailloom mints the key, it never passes the browser. */
export function MailConnect({ label = 'Connect', kind = 'primary' }: { label?: string; kind?: 'primary' | 'ghost' }) {
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

const ONE_KEY = 'One Mailloom key per person: connecting here replaces a key you connected in another organization (that key is revoked).';

/**
 * Manage a linked mailbox: mailbox, key prefix, scopes, Test, Connect again, Disconnect (revokes a key Work OS minted
 * at Mailloom; a pasted key is only forgotten). The key is never shown again, only its prefix.
 */
export function MailManage({ link, connect }: { link: Link; connect: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  return (
    <>
      <button type="button" className={ghost} onClick={() => setOpen(true)} data-mail-manage>
        Manage
      </button>
      <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) setResult(null); }}>
        <DialogContent data-sheet data-mail-linked className="text-left">
          <DialogHeader>
            <DialogTitle>Mail</DialogTitle>
            <DialogDescription>Claude reads, organises and sends your mail through your own Mailloom key.</DialogDescription>
          </DialogHeader>
          <p className="text-[13px] text-foreground break-words" data-mail-mailbox>
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
            {connect && <MailConnect label="Connect again" kind="ghost" />}
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
                  setOpen(false);
                  router.replace('/settings?section=connections');
                  router.refresh();
                })
              }
            >
              Disconnect
            </button>
          </div>
          {result && (
            <p className="text-[13px] break-words" role="status" data-mail-result>
              {result}
            </p>
          )}
          {connect && <p className="text-[12px] text-muted-foreground">{ONE_KEY}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Paste your own Mailloom key. Without a Connect client this is the row's button ("Add key"); with one it is a quiet
 * "Paste a key instead" under the row's detail.
 */
export function MailPaste({ connect }: { connect: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const trigger = connect ? (
    <button type="button" className="mt-1 text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground min-h-11 md:min-h-0" onClick={() => setOpen(true)} data-mail-paste>
      Paste a key instead
    </button>
  ) : (
    <button type="button" className={primary} onClick={() => setOpen(true)} data-mail-paste>
      Add key
    </button>
  );
  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) { setResult(null); setValue(''); } }}>
        <DialogContent data-sheet data-mail-unlinked className="text-left">
          <DialogHeader>
            <DialogTitle>Paste a Mailloom key</DialogTitle>
            <DialogDescription>Make one in Mailloom › Connections › New key, then paste it here.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={e => {
              e.preventDefault();
              start(async () => {
                const r = await saveMailKeyAction(value);
                if (!r.ok) return void setResult(r.error);
                setValue('');
                setResult(null);
                setOpen(false);
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
              <p className="basis-full text-[13px] text-destructive break-words" role="alert" data-mail-result>
                {result}
              </p>
            )}
          </form>
          {connect && (
            <p className="text-[12px] text-muted-foreground" data-mail-one-key>
              {ONE_KEY}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
