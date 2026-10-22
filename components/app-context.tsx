'use client';

import { createContext, useContext, useMemo } from 'react';
import { setBrowserTz } from '@/lib/dates';
import { DEFAULT_MODES, colorOf, type ModeColor, type ModeDef } from '@/lib/modes';
import type { WeekPlan } from '@/lib/schedule';

type ProjectRef = { id: string; name: string; status: string };
export type NavBadges = { overdue: number; claudeWaiting: number; status: 'ok' | 'warn' | 'error' };
/**
 * me: the signed-in user's id; people: user id → name for everyone in their organization (actor labels); tz: their
 * timezone; modes: the organization's modes of work; plan: their week (null: no schedule, so no block bar or tint).
 */
type AppCtx = {
  today: string;
  projects: ProjectRef[];
  projectName: (id: string | null) => string | null;
  unread: number;
  badges: NavBadges;
  me: string;
  orgId: string;
  people: Record<string, string>;
  tz: string;
  modes: ModeDef[];
  plan: WeekPlan | null;
};

const NO_BADGES: NavBadges = { overdue: 0, claudeWaiting: 0, status: 'ok' };
const Ctx = createContext<AppCtx>({ today: '', projects: [], projectName: () => null, unread: 0, badges: NO_BADGES, me: '', orgId: '', people: {}, tz: 'UTC', modes: DEFAULT_MODES, plan: null });

export function AppContextProvider({
  today,
  projects,
  unread = 0,
  badges = NO_BADGES,
  me = '',
  orgId = '',
  people = {},
  tz = 'UTC',
  modes = DEFAULT_MODES,
  plan = null,
  children,
}: {
  today: string;
  projects: ProjectRef[];
  unread?: number;
  badges?: NavBadges;
  me?: string;
  orgId?: string;
  people?: Record<string, string>;
  tz?: string;
  modes?: ModeDef[];
  plan?: WeekPlan | null;
  children: React.ReactNode;
}) {
  // "today" in client code (lib/dates.ts todayStr) is the signed-in person's.
  setBrowserTz(tz);
  const { overdue, claudeWaiting, status } = badges;
  const value = useMemo(() => {
    const map = new Map(projects.map(p => [p.id, p.name]));
    return { today, projects, unread, me, orgId, people, tz, modes, plan, badges: { overdue, claudeWaiting, status }, projectName: (id: string | null) => (id ? (map.get(id) ?? id) : null) };
  }, [today, projects, unread, overdue, claudeWaiting, status, me, orgId, people, tz, modes, plan]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  return useContext(Ctx);
}

/** The organization's modes, their names, and the colour for a mode or one of the person's own block names. */
export function useModes(): { modes: ModeDef[]; names: string[]; color: (name: string | null | undefined) => ModeColor } {
  const { modes, plan } = useContext(Ctx);
  return useMemo(() => ({ modes, names: modes.map(m => m.name), color: (name: string | null | undefined) => colorOf(name, modes, plan?.colors) }), [modes, plan]);
}
