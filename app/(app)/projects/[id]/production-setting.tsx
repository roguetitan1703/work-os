'use client';

import { useState, useTransition } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { setProductionAction } from '@/app/actions';
import { ResponsiveSheet } from '@/components/responsive-sheet';
import { Checkbox } from '@/components/ui/checkbox';
import { productionSummary, type ProductionView } from '@/lib/production-view';

const iconBtn = 'h-11 md:h-8 px-3 rounded-full inline-flex items-center justify-center gap-1 text-[13px] font-medium text-muted-foreground active:bg-muted/60 hover:bg-muted/40 shrink-0 disabled:opacity-50';
const btn = 'h-11 md:h-9 px-4 rounded-full text-sm font-semibold shrink-0 disabled:opacity-50 inline-flex items-center justify-center gap-1.5';
const area =
  'w-full min-w-0 rounded-xl md:rounded-md border border-input bg-background dark:bg-input/30 px-3 py-2 text-base md:text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 font-mono';
const lines = (xs: string[]) => xs.join('\n');
const split = (s: string) => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean);

/**
 * Production: what the Work OS hook treats as this project's production (H8, docs/flows/agent-system.md section 10). An agent
 * needs the owner's yes (a release Need) to push, tag or release there, or to run a production command. One row like the
 * repository rows, one Change button, the same sheet as the other settings. Set here only, never by an agent.
 */
export function ProductionSetting({ projectId, initial }: { projectId: string; initial: ProductionView }) {
  const [view, setView] = useState<ProductionView>(initial);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1.5" data-part="production">
      <h3 className="text-[13px] md:text-xs font-semibold text-foreground px-1 md:px-0">Production</h3>
      <p className="text-[13px] md:text-xs text-muted-foreground px-1 md:px-0">Agents need your yes (a release Need) to push or release here.</p>
      <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card overflow-hidden">
        <div className="flex items-center gap-2 pl-4 md:pl-3 pr-1 py-1.5 min-h-14 md:min-h-11" data-production-row>
          <ShieldCheck className="w-4 h-4 md:w-3.5 md:h-3.5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[15px] md:text-sm break-words" data-production-summary>{productionSummary(view)}</div>
            <div className="text-[13px] md:text-xs text-muted-foreground truncate">{view.off ? 'No block on this project' : view.isDefault ? 'Default' : 'Set by you'}</div>
          </div>
          <button type="button" className={iconBtn} onClick={() => setOpen(true)} data-production-change>
            Change
          </button>
        </div>
      </div>
      {open && <ProductionSheet projectId={projectId} view={view} onSaved={v => { setView(v); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ProductionSheet({ projectId, view, onSaved, onClose }: { projectId: string; view: ProductionView; onSaved: (v: ProductionView) => void; onClose: () => void }) {
  const [branches, setBranches] = useState(lines(view.branches));
  const [remotes, setRemotes] = useState(lines(view.remotes));
  const [targets, setTargets] = useState(lines(view.targets));
  const [off, setOff] = useState(view.off);
  const [pending, start] = useTransition();

  const run = (input: Parameters<typeof setProductionAction>[1]) =>
    start(async () => {
      const r = await setProductionAction(projectId, input);
      if (!r.ok) return void toast.error(r.error);
      toast(input === null ? 'Production back to the default' : 'Production saved');
      onSaved(r.data);
    });

  return (
    <ResponsiveSheet title="Production" onClose={onClose}>
      <div className="space-y-3 pb-2" data-production-sheet>
        <p className="text-[13px] md:text-xs text-muted-foreground">A push, tag or release to these, or a production command, waits for your yes on a release Need. Everything else is untouched.</p>
        <label className="flex items-center gap-2 min-h-11 md:min-h-9 text-[15px] md:text-sm">
          <Checkbox checked={off} onCheckedChange={v => setOff(v === true)} data-production-off aria-label="No production here" />
          No production here
        </label>
        <div className={off ? 'space-y-3 opacity-50 pointer-events-none' : 'space-y-3'}>
          <label className="block space-y-1">
            <span className="text-[13px] md:text-xs font-semibold text-foreground">Branches (one per line)</span>
            <textarea className={area} rows={2} value={branches} onChange={e => setBranches(e.target.value)} placeholder="main" aria-label="Branches" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="block space-y-1">
            <span className="text-[13px] md:text-xs font-semibold text-foreground">Repositories (owner/repo, one per line)</span>
            <textarea className={area} rows={2} value={remotes} onChange={e => setRemotes(e.target.value)} placeholder="owner/repo" aria-label="Repositories" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="block space-y-1">
            <span className="text-[13px] md:text-xs font-semibold text-foreground">Command targets (Supabase project refs, one per line)</span>
            <textarea className={area} rows={2} value={targets} onChange={e => setTargets(e.target.value)} placeholder="None" aria-label="Command targets" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </label>
        </div>
        <div className="flex gap-2">
          <button type="button" className={`${btn} flex-1 border border-border text-foreground font-medium`} onClick={() => run(null)} disabled={pending} data-production-default>
            Use the default
          </button>
          <button type="button" className={`${btn} flex-1 bg-foreground text-background`} onClick={() => run({ branches: split(branches), remotes: split(remotes), targets: split(targets), ...(off ? { off: true } : {}) })} disabled={pending} data-production-save>
            Save
          </button>
        </div>
      </div>
    </ResponsiveSheet>
  );
}
