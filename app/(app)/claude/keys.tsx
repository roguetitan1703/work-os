'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, Copy, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiKeyInfo } from '@/lib/api-keys';
import { BottomSheet } from '@/components/mobile/sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { fmtAgo } from '@/lib/format';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { Disclosure } from '../connect/ui';
import { createApiKeyAction, listApiKeysAction, revokeApiKeyAction, rotateApiKeyAction } from './setup-actions';

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';
const btnPrimary = `${btn} bg-foreground text-background`;
const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

type Pending = { kind: 'revoke' | 'rotate'; key: ApiKeyInfo } | null;

/** Claude › Setup › Keys: create (shown once), list, rotate, revoke. */
export function ClaudeCodeKeys({ url }: { url: string }) {
  const phone = usePhone();
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    listApiKeysAction().then(r => {
      if (!alive) return;
      if (r.ok) setKeys(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const create = () =>
    start(async () => {
      const n = name.trim() || 'Claude Code';
      const r = await createApiKeyAction(n);
      if (!r.ok) return void toast.error(r.error);
      setKeys(r.data.keys);
      setFresh({ key: r.data.key, name: n });
      setName('');
    });

  const act = (p: NonNullable<Pending>) =>
    start(async () => {
      if (p.kind === 'revoke') {
        const r = await revokeApiKeyAction(p.key.id);
        if (!r.ok) return void toast.error(r.error);
        setKeys(r.data);
        toast(`Revoked "${p.key.name}"`);
      } else {
        const r = await rotateApiKeyAction(p.key.id);
        if (!r.ok) return void toast.error(r.error);
        setKeys(r.data.keys);
        setFresh({ key: r.data.key, name: p.key.name });
      }
      setConfirm(null);
    });

  const ask = (p: NonNullable<Pending>) => setConfirm(p);

  return (
    <section className="space-y-3">
      <div className="rounded-2xl border border-border/70 divide-y divide-border/60 bg-card overflow-hidden">
        {error ? (
          <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !keys ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          keys.map(k => (
            <div key={k.id} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14">
              <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] md:text-sm text-foreground truncate">{k.name}</div>
                <div className="text-[13px] md:text-xs text-muted-foreground leading-snug truncate" suppressHydrationWarning>
                  <code className="font-mono">{k.prefix}…</code> · created {day(k.createdAt)} · {k.lastUsedAt ? `used ${fmtAgo(k.lastUsedAt)}` : 'never used'}
                </div>
              </div>
              <button type="button" className={iconBtn} onClick={() => ask({ kind: 'rotate', key: k })} disabled={pending} aria-label={`Rotate ${k.name}`} title="Rotate">
                <RefreshCw className="w-4 h-4" />
              </button>
              <button type="button" className={iconBtn} onClick={() => ask({ kind: 'revoke', key: k })} disabled={pending} aria-label={`Revoke ${k.name}`} title="Revoke">
                <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
              </button>
            </div>
          ))
        )}
        <div className="flex items-center gap-2 px-4 py-3">
          <input
            className={field}
            value={name}
            maxLength={60}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !pending && create()}
            placeholder="Name, e.g. Laptop · work-os"
            aria-label="Name for the new key"
            enterKeyHint="done"
          />
          <button type="button" className={btnPrimary} onClick={create} disabled={pending}>
            <Plus className="w-4 h-4" /> Create
          </button>
        </div>
      </div>

      <Disclosure title="Limits and safety" hint="What a Claude Code key can do">
        <p>
          Separate keys for Claude Code sessions on your PC. They only open the MCP endpoint (not admin or the rest of the API), and everything they change is marked{' '}
          <span className="px-1 rounded bg-violet-500/15 text-violet-700 dark:text-violet-300 text-xs font-medium">Claude Code</span>. Limits: 300 calls an hour, 10
          deletions per 10 minutes, big batches need a dry run first, and you get a notification when one changes or deletes your tasks.
        </p>
      </Disclosure>

      {fresh && !phone && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-4">
          <NewKey fresh={fresh} url={url} onDone={() => setFresh(null)} />
        </div>
      )}
      {fresh && phone && (
        <BottomSheet title={`Key for "${fresh.name}"`} onClose={() => setFresh(null)}>
          <div className="pt-1 pb-2">
            <NewKey fresh={fresh} url={url} onDone={() => setFresh(null)} />
          </div>
        </BottomSheet>
      )}

      {confirm && (
        <ConfirmSheet
          title={confirm.kind === 'revoke' ? 'Revoke key' : 'Rotate key'}
          message={
            confirm.kind === 'revoke'
              ? `Revoke "${confirm.key.name}"? Claude Code sessions using it stop working at once.`
              : `Rotate "${confirm.key.name}"? The old key stops working at once and a new one is shown.`
          }
          verb={confirm.kind === 'revoke' ? 'Revoke' : 'Rotate'}
          danger={confirm.kind === 'revoke'}
          pending={pending}
          onConfirm={() => act(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}

function NewKey({ fresh, url, onDone }: { fresh: { key: string; name: string }; url: string; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (what: string, text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what);
        setTimeout(() => setCopied(null), 1500);
      },
      () => toast.error('Could not copy'),
    );
  const cmd = `claude mcp add --scope user --transport http work-os ${url} --header "Authorization: Bearer ${fresh.key}"`;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-foreground">
        <strong>Copy this key now.</strong> It is not shown again; if you lose it, rotate the key.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono">{fresh.key}</code>
        <button type="button" className={iconBtn} onClick={() => copy('key', fresh.key)} aria-label="Copy key">
          {copied === 'key' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[13px] text-muted-foreground">Add it to Claude Code (run in a terminal):</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[12px] font-mono">{cmd}</code>
        <button type="button" className={iconBtn} onClick={() => copy('cmd', cmd)} aria-label="Copy command">
          {copied === 'cmd' ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Optional headers <code>X-Work-OS-Session</code> (letters, digits, dashes, up to 64) and <code>X-Work-OS-Repo</code> (e.g. owner/name) are shown next to each change in
        history.
      </p>
      <button type="button" className={`${btnPrimary} w-full`} onClick={onDone}>
        I saved it
      </button>
    </div>
  );
}
