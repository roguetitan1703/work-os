'use client';

import { useEffect, useState, useTransition } from 'react';
import { Check, Copy, Laptop, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DeviceInfo } from '@/lib/devices';
import { BottomSheet } from '@/components/mobile/sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { fmtAgo } from '@/lib/format';
import { Disclosure, Section } from './ui';
import { createDeviceAction, listDevicesAction, revokeDeviceAction } from './actions';

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';
const btnPrimary = `${btn} bg-foreground text-background`;
const btnOutline = `${btn} border border-border text-foreground font-medium`;
const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';

const online = (d: DeviceInfo) => !!d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < 2 * 60_000;

/** Connect → Devices: machines running the session-launcher worker (docs/launcher.md). */
export function DevicesTab() {
  const phone = usePhone();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<DeviceInfo | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    listDevicesAction().then(r => {
      if (!alive) return;
      if (r.ok) setDevices(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  const create = () =>
    start(async () => {
      const n = name.trim();
      if (!n) return void toast.error('Name the device, e.g. Om-PC');
      const r = await createDeviceAction(n);
      if (!r.ok) return void toast.error(r.error);
      setDevices(r.data.devices);
      setFresh({ key: r.data.key, name: n });
      setName('');
    });

  const revoke = (d: DeviceInfo) =>
    start(async () => {
      const r = await revokeDeviceAction(d.id);
      if (!r.ok) return void toast.error(r.error);
      setDevices(r.data);
      setConfirm(null);
      toast(`Revoked "${d.name}"`);
    });

  const ask = (d: DeviceInfo) => {
    if (phone) return setConfirm(d);
    if (window.confirm(`Revoke "${d.name}"? Its worker stops at once; links and history stay.`)) revoke(d);
  };

  return (
    <div className="space-y-4">
      <Section title="Devices">
        <p className="text-sm text-muted-foreground mb-3">
          Computers that can open Claude Code sessions for you. Each runs a small worker that checks Work OS for Start / Resume / Stop and reports which folders it has (names only, never paths).
        </p>
        <div className="rounded-2xl border border-border/70 divide-y divide-border/60 bg-card overflow-hidden">
          {error ? (
            <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : !devices ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No devices yet.</p>
          ) : (
            devices.map(d => (
              <div key={d.id} className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14" data-device={d.name}>
                <Laptop className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[15px] md:text-sm text-foreground">
                    <span className="truncate">{d.name}</span>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${online(d) ? 'bg-green-500' : 'bg-muted-foreground/40'}`} aria-label={online(d) ? 'online' : 'offline'} />
                  </div>
                  <div className="text-[13px] md:text-xs text-muted-foreground truncate" suppressHydrationWarning>
                    <code className="font-mono">{d.prefix}…</code> · {d.lastSeenAt ? `seen ${fmtAgo(d.lastSeenAt)}` : 'worker not connected yet'}
                    {d.os ? ` · ${d.os === 'win32' ? 'Windows' : d.os === 'darwin' ? 'macOS' : d.os}` : ''}
                  </div>
                </div>
                <button type="button" className={iconBtn} onClick={() => ask(d)} disabled={pending} aria-label={`Revoke ${d.name}`} title="Revoke">
                  <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                </button>
              </div>
            ))
          )}
          <div className="flex items-center gap-2 px-4 py-3">
            <input
              className={field}
              value={name}
              maxLength={40}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !pending && create()}
              placeholder="Device name, e.g. Om-PC"
              aria-label="Name for the new device"
              enterKeyHint="done"
            />
            <button type="button" className={btnPrimary} onClick={create} disabled={pending}>
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        </div>
      </Section>

      <Disclosure title="What a device can do" hint="Limits and safety">
        <p>
          A device key (<code>wkr_…</code>) only opens the worker endpoints: report folder names, read Start / Resume / Stop jobs for that device, report session status. It can&apos;t read or change tasks,
          notes or projects. The worker only starts <code>claude</code> in folders you linked, in normal permission mode; you give instructions from the Claude app. Revoke here, or set <code>enabled: false</code>{' '}in the worker&apos;s config, to stop it.
        </p>
      </Disclosure>

      {fresh && !phone && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-4">
          <NewDevice fresh={fresh} onDone={() => setFresh(null)} />
        </div>
      )}
      {fresh && phone && (
        <BottomSheet title={`Key for "${fresh.name}"`} onClose={() => setFresh(null)}>
          <div className="pt-1 pb-2">
            <NewDevice fresh={fresh} onDone={() => setFresh(null)} />
          </div>
        </BottomSheet>
      )}
      {confirm && (
        <BottomSheet title="Revoke device" onClose={() => setConfirm(null)}>
          <div className="space-y-4 pt-1 pb-2">
            <p className="text-[15px] text-foreground">Revoke &quot;{confirm.name}&quot;? Its worker stops at once; links and history stay.</p>
            <div className="flex gap-2">
              <button type="button" className={`${btnOutline} flex-1`} onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className={`${btn} flex-1 bg-red-600 text-white`} onClick={() => revoke(confirm)} disabled={pending}>
                Revoke
              </button>
            </div>
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

const SETUP_CMD = 'node worker/worker.mjs setup';

function NewDevice({ fresh, onDone }: { fresh: { key: string; name: string }; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const copyCmd = () =>
    navigator.clipboard?.writeText(SETUP_CMD).then(
      () => {
        setCopiedCmd(true);
        setTimeout(() => setCopiedCmd(false), 1500);
      },
      () => toast.error('Could not copy'),
    );
  const copy = () =>
    navigator.clipboard?.writeText(fresh.key).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy'),
    );
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-foreground">
        <strong>Copy this key now.</strong> It is not shown again; if you lose it, revoke the device and add it again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono">{fresh.key}</code>
        <button type="button" className={iconBtn} onClick={copy} aria-label="Copy key">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[13px] text-muted-foreground">On that computer, from the work-os repo, run:</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono">{SETUP_CMD}</code>
        <button type="button" className={iconBtn} onClick={copyCmd} aria-label="Copy command">
          {copiedCmd ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[13px] text-muted-foreground">Paste the key when asked.</p>
      <button type="button" className={`${btnPrimary} w-full`} onClick={onDone}>
        I saved it
      </button>
    </div>
  );
}
