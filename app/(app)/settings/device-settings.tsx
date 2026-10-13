'use client';

import { useEffect, useState, useTransition } from 'react';
import { Bell, BellOff, Download, Share, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { saveNotifySettingsAction, subscribePushAction, testNotificationAction, unsubscribePushAction } from './actions';
import type { NotifySettings } from '@/lib/notify';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

// Chrome fires beforeinstallprompt once, early; keep it for when Settings opens.
let deferredInstall: InstallEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e as InstallEvent;
  });
}

function urlB64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Env = { standalone: boolean; ios: boolean; android: boolean; pushSupported: boolean; permission: NotificationPermission | 'unsupported' };

function readEnv(): Env {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ua = navigator.userAgent;
  return {
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    ios: /iPhone|iPad|iPod/.test(ua),
    android: /Android/.test(ua),
    pushSupported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

/** Install the app on this device. */
export function InstallCard() {
  const [env, setEnv] = useState<Env | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setEnv(readEnv());
      setCanPrompt(!!deferredInstall);
    }, 0);
    const onPrompt = () => setTimeout(() => setCanPrompt(true), 0);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      clearTimeout(t);
      window.removeEventListener('beforeinstallprompt', onPrompt);
    };
  }, []);
  if (!env) return <Row icon={<Smartphone className="w-5 h-5" />} title="Install app" sub="Checking…" />;
  if (env.standalone) return <Row icon={<Smartphone className="w-5 h-5 text-green-600" />} title="Installed" sub="You're using the installed app." />;
  if (canPrompt)
    return (
      <Row
        icon={<Download className="w-5 h-5 text-blue-600" />}
        title="Install app"
        sub="Adds Work OS to your home screen; opens full screen."
        action={
          <button
            onClick={async () => {
              await deferredInstall?.prompt();
              const c = await deferredInstall?.userChoice;
              if (c?.outcome === 'accepted') setEnv(e => (e ? { ...e, standalone: true } : e));
              deferredInstall = null;
              setCanPrompt(false);
            }}
            className="h-9 px-4 rounded-full bg-foreground text-background text-sm font-semibold"
          >
            Install
          </button>
        }
      />
    );
  return (
    <Row
      icon={env.ios ? <Share className="w-5 h-5 text-blue-600" /> : <Download className="w-5 h-5 text-blue-600" />}
      title="Install app"
      sub={
        env.ios
          ? 'In Safari: tap Share → Add to Home Screen. Needed for notifications on iPhone.'
          : env.android
            ? 'Chrome menu (⋮) → Install app / Add to Home screen.'
            : 'Browser menu → Install Work OS (Chrome/Edge), or open this page on your phone.'
      }
    />
  );
}

/** Push notifications for this device. */
export function PushCard({ vapidKey, devices }: { vapidKey: string | null; devices: number }) {
  const [env, setEnv] = useState<Env | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    (async () => {
      const e = readEnv();
      let sub = false;
      if (e.pushSupported) {
        const reg = await navigator.serviceWorker.getRegistration();
        sub = !!(await reg?.pushManager.getSubscription());
      }
      if (alive) {
        setEnv(e);
        setSubscribed(sub);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const enable = () =>
    start(async () => {
      if (!vapidKey) return void toast.error('Push keys are not set on the server yet (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in Vercel).');
      const perm = await Notification.requestPermission();
      setEnv(e => (e ? { ...e, permission: perm } : e));
      if (perm !== 'granted') return void toast.error('Notifications were not allowed. Allow them in the phone settings for this app.');
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidKey) });
      const r = await subscribePushAction(sub.toJSON() as never, navigator.userAgent);
      if (!r.ok) return void toast.error(r.error);
      setSubscribed(true);
      toast.success('Notifications on for this device');
    });

  const disable = () =>
    start(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await unsubscribePushAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast('Notifications off for this device');
    });

  const test = () =>
    start(async () => {
      const r = await testNotificationAction();
      if (r.ok) toast.success(`Test sent: ${r.detail}`);
      else toast.error(r.error);
    });

  if (!env) return <Row icon={<Bell className="w-5 h-5" />} title="Notifications on this device" sub="Checking…" />;

  let sub: string;
  if (!env.pushSupported) sub = env.ios && !env.standalone ? 'On iPhone, install the app first (above), then open it from the home screen.' : 'This browser does not support push notifications.';
  else if (env.permission === 'denied') sub = 'Blocked. Allow notifications for Work OS in the phone settings, then come back.';
  else if (subscribed) sub = 'On. Alerts arrive even when the app is closed.';
  else sub = 'Off. Turn on to get alerts as phone notifications.';

  return (
    <>
      <Row
        icon={subscribed ? <Bell className="w-5 h-5 text-green-600" /> : <BellOff className="w-5 h-5 text-muted-foreground" />}
        title="Notifications on this device"
        sub={sub}
        action={
          env.pushSupported && env.permission !== 'denied' ? (
            <Switch on={subscribed} disabled={pending} onChange={v => (v ? enable() : disable())} />
          ) : undefined
        }
      />
      <div className="flex items-center justify-between px-4 h-14">
        <span className="text-sm text-muted-foreground">
          {devices} device{devices === 1 ? '' : 's'} receiving push
        </span>
        <button onClick={test} disabled={pending} className="h-9 px-4 rounded-full border border-border text-sm font-medium disabled:opacity-50">
          Send test
        </button>
      </div>
    </>
  );
}

/** Channels and alert types. */
export function NotifyPrefs({ initial, kinds, discordReady }: { initial: NotifySettings; kinds: { kind: string; label: string; hint: string }[]; discordReady: boolean }) {
  const [s, setS] = useState(initial);
  const [, start] = useTransition();
  const save = (next: NotifySettings) => {
    setS(next);
    start(async () => {
      const r = await saveNotifySettingsAction(next);
      if (!r.ok) toast.error(r.error);
    });
  };
  return (
    <>
      <Row title="In-app inbox" sub="Always on: the bell on Today and the Notifications screen." action={<Switch on disabled onChange={() => {}} />} />
      <Row title="Phone notifications" sub="Push to every device that turned them on." action={<Switch on={s.channels.push} onChange={v => save({ ...s, channels: { ...s.channels, push: v } })} />} />
      <Row
        title="Discord DMs"
        sub={discordReady ? 'From the Work OS bot.' : 'Discord bot not configured.'}
        action={<Switch on={s.channels.discord} disabled={!discordReady} onChange={v => save({ ...s, channels: { ...s.channels, discord: v } })} />}
      />
      {kinds.map(k => (
        <Row
          key={k.kind}
          title={k.label}
          sub={k.hint}
          action={<Switch on={s.kinds[k.kind as keyof NotifySettings['kinds']]} onChange={v => save({ ...s, kinds: { ...s.kinds, [k.kind]: v } })} />}
        />
      ))}
    </>
  );
}

export function Row({ icon, title, sub, action }: { icon?: React.ReactNode; title: string; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 min-h-14">
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-[15px] text-foreground">{title}</div>
        {sub && <div className="text-[13px] text-muted-foreground leading-snug">{sub}</div>}
      </div>
      {action}
    </div>
  );
}

function Switch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn('relative w-[51px] h-[31px] rounded-full transition-colors shrink-0 disabled:opacity-40', on ? 'bg-green-500' : 'bg-muted-foreground/30')}
    >
      <span className={cn('absolute top-[2px] left-[2px] w-[27px] h-[27px] rounded-full bg-white shadow transition-transform', on && 'translate-x-5')} />
    </button>
  );
}
