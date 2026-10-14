'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, Copy, KeyRound, Pencil, Plus, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '@/lib/passkeys';
import type { TotpState } from '@/lib/totp';
import { Row } from './device-settings';
import {
  getSecurityStateAction,
  passkeyRegisterAction,
  passkeyRegisterOptionsAction,
  removePasskeyAction,
  renamePasskeyAction,
  totpBeginAction,
  totpConfirmAction,
  totpDisableAction,
  totpRegenerateCodesAction,
} from './security-actions';

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50';
const btnPrimary = `${btn} bg-foreground text-background`;
const btnOutline = `${btn} border border-border text-foreground font-medium`;
const iconBtn = 'w-11 h-11 -my-1 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';

function deviceFromUA(ua: string): string {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Macintosh|Mac OS X/.test(ua)
            ? 'Mac'
            : /Windows/.test(ua)
              ? 'Windows PC'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'This device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari/.test(ua)
            ? 'Safari'
            : '';
  return browser ? `${os} · ${browser}` : os;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function SecuritySettings() {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [totp, setTotp] = useState<TotpState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSecurityStateAction().then(r => {
      if (!alive) return;
      if (r.ok) {
        setPasskeys(r.data.passkeys);
        setTotp(r.data.totp);
      } else setLoadError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (loadError) return <Row icon={<ShieldOff className="w-5 h-5 text-red-500" />} title="Security" sub={loadError} />;
  if (!passkeys || !totp) return <Row icon={<KeyRound className="w-5 h-5" />} title="Passkeys" sub="Checking…" />;

  return (
    <>
      <Passkeys list={passkeys} onChange={setPasskeys} />
      <Totp state={totp} onChange={setTotp} />
    </>
  );
}

// ── Passkeys ────────────────────────────────────────────────────────────────

function Passkeys({ list, onChange }: { list: PasskeyInfo[]; onChange: (l: PasskeyInfo[]) => void }) {
  const [supported, setSupported] = useState(true);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => {
      setSupported(browserSupportsWebAuthn());
      setName(deviceFromUA(navigator.userAgent));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const add = () =>
    start(async () => {
      const opts = await passkeyRegisterOptionsAction();
      if (!opts.ok) return void toast.error(opts.error);
      let response;
      try {
        response = await startRegistration({ optionsJSON: opts.data });
      } catch (e) {
        const n = e instanceof Error ? e.name : '';
        if (n === 'InvalidStateError') toast.error('This device already has a passkey for Work OS.');
        else if (n !== 'NotAllowedError' && n !== 'AbortError') toast.error(e instanceof Error ? e.message : 'Could not create a passkey.');
        return;
      }
      const r = await passkeyRegisterAction(response, name);
      if (!r.ok) return void toast.error(r.error);
      onChange(r.data);
      toast.success('Passkey added. You can now sign in with it.');
    });

  const remove = (p: PasskeyInfo) => {
    if (!window.confirm(`Remove the passkey "${p.deviceName}"? It will no longer sign you in.`)) return;
    start(async () => {
      const r = await removePasskeyAction(p.id);
      if (!r.ok) return void toast.error(r.error);
      onChange(r.data);
      toast('Passkey removed');
    });
  };

  const saveName = () => {
    if (!editing) return;
    const e = editing;
    start(async () => {
      const r = await renamePasskeyAction(e.id, e.name);
      if (!r.ok) return void toast.error(r.error);
      onChange(r.data);
      setEditing(null);
    });
  };

  return (
    <>
      <Row
        icon={<KeyRound className="w-5 h-5 text-blue-600" />}
        title="Passkeys"
        sub="Sign in with Face ID, fingerprint or your device PIN. No password or code needed."
      />
      {list.map(p =>
        editing?.id === p.id ? (
          <div key={p.id} className="flex items-center gap-2 px-4 py-2 min-h-14">
            <input
              className={field}
              value={editing.name}
              maxLength={60}
              autoFocus
              aria-label="Passkey name"
              onChange={e => setEditing({ id: p.id, name: e.target.value })}
              onKeyDown={e => e.key === 'Enter' && saveName()}
            />
            <button type="button" className={iconBtn} onClick={saveName} disabled={pending} aria-label="Save name">
              <Check className="w-5 h-5 text-green-600" />
            </button>
            <button type="button" className={iconBtn} onClick={() => setEditing(null)} aria-label="Cancel">
              <X className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <div key={p.id} className="flex items-center gap-2 pl-4 pr-2 py-3 min-h-14">
            <div className="flex-1 min-w-0 pl-8">
              <div className="text-[15px] text-foreground truncate">{p.deviceName}</div>
              <div className="text-[13px] text-muted-foreground leading-snug">
                Added {day(p.createdAt)} · {p.lastUsedAt ? `last used ${day(p.lastUsedAt)}` : 'not used yet'}
              </div>
            </div>
            <button type="button" className={iconBtn} onClick={() => setEditing({ id: p.id, name: p.deviceName })} disabled={pending} aria-label={`Rename ${p.deviceName}`}>
              <Pencil className="w-4 h-4" />
            </button>
            <button type="button" className={iconBtn} onClick={() => remove(p)} disabled={pending} aria-label={`Remove ${p.deviceName}`}>
              <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
            </button>
          </div>
        ),
      )}
      {supported ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <input className={field} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="Name this device" aria-label="Name for the new passkey" />
          <button type="button" className={`${btnPrimary} flex items-center gap-1.5`} onClick={add} disabled={pending}>
            <Plus className="w-4 h-4" /> Add passkey
          </button>
        </div>
      ) : (
        <Row title="Add passkey" sub="This browser does not support passkeys." />
      )}
    </>
  );
}

// ── Authenticator app ───────────────────────────────────────────────────────

type Mode = { kind: 'idle' } | { kind: 'setup'; secret: string; qr: string } | { kind: 'disable' } | { kind: 'regen' } | { kind: 'codes'; codes: string[] };

function Totp({ state, onChange }: { state: TotpState; onChange: (s: TotpState) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [pending, start] = useTransition();

  const go = (m: Mode) => {
    setCode('');
    setMode(m);
  };

  const begin = () =>
    start(async () => {
      const r = await totpBeginAction();
      if (!r.ok) return void toast.error(r.error);
      go({ kind: 'setup', secret: r.data.secret, qr: r.data.qr });
    });

  const confirm = () =>
    start(async () => {
      const r = await totpConfirmAction(code);
      if (!r.ok) return void toast.error(r.error);
      onChange({ enabled: true, recoveryLeft: r.data.length, enabledAt: new Date().toISOString() });
      go({ kind: 'codes', codes: r.data });
      toast.success('Authenticator app on');
    });

  const disable = () =>
    start(async () => {
      const r = await totpDisableAction(code);
      if (!r.ok) return void toast.error(r.error);
      onChange({ enabled: false, recoveryLeft: 0, enabledAt: null });
      go({ kind: 'idle' });
      toast('Authenticator app off');
    });

  const regen = () =>
    start(async () => {
      const r = await totpRegenerateCodesAction(code);
      if (!r.ok) return void toast.error(r.error);
      onChange({ ...state, recoveryLeft: r.data.length });
      go({ kind: 'codes', codes: r.data });
    });

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Could not copy'),
    );

  const codeInput = (onEnter: () => void, label: string) => (
    <input
      className={`${field} tracking-widest`}
      value={code}
      onChange={e => setCode(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && code && onEnter()}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123456"
      maxLength={20}
      autoFocus
      aria-label={label}
    />
  );

  return (
    <>
      <Row
        icon={state.enabled ? <ShieldCheck className="w-5 h-5 text-green-600" /> : <ShieldOff className="w-5 h-5 text-muted-foreground" />}
        title="Authenticator app"
        sub={
          state.enabled
            ? `On. Password sign-in also asks for a code. ${state.recoveryLeft} recovery code${state.recoveryLeft === 1 ? '' : 's'} left.`
            : 'Off. Turn on to ask for a 6-digit code after your password. Passkeys skip it.'
        }
        action={
          mode.kind === 'idle' ? (
            state.enabled ? (
              <button type="button" className={btnOutline} onClick={() => go({ kind: 'disable' })}>
                Turn off
              </button>
            ) : (
              <button type="button" className={btnPrimary} onClick={begin} disabled={pending}>
                Turn on
              </button>
            )
          ) : undefined
        }
      />

      {mode.kind === 'idle' && state.enabled && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 min-h-14">
          <span className="text-sm text-muted-foreground">Lost or used up your recovery codes?</span>
          <button type="button" className={btnOutline} onClick={() => go({ kind: 'regen' })}>
            New codes
          </button>
        </div>
      )}

      {mode.kind === 'setup' && (
        <div className="px-4 py-4 space-y-3">
          <p className="text-[13px] text-muted-foreground">
            1. In Google Authenticator, 1Password, Authy or similar, scan this code or enter the key by hand.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL QR code */}
          <img src={mode.qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-xl bg-white p-2" />
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono">{mode.secret}</code>
            <button type="button" className={iconBtn} onClick={() => copy(mode.secret)} aria-label="Copy key">
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[13px] text-muted-foreground">2. Enter the 6-digit code it shows.</p>
          <div className="flex items-center gap-2">
            {codeInput(confirm, 'Code from your authenticator app')}
            <button type="button" className={btnPrimary} onClick={confirm} disabled={pending || !code}>
              Confirm
            </button>
          </div>
          <button type="button" className={`${btnOutline} w-full`} onClick={() => go({ kind: 'idle' })}>
            Cancel
          </button>
        </div>
      )}

      {(mode.kind === 'disable' || mode.kind === 'regen') && (
        <div className="px-4 py-4 space-y-3">
          <p className="text-[13px] text-muted-foreground">
            {mode.kind === 'disable'
              ? 'Enter a current code from your authenticator app (or a recovery code) to turn it off.'
              : 'Enter a current code from your authenticator app. Your old recovery codes stop working.'}
          </p>
          <div className="flex items-center gap-2">
            {codeInput(mode.kind === 'disable' ? disable : regen, 'Authenticator code')}
            <button
              type="button"
              className={mode.kind === 'disable' ? `${btn} bg-red-600 text-white` : btnPrimary}
              onClick={mode.kind === 'disable' ? disable : regen}
              disabled={pending || !code}
            >
              {mode.kind === 'disable' ? 'Turn off' : 'Create'}
            </button>
          </div>
          <button type="button" className={`${btnOutline} w-full`} onClick={() => go({ kind: 'idle' })}>
            Cancel
          </button>
        </div>
      )}

      {mode.kind === 'codes' && (
        <div className="px-4 py-4 space-y-3">
          <p className="text-[13px] text-foreground">
            <strong>Save these recovery codes now.</strong> Each one works once, instead of an app code. They are not shown again.
          </p>
          <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-muted px-4 py-3 font-mono text-[15px]">
            {mode.codes.map(c => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="flex gap-2">
            <button type="button" className={`${btnOutline} flex-1 flex items-center justify-center gap-1.5`} onClick={() => copy(mode.codes.join('\n'))}>
              <Copy className="w-4 h-4" /> Copy all
            </button>
            <button type="button" className={`${btnPrimary} flex-1`} onClick={() => go({ kind: 'idle' })}>
              I saved them
            </button>
          </div>
        </div>
      )}
    </>
  );
}
