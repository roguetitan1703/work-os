import { MODES } from '@/lib/modes';
import { Disclosure } from './ui';

/** Help and recovery: what to do when the day breaks. Static text, every part collapsed. */
export function Help() {
  return (
    <div className="space-y-3" data-help>
      <p className="px-1 text-sm text-muted-foreground">What to do when the day breaks.</p>

      <Disclosure title="Mode definitions" hint="The eight modes of work">
        <div className="space-y-2 -mx-1">
          {MODES.map(mode => (
            <div key={mode.name} className="rounded-2xl border p-4" style={{ backgroundColor: mode.hex + '18', borderColor: mode.hex + '40' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: mode.hex }} />
                <span className="font-semibold text-sm" style={{ color: mode.hex }}>{mode.name}</span>
                <span className="font-mono text-xs text-muted-foreground">RGB({mode.rgb})</span>
              </div>
              <p className="text-sm text-foreground/70">{mode.description}</p>
            </div>
          ))}
        </div>
      </Disclosure>

      <Disclosure title="Core principles" hint="Four rules">
        <ul className="space-y-3 text-[15px] text-foreground/80">
          <li className="flex gap-2"><span className="text-muted-foreground shrink-0">1.</span><span><strong>Lost time stays lost.</strong> Don&apos;t try to compress 3 blocks into 2 to make up. Just continue from wherever you are.</span></li>
          <li className="flex gap-2"><span className="text-muted-foreground shrink-0">2.</span><span><strong>Extension token.</strong> Once per week you may extend a block by 30 min max. Use it on Code &amp; Dev or Client Delivery only. Log it in Weekly Review.</span></li>
          <li className="flex gap-2"><span className="text-muted-foreground shrink-0">3.</span><span><strong>Phone after 21:00.</strong> No doom-scroll during work blocks. Phone lives face-down until 21:00.</span></li>
          <li className="flex gap-2"><span className="text-muted-foreground shrink-0">4.</span><span><strong>Max 3 P1s per day.</strong> If you have more than 3, downgrade. P1 means &quot;must ship today or the business is hurt.&quot;</span></li>
        </ul>
      </Disclosure>

      <Disclosure title="Failure modes" hint="Meeting overrun, slept late, sick day">
        <div className="space-y-3 text-[15px]">
          <FailureMode title="Meeting overrun">End the call. Hard stop. If the other party isn&apos;t done: &quot;I need to wrap, let&apos;s continue async or schedule a follow-up.&quot; The meeting cap is 2 hours. A 3rd meeting moves to tomorrow.</FailureMode>
          <FailureMode title="Slept late">Start at whatever time you wake up. Begin with Morning Setup regardless of clock. Skip no block, just compress duration proportionally if needed. Don&apos;t skip Fiverr Ritual.</FailureMode>
          <FailureMode title="Block runs hot (deep flow, can't stop)">Use your extension token (once per week, 30 min max). If already used: stop at the block end. Log the overflow task as a P1 for tomorrow.</FailureMode>
          <FailureMode title="P0 emergency">Declare it. Drop into Code &amp; Dev mode regardless of schedule block. Work until resolved. Then resume from wherever the clock says you are. Log in Weekly Review.</FailureMode>
          <FailureMode title="Sick day">Don&apos;t try to work. Rest. Mark the day broken. If 2+ sick days in a week, update the review and adjust the coming week&apos;s P1s accordingly.</FailureMode>
        </div>
      </Disclosure>

      <Disclosure title="Broken day thresholds" hint="1, 2, 3+ broken days a week">
        <div className="-mx-4 -my-4 text-sm">
          <table className="w-full">
            <thead className="bg-muted text-xs text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Broken days / week</th>
                <th className="px-4 py-2 text-left">Response</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t"><td className="px-4 py-3 font-medium text-green-600 dark:text-green-400">1</td><td className="px-4 py-3 text-foreground/70">Normal. Log it, move on.</td></tr>
              <tr className="border-t"><td className="px-4 py-3 font-medium text-amber-600 dark:text-amber-400">2</td><td className="px-4 py-3 text-foreground/70">Investigate. What broke? Fix the environment, not your willpower.</td></tr>
              <tr className="border-t"><td className="px-4 py-3 font-medium text-red-600 dark:text-red-400">3+</td><td className="px-4 py-3 text-foreground/70">System failure. Do a full weekly review. Restructure blocks before next Monday.</td></tr>
            </tbody>
          </table>
        </div>
      </Disclosure>
    </div>
  );
}

function FailureMode({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card text-card-foreground p-4">
      <div className="font-semibold mb-1">{title}</div>
      <div className="text-foreground/70">{children}</div>
    </div>
  );
}
