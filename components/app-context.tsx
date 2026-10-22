'use client';

import { createContext, useContext, useMemo } from 'react';

type ProjectRef = { id: string; name: string; status: string };
export type NavBadges = { overdue: number; claudeWaiting: number; status: 'ok' | 'warn' | 'error' };
/** me: the signed-in user's id; people: user id → name for everyone in their organization (actor labels). */
type AppCtx = { today: string; projects: ProjectRef[]; projectName: (id: string | null) => string | null; unread: number; badges: NavBadges; me: string; orgId: string; people: Record<string, string> };

const NO_BADGES: NavBadges = { overdue: 0, claudeWaiting: 0, status: 'ok' };
const Ctx = createContext<AppCtx>({ today: '', projects: [], projectName: () => null, unread: 0, badges: NO_BADGES, me: '', orgId: '', people: {} });

export function AppContextProvider({
  today,
  projects,
  unread = 0,
  badges = NO_BADGES,
  me = '',
  orgId = '',
  people = {},
  children,
}: {
  today: string;
  projects: ProjectRef[];
  unread?: number;
  badges?: NavBadges;
  me?: string;
  orgId?: string;
  people?: Record<string, string>;
  children: React.ReactNode;
}) {
  const { overdue, claudeWaiting, status } = badges;
  const value = useMemo(() => {
    const map = new Map(projects.map(p => [p.id, p.name]));
    return { today, projects, unread, me, orgId, people, badges: { overdue, claudeWaiting, status }, projectName: (id: string | null) => (id ? (map.get(id) ?? id) : null) };
  }, [today, projects, unread, overdue, claudeWaiting, status, me, orgId, people]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  return useContext(Ctx);
}
