import { NextResponse } from 'next/server';
import { bearerToken, checkToken } from '@/lib/auth';
import { collections } from '@/lib/db';
import { importLegacy, type LegacyData } from '@/lib/legacy-import';

// One-off import of the old data/tasks.json. POST the file as the JSON body.
//   Authorization: Bearer <MCP_TOKEN>      ?dryRun=1 to preview without writing
// Token is checked here as well as in proxy.ts (a logged-in browser session is not enough).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await checkToken(bearerToken(req)))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let body: LegacyData;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be the tasks.json contents' }, { status: 400 });
  }
  if (!Array.isArray(body?.tasks)) return NextResponse.json({ error: 'expected { tasks: [...] }' }, { status: 400 });

  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1';
  try {
    const report = await importLegacy(await collections(), body, { dryRun });
    return NextResponse.json(report, { status: report.problems.length ? 207 : 200 });
  } catch (err) {
    console.error('[import]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'import failed' }, { status: 500 });
  }
}
