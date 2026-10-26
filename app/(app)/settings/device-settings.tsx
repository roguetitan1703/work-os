'use client';

import { useEffect, useState, useTransition } from 'react';
import { Bell, BellOff, Download, Share, Smartphone } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { listPushDevicesAction, removePushDeviceAction, saveNotifySettingsAction, subscribePushAction, testNotificationAction, unsubscribePushAction, type PushDevice } from './actions';
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
            : 'Put Work OS on your phone: open this page on the phone, then Share or the browser menu, Add to Home Screen.'
      }
    />
  );
}

/** Push notifications for this device. */
export function PushCard({ vapidKey, devices }: { vapidKey: string | null; devices: number }) {
  const [env, setEnv] = useState<Env | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [list, setList] = useState<PushDevice[] | null>(null);
  const [pending, start] = useTransition();

  const thisEndpoint = async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      return (await reg?.pushManager.getSubscription())?.endpoint;
    } catch {
      return undefined;
    }
  };
  const loadList = async () => {
    const r = await listPushDevicesAction(await thisEndpoint());
    if (r.ok) setList(r.data);
  };
  const removeDevice = (d: PushDevice) =>
    start(async () => {
      const r = await removePushDeviceAction(d.id);
      if (!r.ok) toast.error(r.error);
      else {
        if (d.current) {
          const reg = await navigator.serviceWorker.getRegistration();
          await (await reg?.pushManager.getSubscription())?.unsubscribe();
          setSubscribed(false);
        }
        toast('Removed. It will not get alerts any more.');
      }
      await loadList();
    });

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
      const r = await listPushDevicesAction(await thisEndpoint());
      if (alive && r.ok) setList(r.data);
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
      void loadList();
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
      void loadList();
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
  else if (env.permission === 'denied') sub = 'Notifications are blocked on this phone. Allow them in the phone settings, then press Send test.';
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
            <Switch label="Notifications on this device" on={subscribed} disabled={pending} onChange={v => (v ? enable() : disable())} />
          ) : undefined
        }
      />
      <div className="px-4 py-2" data-push-devices>
        <div className="text-sm text-muted-foreground mb-1">
          {(list?.length ?? devices) === 0 ? 'No phone is set up for alerts yet' : `${list?.length ?? devices} device${(list?.length ?? devices) === 1 ? '' : 's'} receiving push`}
        </div>
        {(list ?? []).map(d => (
          <div key={d.id} data-push-device={d.id} className="flex items-center gap-2 min-h-11 py-1">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] text-foreground truncate">
                {d.device}
                {d.current && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">this browser</span>}
              </div>
              <div className="text-[12px] text-muted-foreground" suppressHydrationWarning>Added {new Date(d.addedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</div>
            </div>
            <button type="button" onClick={() => removeDevice(d)} disabled={pending} aria-label={`Remove ${d.device}`} className="h-9 px-3 rounded-full border border-border text-[13px] font-medium disabled:opacity-50">
              Remove
            </button>
          </div>
        ))}
        {list && list.length > 0 && <p className="text-[12px] text-muted-foreground pt-1">Remove a device you no longer use, or one that was set up on an old address of Work OS.</p>}
      </div>
      <div className="flex items-center justify-end px-4 h-14">
        <button onClick={test} disabled={pending} className="h-9 px-4 rounded-full border border-border text-sm font-medium disabled:opacity-50">
          Send test
        </button>
      </div>
    </>
  );
}

const INBOX_ONLY = new Set(['claude_code_changes', 'claude_waiting']);

/** Alerts as one labelled table: each alert kind (switch) by where it is delivered. Channel switches sit in the first row. */
export function AlertsTable({
  initial,
  kinds,
  discordReady,
  pushReady,
  devices,
}: {
  initial: NotifySettings;
  kinds: { kind: string; label: string; hint: string }[];
  discordReady: boolean;
  pushReady: boolean;
  devices: number;
}) {
  const [s, setS] = useState(initial);
  const [, start] = useTransition();
  const save = (next: NotifySettings) => {
    setS(next);
    start(async () => {
      const r = await saveNotifySettingsAction(next);
      if (!r.ok) toast.error(r.error);
    });
  };
  const pushOn = s.channels.push && pushReady;
  const discordOn = s.channels.discord && discordReady;
  const mark = (on: boolean, label: string) => (
    <span role="img" aria-label={`${label}: ${on ? 'delivered' : 'not delivered'}`} className={cn('text-base font-semibold', on ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground/50')}>
      {on ? '✓' : '–'}
    </span>
  );
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse" aria-label="Alerts by channel">
          <thead>
            <tr className="text-[13px] text-muted-foreground">
              <th scope="col" className="pl-4 pr-2 py-2 font-medium">Alert</th>
              <th scope="col" className="w-14 px-1 py-2 text-center font-medium">In-app</th>
              <th scope="col" className="w-14 px-1 py-2 text-center font-medium">Push</th>
              <th scope="col" className="w-16 pr-3 pl-1 py-2 text-center font-medium">Discord</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60 border-t border-border/60">
            <tr>
              <th scope="row" className="pl-4 pr-2 py-2 text-[15px] font-medium">
                Send to
                <span className="block text-[13px] font-normal text-muted-foreground leading-snug">Channel on or off</span>
              </th>
              <td className="px-1 text-center">
                <div className="flex justify-center"><Switch label="In-app inbox" on disabled onChange={() => {}} /></div>
              </td>
              <td className="px-1 text-center">
                <div className="flex justify-center"><Switch label="Phone notifications (push)" on={s.channels.push} onChange={v => save({ ...s, channels: { ...s.channels, push: v } })} /></div>
              </td>
              <td className="pr-3 pl-1 text-center">
                <div className="flex justify-center"><Switch label="Discord DMs" on={s.channels.discord} disabled={!discordReady} onChange={v => save({ ...s, channels: { ...s.channels, discord: v } })} /></div>
              </td>
            </tr>
            {kinds.map(k => {
              const on = s.kinds[k.kind as keyof NotifySettings['kinds']];
              const inboxOnly = INBOX_ONLY.has(k.kind);
              return (
                <tr key={k.kind}>
                  <th scope="row" className="pl-4 pr-2 py-2 font-normal">
                    <div className="flex items-center gap-3">
                      <Switch label={k.label} on={on} onChange={v => save({ ...s, kinds: { ...s.kinds, [k.kind]: v } })} />
                      <div className="min-w-0">
                        <div className="text-[15px] text-foreground">{k.label}</div>
                        <div className="text-[13px] text-muted-foreground leading-snug">{k.hint}</div>
                      </div>
                    </div>
                  </th>
                  <td className="px-1 text-center">{mark(on, `${k.label} in-app`)}</td>
                  <td className="px-1 text-center">{mark(on && !inboxOnly && pushOn, `${k.label} push`)}</td>
                  <td className="pr-3 pl-1 text-center">{mark(on && !inboxOnly && discordOn, `${k.label} Discord`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="px-4 py-3 text-[13px] text-muted-foreground space-y-1 leading-snug">
        <li><b>In-app:</b> always on. The Inbox is where every alert lands.</li>
        <li>
          <b>Push:</b>{' '}
          {!pushReady ? 'not set up on the server (VAPID keys missing).' : !s.channels.push ? 'switched off above.' : devices === 0 ? 'on, but no device has turned it on yet (This device).' : `on, ${devices} device${devices === 1 ? '' : 's'} receiving.`}
        </li>
        <li>
          <b>Discord:</b> {!discordReady ? 'the Discord bot is not set up (Connections).' : s.channels.discord ? 'on, sent as a direct message from the bot.' : 'switched off above.'}
        </li>
        <li>Claude Code changes and questions from Claude are inbox-only.</li>
      </ul>
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

const noop = () => () => {};

/** Light / Dark / Auto as three buttons: the choice is visible and the first click always changes something. */
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const cur = mounted ? theme ?? 'system' : null;
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-full bg-muted/70 p-1 gap-1">
      {([['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']] as const).map(([v, label]) => (
        <button
          key={v}
          role="radio"
          aria-checked={cur === v}
          onClick={() => setTheme(v)}
          className={cn('h-9 min-w-14 px-3 rounded-full text-sm font-medium', cur === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn('relative w-[51px] h-[31px] rounded-full transition-colors shrink-0 disabled:opacity-40', on ? 'bg-green-500' : 'bg-muted-foreground/30')}
    >
      <span className={cn('absolute top-[2px] left-[2px] w-[27px] h-[27px] rounded-full bg-white shadow transition-transform', on && 'translate-x-5')} />
    </button>
  );
}
