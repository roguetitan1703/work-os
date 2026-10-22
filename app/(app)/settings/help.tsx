import { requireCaller } from '@/lib/caller';
import { colorFromHex } from '@/lib/modes';
import { getOrgModes } from '@/lib/org-modes';
import { getSchedule } from '@/lib/user-schedule';
import { Disclosure } from './ui';

/**
 * Help and recovery: the organization's modes of work, then the person's own help sections (their schedule's `help`:
 * principles, what to do when the day breaks). Every part collapsed.
 */
export async function Help() {
  const me = await requireCaller();
  const [modes, schedule] = await Promise.all([getOrgModes(me.orgId), getSchedule(me)]);
  return (
    <div className="space-y-3" data-help>
      <p className="px-1 text-sm text-muted-foreground">{schedule.help.length ? 'Your modes of work and what to do when the day breaks.' : "Your organization's modes of work."}</p>

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

      {schedule.help.map(sec => (
        <Disclosure key={sec.title} title={sec.title} hint={sec.hint}>
          {sec.items.every(i => !i.title) ? (
            <ol className="space-y-3 text-[15px] text-foreground/80 list-decimal pl-5">
              {sec.items.map((i, n) => (
                <li key={n}>{i.text}</li>
              ))}
            </ol>
          ) : (
            <div className="space-y-3 text-[15px]">
              {sec.items.map((i, n) => (
                <div key={n} className="rounded-2xl border border-border/70 bg-card text-card-foreground p-4">
                  {i.title && <div className="font-semibold mb-1">{i.title}</div>}
                  <div className="text-foreground/70">{i.text}</div>
                </div>
              ))}
            </div>
          )}
        </Disclosure>
      ))}
    </div>
  );
}
