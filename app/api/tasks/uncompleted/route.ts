import { NextResponse } from 'next/server';
import { listTasks } from '@/lib/data/tasks';

// Auth: session cookie or `Authorization: Bearer <MCP_TOKEN>` (enforced in proxy.ts).
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const tasks = await listTasks({ open: true });
    return NextResponse.json({ count: tasks.length, tasks });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'failed to read tasks' }, { status: 500 });
  }
}
