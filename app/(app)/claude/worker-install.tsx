'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { installCommands, type InstallInfo } from '@/lib/worker-install';

const iconBtn = 'w-11 h-11 rounded-full flex items-center justify-center text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0';
const tabBtn = (on: boolean) => `h-9 px-3 rounded-full text-[13px] font-medium ${on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted/40'}`;

/** The copy-paste install command per OS (lib/worker-install.ts). Used for a new computer and for an update. */
export function InstallCommands({ info }: { info: InstallInfo }) {
  const [os, setOs] = useState<'windows' | 'mac'>('windows');
  const [copied, setCopied] = useState(false);
  let cmds: ReturnType<typeof installCommands> | null = null;
  try {
    cmds = installCommands(info);
  } catch {
    cmds = null;
  }
  if (!cmds) return <p className="text-[13px] text-muted-foreground">The install command could not be made (the site address is not set on the server).</p>;
  const cmd = cmds[os];
  const copy = () =>
    navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error('Could not copy'),
    );
  return (
    <div className="space-y-2" data-install-commands>
      <div className="flex items-center gap-1" role="group" aria-label="Operating system">
        <button type="button" className={tabBtn(os === 'windows')} aria-pressed={os === 'windows'} onClick={() => setOs('windows')}>
          Windows (PowerShell)
        </button>
        <button type="button" className={tabBtn(os === 'mac')} aria-pressed={os === 'mac'} onClick={() => setOs('mac')}>
          macOS (Terminal)
        </button>
      </div>
      <div className="flex items-start gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg bg-muted px-3 py-2 text-[13px] font-mono max-h-40 overflow-y-auto" data-install-command={os}>
          {cmd}
        </code>
        <button type="button" className={iconBtn} onClick={copy} aria-label="Copy command">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Needs Node 22 or newer and Claude Code on that computer; setup checks both and says what is missing. The command downloads the worker to a folder of your own, checks it against this checksum (
        <code className="font-mono break-all">{info.sha256.slice(0, 16)}…</code>, version {info.version}), and asks for the key. The checksum only catches a damaged download; it comes from this same site. Linux is not supported yet.
      </p>
    </div>
  );
}
