'use client';

import { usePathname } from 'next/navigation';
import { AutoRefresh } from '@/app/(app)/claude/auto-refresh';

// Live pages (push, components/live.ts): every page of the app refreshes itself when the server says something it
// shows has changed (a teammate, Claude over MCP, another tab). Placed once in the app layout; a refresh re-reads the
// whole page with the layout, so the nav badges follow too. The Claude page has its own AutoRefresh (it also polls
// while the stream is down); here there is no poll: after a gap the stream's catch-up hint refreshes once.
// What each page listens to. Every page hears 'inbox' (the unread badge); the overdue and Claude badges follow on
// the pages that hear 'tasks' and 'claude'.
function topicsFor(path: string): string[] | null {
  if (path === '/claude' || path.startsWith('/claude/')) return null;
  if (path === '/today' || path === '/') return ['tasks', 'projects', 'claude', 'inbox'];
  if (path.startsWith('/tasks') || path.startsWith('/modes/')) return ['tasks', 'projects', 'inbox'];
  if (path === '/projects') return ['projects', 'tasks', 'inbox'];
  if (path.startsWith('/projects/')) return ['projects', 'tasks', 'notes', 'claude', 'inbox'];
  if (path === '/notes') return ['notes', 'inbox'];
  if (path.startsWith('/review')) return ['review', 'tasks', 'inbox'];
  return ['inbox'];
}

export function LiveRefresh({ stamp }: { stamp: number }) {
  const topics = topicsFor(usePathname());
  if (!topics) return null;
  return <AutoRefresh key={topics.join(',')} stamp={stamp} topics={topics} poll={false} />;
}
