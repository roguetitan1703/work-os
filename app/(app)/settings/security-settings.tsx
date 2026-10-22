'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, Copy, KeyRound, LockKeyhole, Mail, Pencil, Plus, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { authClient, authError } from '@/lib/auth-client';
import { Row } from './device-settings';
import { sendTestEmailAction } from './security-actions';
import { needsReauth, useReauth } from '@/components/reauth';

// Settings › Security (docs/auth.md): passkeys, authenticator app with backup codes, password, test email.
// Everything except the test email is a Better Auth call from the browser (lib/auth-client.ts), which checks the session.

export type EmailState = { configured: boolean; missing: string[]; to: string };

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

const day = (iso: string | Date) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

type PasskeyRow = { id: string; name?: string | null; createdAt: string | Date };

export function SecuritySettings({ email, twoFactor, mail }: { email: string; twoFactor: boolean; mail: EmailState }) {
  const [totpOn, setTotpOn] = useState(twoFactor);
  return (
    <>
      <Passkeys />
      <Totp enabled={totpOn} onChange={setTotpOn} />
      <Password email={email} />
      <Email state={mail} />
    </>
  );
}

// ── Passkeys ────────────────────────────────────────────────────────────────

function Passkeys() {
  const [list, setList] = useState<PasskeyRow[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [pending, start] = useTransition();
  const reauth = useReauth();

  const load = async () => {
    const r = await authClient.passkey.listUserPasskeys();
    if (r.error) toast.error(authError(r.error));
    else setList((r.data ?? []) as PasskeyRow[]);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setSupported(typeof window !== 'undefined' && !!window.PublicKeyCredential);
      setName(deviceFromUA(navigator.userAgent));
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const add = () =>
    start(async () => {
      const make = () => authClient.passkey.addPasskey({ name: name.trim().slice(0, 60) || 'Passkey' });
      let r = await make();
      // More than 10 minutes after sign-in: confirm the password, then try again (lib/fresh.ts).
      if (r?.error && needsReauth(r.error) && (await reauth.ask())) r = await make();
      if (r?.error) {
        const m = r.error.message ?? '';
        if (!/cancel|abort|not allowed/i.test(m)) toast.error(authError(r.error, 'Could not create a passkey.'));
        return;
      }
      await load();
      toast.success('Passkey added. You can now sign in with it.');
    });

  const remove = (p: PasskeyRow) => {
    if (!window.confirm(`Remove the passkey "${p.name ?? 'Passkey'}"? It will no longer sign you in.`)) return;
    start(async () => {
      const r = await authClient.passkey.deletePasskey({ id: p.id });
      if (r.error) return void toast.error(authError(r.error));
      await load();
      toast('Passkey removed');
    });
  };

  const saveName = () => {
    if (!editing) return;
    const e = editing;
    start(async () => {
      const r = await authClient.passkey.updatePasskey({ id: e.id, name: e.name.trim().slice(0, 60) || 'Passkey' });
      if (r.error) return void toast.error(authError(r.error));
      await load();
      setEditing(null);
    });
  };

  return (
    <>
      {reauth.dialog}
      <Row icon={<KeyRound className="w-5 h-5 text-blue-600" />} title="Passkeys" sub={list ? 'Sign in with Face ID, fingerprint or your device PIN. No password or code needed.' : 'Checking…'} />
      {(list ?? []).map(p =>
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
              <div className="text-[15px] text-foreground truncate">{p.name || 'Passkey'}</div>
              <div className="text-[13px] text-muted-foreground leading-snug">Added {day(p.createdAt)}</div>
            </div>
            <button type="button" className={iconBtn} onClick={() => setEditing({ id: p.id, name: p.name ?? '' })} disabled={pending} aria-label={`Rename ${p.name ?? 'passkey'}`}>
              <Pencil className="w-4 h-4" />
            </button>
            <button type="button" className={iconBtn} onClick={() => remove(p)} disabled={pending} aria-label={`Remove ${p.name ?? 'passkey'}`}>
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

type Then = 'enable' | 'disable' | 'regen';
type Mode = { kind: 'idle' } | { kind: 'password'; then: Then } | { kind: 'setup'; secret: string; qr: string; codes: string[] } | { kind: 'codes'; codes: string[] };

function Totp({ enabled, onChange }: { enabled: boolean; onChange: (on: boolean) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [pending, start] = useTransition();

  const go = (m: Mode) => {
    setCode('');
    setPassword('');
    setMode(m);
  };

  const withPassword = (then: Then) =>
    start(async () => {
      if (then === 'enable') {
        const r = await authClient.twoFactor.enable({ password });
        if (r.error || !r.data || !('totpURI' in r.data)) return void toast.error(authError(r.error, 'Wrong password.'));
        const uri = r.data.totpURI;
        const secret = new URL(uri).searchParams.get('secret') ?? '';
        const qr = await QRCode.toDataURL(uri, { margin: 1, width: 200 });
        go({ kind: 'setup', secret, qr, codes: r.data.backupCodes });
      } else if (then === 'disable') {
        const r = await authClient.twoFactor.disable({ password });
        if (r.error) return void toast.error(authError(r.error, 'Wrong password.'));
        onChange(false);
        go({ kind: 'idle' });
        toast('Authenticator app off');
      } else {
        const r = await authClient.twoFactor.generateBackupCodes({ password });
        if (r.error || !r.data) return void toast.error(authError(r.error, 'Wrong password.'));
        go({ kind: 'codes', codes: r.data.backupCodes });
      }
    });

  const confirm = (codes: string[]) =>
    start(async () => {
      const r = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (r.error) return void toast.error(authError(r.error, 'Wrong code.'));
      onChange(true);
      go({ kind: 'codes', codes });
      toast.success('Authenticator app on');
    });

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Could not copy'),
    );

  return (
    <>
      <Row
        icon={enabled ? <ShieldCheck className="w-5 h-5 text-green-600" /> : <ShieldOff className="w-5 h-5 text-muted-foreground" />}
        title="Authenticator app"
        sub={enabled ? 'On. Password sign-in also asks for a code (or a backup code).' : 'Off. Turn on to ask for a 6-digit code after your password. Passkeys skip it.'}
        action={
          mode.kind === 'idle' ? (
            enabled ? (
              <button type="button" className={btnOutline} onClick={() => go({ kind: 'password', then: 'disable' })}>
                Turn off
              </button>
            ) : (
              <button type="button" className={btnPrimary} onClick={() => go({ kind: 'password', then: 'enable' })} disabled={pending}>
                Turn on
              </button>
            )
          ) : undefined
        }
      />

      {mode.kind === 'idle' && enabled && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 min-h-14">
          <span className="text-sm text-muted-foreground">Lost or used up your backup codes?</span>
          <button type="button" className={btnOutline} onClick={() => go({ kind: 'password', then: 'regen' })}>
            New codes
          </button>
        </div>
      )}

      {mode.kind === 'password' && (
        <form
          className="px-4 py-4 space-y-3"
          onSubmit={e => {
            e.preventDefault();
            if (password) withPassword(mode.then);
          }}
        >
          <p className="text-[13px] text-muted-foreground">
            {mode.then === 'enable'
              ? 'Enter your password to set up the authenticator app.'
              : mode.then === 'disable'
                ? 'Enter your password to turn the authenticator app off.'
                : 'Enter your password. Your old backup codes stop working.'}
          </p>
          <div className="flex items-center gap-2">
            <input className={field} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus aria-label="Your password" placeholder="Password" />
            <button type="submit" className={mode.then === 'disable' ? `${btn} bg-red-600 text-white` : btnPrimary} disabled={pending || !password}>
              {mode.then === 'disable' ? 'Turn off' : 'Continue'}
            </button>
          </div>
          <button type="button" className={`${btnOutline} w-full`} onClick={() => go({ kind: 'idle' })}>
            Cancel
          </button>
        </form>
      )}

      {mode.kind === 'setup' && (
        <div className="px-4 py-4 space-y-3">
          <p className="text-[13px] text-muted-foreground">1. In Google Authenticator, 1Password, Authy or similar, scan this code or enter the key by hand.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL QR code */}
          <img src={mode.qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-xl bg-white p-2" />
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono" data-totp-secret>
              {mode.secret}
            </code>
            <button type="button" className={iconBtn} onClick={() => copy(mode.secret)} aria-label="Copy key">
              <Copy className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[13px] text-muted-foreground">2. Enter the 6-digit code it shows.</p>
          <div className="flex items-center gap-2">
            <input
              className={`${field} tracking-widest`}
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && code && confirm(mode.codes)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={20}
              autoFocus
              aria-label="Code from your authenticator app"
            />
            <button type="button" className={btnPrimary} onClick={() => confirm(mode.codes)} disabled={pending || !code}>
              Confirm
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
            <strong>Save these backup codes now.</strong> Each one works once, instead of an app code. They are not shown again.
          </p>
          <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-muted px-4 py-3 font-mono text-[15px]" data-backup-codes>
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

// ── Password ────────────────────────────────────────────────────────────────

function Password({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ current: '', password: '', again: '' });
  const [pending, start] = useTransition();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const close = () => {
    setF({ current: '', password: '', again: '' });
    setOpen(false);
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (f.password.length < 10) return void toast.error('Use at least 10 characters.');
    if (f.password !== f.again) return void toast.error('The two new passwords do not match.');
    start(async () => {
      const r = await authClient.changePassword({ currentPassword: f.current, newPassword: f.password, revokeOtherSessions: true });
      if (r.error) return void toast.error(authError(r.error, 'Wrong password.'));
      close();
      toast.success('Password changed. Other devices were signed out.');
    });
  };

  return (
    <>
      <Row
        icon={<LockKeyhole className="w-5 h-5 text-amber-600" />}
        title="Password"
        sub={`For ${email}. Forgot it? Sign out and use "Forgot password?".`}
        action={
          !open ? (
            <button type="button" className={btnOutline} onClick={() => setOpen(true)}>
              Change
            </button>
          ) : undefined
        }
      />
      {open && (
        <form className="px-4 py-4 space-y-3" onSubmit={save}>
          <input type="text" name="username" value={email} autoComplete="username" readOnly hidden />
          <input className={field} type="password" value={f.current} onChange={set('current')} placeholder="Current password" autoComplete="current-password" required autoFocus aria-label="Current password" />
          <input className={field} type="password" value={f.password} onChange={set('password')} placeholder="New password (10+ characters)" autoComplete="new-password" required minLength={10} maxLength={256} aria-label="New password" />
          <input className={field} type="password" value={f.again} onChange={set('again')} placeholder="New password again" autoComplete="new-password" required minLength={10} maxLength={256} aria-label="New password again" />
          <p className="text-[13px] text-muted-foreground">Every other signed-in device will be signed out.</p>
          <div className="flex gap-2">
            <button type="button" className={`${btnOutline} flex-1`} onClick={close}>
              Cancel
            </button>
            <button type="submit" className={`${btnPrimary} flex-1`} disabled={pending}>
              Change password
            </button>
          </div>
        </form>
      )}
    </>
  );
}

// ── Email ───────────────────────────────────────────────────────────────────

function Email({ state }: { state: EmailState }) {
  const [pending, start] = useTransition();
  const send = () =>
    start(async () => {
      const r = await sendTestEmailAction();
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Test email sent to ${r.data}`);
    });
  return (
    <Row
      icon={<Mail className={`w-5 h-5 ${state.configured ? 'text-blue-600' : 'text-muted-foreground'}`} />}
      title="Email"
      sub={state.configured ? `Reset links and notices go to ${state.to}.` : `Off: set ${state.missing.join(', ')} on the server. Password reset by email needs it.`}
      action={
        state.configured ? (
          <button type="button" className={btnOutline} onClick={send} disabled={pending}>
            {pending ? 'Sending…' : 'Send test email'}
          </button>
        ) : undefined
      }
    />
  );
}
