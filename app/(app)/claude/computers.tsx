'use client';

import { Ago } from '@/components/ago';
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { Check, Copy, FolderGit2, KeyRound, Laptop, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DeviceInfo } from '@/lib/devices';
import { BottomSheet } from '@/components/mobile/sheet';
import { usePhone } from '@/components/mobile/use-phone';
import { ConfirmSheet } from '@/components/responsive-sheet';
import { needsReauth, useReauth } from '@/components/reauth';
import { createDeviceAction, listDevicesAction, replaceDeviceKeyAction, revokeDeviceAction, workerInstallInfoAction } from './setup-actions';
import { InstallCommands } from './worker-install';
import { ComputerFolders } from './computer-folders';
import { QuietFolders } from './quiet-folders';
import type { InstallInfo } from '@/lib/worker-install';

const field =
  'w-full min-w-0 h-11 rounded-xl border border-input bg-background dark:bg-input/30 px-3 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';
const btn = 'h-11 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';
const btnPrimary = `${btn} bg-foreground text-background`;
const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';

const online = (d: DeviceInfo) => !!d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < 2 * 60_000;

/** Claude › Set up › step 2: machines running the session-launcher worker (docs/launcher.md). `initial` is the server's list; it follows each refresh. */
export function Computers({ initial }: { initial?: DeviceInfo[] }) {
  const phone = usePhone();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<InstallInfo | null>(null);
  const [showUpdate, setShowUpdate] = useState<string | null>(null); // the computer whose manual update command is open
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<DeviceInfo | null>(null);
  const [replacing, setReplacing] = useState<DeviceInfo | null>(null);
  const [foldersOf, setFoldersOf] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const reauth = useReauth();

  // The page refreshes by itself while it waits for a computer; follow the list it brings.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    if (initial) setDevices(initial);
  }
  useEffect(() => {
    let alive = true;
    if (!initial)
      listDevicesAction().then(r => {
        if (!alive) return;
        if (r.ok) setDevices(r.data);
        else setError(r.error);
      });
    workerInstallInfoAction().then(r => alive && r.ok && setInfo(r.data));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once; later lists come through `initial`
  }, []);

  const create = () =>
    start(async () => {
      const n = name.trim();
      if (!n) return void toast.error('Name this PC, e.g. Work-PC');
      let r = await createDeviceAction(n);
      if (!r.ok && needsReauth(r.error) && (await reauth.ask())) r = await createDeviceAction(n);
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
      toast(`Removed "${d.name}"`);
    });

  const replaceKey = (d: DeviceInfo) =>
    start(async () => {
      let r = await replaceDeviceKeyAction(d.id);
      if (!r.ok && needsReauth(r.error) && (await reauth.ask())) r = await replaceDeviceKeyAction(d.id);
      setReplacing(null);
      if (!r.ok) return void toast.error(r.error);
      setDevices(r.data.devices);
      setFresh({ key: r.data.key, name: r.data.name });
    });

  const ask = (d: DeviceInfo) => setConfirm(d);

  return (
    <div className="space-y-4">
      {reauth.dialog}
      <div data-computers>
        <p className="text-sm text-muted-foreground mb-3">A small helper on your PC lets Claude start work there. It only sees folder names you link to projects.</p>
        <div className="rounded-2xl border border-border/70 divide-y divide-border/60 bg-card overflow-hidden">
          {error ? (
            <p className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : !devices ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No PC added yet.</p>
          ) : (
            devices.map(d => (
              <div key={d.id}>
              <div className="flex items-center gap-2 pl-4 pr-2 py-2 min-h-14" data-device={d.name}>
                <Laptop className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-[15px] md:text-sm text-foreground">
                    <span className="truncate">{d.name}</span>
                    <span className={`w-2 h-2 rounded-full shrink-0 ${online(d) ? 'bg-green-500' : 'bg-muted-foreground/40'}`} aria-label={online(d) ? 'online' : 'offline'} />
                  </div>
                  <div className="text-[13px] md:text-xs text-muted-foreground truncate" suppressHydrationWarning>
                    <code className="font-mono">{d.prefix}…</code> · {d.lastSeenAt ? <Ago iso={d.lastSeenAt} prefix="seen " /> : 'waiting for this PC to connect'}
                    {d.os ? ` · ${d.os === 'win32' ? 'Windows' : d.os === 'darwin' ? 'macOS' : d.os}` : ''}
                    {d.hooks ? ` · ${hooksText(d.hooks)}` : ''}
                  </div>
                  {d.version && <WorkerLine d={d} info={info} onUpdate={() => setShowUpdate(v => (v === d.id ? null : d.id))} />}
                </div>
                <button type="button" className={iconBtn} onClick={() => setFoldersOf(v => (v === d.id ? null : d.id))} aria-expanded={foldersOf === d.id} aria-label={`Folders on ${d.name}`} title="Folders and their projects">
                  <FolderGit2 className="w-4 h-4" />
                </button>
                <button type="button" className={iconBtn} onClick={() => setReplacing(d)} disabled={pending} aria-label={`Replace key for ${d.name}`} title="Replace key">
                  <KeyRound className="w-4 h-4" />
                </button>
                <button type="button" className={iconBtn} onClick={() => ask(d)} disabled={pending} aria-label={`Remove ${d.name}`} title="Remove">
                  <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
                </button>
              </div>
              {foldersOf === d.id && <ComputerFolders deviceId={d.id} />}
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
              placeholder="Name this PC, e.g. Work-PC"
              aria-label="Name for the new computer"
              enterKeyHint="done"
            />
            <button type="button" className={btnPrimary} onClick={create} disabled={pending}>
              <Plus className="w-4 h-4" /> Add this PC
            </button>
          </div>
        </div>
        <QuietFolders />
        {(() => {
          // Only for a worker from before self-update (it has no signature check yet: the command is its first install of
          // one). A worker that updates itself never gets the command here: after a refused or failed update it would
          // fetch the same file from the same server it just refused.
          const d = showUpdate && info ? devices?.find(x => x.id === showUpdate) : null;
          if (!d || !info || d.selfUpdate) return null;
          return (
            <div className="mt-3 rounded-lg border border-border/70 p-3 space-y-2" data-manual-update={d.name}>
              <p className="text-[13px] text-foreground">
                {`"${d.name}" runs a worker from before self-update. Run this on it once (its settings and key are kept: press Enter at each question); from then on it updates itself.`}
              </p>
              <InstallCommands info={info} />
            </div>
          );
        })()}
      </div>

      {fresh && !phone && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-4">
          <NewDevice fresh={fresh} info={info} onDone={() => setFresh(null)} />
        </div>
      )}
      {fresh && phone && (
        <BottomSheet title={`Key for "${fresh.name}"`} onClose={() => setFresh(null)}>
          <div className="pt-1 pb-2">
            <NewDevice fresh={fresh} info={info} onDone={() => setFresh(null)} />
          </div>
        </BottomSheet>
      )}
      {replacing && (
        <ConfirmSheet
          title="Replace key"
          message={<>Make a new key for &quot;{replacing.name}&quot;? Its folder links and sessions stay. The old key stops working at once, so its worker is offline until you run setup with the new key.</>}
          verb="Replace key"
          pending={pending}
          onConfirm={() => replaceKey(replacing)}
          onClose={() => setReplacing(null)}
        />
      )}
      {confirm && (
        <ConfirmSheet
          title="Remove computer"
          message={<>Remove &quot;{confirm.name}&quot;? Its helper stops at once; folder links and history stay.</>}
          verb="Remove"
          danger
          pending={pending}
          onConfirm={() => revoke(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** What a computer's row says about its Claude Code hooks (Work OS brief, stop check, WORK-STATE.md copy). */
function hooksText(h: NonNullable<DeviceInfo['hooks']>): string {
  if (h.events < 4) return 'no hooks';
  return h.stale ? 'hooks out of date' : 'hooks on';
}

/** A downloaded worker other than the one this site serves (repo runs and not-yet-reported ones never show it). */
/**
 * What a self-update problem (worker/update.mjs: "update refused: <why>" or "update failed: <why>") tells the person. A
 * refusal means the server offered a release the worker's own keys did not sign (or an older one): never reinstall from
 * that server, tell Om. A failure (network, disk) clears itself: the worker tries again.
 */
function updateProblem(problem: string): { kind: 'refused' | 'failed'; text: string } {
  const failed = /^update failed: (.+)$/.exec(problem);
  if (failed) return { kind: 'failed', text: `update failed: ${failed[1]}; it will try again` };
  const older = /^update refused: version (\S+) is not newer/.exec(problem);
  if (older) return { kind: 'refused', text: `Update refused: Work OS offered an older release (${older[1]}). Don't reinstall; tell Om.` };
  return { kind: 'refused', text: "Update refused: this release isn't signed by Delpat. Don't reinstall; tell Om." };
}

const stale = (d: DeviceInfo, info: InstallInfo | null) =>!!info && !!d.bundle && d.bundle !== info.sha256.slice(0, 12);

/**
 * The row's second line: the worker version and how it updates (worker/update.mjs). A downloaded worker from 0.5.0 on
 * updates itself to signed releases; an older one needs the install command once; a repo run never updates itself.
 */
function WorkerLine({ d, info, onUpdate }: { d: DeviceInfo; info: InstallInfo | null; onUpdate: () => void }) {
  const link = 'underline underline-offset-2 text-left';
  const u = d.selfUpdate;
  let tail: ReactNode = null;
  if (!d.bundle) tail = 'from the repo';
  else if (u?.problem) {
    // No install command after a refusal or a failure: its file and checksum come from the same server.
    const p = updateProblem(u.problem);
    tail = (
      <span className="text-red-600 dark:text-red-400" data-update-problem={p.kind}>
        {p.text}
      </span>
    );
  }
  else if (u && stale(d, info)) tail = `updates itself to ${info?.version} within 6 hours`;
  else if (u?.updatedAt) tail = <Ago iso={u.updatedAt} prefix="updated itself " />;
  else if (u) tail = 'updates itself';
  else if (stale(d, info))
    tail = (
      <button type="button" className={`${link} text-foreground`} onClick={onUpdate}>
        update available
      </button>
    );
  return (
    // Wraps instead of truncating: a refusal must be readable and tappable at 390 px.
    <div className="text-[13px] md:text-xs text-muted-foreground break-words" data-worker-line suppressHydrationWarning>
      Worker {d.version}
      {tail && <> · {tail}</>}
    </div>
  );
}

function NewDevice({ fresh, info, onDone }: { fresh: { key: string; name: string }; info: InstallInfo | null; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
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
        <strong>Copy this key now.</strong> It is not shown again; if you lose it, use Replace key on that computer.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono">{fresh.key}</code>
        <button type="button" className={iconBtn} onClick={copy} aria-label="Copy key">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[13px] text-muted-foreground">On that computer, paste this into a terminal, then paste the key when it asks (the key is never part of the command):</p>
      {info ? <InstallCommands info={info} /> : <p className="text-[13px] text-muted-foreground">Loading the install command…</p>}
      <button type="button" className={`${btnPrimary} w-full`} onClick={onDone}>
        I saved it
      </button>
    </div>
  );
}
