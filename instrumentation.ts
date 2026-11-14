// Runs once when the server starts (Next.js instrumentation).
export function register() {
  if (process.env.CRON_ALLOW_AT === '1') {
    const e2e = /^workos_e2e/.test(process.env.MONGODB_DB ?? '');
    console.error(
      e2e
        ? '[WARNING] CRON_ALLOW_AT=1: the alerts cron takes ?at= to simulate time (e2e database only).'
        : '[WARNING] CRON_ALLOW_AT=1 is set but the database is not an e2e one: it is IGNORED. Remove it from the environment.',
    );
  }
}
