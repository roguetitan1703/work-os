'use client';

import { createContext, useContext, useMemo } from 'react';

type ProjectRef = { id: string; name: string; status: string };
type AppCtx = { today: string; projects: ProjectRef[]; projectName: (id: string | null) => string | null; unread: number };

const Ctx = createContext<AppCtx>({ today: '', projects: [], projectName: () => null, unread: 0 });

export function AppContextProvider({ today, projects, unread = 0, children }: { today: string; projects: ProjectRef[]; unread?: number; children: React.ReactNode }) {
  const value = useMemo(() => {
    const map = new Map(projects.map(p => [p.id, p.name]));
    return { today, projects, unread, projectName: (id: string | null) => (id ? (map.get(id) ?? id) : null) };
  }, [today, projects, unread]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  return useContext(Ctx);
}
