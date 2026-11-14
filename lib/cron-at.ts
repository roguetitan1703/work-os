// The alerts cron's ?at=<ISO> simulates another time (docs/HANDOVER.md section 7). Outside production it always works;
// in a production build (the e2e runner's) it needs CRON_ALLOW_AT=1 AND a database whose name starts with workos_e2e, so
// setting it on a real deployment does nothing. Outside the e2e database the time is clamped to a week either side of
// the real clock; the e2e suites use fixed dates and so are not clamped.
const E2E_DB = () => /^workos_e2e/.test(process.env.MONGODB_DB ?? '');
export const cronAtAllowed = () => process.env.NODE_ENV !== 'production' || (process.env.CRON_ALLOW_AT === '1' && E2E_DB());
/** True only in the e2e database: stamps may then carry a simulated time (never anywhere else). */
export const simulatedStampsAllowed = E2E_DB;

/** The simulated time for ?at=, undefined when none or not allowed; null when the value is not a date. */
export function parseCronAt(raw: string | null): Date | undefined | null {
  if (!raw || !cronAtAllowed()) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  if (E2E_DB()) return d;
  const now = Date.now();
  const week = 7 * 86_400_000;
  return new Date(Math.min(now + week, Math.max(now - week, d.getTime())));
}
