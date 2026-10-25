import { requireCaller } from '@/lib/caller';
import { colorFromHex } from '@/lib/modes';
import { getOrgModes } from '@/lib/org-modes';
import { Disclosure } from './ui';

/** Settings › Modes of work: the organization's modes, collapsed. */
export async function Help() {
  const me = await requireCaller();
  const modes = await getOrgModes(me.orgId);
  return (
    <div className="space-y-3" data-help>
      <p className="px-1 text-sm text-muted-foreground">{"Your organization's modes of work."}</p>

      <Disclosure title="Mode definitions" hint={`The ${modes.length} modes of work`}>
        <div className="space-y-2 -mx-1">
          {modes.map(mode => {
            const c = colorFromHex(mode.hex, mode.light);
            return (
              <div key={mode.name} className="rounded-2xl border p-4" style={{ backgroundColor: c.hex + '18', borderColor: c.hex + '40' }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.hex }} />
                  <span className="font-semibold text-sm" style={{ color: c.hex }}>{mode.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">RGB({c.rgb})</span>
                </div>
                {mode.description && <p className="text-sm text-foreground/70">{mode.description}</p>}
              </div>
            );
          })}
        </div>
      </Disclosure>
    </div>
  );
}
