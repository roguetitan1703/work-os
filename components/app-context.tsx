'use client';

import { createContext, useContext, useMemo } from 'react';

type ProjectRef = { id: string; name: string; status: string };
type AppCtx = { today: string; projects: ProjectRef[]; projectName: (id: string | null) => string | null };

const Ctx = createContext<AppCtx>({ today: '', projects: [], projectName: () => null });

export function AppContextProvider({ today, projects, children }: { today: string; projects: ProjectRef[]; children: React.ReactNode }) {
  const value = useMemo(() => {
    const map = new Map(projects.map(p => [p.id, p.name]));
    return { today, projects, projectName: (id: string | null) => (id ? (map.get(id) ?? id) : null) };
  }, [today, projects]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  return useContext(Ctx);
}
