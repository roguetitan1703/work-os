import { MODES } from '@/lib/modes';
import { SubHeader } from '@/components/mobile/sub-header';

export const metadata = { title: 'Recovery · Work OS' };

export default function RecoveryPage() {
  return (
    <div className="space-y-8 max-w-2xl">
      <SubHeader title="Recovery" subtitle="What to do when the day breaks." />
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold text-foreground">Recovery</h1>
        <p className="text-sm text-muted-foreground mt-0.5">What to do when the day breaks.</p>
      </div>

      <section className="space-y-2 md:space-y-3">
        <h2 className="px-1 md:px-0 text-[13px] md:text-lg font-semibold uppercase md:normal-case tracking-wider md:tracking-normal text-muted-foreground md:text-foreground">Mode Definitions</h2>
        <div className="space-y-2">
          {MODES.map(mode => (
            <div
              key={mode.name}
              className="rounded-2xl md:rounded-lg border p-4 md:p-3"
              style={{ backgroundColor: mode.hex + '18', borderColor: mode.hex + '40' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: mode.hex }} />
                <span className="font-semibold text-sm" style={{ color: mode.hex }}>{mode.name}</span>
                <span className="font-mono text-xs text-muted-foreground">RGB({mode.rgb})</span>
              </div>
              <p className="text-sm text-foreground/70">{mode.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2 md:space-y-3">
        <h2 className="px-1 md:px-0 text-[13px] md:text-lg font-semibold uppercase md:normal-case tracking-wider md:tracking-normal text-muted-foreground md:text-foreground">Core Principles</h2>
        <ul className="space-y-3 md:space-y-2 text-[15px] md:text-sm text-foreground/80 rounded-2xl md:rounded-none border border-border/70 md:border-0 bg-card md:bg-transparent p-4 md:p-0">
          <li className="flex gap-2">
            <span className="text-muted-foreground shrink-0">1.</span>
            <span><strong>Lost time stays lost.</strong> Don&apos;t try to compress 3 blocks into 2 to make up. Just continue from wherever you are.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted-foreground shrink-0">2.</span>
            <span><strong>Extension token.</strong> Once per week you may extend a block by 30 min max. Use it on Code &amp; Dev or Client Delivery only. Log it in Weekly Review.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted-foreground shrink-0">3.</span>
            <span><strong>Phone after 21:00.</strong> No doom-scroll during work blocks. Phone lives face-down until 21:00.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted-foreground shrink-0">4.</span>
            <span><strong>Max 3 P1s per day.</strong> If you have more than 3, downgrade. P1 means &quot;must ship today or the business is hurt.&quot;</span>
          </li>
        </ul>
      </section>

      <section className="space-y-2 md:space-y-3">
        <h2 className="px-1 md:px-0 text-[13px] md:text-lg font-semibold uppercase md:normal-case tracking-wider md:tracking-normal text-muted-foreground md:text-foreground">Failure Modes</h2>
        <div className="space-y-2 text-[15px] md:text-sm">
          <FailureMode title="Meeting overrun">
            End the call. Hard stop. If the other party isn&apos;t done — &quot;I need to wrap, let&apos;s continue async or schedule a follow-up.&quot; The meeting cap is 2 hours. A 3rd meeting moves to tomorrow.
          </FailureMode>
          <FailureMode title="Slept late">
            Start at whatever time you wake up. Begin with Morning Setup regardless of clock. Skip no block — just compress duration proportionally if needed. Don&apos;t skip Fiverr Ritual.
          </FailureMode>
          <FailureMode title="Block runs hot (deep flow, can't stop)">
            Use your extension token (once per week, 30 min max). If already used: stop at the block end. Log the overflow task as a P1 for tomorrow.
          </FailureMode>
          <FailureMode title="P0 emergency">
            Declare it. Drop into Code &amp; Dev mode regardless of schedule block. Work until resolved. Then resume from wherever the clock says you are. Log in Weekly Review.
          </FailureMode>
          <FailureMode title="Sick day">
            Don&apos;t try to work. Rest. Mark the day broken. If 2+ sick days in a week, update the review and adjust the coming week&apos;s P1s accordingly.
          </FailureMode>
        </div>
      </section>

      <section className="space-y-2 md:space-y-3">
        <h2 className="px-1 md:px-0 text-[13px] md:text-lg font-semibold uppercase md:normal-case tracking-wider md:tracking-normal text-muted-foreground md:text-foreground">Broken Day Thresholds</h2>
        <div className="border border-border/70 md:border-border rounded-2xl md:rounded overflow-hidden text-sm bg-card md:bg-transparent">
          <table className="w-full">
            <thead className="bg-muted text-xs text-muted-foreground uppercase">
              <tr>
                <th className="px-4 md:px-3 py-2 text-left">Broken Days / Week</th>
                <th className="px-4 md:px-3 py-2 text-left">Response</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="px-4 md:px-3 py-3 md:py-2 font-medium text-green-600 dark:text-green-400">1</td>
                <td className="px-4 md:px-3 py-3 md:py-2 text-foreground/70">Normal. Log it, move on.</td>
              </tr>
              <tr className="border-t">
                <td className="px-4 md:px-3 py-3 md:py-2 font-medium text-amber-600 dark:text-amber-400">2</td>
                <td className="px-4 md:px-3 py-3 md:py-2 text-foreground/70">Investigate. What broke? Fix the environment, not your willpower.</td>
              </tr>
              <tr className="border-t">
                <td className="px-4 md:px-3 py-3 md:py-2 font-medium text-red-600 dark:text-red-400">3+</td>
                <td className="px-4 md:px-3 py-3 md:py-2 text-foreground/70">System failure. Do a full weekly review. Restructure blocks before next Monday.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FailureMode({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl md:rounded-lg border border-border/70 md:border-border bg-card text-card-foreground p-4 md:p-3">
      <div className="font-semibold mb-1">{title}</div>
      <div className="text-foreground/70">{children}</div>
    </div>
  );
}
