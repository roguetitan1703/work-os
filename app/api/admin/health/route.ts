import { NextResponse } from 'next/server';
import { authSecret } from '@/lib/auth';
import { callerFromRequest } from '@/lib/caller';
import { isOperator } from '@/lib/operator';
import { mongoEnvNames } from '@/lib/db';
import { scoped } from '@/lib/scope';
import { APP_TZ, todayStr } from '@/lib/dates';
import { converterCheck } from '@/lib/notes-convert';

// Connects to MongoDB (creating collections/indexes on first run) and reports what is configured.
// The operator (OPERATOR_EMAILS): signed in, or an API key of theirs (Authorization: Bearer wos_…).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // About the deployment, not an organization: the operator only (lib/operator.ts OPERATOR_EMAILS).
  if (!isOperator(caller)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const env = {
    MONGODB_URI: !!process.env.MONGODB_URI,
    mongoVarsSeen: mongoEnvNames(),
    VERCEL_ENV: process.env.VERCEL_ENV ?? null,
    MONGODB_DB: process.env.MONGODB_DB || 'workos (default)',
    BETTER_AUTH_SECRET: !!authSecret(),
    APP_TZ,
    APP_URL: process.env.APP_URL || null,
  };
  try {
    // Counts of the caller's organization only (their own reviews and logs).
    const c = await scoped({ userId: caller.userId, orgId: caller.orgId });
    const [tasks, activity, projects, reviews, ritualLogs, counter] = await Promise.all([
      c.tasks.countDocuments(),
      c.activity.countDocuments(),
      c.projects.countDocuments(),
      c.reviews.countDocuments(),
      c.ritualLogs.countDocuments(),
      c.counters.findOne({ _id: `task:${caller.orgId}` }),
    ]);
    const notesConverter = await converterCheck();
    const runtime = process.version;
    return NextResponse.json({ ok: true, today: todayStr(), env, runtime, notesConverter, blobStorage: !!process.env.BLOB_READ_WRITE_TOKEN, counts: { tasks, activity, projects, reviews, ritualLogs, lastRef: counter?.seq ?? 0 } });
  } catch (err) {
    return NextResponse.json({ ok: false, env, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
