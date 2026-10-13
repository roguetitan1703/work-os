import { NextResponse } from 'next/server';
import { bearerToken, checkToken, uiAuthConfigured } from '@/lib/auth';
import { collections, mongoEnvNames } from '@/lib/db';
import { APP_TZ, todayStr } from '@/lib/dates';
import { converterCheck } from '@/lib/notes-convert';

// Connects to MongoDB (creating collections/indexes on first run) and reports what is configured.
// Authorization: Bearer <MCP_TOKEN>

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!(await checkToken(bearerToken(req)))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const env = {
    MONGODB_URI: !!process.env.MONGODB_URI,
    mongoVarsSeen: mongoEnvNames(),
    VERCEL_ENV: process.env.VERCEL_ENV ?? null,
    MONGODB_DB: process.env.MONGODB_DB || 'workos (default)',
    APP_PASSWORD_and_SESSION_SECRET: uiAuthConfigured(),
    MCP_TOKEN: true,
    APP_TZ,
    APP_URL: process.env.APP_URL || null,
  };
  try {
    const c = await collections();
    const [tasks, activity, projects, reviews, ritualLogs, counter] = await Promise.all([
      c.tasks.countDocuments(),
      c.activity.countDocuments(),
      c.projects.countDocuments(),
      c.reviews.countDocuments(),
      c.ritualLogs.countDocuments(),
      c.counters.findOne({ _id: 'task' }),
    ]);
    const notesConverter = await converterCheck();
    return NextResponse.json({ ok: true, today: todayStr(), env, notesConverter, blobStorage: !!process.env.BLOB_READ_WRITE_TOKEN, counts: { tasks, activity, projects, reviews, ritualLogs, lastRef: counter?.seq ?? 0 } });
  } catch (err) {
    return NextResponse.json({ ok: false, env, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
