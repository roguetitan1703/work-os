/** "Untouched" rule shared by the sidebar badge and the Untouched page: open and not updated for more than 7 x 24h. */
export const UNTOUCHED_DAYS = 7;

const DAY_MS = 86_400_000;

/** Tasks last updated before this moment count as untouched. */
export function untouchedCutoff(now: number = Date.now()): Date {
  return new Date(now - UNTOUCHED_DAYS * DAY_MS);
}

export function isUntouched(updatedAt: string | Date, now: number = Date.now()): boolean {
  return new Date(updatedAt).getTime() < now - UNTOUCHED_DAYS * DAY_MS;
}
