'use client';

import { createContext, useContext, useMemo } from 'react';
import { setBrowserTz } from '@/lib/dates';
import { DEFAULT_MODES, colorOf, type ModeColor, type ModeDef } from '@/lib/modes';
import type { WeekPlan } from '@/lib/schedule';

type ProjectRef = { id: string; name: string; status: string; visibility?: 'org' | 'private' };
export type NavBadges = { overdue: number; claudeWaiting: number; status: 'ok' | 'warn' | 'error' };
/** The signed-in person as the sidebar's account button shows them. `operator`: runs this deployment (sees the server status). */
export type Account = { name: string; email: string; org: string; operator: boolean };
export type RecentProject = { id: string; name: string; private: boolean };
/**
 * me: the signed-in user's id; people: user id → name for everyone in their organization (actor labels); tz: their
 * timezone; modes: the organization's modes of work; plan: their week (null: no schedule, so no block bar or tint).
 */
type AppCtx = {
  today: string;
  projects: ProjectRef[];
  projectName: (id: string | null) => string | null;
  isPrivateProject: (id: string | null) => boolean;
  unread: number;
  badges: NavBadges;
  me: string;
  orgId: string;
  people: Record<string, string>;
  tz: string;
  modes: ModeDef[];
  plan: WeekPlan | null;
  account: Account;
  /** At least one computer is set up (Start Claude has something to start on). */
  hasComputers: boolean;
  recent: RecentProject[];
};

const NO_BADGES: NavBadges = { overdue: 0, claudeWaiting: 0, status: 'ok' };
const Ctx = createContext<AppCtx>({ today: '', projects: [], projectName: () => null, isPrivateProject: () => false, unread: 0, badges: NO_BADGES, me: '', orgId: '', people: {}, tz: 'UTC', modes: DEFAULT_MODES, plan: null, account: { name: '', email: '', org: '', operator: false }, hasComputers: false, recent: [] });

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
  account = { name: '', email: '', org: '', operator: false },
  hasComputers = false,
  recent = [],
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
  account?: Account;
  hasComputers?: boolean;
  recent?: RecentProject[];
  children: React.ReactNode;
}) {
  // "today" in client code (lib/dates.ts todayStr) is the signed-in person's.
  setBrowserTz(tz);
  const { overdue, claudeWaiting, status } = badges;
  const value = useMemo(() => {
    const map = new Map(projects.map(p => [p.id, p.name]));
    const priv = new Set(projects.filter(p => p.visibility === 'private').map(p => p.id));
    return { today, projects, unread, me, orgId, people, tz, modes, plan, account, hasComputers, recent, badges: { overdue, claudeWaiting, status }, projectName: (id: string | null) => (id ? (map.get(id) ?? id) : null), isPrivateProject: (id: string | null) => !!id && priv.has(id) };
  }, [today, projects, unread, overdue, claudeWaiting, status, me, orgId, people, tz, modes, plan, account, hasComputers, recent]);
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
